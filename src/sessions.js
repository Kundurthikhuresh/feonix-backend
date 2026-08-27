const express = require('express');
const { col, nextId, nowSql, isExpired, addMinutesFromNow, publicDoc, sessionTokensUsed } = require('./db');
const { requireAuth } = require('./auth');
const credits = require('./credits');

const router = express.Router();

async function enrichSession(session) {
  if (!session) return null;
  const s = publicDoc(session);
  const [tokens_used, answer_count, line_count] = await Promise.all([
    sessionTokensUsed(s.id),
    col('answers').countDocuments({ session_id: s.id }),
    col('transcript_lines').countDocuments({ session_id: s.id }),
  ]);
  return { ...s, tokens_used, answer_count, line_count };
}

async function ownedSession(userId, id) {
  return publicDoc(await col('call_sessions').findOne({ id: Number(id), user_id: userId }));
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const status = String(req.query.status || 'all');
    const filter = { user_id: req.user.id };
    if (status !== 'all') filter.status = status;
    const rows = await col('call_sessions').find(filter).sort({ id: -1 }).toArray();
    res.json({ sessions: await Promise.all(rows.map(enrichSession)) });
  } catch (err) {
    next(err);
  }
});

router.get('/account', requireAuth, async (req, res, next) => {
  try {
    const recent = await col('call_sessions')
      .find({ user_id: req.user.id, started_at: { $ne: null } })
      .sort({ id: -1 })
      .limit(20)
      .toArray();
    const recent_usage = [];
    for (const s of recent) {
      const consume = await col('credit_transactions').findOne({ session_id: s.id, type: 'CONSUME' });
      recent_usage.push({
        id: s.id,
        company: s.company,
        role: s.role,
        billing_kind: s.billing_kind,
        status: s.status,
        started_at: s.started_at,
        ended_at: s.ended_at,
        settled_at: s.settled_at,
        credits_charged: consume ? consume.amount : null,
        usage_minutes: consume ? consume.usage_minutes : null,
      });
    }
    res.json({
      account: await credits.accountSummary(req.user.id),
      recent_usage,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    const mode = b.mode === 'call' ? 'call' : 'interview';
    const company = String(b.company || '').trim();
    const role = String(b.role || '').trim();
    const jobDescription = String(b.job_description || '').trim().slice(0, 20000);
    const language = String(b.language || 'English').slice(0, 40);
    const autoAnswer = b.auto_answer === false ? 0 : 1;
    const context = String(b.context || '').trim().slice(0, 20000);
    const agent = String(b.agent || '').trim().slice(0, 60);
    const billing = String(b.billing) === 'paid' ? 'paid' : 'trial';
    const saveTranscript = b.save_transcript === false ? 0 : 1;

    if (!company) {
      return res.status(400).json({
        error: 'missing_company',
        message: mode === 'call' ? 'Give the call a title.' : 'Company is required.',
      });
    }

    const id = await nextId('call_sessions');
    const session = {
      id,
      user_id: req.user.id,
      company,
      role,
      mode,
      status: 'ready',
      started_at: null,
      ended_at: null,
      created_at: nowSql(),
      job_description: jobDescription,
      language,
      auto_answer: autoAnswer,
      save_transcript: saveTranscript,
      context,
      agent,
      plan: null,
      expires_at: null,
      billing_kind: billing,
      settled_at: null,
      notes: null,
    };
    await col('call_sessions').insertOne(session);
    return res.status(201).json({ session: await enrichSession(session) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const owned = await ownedSession(req.user.id, req.params.id);
    if (!owned) return res.status(404).json({ error: 'not_found' });
    const lines = await col('transcript_lines')
      .find({ session_id: owned.id })
      .project({ _id: 0, id: 1, text: 1, is_question: 1, created_at: 1 })
      .sort({ id: 1 })
      .toArray();
    const answers = await col('answers')
      .find({ session_id: owned.id })
      .project({ _id: 0, id: 1, question: 1, reply: 1, mode: 1, action: 1, created_at: 1 })
      .sort({ id: 1 })
      .toArray();
    return res.json({ session: await enrichSession(owned), transcript: lines, answers });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/start', requireAuth, async (req, res, next) => {
  try {
    const owned = await ownedSession(req.user.id, req.params.id);
    if (!owned) return res.status(404).json({ error: 'not_found' });
    if (owned.status === 'ended') {
      return res.status(409).json({ error: 'already_ended', message: 'This session has already ended.' });
    }
    if (owned.expires_at && isExpired(owned.expires_at)) {
      await col('call_sessions').updateOne(
        { id: owned.id },
        { $set: { status: 'ended', ended_at: owned.ended_at || nowSql() } }
      );
      const fresh = await ownedSession(req.user.id, owned.id);
      await credits.settleSession(fresh);
      return res.status(409).json({
        error: 'session_expired',
        message: 'This session’s time has already run out. Start a new session to continue.',
      });
    }

    const requested = String((req.body && req.body.billing) || '')
      || (owned.billing_kind || (String(req.body && req.body.plan) === 'full' ? 'paid' : 'trial'));

    let opened;
    try {
      opened = await credits.openSession(req.user.id, owned.id, requested);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.code || 'cannot_start', message: err.message });
    }

    const forceKind = opened.kind === 'unlimited';
    const $set = {
      status: 'active',
      plan: owned.plan || (opened.kind === 'trial' ? 'free' : 'full'),
    };
    if (forceKind || !owned.billing_kind) $set.billing_kind = opened.kind;
    if (!owned.started_at) $set.started_at = nowSql();
    if (!owned.expires_at) $set.expires_at = addMinutesFromNow(opened.minutes);

    await col('call_sessions').updateOne({ id: owned.id }, { $set });
    res.json({ session: await enrichSession(await ownedSession(req.user.id, owned.id)) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/end', requireAuth, async (req, res, next) => {
  try {
    const owned = await ownedSession(req.user.id, req.params.id);
    if (!owned) return res.status(404).json({ error: 'not_found' });

    await col('call_sessions').updateOne(
      { id: owned.id },
      { $set: { status: 'ended', ended_at: owned.ended_at || nowSql() } }
    );
    const fresh = await ownedSession(req.user.id, owned.id);
    const settlement = await credits.settleSession(fresh);
    res.json({
      session: await enrichSession(await ownedSession(req.user.id, owned.id)),
      settlement,
      account: await credits.accountSummary(req.user.id),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/transcript', requireAuth, async (req, res, next) => {
  try {
    const owned = await ownedSession(req.user.id, req.params.id);
    if (!owned) return res.status(404).json({ error: 'not_found' });
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: 'empty_line' });
    const id = await nextId('transcript_lines');
    await col('transcript_lines').insertOne({
      id,
      session_id: owned.id,
      text,
      is_question: req.body.is_question ? 1 : 0,
      created_at: nowSql(),
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await col('call_sessions').deleteOne({
      id: Number(req.params.id),
      user_id: req.user.id,
    });
    if (!result.deletedCount) return res.status(404).json({ error: 'not_found' });
    await col('transcript_lines').deleteMany({ session_id: Number(req.params.id) });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

async function sessionExists(userId, id) {
  if (!id) return null;
  const row = await ownedSession(userId, id);
  return row ? row.id : null;
}

async function getSession(userId, id) {
  if (!id) return null;
  return ownedSession(userId, id);
}

module.exports = { router, sessionExists, getSession, ownedSession };
