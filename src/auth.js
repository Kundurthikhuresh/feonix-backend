const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { col, nextId, nowSql, tokensUsedThisMonth, publicDoc } = require('./db');

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;
const DEFAULT_TOKEN_QUOTA = Number(process.env.DEFAULT_TOKEN_QUOTA || 100000);
const DUMMY_HASH = bcrypt.hashSync('no-user-matched-this-password', BCRYPT_ROUNDS);

const router = express.Router();
const buckets = new Map();

function rateLimit({ windowMs, max, keyFn }) {
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'too_many_attempts',
        message: `Too many attempts. Try again in ${retryAfter}s.`,
      });
    }
    return next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyFn: (req) => `login:${req.ip}:${normalizeEmail(req.body && req.body.email)}`,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyFn: (req) => `register:${req.ip}`,
});

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

async function publicUser(user) {
  const used = await tokensUsedThisMonth(user.id);
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    token_quota: user.token_quota,
    tokens_used_this_month: used,
    tokens_remaining: Math.max(0, user.token_quota - used),
  };
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
    const userId = req.session && req.session.userId;
    if (!userId) {
      return res.status(401).json({ error: 'unauthenticated', message: 'Sign in first.' });
    }
    const user = await findUserById(userId);
    if (!user) {
      return req.session.destroy(() =>
        res.status(401).json({ error: 'unauthenticated', message: 'Sign in first.' })
      );
    }
    if (user.disabled) {
      return req.session.destroy(() =>
        res.status(403).json({ error: 'account_disabled', message: 'This account has been disabled.' })
      );
    }
    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
}

function requireOwner(req, res, next) {
  if (!req.user || req.user.role !== 'owner') {
    return res.status(403).json({ error: 'forbidden', message: 'Owner only.' });
  }
  return next();
}

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
        message: `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`,
      });
    }

    const isFirstAccount = (await col('users').countDocuments()) === 0;
    if (!isFirstAccount) {
      const expected = process.env.SIGNUP_CODE;
      if (!expected) {
        return res.status(403).json({
          error: 'registration_closed',
          message: 'Registration is closed. Ask the owner for an account.',
        });
      }
      if (!safeEqual(signupCode, expected)) {
        return res.status(403).json({ error: 'invalid_signup_code', message: 'Invalid signup code.' });
      }
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const id = await nextId('users');
    try {
      await col('users').insertOne({
        id,
        email,
        password_hash: passwordHash,
        role: isFirstAccount ? 'owner' : 'member',
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
    return res.status(201).json({ user: await publicUser(await findUserById(id)) });
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
    await startSession(req, user.id);
    return res.json({ user: await publicUser(user) });
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
  router, requireAuth, requireOwner, publicUser, normalizeEmail,
  BCRYPT_ROUNDS, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, findUserById,
};
