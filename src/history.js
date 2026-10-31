const express = require('express');
const { col, nextId, nowSql, publicDoc } = require('./db');
const { requireAuth } = require('./auth');

async function saveAnswer({ userId, question, reply, mode, action, sessionId = null }) {
  if (!reply || !reply.trim()) return null;
  const id = await nextId('answers');
  const numSessionId = sessionId != null && Number.isFinite(Number(sessionId))
    ? Number(sessionId)
    : (sessionId != null ? String(sessionId) : null);
  await col('answers').insertOne({
    id,
    user_id: userId,
    question,
    reply,
    mode,
    action,
    session_id: numSessionId,
    created_at: nowSql(),
  });
  return id;
}

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const filter = { user_id: req.user.id };
    if (req.query.session_id) {
      const sId = req.query.session_id;
      const numSessionId = Number(sId);
      filter.session_id = Number.isFinite(numSessionId) ? { $in: [numSessionId, String(sId)] } : sId;
    }
    const answers = await col('answers')
      .find(filter)
      .project({ _id: 0, id: 1, question: 1, reply: 1, mode: 1, action: 1, created_at: 1 })
      .sort({ id: -1 })
      .limit(limit)
      .toArray();
    res.json({ answers });
  } catch (err) {
    next(err);
  }
});

router.delete('/', requireAuth, async (req, res, next) => {
  try {
    await col('answers').deleteMany({ user_id: req.user.id });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = { router, saveAnswer, publicDoc };
