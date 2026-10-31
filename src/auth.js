require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { col, nextId, nowSql, tokensUsedThisMonth, publicDoc } = require('./db');
const { sendWelcomeEmail, sendPasswordResetEmail } = require('./mailer');
const { rateLimit } = require('./rateLimit');
const credits = require('./credits');

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 200;
const DEFAULT_TOKEN_QUOTA = Number(process.env.DEFAULT_TOKEN_QUOTA || 100000);
const DUMMY_HASH = bcrypt.hashSync('no-user-matched-this-password', BCRYPT_ROUNDS);

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  keyFn: (req) => `login:${req.ip}:${normalizeEmail(req.body && req.body.email)}`,
  errorCode: 'too_many_attempts',
  messagePrefix: 'Too many attempts',
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1000,
  keyFn: (req) => `register:${req.ip}`,
  errorCode: 'too_many_attempts',
  messagePrefix: 'Too many attempts',
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyFn: (req) => `forgot:${req.ip}:${normalizeEmail(req.body && req.body.email)}`,
  errorCode: 'too_many_attempts',
  messagePrefix: 'Too many attempts',
});

const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyFn: (req) => `reset:${req.ip}`,
  errorCode: 'too_many_attempts',
  messagePrefix: 'Too many attempts',
});

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour, matches the email copy

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function looksLikeEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function findUserById(id) {
  return publicDoc(await col('users').findOne({ id: Number(id) }));
}

async function findUserByEmail(email) {
  return publicDoc(await col('users').findOne({ email }));
}

function isDesignatedAdmin(user) {
  if (!user) return false;
  if (user.role === 'owner' || user.role === 'admin' || user.is_admin === true) return true;
  const raw = process.env.ADMIN_EMAIL || '';
  const adminList = raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  if (!adminList.length || !user.email) return false;
  return adminList.includes(user.email.trim().toLowerCase());
}

// Split out so callers that already know `used` (a brand-new account has
// no usage yet, a parallel fetch already has it) can skip the round trip
// tokensUsedThisMonth() would otherwise cost.
function publicUserFrom(user, used, account = null) {
  const isAdmin = isDesignatedAdmin(user);
  const remainingTrials = account && typeof account.trials_remaining === 'number'
    ? account.trials_remaining
    : (user.trials_remaining !== undefined ? user.trials_remaining : (credits.DEFAULT_FREE_TRIALS || 5));
  const creditBal = account && typeof account.credits === 'number'
    ? account.credits
    : (user.credits !== undefined ? user.credits : 0);

  return {
    id: user.id,
    email: user.email,
    role: isAdmin ? 'owner' : 'member',
    is_admin: isAdmin,
    plan: user.plan || (isAdmin ? 'owner' : 'free'),
    subscription_status: user.subscription_status || null,
    token_quota: user.token_quota,
    tokens_used_this_month: used,
    tokens_remaining: Math.max(0, user.token_quota - used),
    trials_remaining: remainingTrials,
    trials_total: credits.DEFAULT_FREE_TRIALS || 5,
    credits: creditBal,
  };
}

async function publicUser(user) {
  const [used, account] = await Promise.all([
    tokensUsedThisMonth(user.id),
    credits.accountSummary(user.id).catch(() => null),
  ]);
  return publicUserFrom(user, used, account);
}

function startSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

async function requireAuth(req, res, next) {
  try {
    let userId = req.session && req.session.userId;

    if (!userId) {
      return res.status(401).json({ error: 'unauthenticated', message: 'Sign in first.' });
    }
    const user = await findUserById(userId);
    if (!user) {
      return req.session ? req.session.destroy(() =>
        res.status(401).json({ error: 'unauthenticated', message: 'Sign in first.' })
      ) : res.status(401).json({ error: 'unauthenticated', message: 'Sign in first.' });
    }
    if (user.disabled) {
      return req.session ? req.session.destroy(() =>
        res.status(403).json({ error: 'account_disabled', message: 'This account has been disabled.' })
      ) : res.status(403).json({ error: 'account_disabled', message: 'This account has been disabled.' });
    }
    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
}

// For the live-call routes only (transcription chunks every couple of seconds,
// answers): skips the user lookup when the same user was verified moments
// ago. A disabled account is refused within USER_CACHE_MS; every other route
// keeps the exact per-request check above.
const USER_CACHE_MS = 10 * 1000;
// Older than USER_CACHE_MS but younger than this: serve the cached user and
// re-check in the background, so a question never waits on the user lookup
// mid-call. A disabled account is still refused from the next request on.
const USER_STALE_MS = 10 * 60 * 1000;
const userCache = new Map();

async function requireAuthLive(req, res, next) {
  const userId = req.session && req.session.userId;
  const hit = userId && userCache.get(Number(userId));
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < USER_STALE_MS) {
    req.user = hit.user;
    if (age >= USER_CACHE_MS && !hit.refreshing) {
      hit.refreshing = true;
      findUserById(userId)
        .then((user) => {
          if (user && !user.disabled) userCache.set(Number(userId), { user, at: Date.now() });
          else userCache.delete(Number(userId));
        })
        .catch(() => { hit.refreshing = false; });
    }
    return next();
  }
  return requireAuth(req, res, (err) => {
    if (!err && req.user) userCache.set(Number(userId), { user: req.user, at: Date.now() });
    next(err);
  });
}

function requireOwner(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'unauthenticated', message: 'Sign in first.' });
  }
  if (!isDesignatedAdmin(req.user)) {
    return res.status(403).json({ error: 'forbidden', message: 'Designated administrator access only.' });
  }
  return next();
}

const requireAdmin = requireOwner;

router.post('/register', registerLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');
    const signupCode = (req.body && req.body.signup_code) || '';

    if (!looksLikeEmail(email)) {
      return res.status(400).json({ error: 'invalid_email', message: 'Enter a valid email address.' });
    }
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: 'weak_password',
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
    }

    // SIGNUP_CODE is optional: set it to gate registration behind an invite
    // code, or leave it unset (the default) for open registration. The
    // first-account check exists only for that gate, so with no code set it is
    // skipped — it was a full database round trip on every signup.
    const expectedCode = process.env.SIGNUP_CODE;
    if (expectedCode && !safeEqual(signupCode, expectedCode)) {
      const isFirstAccount = !(await col('users').findOne({}, { projection: { _id: 1 } }));
      if (!isFirstAccount) {
        return res.status(403).json({ error: 'invalid_signup_code', message: 'Invalid signup code.' });
      }
    }

    // Public registration creates standard candidate (USER) accounts only.
    // Administrator accounts must be explicitly provisioned through server-side setup.
    // Any requested role or admin code parameter is strictly ignored to prevent privilege escalation.
    const role = 'member';

    // Hashing is CPU work and nextId is a database trip: neither needs the
    // other, so they run together instead of one after the other.
    const [passwordHash, id] = await Promise.all([
      bcrypt.hash(password, BCRYPT_ROUNDS),
      nextId('users'),
    ]);
    try {
      await col('users').insertOne({
        id,
        email,
        password_hash: passwordHash,
        role,
        token_quota: DEFAULT_TOKEN_QUOTA,
        disabled: 0,
        created_at: nowSql(),
      });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({ error: 'email_taken', message: 'That email is already registered.' });
      }
      throw err;
    }

    await startSession(req, id);

    // Send welcome email (fire-and-forget, deferred to next tick)
    setImmediate(() => {
      sendWelcomeEmail(email).catch((mailErr) => {
        console.error('Non-blocking welcome email error:', mailErr);
      });
    });

    // Skips both findUserById() and tokensUsedThisMonth(): we already have
    // every field of the row we just inserted, and a brand-new account
    // cannot have any usage yet — querying for it would only ever confirm
    // zero, at the cost of a full round trip.
    const account = await credits.accountSummary(id).catch(() => null);
    return res.status(201).json({
      user: publicUserFrom({ id, email, role, token_quota: DEFAULT_TOKEN_QUOTA }, 0, account),
      account: account || { trials_remaining: 5, trials_total: 5, credits: 0, credits_used: 0 },
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');
    const user = await findUserByEmail(email);
    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Email or password is incorrect.' });
    }
    const requestedRole = String((req.body && req.body.role) || '').toLowerCase();
    const isAdmin = isDesignatedAdmin(user);
    if (requestedRole === 'admin' && !isAdmin) {
      return res.status(403).json({
        error: 'not_an_admin',
        message: 'Access denied: This account does not have administrator privileges. Please use User Login.'
      });
    }
    // Independent round trips — the session write doesn't need the usage
    // figure, and vice versa — so they don't have to happen back to back.
    const [, used, account] = await Promise.all([
      startSession(req, user.id),
      tokensUsedThisMonth(user.id),
      credits.accountSummary(user.id).catch(() => null),
    ]);
    return res.json({
      user: publicUserFrom(user, used, account),
      account: account || { trials_remaining: 5, trials_total: 5, credits: 0, credits_used: 0 },
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/forgot-password', forgotPasswordLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    const genericResponse = {
      message: 'If an account exists for that email, a reset link has been sent.',
    };

    if (!looksLikeEmail(email)) {
      // Still 200 here — an invalid-email response would let a caller probe
      // for which strings are worth trying, same reasoning as below.
      return res.json(genericResponse);
    }

    const user = await findUserByEmail(email);
    if (user && !user.disabled) {
      const token = crypto.randomBytes(32).toString('base64url');
      await col('password_resets').insertOne({
        token,
        user_id: user.id,
        expires_at: Date.now() + RESET_TOKEN_TTL_MS,
        used_at: null,
        created_at: nowSql(),
      });

      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      const resetUrl = `${appUrl}/reset-password?token=${token}`;
      try {
        const expiresInMinutes = Math.round(RESET_TOKEN_TTL_MS / 60000);
        const mailResult = await sendPasswordResetEmail(email, resetUrl, { expiresInMinutes });
        if (!mailResult.success) {
          console.error('Password reset email failed:', mailResult.error);
        } else {
          console.log('Password reset email successfully sent to', email);
        }
      } catch (mailErr) {
        console.error('Failed to send password reset email:', mailErr);
      }
    }

    // Always respond the same way whether or not the account exists, so
    // this endpoint can't be used to enumerate registered emails.
    return res.json(genericResponse);
  } catch (err) {
    return next(err);
  }
});

router.post('/reset-password', resetPasswordLimiter, async (req, res, next) => {
  try {
    const token = String((req.body && req.body.token) || '');
    const password = String((req.body && req.body.password) || '');

    if (!token) {
      return res.status(400).json({ error: 'missing_token', message: 'Missing reset token.' });
    }
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: 'weak_password',
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
    }

    const record = await col('password_resets').findOne({ token });
    if (!record || record.used_at || record.expires_at < Date.now()) {
      return res.status(401).json({
        error: 'invalid_token',
        message: 'This reset link is invalid or has expired. Request a new one.',
      });
    }

    const burned = await col('password_resets').updateOne(
      { token, used_at: null },
      { $set: { used_at: Date.now() } }
    );
    if (!burned.modifiedCount) {
      return res.status(401).json({ error: 'token_used', message: 'This reset link has already been used.' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await col('users').updateOne({ id: record.user_id }, { $set: { password_hash: passwordHash } });

    return res.json({ message: 'Password updated. You can now sign in.' });
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', (req, res) => {
  if (!req.session) return res.status(204).end();
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'logout_failed' });
    res.clearCookie('sid');
    return res.status(204).end();
  });
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    res.json({ user: await publicUser(req.user) });
  } catch (err) {
    next(err);
  }
});

module.exports = {
  router, requireAuth, requireAuthLive, requireOwner, requireAdmin, isDesignatedAdmin, publicUser, normalizeEmail,
  BCRYPT_ROUNDS, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, findUserById,
};
