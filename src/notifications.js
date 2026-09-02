/**
 * In-app Notifications System
 * GET    /api/notifications          — list notifications (newest first)
 * POST   /api/notifications/:id/read — mark one as read
 * POST   /api/notifications/read-all — mark all as read
 */
const express = require('express');
const { col, nextId, nowSql, publicDoc } = require('./db');
const { requireAuth } = require('./auth');

const router = express.Router();

// GET /api/notifications
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const onlyUnread = req.query.unread === '1';

    const filter = { user_id: req.user.id };
    if (onlyUnread) filter.read = false;

    const rows = await col('notifications')
      .find(filter)
      .sort({ id: -1 })
      .limit(limit)
      .toArray();

    const unreadCount = await col('notifications').countDocuments({
      user_id: req.user.id,
      read: false,
    });

    return res.json({ notifications: rows.map(publicDoc), unread_count: unreadCount });
  } catch (err) {
    return next(err);
  }
});

// POST /api/notifications/:id/read
router.post('/:id/read', requireAuth, async (req, res, next) => {
  try {
    await col('notifications').updateOne(
      { id: Number(req.params.id), user_id: req.user.id },
      { $set: { read: true, read_at: nowSql() } }
    );
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

// POST /api/notifications/read-all
router.post('/read-all', requireAuth, async (req, res, next) => {
  try {
    await col('notifications').updateMany(
      { user_id: req.user.id, read: false },
      { $set: { read: true, read_at: nowSql() } }
    );
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

// Helper: create a notification (used by other modules)
async function createNotification(userId, { type, title, message }) {
  try {
    const id = await nextId('notifications');
    await col('notifications').insertOne({
      id,
      user_id: userId,
      type: type || 'info',
      title: String(title || '').trim(),
      message: String(message || '').trim(),
      read: false,
      created_at: nowSql(),
    });
  } catch (err) {
    console.error('Failed to create notification:', err);
  }
}

module.exports = { router, createNotification };
