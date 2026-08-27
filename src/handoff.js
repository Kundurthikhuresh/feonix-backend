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
    const session = publicDoc(await col('call_sessions').findOne({
      id: Number(req.params.id),
      user_id: req.user.id,
    }));
    if (!session) return res.status(404).json({ error: 'not_found' });

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

router.post('/redeem', express.json(), async (req, res, next) => {
  try {
    const token = String((req.body && req.body.token) || '');
    if (!token) return res.status(400).json({ error: 'missing_token' });

    const row = publicDoc(await col('handoff_tokens').findOne({ token }));
    if (!row) return res.status(401).json({ error: 'invalid_token', message: 'That link is not valid.' });

    if (row.used_at) {
      return res.status(401).json({
        error: 'token_used',
        message: 'That link has already been used. Start the session again from the dashboard.',
      });
    }
    if (row.expires_at < Date.now()) {
      return res.status(401).json({
        error: 'token_expired',
        message: 'That link expired. Start the session again from the dashboard.',
      });
    }

    const burned = await col('handoff_tokens').updateOne(
      { token, used_at: null },
      { $set: { used_at: Date.now() } }
    );
    if (!burned.modifiedCount) {
      return res.status(401).json({ error: 'token_used', message: 'That link has already been used.' });
    }

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
