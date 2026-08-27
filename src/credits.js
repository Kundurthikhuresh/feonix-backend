const { col, nextId, nowSql, minutesBetween, publicDoc } = require('./db');

const DEFAULT_FREE_TRIALS = 5;
const TRIAL_MINUTES = 10;
const BILLING_BLOCK_MINUTES = 30;
const CREDIT_PER_BLOCK = 0.5;
const UNLIMITED_MINUTES = 24 * 60;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function isUnlimited(userId) {
  const row = await col('users').findOne({ id: userId });
  return Boolean(row && row.role === 'owner');
}

async function creditBalance(userId) {
  const rows = await col('credit_transactions').aggregate([
    { $match: { user_id: userId } },
    { $group: { _id: null, bal: { $sum: '$amount' } } },
  ]).toArray();
  return round2(rows[0] ? rows[0].bal : 0);
}

async function trialsRemaining(userId) {
  const rows = await col('trial_transactions').aggregate([
    { $match: { user_id: userId } },
    { $group: { _id: null, net: { $sum: '$amount' } } },
  ]).toArray();
  const net = rows[0] ? rows[0].net : 0;
  return Math.max(0, DEFAULT_FREE_TRIALS + net);
}

async function trialsUsed(userId) {
  const rows = await col('trial_transactions').aggregate([
    { $match: { user_id: userId, type: 'TRIAL_CONSUMED' } },
    { $group: { _id: null, used: { $sum: '$amount' } } },
  ]).toArray();
  return Math.max(0, -(rows[0] ? rows[0].used : 0));
}

function creditsForMinutes(minutes) {
  const m = Math.max(0, Number(minutes) || 0);
  const blocks = Math.max(1, Math.ceil(m / BILLING_BLOCK_MINUTES));
  return round2(blocks * CREDIT_PER_BLOCK);
}

async function entitlementMinutes(userId) {
  const blocks = Math.floor((await creditBalance(userId)) / CREDIT_PER_BLOCK);
  return blocks * BILLING_BLOCK_MINUTES;
}

async function grantCredits(userId, amount, { adminId = null, reason = null } = {}) {
  const value = round2(amount);
  if (!(value > 0)) throw new Error('grant amount must be positive');
  const id = await nextId('credit_transactions');
  await col('credit_transactions').insertOne({
    id, user_id: userId, type: 'GRANT', amount: value,
    session_id: null, usage_minutes: null, admin_id: adminId, reason, created_at: nowSql(),
  });
  return creditBalance(userId);
}

async function refundCredits(userId, amount, { sessionId = null, adminId = null, reason = null } = {}) {
  const value = round2(amount);
  if (!(value > 0)) throw new Error('refund amount must be positive');
  const id = await nextId('credit_transactions');
  await col('credit_transactions').insertOne({
    id, user_id: userId, type: 'REFUND', amount: value,
    session_id: sessionId, usage_minutes: null, admin_id: adminId, reason, created_at: nowSql(),
  });
  return creditBalance(userId);
}

async function adjustCredits(userId, amount, { adminId = null, reason = null } = {}) {
  const value = round2(amount);
  if (!value) throw new Error('adjustment must be non-zero');
  const id = await nextId('credit_transactions');
  await col('credit_transactions').insertOne({
    id, user_id: userId, type: 'ADJUST', amount: value,
    session_id: null, usage_minutes: null, admin_id: adminId, reason, created_at: nowSql(),
  });
  return creditBalance(userId);
}

async function grantTrials(userId, count, { adminId = null, reason = null } = {}) {
  const n = Math.trunc(Number(count) || 0);
  if (n <= 0) throw new Error('trial grant must be positive');
  const id = await nextId('trial_transactions');
  await col('trial_transactions').insertOne({
    id, user_id: userId, type: 'TRIAL_GRANTED', amount: n,
    session_id: null, admin_id: adminId, reason, created_at: nowSql(),
  });
  return trialsRemaining(userId);
}

async function openSession(userId, sessionId, requestedKind) {
  if (await isUnlimited(userId)) {
    return { kind: 'unlimited', minutes: UNLIMITED_MINUTES };
  }

  const kind = requestedKind === 'paid' ? 'paid' : 'trial';

  if (kind === 'trial') {
    if ((await trialsRemaining(userId)) <= 0) {
      const err = new Error('All free trials have been used.');
      err.code = 'no_trials_left';
      err.status = 409;
      throw err;
    }
    const id = await nextId('trial_transactions');
    await col('trial_transactions').insertOne({
      id, user_id: userId, type: 'TRIAL_CONSUMED', amount: -1,
      session_id: sessionId, admin_id: null, reason: null, created_at: nowSql(),
    });
    return { kind, minutes: TRIAL_MINUTES };
  }

  const minutes = await entitlementMinutes(userId);
  if (minutes < 1) {
    const err = new Error('Not enough credits to start a paid session.');
    err.code = 'insufficient_credits';
    err.status = 402;
    throw err;
  }
  return { kind, minutes };
}

async function settleSession(session) {
  if (!session || session.settled_at) return null;

  const started = session.started_at;
  const ended = session.ended_at || nowSql();
  const minutes = minutesBetween(started, ended);

  const stamped = await col('call_sessions').findOneAndUpdate(
    { id: session.id, settled_at: null },
    { $set: { settled_at: nowSql() } },
    { returnDocument: 'after' }
  );
  const updated = stamped && stamped.id ? stamped : stamped && stamped.value;
  if (!updated) return null;

  if (session.billing_kind === 'unlimited') {
    return { kind: 'unlimited', minutes: round2(minutes), credits: 0 };
  }
  if (session.billing_kind !== 'paid') {
    return { kind: 'trial', minutes, credits: 0 };
  }

  const credits = creditsForMinutes(minutes);
  const id = await nextId('credit_transactions');
  await col('credit_transactions').insertOne({
    id,
    user_id: session.user_id,
    type: 'CONSUME',
    amount: -credits,
    session_id: session.id,
    usage_minutes: round2(minutes),
    admin_id: null,
    reason: 'session usage',
    created_at: nowSql(),
  });

  return { kind: 'paid', minutes: round2(minutes), credits };
}

async function accountSummary(userId) {
  const grantedRows = await col('credit_transactions').aggregate([
    { $match: { user_id: userId, amount: { $gt: 0 } } },
    { $group: { _id: null, v: { $sum: '$amount' } } },
  ]).toArray();
  const consumedRows = await col('credit_transactions').aggregate([
    { $match: { user_id: userId, amount: { $lt: 0 } } },
    { $group: { _id: null, v: { $sum: '$amount' } } },
  ]).toArray();
  const unlimited = await isUnlimited(userId);
  return {
    unlimited,
    credits: await creditBalance(userId),
    credits_granted: round2(grantedRows[0] ? grantedRows[0].v : 0),
    credits_used: round2(-(consumedRows[0] ? consumedRows[0].v : 0)),
    entitlement_minutes: unlimited ? UNLIMITED_MINUTES : await entitlementMinutes(userId),
    trials_total: DEFAULT_FREE_TRIALS,
    trials_used: await trialsUsed(userId),
    trials_remaining: await trialsRemaining(userId),
    trial_minutes: TRIAL_MINUTES,
  };
}

module.exports = {
  DEFAULT_FREE_TRIALS,
  UNLIMITED_MINUTES,
  isUnlimited,
  TRIAL_MINUTES,
  creditBalance,
  trialsRemaining,
  trialsUsed,
  creditsForMinutes,
  entitlementMinutes,
  grantCredits,
  refundCredits,
  adjustCredits,
  grantTrials,
  openSession,
  settleSession,
  accountSummary,
  minutesBetween,
  publicDoc,
};
