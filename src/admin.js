const express = require('express');
const bcrypt = require('bcrypt');
const { col, nextId, nowSql, publicDoc } = require('./db');
const credits = require('./credits');
const {
  requireAuth, requireOwner, publicUser, normalizeEmail,
  BCRYPT_ROUNDS, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH,
} = require('./auth');
const { destroyUserSessions } = require('./session-store');

const router = express.Router();
router.use(requireAuth, requireOwner);

router.get('/users', async (req, res, next) => {
  try {
    const users = await col('users').find({}).sort({ id: 1 }).toArray();
    const out = [];
    for (const u of users) {
      const usageAgg = await col('call_sessions').aggregate([
        { $match: { user_id: u.id, started_at: { $ne: null } } },
        {
          $group: {
            _id: null,
            sessions: { $sum: 1 },
            paid_sessions: { $sum: { $cond: [{ $eq: ['$billing_kind', 'paid'] }, 1, 0] } },
            trial_sessions: { $sum: { $cond: [{ $eq: ['$billing_kind', 'paid'] }, 0, 1] } },
            last_session: { $max: '$started_at' },
          },
        },
      ]).toArray();
      out.push({
        ...(await publicUser(u)),
        disabled: Boolean(u.disabled),
        account: await credits.accountSummary(u.id),
        usage: usageAgg[0] || { sessions: 0, paid_sessions: 0, trial_sessions: 0, last_session: null },
      });
    }
    res.json({ users: out });
  } catch (err) {
    next(err);
  }
});

router.post('/users', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');
    const quota = Number((req.body && req.body.token_quota) ?? 100000);

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'invalid_email' });
    }
    if (password.length < 10) {
      return res.status(400).json({ error: 'weak_password', message: 'Minimum 10 characters.' });
    }
    if (!Number.isInteger(quota) || quota < 0) {
      return res.status(400).json({ error: 'invalid_quota', message: 'token_quota must be a non-negative integer.' });
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const id = await nextId('users');
    try {
      await col('users').insertOne({
        id,
        email,
        password_hash: hash,
        role: 'member',
        token_quota: quota,
        disabled: 0,
        created_at: nowSql(),
      });
    } catch (err) {
      if (err.code === 11000) return res.status(409).json({ error: 'email_taken' });
      throw err;
    }
    const user = publicDoc(await col('users').findOne({ id }));
    return res.status(201).json({ user: await publicUser(user) });
  } catch (err) {
    return next(err);
  }
});

router.patch('/users/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const user = publicDoc(await col('users').findOne({ id }));
    if (!user) return res.status(404).json({ error: 'not_found' });

    const body = req.body || {};
    const $set = {};

    if (body.disabled !== undefined) {
      if (user.role === 'owner' && body.disabled) {
        return res.status(400).json({ error: 'cannot_disable_owner', message: 'Owners cannot be disabled.' });
      }
      $set.disabled = body.disabled ? 1 : 0;
    }

    if (body.token_quota !== undefined) {
      const quota = Number(body.token_quota);
      if (!Number.isInteger(quota) || quota < 0) {
        return res.status(400).json({ error: 'invalid_quota', message: 'token_quota must be a non-negative integer.' });
      }
      $set.token_quota = quota;
    }

    if (body.role !== undefined) {
      if (!['owner', 'member'].includes(body.role)) {
        return res.status(400).json({ error: 'invalid_role' });
      }
      if (user.role === 'owner' && body.role !== 'owner') {
        const owners = await col('users').countDocuments({ role: 'owner' });
        if (owners <= 1) {
          return res.status(409).json({ error: 'last_owner', message: 'Promote another owner first.' });
        }
      }
      $set.role = body.role;
    }

    if (Object.keys($set).length) {
      await col('users').updateOne({ id }, { $set });
    }
    const updated = publicDoc(await col('users').findOne({ id }));
    return res.json({ user: await publicUser(updated) });
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id/account', async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const user = publicDoc(await col('users').findOne(
      { id: userId },
      { projection: { _id: 0, id: 1, email: 1, role: 1 } }
    ));
    if (!user) return res.status(404).json({ error: 'not_found' });

    const credit_transactions = await col('credit_transactions')
      .find({ user_id: userId })
      .project({ _id: 0, id: 1, type: 1, amount: 1, session_id: 1, usage_minutes: 1, admin_id: 1, reason: 1, created_at: 1 })
      .sort({ id: -1 })
      .limit(200)
      .toArray();
    const trial_transactions = await col('trial_transactions')
      .find({ user_id: userId })
      .project({ _id: 0, id: 1, type: 1, amount: 1, session_id: 1, admin_id: 1, reason: 1, created_at: 1 })
      .sort({ id: -1 })
      .limit(200)
      .toArray();
    const sessions = await col('call_sessions')
      .find({ user_id: userId })
      .project({
        _id: 0, id: 1, company: 1, role: 1, status: 1, billing_kind: 1, plan: 1,
        started_at: 1, ended_at: 1, expires_at: 1, settled_at: 1,
      })
      .sort({ id: -1 })
      .limit(100)
      .toArray();

    res.json({
      user,
      account: await credits.accountSummary(userId),
      credit_transactions,
      trial_transactions,
      sessions,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id/credits', async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    if (!(await col('users').findOne({ id: userId }))) {
      return res.status(404).json({ error: 'not_found' });
    }
    const { action, amount, reason } = req.body || {};
    const value = Number(amount);
    if (!Number.isFinite(value)) {
      return res.status(400).json({ error: 'bad_amount', message: 'amount must be a number.' });
    }
    const opts = { adminId: req.user.id, reason: reason || null };
    let balance;
    if (action === 'grant') balance = await credits.grantCredits(userId, value, opts);
    else if (action === 'refund') balance = await credits.refundCredits(userId, value, opts);
    else if (action === 'adjust') balance = await credits.adjustCredits(userId, value, opts);
    else return res.status(400).json({ error: 'bad_action', message: 'action must be grant, refund or adjust.' });

    res.json({ account: await credits.accountSummary(userId), balance });
  } catch (err) {
    res.status(400).json({ error: 'rejected', message: err.message });
  }
});

router.post('/users/:id/trials', async (req, res) => {
  const userId = Number(req.params.id);
  if (!(await col('users').findOne({ id: userId }))) {
    return res.status(404).json({ error: 'not_found' });
  }
  try {
    await credits.grantTrials(userId, Number(req.body && req.body.count), {
      adminId: req.user.id,
      reason: (req.body && req.body.reason) || null,
    });
    res.json({ account: await credits.accountSummary(userId) });
  } catch (err) {
    res.status(400).json({ error: 'rejected', message: err.message });
  }
});

router.post('/users/:id/password', async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const password = String((req.body && req.body.password) || '');
    const user = publicDoc(await col('users').findOne({ id: userId }));
    if (!user) return res.status(404).json({ error: 'not_found', message: 'No such user.' });

    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: 'weak_password',
        message: `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`,
      });
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await col('users').updateOne({ id: userId }, { $set: { password_hash: hash } });

    const signedOut = await destroyUserSessions(userId);
    if (userId === req.user.id) await new Promise((r) => req.session.save(r));

    return res.json({ ok: true, email: user.email, sessions_ended: signedOut });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
