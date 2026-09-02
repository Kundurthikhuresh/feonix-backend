const express = require('express');
const { col, nextId, nowSql, publicDoc } = require('./db');
const { requireAuth } = require('./auth');

const router = express.Router();

const ALLOWED_FIELDS = [
  'name', 'phone', 'location', 'title', 'bio',
  'linkedin', 'github', 'portfolio',
  'years_experience', 'preferred_roles', 'preferred_locations',
  'skills', 'education_summary',
];

function pickAllowed(body) {
  const out = {};
  for (const key of ALLOWED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      if (Array.isArray(body[key])) {
        out[key] = body[key].map((v) => String(v || '').trim()).filter(Boolean);
      } else {
        out[key] = String(body[key] || '').trim();
      }
    }
  }
  return out;
}

// GET /api/profile — fetch own profile
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const profile = await col('user_profiles').findOne({ user_id: req.user.id });
    const user = publicDoc(await col('users').findOne({ id: req.user.id }));
    res.json({
      profile: {
        email: user.email,
        plan: user.plan || 'free',
        created_at: user.created_at,
        ...(profile ? publicDoc(profile) : {}),
        user_id: req.user.id,
      },
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/profile — update own profile
router.put('/', requireAuth, async (req, res, next) => {
  try {
    const updates = pickAllowed(req.body || {});
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no_fields', message: 'No valid fields to update.' });
    }

    const now = nowSql();
    const existing = await col('user_profiles').findOne({ user_id: req.user.id });
    if (!existing) {
      const id = await nextId('user_profiles');
      await col('user_profiles').insertOne({
        id,
        user_id: req.user.id,
        ...updates,
        created_at: now,
        updated_at: now,
      });
    } else {
      await col('user_profiles').updateOne(
        { user_id: req.user.id },
        { $set: { ...updates, updated_at: now } }
      );
    }

    const profile = publicDoc(await col('user_profiles').findOne({ user_id: req.user.id }));
    const user = publicDoc(await col('users').findOne({ id: req.user.id }));

    return res.json({
      profile: {
        email: user.email,
        plan: user.plan || 'free',
        ...profile,
        user_id: req.user.id,
      },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
