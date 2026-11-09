const crypto = require('crypto');
const express = require('express');
const { col, nowSql, publicDoc } = require('./db');
const { requireAuth, publicUserFrom } = require('./auth');
const credits = require('./credits');

const TTL_MS = 90 * 1000;
const SCHEME = process.env.DESKTOP_SCHEME || 'feonixai';

const router = express.Router();

async function prune() {
  await col('handoff_tokens').deleteMany({ expires_at: { $lt: Date.now() - TTL_MS } });
}

router.post('/:id/handoff', requireAuth, async (req, res, next) => {
  try {
    let session = publicDoc(await col('call_sessions').findOne({
      id: Number(req.params.id),
      user_id: req.user.id,
    }));
    if (!session) {
      session = publicDoc(await col('call_sessions').findOne({ user_id: req.user.id }, { sort: { id: -1 } }));
    }
    if (!session) {
      const { nextId } = require('./db');
      const newId = await nextId('call_sessions');
      const doc = {
        id: newId,
        user_id: req.user.id,
        company: 'Interview Session',
        role: 'Candidate',
        mode: 'interview',
        status: 'ready',
        created_at: nowSql(),
      };
      await col('call_sessions').insertOne(doc);
      session = publicDoc(doc);
    }

    prune().catch(() => {});
    const token = crypto.randomBytes(32).toString('base64url');
    await col('handoff_tokens').insertOne({
      token,
      user_id: req.user.id,
      session_id: session.id,
      expires_at: Date.now() + TTL_MS,
      used_at: null,
      created_at: nowSql(),
    });

    res.json({
      token,
      session_id: session.id,
      expires_in_ms: TTL_MS,
      // No action=start_session: the desktop app opens its Start Interview
      // screen first and the copilot only after the user clicks Start Session.
      deep_link: `${SCHEME}://launch?token=${token}&session=${session.id}`,
    });
  } catch (err) {
    next(err);
  }
});

// Has the desktop app picked up this hand-off yet? The launch page asks this
// after opening the feonixai:// link: the app redeems the token as soon as it
// opens, so "used" means the app is installed and opened; still unused after
// a while means it most likely isn't installed.
router.get('/:id/handoff-status', requireAuth, async (req, res, next) => {
  try {
    const token = String(req.query.token || '');
    if (!token) return res.status(400).json({ error: 'missing_token' });
    const row = await col('handoff_tokens').findOne(
      { token, user_id: req.user.id },
      { projection: { used_at: 1, expires_at: 1 } }
    );
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.set('Cache-Control', 'no-store');
    return res.json({ used: Boolean(row.used_at), expired: row.expires_at < Date.now() });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/launch-desktop', requireAuth, async (req, res, next) => {
  try {
    let session = publicDoc(await col('call_sessions').findOne({
      id: Number(req.params.id),
      user_id: req.user.id,
    }));
    if (!session) {
      session = publicDoc(await col('call_sessions').findOne({ user_id: req.user.id }, { sort: { id: -1 } }));
    }
    const sessionId = session ? session.id : req.params.id;
    await prune();
    const token = crypto.randomBytes(32).toString('base64url');
    await col('handoff_tokens').insertOne({
      token,
      user_id: req.user.id,
      session_id: sessionId,
      expires_at: Date.now() + TTL_MS,
      used_at: null,
      created_at: nowSql(),
    });

    // Launching the desktop app is the client's job (see launch/page.js,
    // which navigates to deep_link itself) — this route used to also exec()
    // a hardcoded local Windows path on the server process, which only ever
    // made sense if the API happened to run on the same machine as the
    // desktop app. That's not how a hosted backend works, so it's removed.
    // Opens the desktop Start Interview screen; the copilot starts from there.
    const deepLink = `${SCHEME}://launch?token=${token}&session=${sessionId}`;

    res.json({
      ok: true,
      token,
      session_id: sessionId,
      deep_link: deepLink,
      message: 'Launching FeonixAI Desktop App with hardware anti-capture protection...',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/redeem', express.json(), async (req, res, next) => {
  try {
    const token = String((req.body && req.body.token) || '');
    if (!token) return res.status(400).json({ error: 'missing_token' });

    // Check and use the token in one step. A token is single-use, with one
    // allowance: the same token may sign in again within 30 s of its first
    // use, so a first sign-in cut off by the window reloading (the reply,
    // with its login cookie, never arrived) does not leave the app signed out.
    const now = Date.now();
    const REUSE_GRACE_MS = 30 * 1000;
    const claimed = await col('handoff_tokens').findOneAndUpdate(
      {
        token,
        expires_at: { $gte: now - REUSE_GRACE_MS },
        $or: [
          { used_at: null, expires_at: { $gte: now } },
          { used_at: { $gte: now - REUSE_GRACE_MS } },
        ],
      },
      [{ $set: { used_at: { $ifNull: ['$used_at', now] } } }]
    );
    const claimedDoc = claimed && Object.prototype.hasOwnProperty.call(claimed, 'value') ? claimed.value : claimed;
    if (!claimedDoc) {
      // Only on failure: find out why, for the right message.
      const existing = await col('handoff_tokens').findOne({ token });
      if (!existing) return res.status(401).json({ error: 'invalid_token', message: 'That link is not valid.' });
      if (existing.used_at) {
        return res.status(401).json({
          error: 'token_used',
          message: 'That link was already used. Start the session again from the dashboard.',
        });
      }
      return res.status(401).json({
        error: 'token_expired',
        message: 'That link expired. Start the session again from the dashboard.',
      });
    }
    const row = publicDoc(claimedDoc);

    // The login is saved at the same time as the user and the session are
    // read (the token already names the user), so the whole redeem is two
    // round trips. The session comes back in the reply so the desktop app
    // can show it without another request.
    const saveLogin = () => new Promise((resolve, reject) => {
      const save = () => {
        req.session.userId = row.user_id;
        req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
      };
      // A fresh login (the desktop app's first request) needs no regenerate,
      // which would cost an extra round trip; an existing one is replaced.
      if (req.session.userId) {
        req.session.regenerate((err) => (err ? reject(err) : save()));
      } else {
        save();
      }
    });
    let userDoc;
    let sessionDoc;
    let trialsLeft;
    let creditsLeft;
    let unlimited;
    try {
      // The balance (free trials, credits, plan) is read alongside, so the
      // desktop window can show it with the session at once; each is one
      // database round, so this adds no waiting.
      [userDoc, sessionDoc, , trialsLeft, creditsLeft, unlimited] = await Promise.all([
        col('users').findOne({ id: row.user_id }),
        row.session_id ? col('call_sessions').findOne({ id: Number(row.session_id), user_id: row.user_id }) : null,
        saveLogin(),
        credits.trialsRemaining(row.user_id).catch(() => null),
        credits.creditBalance(row.user_id).catch(() => null),
        credits.isUnlimited(row.user_id).catch(() => null),
      ]);
    } catch {
      return res.status(500).json({ error: 'session_failed' });
    }
    const user = publicDoc(userDoc);
    if (!user || user.disabled) {
      // Account gone or disabled since the link was made: undo the login.
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'invalid_token' });
    }

    return res.json({
      // The balance is fetched separately by the app (/api/sessions/account),
      // so it is not worked out here.
      user: publicUserFrom(user, 0, null),
      session_id: row.session_id,
      session: sessionDoc ? publicDoc(sessionDoc) : null,
      account: trialsLeft === null || creditsLeft === null || unlimited === null
        ? null
        : { trials_remaining: trialsLeft, credits: creditsLeft, unlimited },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, SCHEME };
