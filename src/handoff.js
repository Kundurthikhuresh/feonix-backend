const crypto = require('crypto');
const express = require('express');
const { col, nowSql, publicDoc } = require('./db');
const { requireAuth, publicUser } = require('./auth');

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

    await prune();
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
      deep_link: `${SCHEME}://launch?token=${token}&session=${session.id}`,
    });
  } catch (err) {
    next(err);
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

    const deepLink = `${SCHEME}://launch?token=${token}&session=${sessionId}&action=start_session&start=open`;
    if (process.platform === 'win32') {
      const { exec } = require('child_process');
      exec(`start "" "${deepLink}"`, (err) => {
        if (err) {
          const exePath = 'C:\\Users\\arsha\\AppData\\Local\\Programs\\FeonixAI\\FeonixAI.exe';
          exec(`"${exePath}" "${deepLink}"`, () => {});
        }
      });
    }

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

    const row = publicDoc(await col('handoff_tokens').findOne({ token }));
    if (!row) return res.status(401).json({ error: 'invalid_token', message: 'That link is not valid.' });

    if (row.expires_at < Date.now()) {
      return res.status(401).json({
        error: 'token_expired',
        message: 'That link expired. Start the session again from the dashboard.',
      });
    }

    await col('handoff_tokens').updateOne(
      { token },
      { $set: { used_at: Date.now() } }
    );

    const user = publicDoc(await col('users').findOne({ id: row.user_id }));
    if (!user) return res.status(401).json({ error: 'invalid_token' });

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'session_failed' });
      req.session.userId = user.id;
      req.session.save(async (saveErr) => {
        if (saveErr) return res.status(500).json({ error: 'session_failed' });
        return res.json({ user: await publicUser(user), session_id: row.session_id });
      });
    });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, SCHEME };
