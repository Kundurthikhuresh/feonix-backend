const { col, nextId, nowSql, isExpired, minutesBetween, publicDoc } = require('./db');

const DEFAULT_FREE_CREDITS = Number(process.env.DEFAULT_FREE_CREDITS || process.env.DEFAULT_FREE_TRIALS || 5);
const DEFAULT_FREE_TRIALS = DEFAULT_FREE_CREDITS;
const TRIAL_MINUTES = 15;
const BILLING_BLOCK_MINUTES = 15;
const CREDIT_PER_BLOCK = 1;
const UNLIMITED_MINUTES = 24 * 60;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Unlimited session minutes is a billing entitlement, not an admin
// permission — it must never be implied by role alone. It used to check
// role === 'owner'/'admin', which meant WHOEVER happens to be the first
// account in the users collection (an accident of registration order, not
// a deliberate grant) got free unlimited AI sessions forever, silently
// skipping the entire trial/credit/payment flow this function exists to
// enforce. Comp a specific account explicitly with grantCredits/grantTrials
// instead — those already exist and are visible in the ledger.
async function isUnlimited(userId) {
  const row = await col('users').findOne({ id: userId });
  return Boolean(row && row.unlimited_sessions === true);
}

async function creditBalance(userId) {
  const [creditRows, trialRows] = await Promise.all([
    col('credit_transactions').aggregate([
      { $match: { user_id: userId } },
      { $group: { _id: null, bal: { $sum: '$amount' } } },
    ]).toArray(),
    col('trial_transactions').aggregate([
      { $match: { user_id: userId, type: 'TRIAL_CONSUMED' } },
      { $group: { _id: null, used: { $sum: '$amount' } } },
    ]).toArray(),
  ]);
  const netCredits = creditRows[0] ? creditRows[0].bal : 0;
  const usedTrials = trialRows[0] ? -trialRows[0].used : 0;
  // Every user starts with 5 free credits, minus any consumed sessions + any granted credits
  return round2(Math.max(0, DEFAULT_FREE_CREDITS - usedTrials + netCredits));
}

async function trialsRemaining(userId) {
  return await creditBalance(userId);
}

async function trialsUsed(userId) {
  const [trialRows, creditRows] = await Promise.all([
    col('trial_transactions').aggregate([
      { $match: { user_id: userId, type: 'TRIAL_CONSUMED' } },
      { $group: { _id: null, used: { $sum: '$amount' } } },
    ]).toArray(),
    col('credit_transactions').aggregate([
      { $match: { user_id: userId, type: 'CONSUME' } },
      { $group: { _id: null, used: { $sum: '$amount' } } },
    ]).toArray(),
  ]);
  const trialUsed = trialRows[0] ? -trialRows[0].used : 0;
  const creditUsed = creditRows[0] ? -creditRows[0].used : 0;
  return Math.max(0, trialUsed + creditUsed);
}

function creditsForMinutes(minutes) {
  const m = Math.max(0, Number(minutes) || 0);
  const blocks = Math.max(1, Math.ceil(m / TRIAL_MINUTES));
  return round2(blocks * CREDIT_PER_BLOCK);
}

async function entitlementMinutes(userId) {
  const balance = await creditBalance(userId);
  return balance * TRIAL_MINUTES;
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

  // If a trial or credit transaction was already deducted for this session and it is still valid (not expired), return existing allocation
  if (sessionId) {
    const sessionDoc = await col('call_sessions').findOne({ id: Number(sessionId), user_id: userId });
    const isEnded = sessionDoc && (sessionDoc.status === 'ended' || (sessionDoc.expires_at && isExpired(sessionDoc.expires_at)));
    if (sessionDoc && !isEnded) {
      return { kind: sessionDoc.billing_kind || 'trial', minutes: TRIAL_MINUTES };
    }
  }

  const remaining = await creditBalance(userId);
  if (remaining <= 0) {
    const err = new Error('All 5 free credits have been used. Payment is required to continue.');
    err.code = 'no_trials_left';
    err.status = 409;
    throw err;
  }

  const id = await nextId('trial_transactions');
  await col('trial_transactions').insertOne({
    id, user_id: userId, type: 'TRIAL_CONSUMED', amount: -1,
    session_id: sessionId ? Number(sessionId) : null, admin_id: null, reason: '15-min session created', created_at: nowSql(),
  });
  return { kind: 'trial', minutes: TRIAL_MINUTES };
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
  return { kind: session.billing_kind || 'trial', minutes: round2(minutes), credits: 1 };
}

async function accountSummary(userId) {
  const balance = await creditBalance(userId);
  const used = await trialsUsed(userId);
  const unlimited = await isUnlimited(userId);
  const grantedRows = await col('credit_transactions').aggregate([
    { $match: { user_id: userId, amount: { $gt: 0 } } },
    { $group: { _id: null, v: { $sum: '$amount' } } },
  ]).toArray();
  return {
    unlimited,
    credits: balance,
    credits_granted: round2(DEFAULT_FREE_CREDITS + (grantedRows[0] ? grantedRows[0].v : 0)),
    credits_used: round2(used),
    entitlement_minutes: unlimited ? UNLIMITED_MINUTES : balance * TRIAL_MINUTES,
    trials_total: DEFAULT_FREE_TRIALS,
    trials_used: used,
    trials_remaining: balance,
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
