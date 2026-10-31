require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');
const { col, nextId, nowSql, publicDoc } = require('./db');
const credits = require('./credits');
const { getPromotionStatus } = require('./promotions');
const {
  requireAuth, requireOwner, requireAdmin, isDesignatedAdmin, publicUser, normalizeEmail,
  BCRYPT_ROUNDS, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH,
} = require('./auth');
const { destroyUserSessions } = require('./session-store');

const router = express.Router();
// Protect every administrative endpoint: Authentication + Single-Admin Authorization
router.use(requireAuth, requireAdmin);

/**
 * Audit log helper
 */
async function logAudit(adminUser, action, targetId = null, targetEmail = null, details = {}, status = 'success') {
  try {
    const id = await nextId('audit_logs');
    await col('audit_logs').insertOne({
      id,
      admin_id: adminUser?.id || null,
      admin_email: adminUser?.email || 'admin',
      action,
      target_id: targetId ? Number(targetId) : null,
      target_email: targetEmail || null,
      details: details || {},
      status,
      created_at: nowSql(),
    });
  } catch (err) {
    console.error('Audit log write error:', err);
  }
}

/**
 * Helper to get user email by id (with caching)
 */
const userEmailCache = new Map();
async function getUserEmail(userId) {
  if (!userId) return 'Anonymous';
  if (userEmailCache.has(Number(userId))) return userEmailCache.get(Number(userId));
  const u = await col('users').findOne({ id: Number(userId) }, { projection: { email: 1 } });
  const email = u?.email || `User #${userId}`;
  userEmailCache.set(Number(userId), email);
  return email;
}

/**
 * Loads every uncached email for the given user ids in ONE query, so the
 * per-row getUserEmail() calls in the admin tables hit the cache instead of
 * making one database round trip per row (dozens in sequence on a slow link).
 */
async function primeUserEmails(userIds) {
  const missing = [...new Set(userIds.filter(Boolean).map(Number))].filter((id) => !userEmailCache.has(id));
  if (!missing.length) return;
  const rows = await col('users').find({ id: { $in: missing } }, { projection: { id: 1, email: 1 } }).toArray();
  const found = new Map(rows.map((r) => [Number(r.id), r.email]));
  for (const id of missing) userEmailCache.set(id, found.get(id) || `User #${id}`);
}

// --------------------------------------------------------------------------
// 1. GET /api/admin/overview - Dashboard KPIs, Charts, Recent Activity
// --------------------------------------------------------------------------
router.get('/overview', async (req, res, next) => {
  try {
    const { range = '30d', start, end } = req.query;

    let startDate;
    const now = new Date();
    if (start && end) {
      startDate = new Date(start);
    } else if (range === '7d') {
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (range === 'this_month') {
      startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    } else if (range === 'all') {
      startDate = new Date(0);
    } else {
      // 30 days default
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
    const startSql = startDate.toISOString().replace('T', ' ').slice(0, 19);

    // 1. Total Users KPI
    const [totalUsers, newUsersPeriod, activeUsers, disabledUsers] = await Promise.all([
      col('users').countDocuments(),
      col('users').countDocuments({ created_at: { $gte: startSql } }),
      col('users').countDocuments({ disabled: { $ne: 1 } }),
      col('users').countDocuments({ disabled: 1 }),
    ]);

    // 2. AI Sessions KPI & Outcomes
    const [
      totalSessions,
      completedSessions,
      inProgressSessions,
      failedSessions,
      newSessionsPeriod,
    ] = await Promise.all([
      col('call_sessions').countDocuments(),
      col('call_sessions').countDocuments({ status: 'ended' }),
      col('call_sessions').countDocuments({ status: { $in: ['active', 'answering', 'listening', 'ready'] } }),
      col('call_sessions').countDocuments({ status: 'failed' }),
      col('call_sessions').countDocuments({ created_at: { $gte: startSql } }),
    ]);

    // 3. Transcriptions KPI
    const [totalTranscriptions, newTranscriptionsPeriod] = await Promise.all([
      col('transcript_lines').countDocuments(),
      col('transcript_lines').countDocuments({ created_at: { $gte: startSql } }),
    ]);

    // 4. Credits Consumed KPI
    const [trialConsumedAgg, creditConsumedAgg, allUsers] = await Promise.all([
      col('trial_transactions').aggregate([
        { $match: { type: 'TRIAL_CONSUMED' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]).toArray(),
      col('credit_transactions').aggregate([
        { $match: { type: 'CONSUME' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]).toArray(),
      col('users').find({}, { projection: { id: 1 } }).toArray(),
    ]);

    const totalTrialsUsed = trialConsumedAgg[0] ? Math.abs(trialConsumedAgg[0].total) : 0;
    const totalCreditsUsed = creditConsumedAgg[0] ? Math.abs(creditConsumedAgg[0].total) : 0;
    const creditsConsumed = Math.round(totalCreditsUsed * 10) / 10;
    const trialsConsumed = Math.round(totalTrialsUsed);

    // Remaining allocation across all users — fetched in parallel, not one
    // user after another.
    const balances = await Promise.all(allUsers.map((u) => credits.creditBalance(u.id).catch(() => 0)));
    let totalCreditsRemaining = balances.reduce((n, b) => n + (Number(b) || 0), 0);
    totalCreditsRemaining = Math.round(totalCreditsRemaining * 10) / 10;
    const totalAllocation = creditsConsumed + totalCreditsRemaining;
    const creditPercent = totalAllocation > 0 ? Math.min(100, Math.round((creditsConsumed / totalAllocation) * 100)) : 0;

    // 5. Session Outcomes Donut
    const otherSessions = Math.max(0, totalSessions - completedSessions - inProgressSessions - failedSessions);
    const completedPct = totalSessions > 0 ? Math.round((completedSessions / totalSessions) * 100) : 0;
    const inProgressPct = totalSessions > 0 ? Math.round((inProgressSessions / totalSessions) * 100) : 0;
    const failedPct = totalSessions > 0 ? Math.max(0, 100 - completedPct - inProgressPct) : 0;

    const sessionOutcomes = {
      total: totalSessions,
      completed: completedSessions,
      completed_pct: completedPct,
      in_progress: inProgressSessions,
      in_progress_pct: inProgressPct,
      failed: failedSessions + otherSessions,
      failed_pct: failedPct,
    };

    // 6. AI Usage Over Time (Answers, Transcriptions, Vision/Screens)
    // Daily buckets for chart
    const daysCount = range === '7d' ? 7 : 14;
    const dateBuckets = [];
    for (let i = daysCount - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateKey = d.toISOString().slice(0, 10);
      const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      dateBuckets.push({ key: dateKey, label, answers: 0, transcriptions: 0, screenshots: 0, total: 0 });
    }

    const bucketMap = new Map(dateBuckets.map((b) => [b.key, b]));

    // Daily answers / transcription lines / usage rows, plus the all-time
    // totals — independent queries, so they run together.
    const byDay = [
      { $match: { created_at: { $gte: dateBuckets[0].key } } },
      { $project: { day: { $substr: ['$created_at', 0, 10] } } },
      { $group: { _id: '$day', count: { $sum: 1 } } },
    ];
    const [answersAgg, transAgg, visionAgg, totalAiRequests, totalAnswers] = await Promise.all([
      col('answers').aggregate(byDay).toArray(),
      col('transcript_lines').aggregate(byDay).toArray(),
      col('usage').aggregate(byDay).toArray(),
      col('usage').countDocuments(),
      col('answers').countDocuments(),
    ]);

    answersAgg.forEach((r) => {
      if (bucketMap.has(r._id)) {
        bucketMap.get(r._id).answers = r.count;
      }
    });

    transAgg.forEach((r) => {
      if (bucketMap.has(r._id)) {
        bucketMap.get(r._id).transcriptions = r.count;
      }
    });

    visionAgg.forEach((r) => {
      if (bucketMap.has(r._id)) {
        bucketMap.get(r._id).screenshots = Math.round(r.count / 2); // approximate cues/shots
      }
    });

    dateBuckets.forEach((b) => {
      b.total = b.answers + b.transcriptions + b.screenshots;
    });

    // 7. Platform Activity (Total AI requests)
    const platformActivityTotal = totalAiRequests > 0 ? totalAiRequests : (totalAnswers + totalTranscriptions);

    // 8. Recent Activities Table
    const [recentAnswers, recentSessionsList, recentDocs, recentUsersList] = await Promise.all([
      col('answers').find({}).sort({ _id: -1 }).limit(8).toArray(),
      col('call_sessions').find({}).sort({ _id: -1 }).limit(8).toArray(),
      col('documents').find({}).sort({ _id: -1 }).limit(8).toArray(),
      col('users').find({}).sort({ _id: -1 }).limit(5).toArray(),
    ]);
    await primeUserEmails([...recentAnswers, ...recentSessionsList, ...recentDocs].map((r) => r.user_id));

    const activityList = [];

    for (const a of recentAnswers) {
      activityList.push({
        id: `ans-${a.id || a._id}`,
        user: await getUserEmail(a.user_id),
        activity: 'AI answer generated',
        type: 'answer',
        credits: 1,
        status: 'Completed',
        timestamp: a.created_at,
      });
    }

    for (const s of recentSessionsList) {
      activityList.push({
        id: `sess-${s.id || s._id}`,
        user: await getUserEmail(s.user_id),
        activity: `Call session (${s.company || 'Practice'})`,
        type: 'session',
        credits: s.billing_kind === 'paid' ? 2 : 1,
        status: s.status === 'ended' ? 'Completed' : 'In progress',
        timestamp: s.created_at,
      });
    }

    for (const d of recentDocs) {
      activityList.push({
        id: `doc-${d.id || d._id}`,
        user: await getUserEmail(d.user_id),
        activity: `${d.kind === 'resume' ? 'Resume' : 'Document'} upload`,
        type: 'document',
        credits: 0,
        status: 'Completed',
        timestamp: d.created_at,
      });
    }

    for (const u of recentUsersList) {
      activityList.push({
        id: `user-${u.id || u._id}`,
        user: u.email,
        activity: 'New user registered',
        type: 'user',
        credits: 0,
        status: 'Active',
        timestamp: u.created_at,
      });
    }

    activityList.sort((a, b) => (String(b.timestamp) > String(a.timestamp) ? 1 : -1));
    const recentUserActivity = activityList.slice(0, 7);

    // 9. Recent Sessions Table
    const recentSessionsDetailed = [];
    for (const s of recentSessionsList.slice(0, 5)) {
      let durationStr = '—';
      if (s.started_at && s.ended_at) {
        const startMs = Date.parse(String(s.started_at).replace(' ', 'T') + 'Z');
        const endMs = Date.parse(String(s.ended_at).replace(' ', 'T') + 'Z');
        if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
          const secs = Math.max(0, Math.round((endMs - startMs) / 1000));
          const m = Math.floor(secs / 60);
          const sc = secs % 60;
          durationStr = `${m}m ${sc}s`;
        }
      } else if (s.started_at) {
        durationStr = 'In progress';
      }

      recentSessionsDetailed.push({
        id: s.id,
        sessionId: `FS-${s.id || s._id}`,
        company: s.company || 'Unnamed Call',
        role: s.role || '—',
        type: s.mode ? s.mode.charAt(0).toUpperCase() + s.mode.slice(1) : 'Interview',
        duration: durationStr,
        status: s.status === 'ended' ? 'Completed' : s.status === 'failed' ? 'Failed' : 'In progress',
        user: await getUserEmail(s.user_id),
        date: s.created_at,
      });
    }

    res.json({
      kpis: {
        total_users: totalUsers,
        new_users_period: newUsersPeriod,
        active_users: activeUsers,
        disabled_users: disabledUsers,
        total_sessions: totalSessions,
        completed_sessions: completedSessions,
        in_progress_sessions: inProgressSessions,
        new_sessions_period: newSessionsPeriod,
        total_transcriptions: totalTranscriptions,
        new_transcriptions_period: newTranscriptionsPeriod,
        credits_consumed: creditsConsumed,
        trials_consumed: trialsConsumed,
        credits_remaining: totalCreditsRemaining,
        credit_allocation_percentage: creditPercent,
      },
      session_outcomes: sessionOutcomes,
      ai_usage_trend: dateBuckets,
      platform_activity: {
        total_requests: platformActivityTotal,
        chart_points: dateBuckets.map((b) => ({ label: b.label, count: b.total })),
      },
      recent_user_activity: recentUserActivity,
      recent_sessions: recentSessionsDetailed,
    });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------------
// 2. GET /api/admin/users - User Management (Fixes NaN credits!)
// --------------------------------------------------------------------------
router.get('/users', async (req, res, next) => {
  try {
    const { search = '', status = 'all', page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const query = {};
    if (search.trim()) {
      query.email = { $regex: search.trim(), $options: 'i' };
    }
    if (status === 'active') {
      query.disabled = { $ne: 1 };
    } else if (status === 'suspended' || status === 'disabled') {
      query.disabled = 1;
    }

    const [totalMatching, rawUsers] = await Promise.all([
      col('users').countDocuments(query),
      col('users').find(query).sort({ id: -1 }).skip(skip).limit(limitNum).toArray(),
    ]);

    // Each user's figures are independent, so they are fetched in parallel —
    // one after another this took ~2 round trips per user in sequence.
    const users = await Promise.all(rawUsers.map(async (u) => {
      const [usageAgg, account, pub] = await Promise.all([col('call_sessions').aggregate([
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
      ]).toArray(), credits.accountSummary(u.id), publicUser(u)]);

      const safeCredits = typeof account.credits === 'number' && !isNaN(account.credits) ? account.credits : 0;
      const safeTrials = typeof account.trials_remaining === 'number' && !isNaN(account.trials_remaining) ? account.trials_remaining : 0;
      const sessionsCount = usageAgg[0]?.sessions || 0;

      return {
        ...pub,
        disabled: Boolean(u.disabled),
        account,
        plan: u.plan || (isDesignatedAdmin(u) ? 'owner' : 'free'),
        subscription_status: u.subscription_status || null,
        unlimited_sessions: Boolean(u.unlimited_sessions),
        // Top-level numeric values guaranteeing NO NaN on frontend:
        credits_remaining: safeCredits,
        trials_remaining: safeTrials,
        sessions_count: sessionsCount,
        usage: usageAgg[0] || { sessions: 0, paid_sessions: 0, trial_sessions: 0, last_session: null },
      };
    }));

    res.json({
      users,
      pagination: {
        total: totalMatching,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(totalMatching / limitNum) || 1,
      },
    });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------------
// 3. POST /api/admin/users - Create User
// --------------------------------------------------------------------------
router.post('/users', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');
    const quota = Number((req.body && req.body.token_quota) ?? 100000);

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'invalid_email', message: 'Enter a valid email address.' });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: 'weak_password', message: `Minimum ${MIN_PASSWORD_LENGTH} characters.` });
    }
    if (!Number.isInteger(quota) || quota < 0) {
      return res.status(400).json({ error: 'invalid_quota', message: 'token_quota must be a non-negative integer.' });
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const id = await nextId('users');
    const role = isDesignatedAdmin({ email }) ? 'owner' : 'member';

    try {
      await col('users').insertOne({
        id,
        email,
        password_hash: hash,
        role,
        token_quota: quota,
        disabled: 0,
        created_at: nowSql(),
      });
    } catch (err) {
      if (err.code === 11000) return res.status(409).json({ error: 'email_taken', message: 'That email is already registered.' });
      throw err;
    }

    await logAudit(req.user, 'USER_CREATE', id, email, { quota, role });
    const user = publicDoc(await col('users').findOne({ id }));
    return res.status(201).json({ user: await publicUser(user) });
  } catch (err) {
    return next(err);
  }
});

// --------------------------------------------------------------------------
// 4. PATCH /api/admin/users/:id - Update User (Status, Quota, Role)
// --------------------------------------------------------------------------
router.patch('/users/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const user = publicDoc(await col('users').findOne({ id }));
    if (!user) return res.status(404).json({ error: 'not_found' });

    const body = req.body || {};
    const $set = {};

    if (body.disabled !== undefined) {
      if (isDesignatedAdmin(user) && body.disabled) {
        return res.status(400).json({ error: 'cannot_disable_admin', message: 'The designated administrator cannot be suspended.' });
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
      // Only the designated admin can be owner
      if (body.role === 'owner' && !isDesignatedAdmin(user)) {
        return res.status(403).json({ error: 'forbidden', message: 'Only the designated administrator email can have the owner role.' });
      }
      $set.role = body.role;
    }

    if (body.plan !== undefined) {
      $set.plan = String(body.plan).trim();
    }

    if (Object.keys($set).length) {
      await col('users').updateOne({ id }, { $set });
      const actionName = body.disabled !== undefined
        ? (body.disabled ? 'USER_SUSPEND' : 'USER_ACTIVATE')
        : 'USER_UPDATE';
      await logAudit(req.user, actionName, id, user.email, $set);
    }

    const updated = publicDoc(await col('users').findOne({ id }));
    return res.json({ user: await publicUser(updated) });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------------
// 5. GET /api/admin/users/:id/account - User Account & Ledger Details
// --------------------------------------------------------------------------
router.get('/users/:id/account', async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const user = publicDoc(await col('users').findOne(
      { id: userId },
      { projection: { _id: 0, id: 1, email: 1, role: 1, disabled: 1, created_at: 1 } }
    ));
    if (!user) return res.status(404).json({ error: 'not_found' });

    const [credit_transactions, trial_transactions, sessions, account] = await Promise.all([
      col('credit_transactions')
        .find({ user_id: userId })
        .project({ _id: 0, id: 1, type: 1, amount: 1, session_id: 1, usage_minutes: 1, admin_id: 1, reason: 1, created_at: 1 })
        .sort({ id: -1 })
        .limit(200)
        .toArray(),
      col('trial_transactions')
        .find({ user_id: userId })
        .project({ _id: 0, id: 1, type: 1, amount: 1, session_id: 1, admin_id: 1, reason: 1, created_at: 1 })
        .sort({ id: -1 })
        .limit(200)
        .toArray(),
      col('call_sessions')
        .find({ user_id: userId })
        .project({
          _id: 0, id: 1, company: 1, role: 1, status: 1, billing_kind: 1, plan: 1,
          started_at: 1, ended_at: 1, expires_at: 1, settled_at: 1, created_at: 1,
        })
        .sort({ id: -1 })
        .limit(100)
        .toArray(),
      credits.accountSummary(userId),
    ]);

    res.json({
      user,
      account,
      // Provide clean numbers for frontend dialog
      credits_remaining: typeof account.credits === 'number' ? account.credits : 0,
      credits_used: typeof account.credits_used === 'number' ? account.credits_used : 0,
      trials_remaining: typeof account.trials_remaining === 'number' ? account.trials_remaining : 0,
      credit_transactions,
      trial_transactions,
      sessions,
    });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------------
// 6. POST /api/admin/users/:id/credits - Adjust Credits Ledger
// --------------------------------------------------------------------------
router.post('/users/:id/credits', async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const user = await col('users').findOne({ id: userId });
    if (!user) return res.status(404).json({ error: 'not_found' });

    const { action, amount, reason } = req.body || {};
    const value = Number(amount);
    if (!Number.isFinite(value)) {
      return res.status(400).json({ error: 'bad_amount', message: 'amount must be a valid number.' });
    }

    const opts = { adminId: req.user.id, reason: reason || null };
    let balance;
    if (action === 'grant') balance = await credits.grantCredits(userId, value, opts);
    else if (action === 'refund') balance = await credits.refundCredits(userId, value, opts);
    else if (action === 'adjust') balance = await credits.adjustCredits(userId, value, opts);
    else return res.status(400).json({ error: 'bad_action', message: 'action must be grant, refund or adjust.' });

    await logAudit(req.user, `CREDIT_${action.toUpperCase()}`, userId, user.email, { amount: value, reason, new_balance: balance });
    res.json({ account: await credits.accountSummary(userId), balance });
  } catch (err) {
    res.status(400).json({ error: 'rejected', message: err.message });
  }
});

// --------------------------------------------------------------------------
// 7. POST /api/admin/users/:id/trials - Grant Free Trials
// --------------------------------------------------------------------------
router.post('/users/:id/trials', async (req, res) => {
  const userId = Number(req.params.id);
  const user = await col('users').findOne({ id: userId });
  if (!user) return res.status(404).json({ error: 'not_found' });

  try {
    const count = Number(req.body && req.body.count);
    const reason = (req.body && req.body.reason) || null;
    await credits.grantTrials(userId, count, { adminId: req.user.id, reason });

    await logAudit(req.user, 'GRANT_TRIALS', userId, user.email, { count, reason });
    res.json({ account: await credits.accountSummary(userId) });
  } catch (err) {
    res.status(400).json({ error: 'rejected', message: err.message });
  }
});

// --------------------------------------------------------------------------
// 8. POST /api/admin/users/:id/password - Reset User Password
// --------------------------------------------------------------------------
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

    await logAudit(req.user, 'PASSWORD_RESET', userId, user.email, { sessions_invalidated: signedOut });
    return res.json({ ok: true, email: user.email, sessions_ended: signedOut });
  } catch (err) {
    return next(err);
  }
});

// --------------------------------------------------------------------------
// 9. GET /api/admin/sessions - All Platform Call Sessions
// --------------------------------------------------------------------------
router.get('/sessions', async (req, res, next) => {
  try {
    const { search = '', status = 'all', page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const query = {};
    if (status !== 'all') {
      if (status === 'ended') query.status = 'ended';
      else if (status === 'active') query.status = { $in: ['active', 'answering', 'listening'] };
      else if (status === 'ready') query.status = 'ready';
    }
    if (search.trim()) {
      query.$or = [
        { company: { $regex: search.trim(), $options: 'i' } },
        { role: { $regex: search.trim(), $options: 'i' } },
      ];
    }

    const [total, rawSessions] = await Promise.all([
      col('call_sessions').countDocuments(query),
      col('call_sessions').find(query).sort({ id: -1 }).skip(skip).limit(limitNum).toArray(),
    ]);

    await primeUserEmails(rawSessions.map((s) => s.user_id));
    const sessions = [];
    for (const s of rawSessions) {
      const [answersCount, linesCount] = await Promise.all([
        col('answers').countDocuments({ session_id: s.id }),
        col('transcript_lines').countDocuments({ session_id: s.id }),
      ]);

      let durationStr = '—';
      if (s.started_at && s.ended_at) {
        const startMs = Date.parse(String(s.started_at).replace(' ', 'T') + 'Z');
        const endMs = Date.parse(String(s.ended_at).replace(' ', 'T') + 'Z');
        if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
          const secs = Math.max(0, Math.round((endMs - startMs) / 1000));
          const m = Math.floor(secs / 60);
          const sc = secs % 60;
          durationStr = `${m}m ${sc}s`;
        }
      } else if (s.started_at) {
        durationStr = 'Live';
      }

      sessions.push({
        id: s.id,
        sessionId: `FS-${s.id}`,
        user_id: s.user_id,
        user_email: await getUserEmail(s.user_id),
        company: s.company || 'Unnamed Call',
        role: s.role || '—',
        mode: s.mode || 'interview',
        status: s.status || 'ready',
        duration: durationStr,
        billing_kind: s.billing_kind || 'trial',
        answers_count: answersCount,
        lines_count: linesCount,
        created_at: s.created_at,
        started_at: s.started_at,
        ended_at: s.ended_at,
      });
    }

    res.json({
      sessions,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------------
// 10. GET /api/admin/ai-usage - LLM & AI Usage Metrics
// --------------------------------------------------------------------------
router.get('/ai-usage', async (req, res, next) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const excludedModels = ['whisper-1', 'gpt-4o-mini-transcribe'];
    const modelFilter = { model: { $nin: excludedModels } };

    const [total, rawUsage, modelBreakdown] = await Promise.all([
      col('usage').countDocuments(modelFilter),
      col('usage').find(modelFilter).sort({ id: -1 }).skip(skip).limit(limitNum).toArray(),
      col('usage').aggregate([
        { $match: modelFilter },
        {
          $group: {
            _id: '$model',
            requests: { $sum: 1 },
            prompt_tokens: { $sum: '$prompt_tokens' },
            output_tokens: { $sum: '$output_tokens' },
          },
        },
      ]).toArray(),
    ]);

    await primeUserEmails(rawUsage.map((u) => u.user_id));
    const usageList = [];
    for (const u of rawUsage) {
      usageList.push({
        id: u.id,
        user_id: u.user_id,
        user_email: await getUserEmail(u.user_id),
        model: u.model || 'gpt-4o-mini',
        prompt_tokens: u.prompt_tokens || 0,
        output_tokens: u.output_tokens || 0,
        total_tokens: (u.prompt_tokens || 0) + (u.output_tokens || 0),
        session_id: u.session_id,
        created_at: u.created_at,
      });
    }

    res.json({
      usage: usageList,
      models: modelBreakdown
        .filter((m) => m._id && !excludedModels.includes(m._id))
        .map((m) => ({
          model: m._id || 'unknown',
          requests: m.requests,
          prompt_tokens: m.prompt_tokens,
          output_tokens: m.output_tokens,
          total_tokens: m.prompt_tokens + m.output_tokens,
        })),
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------------
// 11. GET /api/admin/transcriptions - Transcriptions Overview
// --------------------------------------------------------------------------
router.get('/transcriptions', async (req, res, next) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const [total, rawLines] = await Promise.all([
      col('transcript_lines').countDocuments(),
      col('transcript_lines').find({}).sort({ id: -1 }).skip(skip).limit(limitNum).toArray(),
    ]);

    const lines = [];
    for (const l of rawLines) {
      let sessionCompany = '—';
      if (l.session_id) {
        const s = await col('call_sessions').findOne({ id: l.session_id }, { projection: { company: 1 } });
        if (s?.company) sessionCompany = s.company;
      }

      lines.push({
        id: l.id,
        session_id: l.session_id,
        company: sessionCompany,
        speaker: l.speaker || (l.is_question ? 'Interviewer' : 'Candidate'),
        is_question: Boolean(l.is_question),
        text: l.text,
        created_at: l.created_at,
      });
    }

    res.json({
      transcriptions: lines,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------------
// 12. GET /api/admin/documents - Resumes & Documents
// --------------------------------------------------------------------------
router.get('/documents', async (req, res, next) => {
  try {
    const { kind = 'all', page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const query = {};
    if (kind !== 'all') {
      query.kind = kind;
    }

    const [total, rawDocs] = await Promise.all([
      col('documents').countDocuments(query),
      col('documents').find(query).sort({ id: -1 }).skip(skip).limit(limitNum).toArray(),
    ]);

    await primeUserEmails(rawDocs.map((d) => d.user_id));
    const docs = [];
    for (const d of rawDocs) {
      docs.push({
        id: d.id,
        user_id: d.user_id,
        user_email: await getUserEmail(d.user_id),
        kind: d.kind,
        filename: d.filename,
        source: d.source || 'uploaded',
        is_active: Boolean(d.is_active),
        chars: String(d.content || '').length,
        created_at: d.created_at,
      });
    }

    res.json({
      documents: docs,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------------
// 13. GET /api/admin/credits-trials - Unified Credit & Trial Ledger
// --------------------------------------------------------------------------
router.get('/credits-trials', async (req, res, next) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const [creditTxs, trialTxs] = await Promise.all([
      col('credit_transactions').find({}).sort({ id: -1 }).limit(100).toArray(),
      col('trial_transactions').find({}).sort({ id: -1 }).limit(100).toArray(),
    ]);

    await primeUserEmails([...creditTxs, ...trialTxs].map((x) => x.user_id));
    const combined = [];
    for (const c of creditTxs) {
      combined.push({
        id: `c-${c.id}`,
        type: c.type,
        ledger: 'Credits',
        amount: c.amount,
        user_id: c.user_id,
        user_email: await getUserEmail(c.user_id),
        admin_id: c.admin_id,
        session_id: c.session_id,
        reason: c.reason || 'Credit transaction',
        created_at: c.created_at,
      });
    }

    for (const t of trialTxs) {
      combined.push({
        id: `t-${t.id}`,
        type: t.type,
        ledger: 'Trials',
        amount: t.amount,
        user_id: t.user_id,
        user_email: await getUserEmail(t.user_id),
        admin_id: t.admin_id,
        session_id: t.session_id,
        reason: t.reason || 'Trial transaction',
        created_at: t.created_at,
      });
    }

    combined.sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
    const paginated = combined.slice(skip, skip + limitNum);

    res.json({
      transactions: paginated,
      pagination: {
        total: combined.length,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(combined.length / limitNum) || 1,
      },
    });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------------
// 14. GET /api/admin/subscriptions - Subscriptions & Razorpay Transactions
// --------------------------------------------------------------------------
router.get('/subscriptions', async (req, res, next) => {
  try {
    const proPrice = Number(process.env.RAZORPAY_PRO_AMOUNT_PAISE || 49900) / 100;
    const premiumPrice = Number(process.env.RAZORPAY_PREMIUM_AMOUNT_PAISE || 99900) / 100;

    const paidUsersCount = await col('users').countDocuments({ role: 'owner' });

    res.json({
      plans: [
        { id: 'free', name: 'Free Trial', price: 0, sessions: 5, active_users: 15 },
        { id: 'pro', name: 'Professional', price: proPrice, sessions: 25, active_users: paidUsersCount },
        { id: 'premium', name: 'Enterprise', price: premiumPrice, sessions: 'Unlimited', active_users: 0 },
      ],
      razorpay_configured: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
    });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------------
// 15. GET /api/admin/audit-logs - Audit Logs
// --------------------------------------------------------------------------
router.get('/audit-logs', async (req, res, next) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const [total, logs] = await Promise.all([
      col('audit_logs').countDocuments(),
      col('audit_logs').find({}).sort({ id: -1 }).skip(skip).limit(limitNum).toArray(),
    ]);

    res.json({
      logs: logs.map(publicDoc),
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (err) {
    next(err);
  }
});

// OpenAI pricing reference rates (per 1,000,000 tokens in USD)
const AI_MODEL_RATES = {
  'gpt-4o-mini': { prompt: 0.15, output: 0.60 },
  'gpt-4.1-mini': { prompt: 0.40, output: 1.60 },
  'gpt-4o': { prompt: 2.50, output: 10.00 },
  'gpt-4': { prompt: 30.00, output: 60.00 },
  'whisper-1': { prompt: 0.50, output: 1.50, perMinuteUsd: 0.006 },
  'gpt-4o-mini-transcribe': { prompt: 0.15, output: 0.60 },
};
const USD_INR_CONVERSION_RATE = 84.00; // 1 USD = 84 INR standard conversion

const AUDIT_PLAN_CONFIG = {
  pro: 499,
  premium: 999,
  sub_weekly: 2490,
  sub_monthly: 4735,
  sub_yearly: 18950,
  pack_1: 1180,
  pack_3: 1845,
  pack_6: 3690,
  pack_9: 5535,
};

function parsePlanAmount(reason = '', userPlan = null) {
  const r = String(reason).toLowerCase();
  if (r.includes('9 + 6') || r.includes('pack_9') || r.includes('88.50')) return AUDIT_PLAN_CONFIG.pack_9;
  if (r.includes('6 credits') || r.includes('pack_6') || r.includes('59')) return AUDIT_PLAN_CONFIG.pack_6;
  if (r.includes('3 credits') || r.includes('pack_3') || r.includes('29.50')) return AUDIT_PLAN_CONFIG.pack_3;
  if (r.includes('1 credit') || r.includes('pack_1') || r.includes('19')) return AUDIT_PLAN_CONFIG.pack_1;
  if (r.includes('yearly') || r.includes('299.95')) return AUDIT_PLAN_CONFIG.sub_yearly;
  if (r.includes('monthly') || r.includes('74.95')) return AUDIT_PLAN_CONFIG.sub_monthly;
  if (r.includes('weekly') || r.includes('39')) return AUDIT_PLAN_CONFIG.sub_weekly;
  if (r.includes('premium')) return AUDIT_PLAN_CONFIG.premium;
  if (r.includes('pro')) return AUDIT_PLAN_CONFIG.pro;
  if (userPlan && AUDIT_PLAN_CONFIG[userPlan]) return AUDIT_PLAN_CONFIG[userPlan];
  return 0;
}

function calcAiUsageCost(model, promptTokens = 0, outputTokens = 0) {
  const m = String(model || 'gpt-4o-mini').toLowerCase();
  let rates = AI_MODEL_RATES['gpt-4o-mini'];
  if (m.includes('transcribe')) {
    rates = AI_MODEL_RATES['gpt-4o-mini-transcribe'];
  } else if (m.includes('4.1-mini')) {
    rates = AI_MODEL_RATES['gpt-4.1-mini'];
  } else if (m.includes('mini')) {
    rates = AI_MODEL_RATES['gpt-4o-mini'];
  } else if (m.includes('4o') || m.includes('gpt-4')) {
    rates = AI_MODEL_RATES['gpt-4o'];
  } else if (m.includes('whisper') || m.includes('transcribe')) {
    rates = AI_MODEL_RATES['whisper-1'];
  }

  const promptCostUsd = (Number(promptTokens) || 0) * (rates.prompt / 1000000);
  const outputCostUsd = (Number(outputTokens) || 0) * (rates.output / 1000000);
  const totalCostUsd = promptCostUsd + outputCostUsd;
  const totalCostInr = totalCostUsd * USD_INR_CONVERSION_RATE;

  return { totalCostUsd, totalCostInr };
}

function parseAuditDateRange(range = 'all', startDate = null, endDate = null) {
  const now = new Date();
  let since = null;
  let until = null;

  if (range === '7d') {
    since = new Date(now.getTime() - 7 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  } else if (range === '30d') {
    since = new Date(now.getTime() - 30 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  } else if (range === '90d') {
    since = new Date(now.getTime() - 90 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  } else if (range === 'custom') {
    if (startDate) since = new Date(startDate).toISOString().replace('T', ' ').slice(0, 19);
    if (endDate) {
      const endD = new Date(endDate);
      endD.setHours(23, 59, 59, 999);
      until = endD.toISOString().replace('T', ' ').slice(0, 19);
    }
  }
  return { since, until };
}

// --------------------------------------------------------------------------
// 15b. GET /api/admin/audit-analytics - Comprehensive Financial & User Audit
// --------------------------------------------------------------------------
// The audit page reads eight collections over a slow database link, so a
// finished report is kept briefly: a repeat visit is answered at once and,
// once it is a little old, refreshed in the background for the next one.
const AUDIT_FRESH_MS = 15 * 1000;
const AUDIT_STALE_MS = 10 * 60 * 1000;
const auditCache = new Map(); // query key -> { at, data, pending }

router.get('/audit-analytics', async (req, res, next) => {
  try {
    const key = JSON.stringify(req.query || {});
    const hit = auditCache.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    const refresh = () => {
      if (hit && hit.pending) return hit.pending;
      const pending = buildAuditAnalytics(req.query || {})
        .then((data) => { auditCache.set(key, { at: Date.now(), data }); return data; })
        .catch((err) => { if (hit) hit.pending = null; throw err; });
      if (hit) hit.pending = pending;
      return pending;
    };
    if (hit && hit.data && age < AUDIT_STALE_MS) {
      if (age >= AUDIT_FRESH_MS) refresh().catch(() => {});
      return res.json(hit.data);
    }
    if (auditCache.size > 200) auditCache.clear();
    res.json(await refresh());
  } catch (err) {
    next(err);
  }
});

async function buildAuditAnalytics(query) {
    const {
      range = 'all',
      start_date = null,
      end_date = null,
      search = '',
      status = 'all',
      sort_by = 'net_profit_loss',
      sort_order = 'desc',
      page = 1,
      limit = 25,
    } = query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const skip = (pageNum - 1) * limitNum;

    const { since, until } = parseAuditDateRange(range, start_date, end_date);

    // Build date filters for queries
    const dateMatch = {};
    if (since || until) {
      dateMatch.created_at = {};
      if (since) dateMatch.created_at.$gte = since;
      if (until) dateMatch.created_at.$lte = until;
    }

    const redemptionDateMatch = {};
    if (since || until) {
      redemptionDateMatch.redeemed_at = {};
      if (since) redemptionDateMatch.redeemed_at.$gte = since;
      if (until) redemptionDateMatch.redeemed_at.$lte = until;
    }

    // 1. Fetch Users query
    const userQuery = {};
    if (search.trim()) {
      userQuery.email = { $regex: search.trim(), $options: 'i' };
    }
    if (status === 'active') {
      userQuery.disabled = { $ne: 1 };
    } else if (status === 'suspended') {
      userQuery.disabled = 1;
    } else if (status === 'paid') {
      userQuery.$or = [
        { plan: { $in: ['pro', 'premium', 'sub_weekly', 'sub_monthly', 'sub_yearly', 'pack_1', 'pack_3', 'pack_6', 'pack_9'] } },
        { subscription_status: 'active' },
      ];
    } else if (status === 'free') {
      userQuery.$and = [
        { plan: { $nin: ['pro', 'premium', 'sub_weekly', 'sub_monthly', 'sub_yearly', 'pack_1', 'pack_3', 'pack_6', 'pack_9'] } },
        { subscription_status: { $ne: 'active' } },
      ];
    }

    // Every read below is independent, so they all go to the database at
    // once instead of one after another. Balances and trials for all users
    // come from two grouped totals rather than three lookups per user.
    const [
      allUsers, redemptions, completedOrders, paidCreditTxns,
      usageRows, callSessionsList, trialTxList, paidTxList,
      balanceRows, trialRows,
    ] = await Promise.all([
      col('users').find(userQuery).toArray(),
      col('promotion_redemptions').find(redemptionDateMatch).toArray(),
      col('pending_orders').find({
        ...dateMatch,
        $or: [{ status: 'completed' }, { payment_id: { $ne: null } }],
      }).toArray(),
      col('credit_transactions').find({
        ...dateMatch,
        type: 'GRANT',
        reason: { $regex: /Razorpay|purchase|plan|pack|credits/i },
      }).toArray(),
      col('usage').find({ ...dateMatch }).toArray(),
      col('call_sessions').find(dateMatch).toArray(),
      col('trial_transactions').find({ ...dateMatch, type: 'TRIAL_CONSUMED' }).toArray(),
      col('credit_transactions').find({ ...dateMatch, type: 'CONSUME' }).toArray(),
      col('credit_transactions').aggregate([
        { $group: { _id: '$user_id', bal: { $sum: '$amount' } } },
      ]).toArray(),
      col('trial_transactions').aggregate([
        { $match: { type: { $in: ['TRIAL_CONSUMED', 'TRIAL_GRANTED'] } } },
        { $group: {
          _id: '$user_id',
          used: { $sum: { $cond: [{ $eq: ['$type', 'TRIAL_CONSUMED'] }, { $abs: '$amount' }, 0] } },
          granted: { $sum: { $cond: [{ $eq: ['$type', 'TRIAL_GRANTED'] }, '$amount', 0] } },
        } },
      ]).toArray(),
    ]);
    const existingUserMap = new Map(allUsers.map((u) => [Number(u.id), u]));
    const balanceMap = new Map(balanceRows.map((r) => [Number(r._id), Number(r.bal) || 0]));
    const trialMap = new Map(trialRows.map((r) => [Number(r._id), r]));

    // Build deduplicated payment revenue map per user
    const userRevenueMap = new Map();
    const seenPaymentKeys = new Set();
    let totalRevenue = 0;
    let totalTransactions = 0;

    const recordUserPayment = (userId, amount, key) => {
      const uId = Number(userId);
      if (!uId || !(amount > 0)) return;
      if (!existingUserMap.has(uId)) return; // Only count verified registered users
      if (key && seenPaymentKeys.has(key)) return;
      if (key) seenPaymentKeys.add(key);

      const cur = userRevenueMap.get(uId) || 0;
      userRevenueMap.set(uId, cur + amount);
      totalRevenue += amount;
      totalTransactions += 1;
    };

    // a. Redemptions
    for (const r of redemptions) {
      const amt = Number(r.final_amount) || 0;
      const key = r.payment_id || `redemption_${r.id}`;
      recordUserPayment(r.user_id, amt, key);
    }

    // b. Completed Orders
    for (const o of completedOrders) {
      const amt = (Number(o.final_amount_paise) || 0) / 100;
      const key = o.payment_id || o.order_id || `order_${o.id}`;
      recordUserPayment(o.user_id, amt, key);
    }

    // c. Paid credit transactions (matches exact plan prices)
    for (const ctx of paidCreditTxns) {
      const key = ctx.reason || `ctx_${ctx.id}`;
      const payMatch = (ctx.reason || '').match(/\(pay_([a-zA-Z0-9_]+)\)/);
      const payKey = payMatch ? `pay_${payMatch[1]}` : key;
      if (!seenPaymentKeys.has(payKey)) {
        const u = existingUserMap.get(Number(ctx.user_id));
        const planAmt = parsePlanAmount(ctx.reason, u?.plan);
        if (planAmt > 0) {
          recordUserPayment(ctx.user_id, planAmt, payKey);
        }
      }
    }

    // 3. Aggregate AI token usage and calculate provider costs in range
    const userAiCostMap = new Map();
    const userTokensMap = new Map();
    let totalPromptTokens = 0;
    let totalOutputTokens = 0;
    let totalAiCostInr = 0;
    let totalAiCostUsd = 0;

    for (const u of usageRows) {
      const prompt = Number(u.prompt_tokens) || 0;
      const output = Number(u.output_tokens) || 0;
      const uId = Number(u.user_id);

      if (uId && existingUserMap.has(uId)) {
        totalPromptTokens += prompt;
        totalOutputTokens += output;

        const { totalCostUsd, totalCostInr } = calcAiUsageCost(u.model, prompt, output);
        totalAiCostUsd += totalCostUsd;
        totalAiCostInr += totalCostInr;

        const curCost = userAiCostMap.get(uId) || 0;
        userAiCostMap.set(uId, curCost + totalCostInr);

        const curTokens = userTokensMap.get(uId) || 0;
        userTokensMap.set(uId, curTokens + prompt + output);
      }
    }

    // 4. Gather sessions across call_sessions, trial_transactions, and credit_transactions
    const sessionStatsMap = new Map();
    const globalSessionKeys = new Set();

    const addSessionToUser = (userId, sessionKey, timestamp) => {
      const uId = Number(userId);
      if (!uId || !existingUserMap.has(uId)) return;
      if (!sessionStatsMap.has(uId)) {
        sessionStatsMap.set(uId, { sessionKeys: new Set(), last_session: null });
      }
      const entry = sessionStatsMap.get(uId);
      if (sessionKey) entry.sessionKeys.add(sessionKey);
      if (timestamp && (!entry.last_session || timestamp > entry.last_session)) {
        entry.last_session = timestamp;
      }
      if (sessionKey) globalSessionKeys.add(sessionKey);
    };

    for (const s of callSessionsList) {
      addSessionToUser(s.user_id, `call_${s.id || s._id}`, s.started_at || s.created_at);
    }
    for (const t of trialTxList) {
      addSessionToUser(t.user_id, t.session_id ? `trial_${t.session_id}` : `trial_tx_${t.id || t._id}`, t.created_at);
    }
    for (const c of paidTxList) {
      addSessionToUser(c.user_id, c.session_id ? `paid_${c.session_id}` : `paid_tx_${c.id || c._id}`, c.created_at);
    }

    // 5. Build user-level ledger entries
    const freeTrials = Number(credits.DEFAULT_FREE_TRIALS) || 5;
    const ledger = allUsers.map((u) => {
        const uId = Number(u.id);
        const creditBal = Math.round(Math.max(0, balanceMap.get(uId) || 0) * 100) / 100;
        const t = trialMap.get(uId);
        const trialsRem = Math.max(0, Math.floor(freeTrials + (Number(t?.granted) || 0) - (Number(t?.used) || 0)));

        const sessionEntry = sessionStatsMap.get(uId) || { sessionKeys: new Set(), last_session: null };
        const paidAmount = Math.round((userRevenueMap.get(uId) || 0) * 100) / 100;
        const aiCost = Math.round((userAiCostMap.get(uId) || 0) * 100) / 100;
        const netProfitLoss = Math.round((paidAmount - aiCost) * 100) / 100;
        const totalTokens = userTokensMap.get(uId) || 0;

        return {
          id: u.id,
          email: u.email,
          role: u.role || 'user',
          status: u.disabled ? 'suspended' : 'active',
          plan: u.plan || 'free',
          credits_remaining: typeof creditBal === 'number' && !isNaN(creditBal) ? creditBal : 0,
          trials_remaining: typeof trialsRem === 'number' && !isNaN(trialsRem) ? trialsRem : 5,
          total_sessions: sessionEntry.sessionKeys.size,
          paid_amount: paidAmount,
          ai_provider_cost: aiCost,
          net_profit_loss: netProfitLoss,
          last_session: sessionEntry.last_session || u.last_payment_date || null,
          total_tokens: totalTokens,
          created_at: u.created_at,
        };
      });

    // 6. Sort user ledger
    ledger.sort((a, b) => {
      let valA = a[sort_by];
      let valB = b[sort_by];

      if (typeof valA === 'string') valA = valA.toLowerCase();
      if (typeof valB === 'string') valB = valB.toLowerCase();

      if (valA === valB) return 0;
      if (valA === null || valA === undefined) return 1;
      if (valB === null || valB === undefined) return -1;

      if (sort_order === 'asc') {
        return valA > valB ? 1 : -1;
      }
      return valA < valB ? 1 : -1;
    });

    // 7. Paginate user ledger
    const totalMatchingUsers = ledger.length;
    const paginatedUsers = ledger.slice(skip, skip + limitNum);

    // 8. Overall Financial calculations
    const cleanRevenue = Math.round(totalRevenue * 100) / 100;
    const cleanCost = Math.round(totalAiCostInr * 100) / 100;
    const cleanProfit = Math.round(Math.max(0, cleanRevenue - cleanCost) * 100) / 100;
    const cleanLoss = Math.round(Math.max(0, cleanCost - cleanRevenue) * 100) / 100;
    const cleanNetEarnings = Math.round((cleanRevenue - cleanCost) * 100) / 100;
    const marginPct = cleanRevenue > 0 ? Math.round(((cleanNetEarnings / cleanRevenue) * 100) * 10) / 10 : 0;

    return {
      summary: {
        total_revenue: cleanRevenue,
        original_cost: cleanCost,
        profit: cleanProfit,
        loss: cleanLoss,
        net_earnings: cleanNetEarnings,
        margin_pct: marginPct,
        total_transactions: totalTransactions,
        total_sessions: globalSessionKeys.size,
        total_tokens: totalPromptTokens + totalOutputTokens,
        total_prompt_tokens: totalPromptTokens,
        total_output_tokens: totalOutputTokens,
        cost_usd: Math.round(totalAiCostUsd * 100) / 100,
        currency: 'INR',
        currency_symbol: '₹',
        usd_inr_rate: USD_INR_CONVERSION_RATE,
        cost_available: (totalPromptTokens + totalOutputTokens) > 0 || usageRows.length > 0,
        is_estimated: true,
      },
      users: paginatedUsers,
      pagination: {
        total: totalMatchingUsers,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(totalMatchingUsers / limitNum) || 1,
      },
      filter: {
        range,
        start_date: since,
        end_date: until,
        search,
        status,
        sort_by,
        sort_order,
      },
    };
}

// --------------------------------------------------------------------------
// 15c. GET /api/admin/audit-events - Granular Unified Security & Usage Event Logs
// --------------------------------------------------------------------------
router.get('/audit-events', async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 50,
      user_email = '',
      category = 'ALL',
      outcome = 'ALL',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const events = [];

    // 1. Audit logs (Admin actions)
    if (category === 'ALL' || category === 'ADMIN') {
      const q = {};
      if (user_email.trim()) {
        q.$or = [
          { target_email: { $regex: user_email.trim(), $options: 'i' } },
          { admin_email: { $regex: user_email.trim(), $options: 'i' } },
        ];
      }
      const adminLogs = await col('audit_logs').find(q).sort({ id: -1 }).limit(100).toArray();
      for (const l of adminLogs) {
        events.push({
          id: `audit_${l.id || l._id}`,
          timestamp: l.created_at || nowSql(),
          event_type: l.action || 'ADMIN_ACTION',
          category: 'ADMIN',
          actor: l.admin_email || 'Administrator',
          user_email: l.target_email || '—',
          user_id: l.target_id || null,
          outcome: l.status === 'success' ? 'success' : (l.status === 'failed' ? 'danger' : 'info'),
          description: `Admin action: ${l.action}`,
          details: l.details || {},
        });
      }
    }

    // 2. Credit Transactions
    if (category === 'ALL' || category === 'CREDIT') {
      const creditTxns = await col('credit_transactions').find({}).sort({ id: -1 }).limit(100).toArray();
      await primeUserEmails(creditTxns.map((c) => c.user_id));
      for (const c of creditTxns) {
        const email = await getUserEmail(c.user_id);
        if (user_email.trim() && !email.toLowerCase().includes(user_email.trim().toLowerCase())) continue;
        events.push({
          id: `credit_${c.id || c._id}`,
          timestamp: c.created_at || nowSql(),
          event_type: `CREDIT_${c.type || 'TX'}`,
          category: 'CREDIT',
          actor: c.admin_id ? `Admin #${c.admin_id}` : 'System / Payment',
          user_email: email,
          user_id: c.user_id,
          outcome: 'success',
          description: `${c.type || 'Transaction'}: ${c.amount > 0 ? '+' : ''}${c.amount} credits (${c.reason || 'Balance change'})`,
          details: { amount: c.amount, reason: c.reason, session_id: c.session_id },
        });
      }
    }

    // 3. Trial Transactions
    if (category === 'ALL' || category === 'TRIAL') {
      const trialTxns = await col('trial_transactions').find({}).sort({ id: -1 }).limit(100).toArray();
      await primeUserEmails(trialTxns.map((t) => t.user_id));
      for (const t of trialTxns) {
        const email = await getUserEmail(t.user_id);
        if (user_email.trim() && !email.toLowerCase().includes(user_email.trim().toLowerCase())) continue;
        events.push({
          id: `trial_${t.id || t._id}`,
          timestamp: t.created_at || nowSql(),
          event_type: t.type || 'TRIAL_EVENT',
          category: 'TRIAL',
          actor: t.admin_id ? `Admin #${t.admin_id}` : 'Copilot Session',
          user_email: email,
          user_id: t.user_id,
          outcome: 'info',
          description: `${t.type === 'TRIAL_CONSUMED' ? 'Consumed 1 free trial session' : 'Free trial granted'}: ${t.amount} (${t.reason || 'Free trial session'})`,
          details: { amount: t.amount, session_id: t.session_id, reason: t.reason },
        });
      }
    }

    // 4. Copilot Sessions
    if (category === 'ALL' || category === 'SESSION') {
      const sessions = await col('call_sessions').find({}).sort({ id: -1 }).limit(100).toArray();
      await primeUserEmails(sessions.map((s) => s.user_id));
      for (const s of sessions) {
        const email = await getUserEmail(s.user_id);
        if (user_email.trim() && !email.toLowerCase().includes(user_email.trim().toLowerCase())) continue;
        events.push({
          id: `sess_${s.id || s._id}`,
          timestamp: s.started_at || s.created_at || nowSql(),
          event_type: `SESSION_${(s.status || 'started').toUpperCase()}`,
          category: 'SESSION',
          actor: email,
          user_email: email,
          user_id: s.user_id,
          outcome: s.status === 'ended' ? 'success' : (s.status === 'active' ? 'info' : 'warning'),
          description: `Copilot session ${s.status || 'started'} (${s.company || 'Practice'} - ${s.billing_kind || 'trial'})`,
          details: {
            session_id: s.id,
            company: s.company,
            role: s.role,
            billing_kind: s.billing_kind,
            duration_minutes: s.duration_minutes || null,
          },
        });
      }
    }

    // 5. Promotion Redemptions
    if (category === 'ALL' || category === 'PROMOTION' || category === 'PAYMENT') {
      const redemptions = await col('promotion_redemptions').find({}).sort({ id: -1 }).limit(100).toArray();
      for (const r of redemptions) {
        if (user_email.trim() && !r.user_email?.toLowerCase().includes(user_email.trim().toLowerCase())) continue;
        events.push({
          id: `promo_${r.id || r._id}`,
          timestamp: r.redeemed_at || nowSql(),
          event_type: 'PROMOTION_REDEEMED',
          category: 'PROMOTION',
          actor: r.user_email,
          user_email: r.user_email,
          user_id: r.user_id,
          outcome: 'success',
          description: `Coupon ${r.promotion_code} applied to ${r.plan || 'plan'}: paid ₹${r.final_amount} (saved ₹${r.discount_amount}${r.bonus_credits ? `, +${r.bonus_credits} bonus credits` : ''})`,
          details: {
            coupon_code: r.promotion_code,
            payment_id: r.payment_id,
            plan: r.plan,
            final_amount: r.final_amount,
            bonus_credits: r.bonus_credits,
          },
        });
      }
    }

    let filteredEvents = events;
    if (outcome !== 'ALL') {
      filteredEvents = filteredEvents.filter((e) => e.outcome === outcome.toLowerCase());
    }

    filteredEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const totalEvents = filteredEvents.length;
    const paginatedEvents = filteredEvents.slice(skip, skip + limitNum);

    res.json({
      events: paginatedEvents,
      pagination: {
        total: totalEvents,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(totalEvents / limitNum) || 1,
      },
      filter: { category, outcome, user_email },
    });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------------
// 16. GET /api/admin/settings - Platform Configuration & Status
// --------------------------------------------------------------------------
router.get('/settings', async (req, res, next) => {
  try {
    res.json({
      admin_email: process.env.ADMIN_EMAIL || 'Not configured',
      designated_admin_email: process.env.ADMIN_EMAIL || '',
      default_free_trials: Number(process.env.DEFAULT_FREE_TRIALS || 5),
      default_token_quota: Number(process.env.DEFAULT_TOKEN_QUOTA || 100000),
      openai_model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      vision_model: process.env.VISION_MODEL || 'gpt-4o',
      transcribe_model: process.env.TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
      openai_configured: Boolean(process.env.OPENAI_API_KEY),
      smtp_configured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER),
      razorpay_configured: Boolean(process.env.RAZORPAY_KEY_ID),
      node_env: process.env.NODE_ENV || 'development',
      server_time: nowSql(),
    });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------------
// 17. POST /api/admin/settings - Save Platform Settings
// --------------------------------------------------------------------------
router.post('/settings', async (req, res, next) => {
  try {
    const { default_free_trials, default_token_quota } = req.body || {};

    if (default_free_trials !== undefined) {
      const val = parseInt(default_free_trials, 10);
      if (val > 0) process.env.DEFAULT_FREE_TRIALS = String(val);
    }
    if (default_token_quota !== undefined) {
      const val = parseInt(default_token_quota, 10);
      if (val > 0) process.env.DEFAULT_TOKEN_QUOTA = String(val);
    }

    await logAudit(req.user, 'SETTINGS_UPDATE', null, null, req.body);
    res.json({ ok: true, message: 'Settings updated successfully.' });
  } catch (err) {
    next(err);
  }
});


// --------------------------------------------------------------------------
// 18. PROMOTIONS & OFFERS (ParakeetAI-Style)
// --------------------------------------------------------------------------

// GET /api/admin/promotions - List, KPI stats, filters
router.get('/promotions', async (req, res, next) => {
  try {
    const { search = '', status = 'all' } = req.query;
    const filter = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    const allPromotions = await col('promotions').find(filter).sort({ created_at: -1 }).toArray();
    const allDbPromotions = await col('promotions').find({}).toArray();

    let totalRedemptionsCount = 0;
    try {
      totalRedemptionsCount = await col('promotion_redemptions').countDocuments();
    } catch {}

    let activeCount = 0;
    let scheduledCount = 0;
    let expiredCount = 0;

    for (const p of allDbPromotions) {
      const dynamicStatus = getPromotionStatus(p);
      if (dynamicStatus === 'active') activeCount++;
      else if (dynamicStatus === 'scheduled') scheduledCount++;
      else if (dynamicStatus === 'expired') expiredCount++;
    }

    const decorated = allPromotions.map((p) => {
      const dynamicStatus = getPromotionStatus(p);
      return {
        ...p,
        calculated_status: dynamicStatus,
      };
    });

    const filtered = status === 'all'
      ? decorated
      : decorated.filter((p) => p.calculated_status === status || p.status === status);

    res.json({
      promotions: filtered,
      kpis: {
        total: allDbPromotions.length,
        active: activeCount,
        scheduled: scheduledCount,
        expired: expiredCount,
        total_redemptions: totalRedemptionsCount,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/promotions/:id - Details & redemption history
router.get('/promotions/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id) || req.params.id;
    const promo = await col('promotions').findOne({ id });
    if (!promo) return res.status(404).json({ error: 'not_found', message: 'Promotion not found' });

    const redemptions = await col('promotion_redemptions')
      .find({ promotion_id: promo.id })
      .sort({ redeemed_at: -1 })
      .limit(100)
      .toArray();

    res.json({
      promotion: {
        ...promo,
        calculated_status: getPromotionStatus(promo),
      },
      redemptions,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/promotions - Create a new promotion
router.post('/promotions', async (req, res, next) => {
  try {
    const {
      name,
      code,
      description = '',
      offer_type = 'percentage_discount',
      discount_percent = 0,
      discount_amount = 0,
      bonus_credits = 0,
      eligible_products = ['all'],
      min_purchase_amount = 0,
      max_redemptions = null,
      per_user_limit = 1,
      start_date = null,
      expiry_date = null,
      status = 'active',
      is_public = true,
      attachment = null,
    } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name_required', message: 'Promotion name is required.' });
    }
    if (!code || typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ error: 'code_required', message: 'Coupon code is required.' });
    }

    const cleanCode = code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (!cleanCode) {
      return res.status(400).json({ error: 'invalid_code', message: 'Coupon code must contain letters or numbers.' });
    }

    const existing = await col('promotions').findOne({ code: cleanCode });
    if (existing) {
      return res.status(409).json({ error: 'duplicate_code', message: `Coupon code '${cleanCode}' already exists.` });
    }

    const id = await nextId('promotions');
    const newPromo = {
      id,
      name: name.trim(),
      code: cleanCode,
      description: description.trim(),
      offer_type,
      discount_percent: Number(discount_percent) || 0,
      discount_amount: Number(discount_amount) || 0,
      bonus_credits: Number(bonus_credits) || 0,
      eligible_products: Array.isArray(eligible_products) && eligible_products.length > 0 ? eligible_products : ['all'],
      min_purchase_amount: Number(min_purchase_amount) || 0,
      max_redemptions: max_redemptions ? Number(max_redemptions) : null,
      redemption_count: 0,
      per_user_limit: Math.max(1, Number(per_user_limit) || 1),
      start_date: start_date ? new Date(start_date).toISOString() : null,
      expiry_date: expiry_date ? new Date(expiry_date).toISOString() : null,
      status: status === 'inactive' ? 'inactive' : 'active',
      is_public: Boolean(is_public),
      attachment: attachment || null,
      created_by: req.user.email,
      created_at: nowSql(),
      updated_at: nowSql(),
    };

    await col('promotions').insertOne(newPromo);
    await logAudit(req.user, 'PROMOTION_CREATED', newPromo.id, null, {
      name: newPromo.name,
      code: newPromo.code,
      offer_type: newPromo.offer_type,
    });

    res.status(201).json({
      promotion: {
        ...newPromo,
        calculated_status: getPromotionStatus(newPromo),
      },
      message: 'Promotion created successfully.',
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/promotions/:id - Update an existing promotion
router.put('/promotions/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id) || req.params.id;
    const existing = await col('promotions').findOne({ id });
    if (!existing) return res.status(404).json({ error: 'not_found', message: 'Promotion not found' });

    const {
      name,
      code,
      description,
      offer_type,
      discount_percent,
      discount_amount,
      bonus_credits,
      eligible_products,
      min_purchase_amount,
      max_redemptions,
      per_user_limit,
      start_date,
      expiry_date,
      status,
      is_public,
      attachment,
    } = req.body || {};

    let cleanCode = existing.code;
    if (code && typeof code === 'string') {
      cleanCode = code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
      if (cleanCode !== existing.code) {
        const dup = await col('promotions').findOne({ code: cleanCode, id: { $ne: id } });
        if (dup) {
          return res.status(409).json({ error: 'duplicate_code', message: `Coupon code '${cleanCode}' is already taken.` });
        }
      }
    }

    const updates = {
      updated_at: nowSql(),
    };

    if (name !== undefined) updates.name = String(name).trim();
    if (code !== undefined) updates.code = cleanCode;
    if (description !== undefined) updates.description = String(description).trim();
    if (offer_type !== undefined) updates.offer_type = offer_type;
    if (discount_percent !== undefined) updates.discount_percent = Number(discount_percent) || 0;
    if (discount_amount !== undefined) updates.discount_amount = Number(discount_amount) || 0;
    if (bonus_credits !== undefined) updates.bonus_credits = Number(bonus_credits) || 0;
    if (eligible_products !== undefined) updates.eligible_products = Array.isArray(eligible_products) ? eligible_products : ['all'];
    if (min_purchase_amount !== undefined) updates.min_purchase_amount = Number(min_purchase_amount) || 0;
    if (max_redemptions !== undefined) updates.max_redemptions = max_redemptions ? Number(max_redemptions) : null;
    if (per_user_limit !== undefined) updates.per_user_limit = Math.max(1, Number(per_user_limit) || 1);
    if (start_date !== undefined) updates.start_date = start_date ? new Date(start_date).toISOString() : null;
    if (expiry_date !== undefined) updates.expiry_date = expiry_date ? new Date(expiry_date).toISOString() : null;
    if (status !== undefined) updates.status = status === 'inactive' ? 'inactive' : 'active';
    if (is_public !== undefined) updates.is_public = Boolean(is_public);
    if (attachment !== undefined) updates.attachment = attachment;

    await col('promotions').updateOne({ id }, { $set: updates });
    const updated = await col('promotions').findOne({ id });

    await logAudit(req.user, 'PROMOTION_UPDATED', id, null, {
      code: updated.code,
      changes: Object.keys(updates),
    });

    res.json({
      promotion: {
        ...updated,
        calculated_status: getPromotionStatus(updated),
      },
      message: 'Promotion updated successfully.',
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/promotions/:id/status - Toggle active/inactive
router.patch('/promotions/:id/status', async (req, res, next) => {
  try {
    const id = Number(req.params.id) || req.params.id;
    const promo = await col('promotions').findOne({ id });
    if (!promo) return res.status(404).json({ error: 'not_found', message: 'Promotion not found' });

    const newStatus = promo.status === 'active' ? 'inactive' : 'active';
    await col('promotions').updateOne({ id }, { $set: { status: newStatus, updated_at: nowSql() } });

    await logAudit(req.user, 'PROMOTION_STATUS_TOGGLED', id, null, {
      code: promo.code,
      status: newStatus,
    });

    const updated = await col('promotions').findOne({ id });
    res.json({
      promotion: {
        ...updated,
        calculated_status: getPromotionStatus(updated),
      },
      message: `Promotion is now ${newStatus}.`,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/promotions/:id - Delete a promotion
router.delete('/promotions/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id) || req.params.id;
    const promo = await col('promotions').findOne({ id });
    if (!promo) return res.status(404).json({ error: 'not_found', message: 'Promotion not found' });

    await col('promotions').deleteOne({ id });
    await logAudit(req.user, 'PROMOTION_DELETED', id, null, {
      name: promo.name,
      code: promo.code,
    });

    res.json({ ok: true, message: `Promotion '${promo.code}' deleted successfully.` });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/promotions/:id/redemptions - Redemption audit records
router.get('/promotions/:id/redemptions', async (req, res, next) => {
  try {
    const id = Number(req.params.id) || req.params.id;
    const promo = await col('promotions').findOne({ id });
    if (!promo) return res.status(404).json({ error: 'not_found', message: 'Promotion not found' });

    const redemptions = await col('promotion_redemptions')
      .find({ promotion_id: promo.id })
      .sort({ redeemed_at: -1 })
      .toArray();

    res.json({ redemptions });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
