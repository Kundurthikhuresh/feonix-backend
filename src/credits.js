const { col, nextId, nowSql, parseSql, isExpired, minutesBetween, publicDoc } = require('./db');

const DEFAULT_FREE_TRIALS = Number(process.env.DEFAULT_FREE_TRIALS || 5);
const TRIAL_MINUTES = 10;
const UNLIMITED_MINUTES = 24 * 60;
const MIN_PAID_CREDITS_TO_START = 0.5;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Unlimited session minutes is a billing entitlement, not an admin
// permission — it must never be implied by role alone.
async function isUnlimited(userId) {
  const row = await col('users').findOne({ id: userId });
  return Boolean(row && row.unlimited_sessions === true);
}

/**
 * Paid credit balance ONLY (separate from free trials).
 * 1 credit = 1 hour of Copilot access.
 * Sum of all GRANT (+), REFUND (+), ADJUST (+/-), and CONSUME (-) amounts.
 */
async function creditBalance(userId) {
  const creditRows = await col('credit_transactions').aggregate([
    { $match: { user_id: userId } },
    { $group: { _id: null, bal: { $sum: '$amount' } } },
  ]).toArray();
  const netCredits = Number(creditRows[0]?.bal) || 0;
  return round2(Math.max(0, netCredits));
}

/**
 * Free trials remaining for the user (exactly 5 on registration, minus consumed, plus any admin grants).
 * Never touches paid credit transactions.
 */
async function trialsRemaining(userId) {
  const [consumedRows, grantedRows] = await Promise.all([
    col('trial_transactions').aggregate([
      { $match: { user_id: userId, type: 'TRIAL_CONSUMED' } },
      { $group: { _id: null, used: { $sum: { $abs: '$amount' } } } },
    ]).toArray(),
    col('trial_transactions').aggregate([
      { $match: { user_id: userId, type: 'TRIAL_GRANTED' } },
      { $group: { _id: null, granted: { $sum: '$amount' } } },
    ]).toArray(),
  ]);

  const used = Number(consumedRows[0]?.used) || 0;
  const extraGranted = Number(grantedRows[0]?.granted) || 0;
  return Math.max(0, Math.floor(DEFAULT_FREE_TRIALS + extraGranted - used));
}

/**
 * Total free trials consumed by this user.
 */
async function trialsUsed(userId) {
  const consumedRows = await col('trial_transactions').aggregate([
    { $match: { user_id: userId, type: 'TRIAL_CONSUMED' } },
    { $group: { _id: null, used: { $sum: { $abs: '$amount' } } } },
  ]).toArray();
  return Number(consumedRows[0]?.used) || 0;
}

/**
 * Paid session billing deduction rule:
 * creditsToDeduct = Math.ceil(usageSeconds / 1800) * 0.5
 * For zero usage (0 seconds), deduct zero credits.
 * 1s-30m: 0.5
 * 30m 1s-60m: 1.0
 * 60m 1s-90m: 1.5
 * 90m 1s-120m: 2.0
 * etc.
 */
function calculatePaidCreditsToDeduct(usageSeconds) {
  const sec = Math.max(0, Math.floor(Number(usageSeconds) || 0));
  if (sec <= 0) return 0;
  return round2(Math.ceil(sec / 1800) * 0.5);
}

function creditsForMinutes(minutes) {
  const sec = Math.max(0, Number(minutes) || 0) * 60;
  return calculatePaidCreditsToDeduct(sec);
}

async function entitlementMinutes(userId) {
  const balance = await creditBalance(userId);
  return Math.round(balance * 60);
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

/**
 * Authorizes and opens a session under either Free Trial or Paid Credits.
 * - Free Trial: Immediately and atomically consumes 1 trial (10-minute limit).
 * - Paid Credits: Verifies balance >= 0.5 credits and sets max allowed duration.
 * - Idempotent: If already authorized/active and not expired, returns existing allocation.
 */
async function openSession(userId, sessionId, requestedKind) {
  if (await isUnlimited(userId)) {
    return { kind: 'unlimited', minutes: UNLIMITED_MINUTES };
  }

  // Idempotency: If this session is already active and unexpired, return existing allocation
  if (sessionId) {
    const sessionDoc = await col('call_sessions').findOne({ id: Number(sessionId), user_id: userId });
    const isEnded = sessionDoc && (sessionDoc.status === 'ended' || (sessionDoc.expires_at && isExpired(sessionDoc.expires_at)));
    if (sessionDoc && sessionDoc.status === 'active' && !isEnded) {
      const isTrial = sessionDoc.billing_kind === 'trial' || sessionDoc.plan === 'free';
      const maxMin = isTrial ? TRIAL_MINUTES : (sessionDoc.max_minutes || 60);
      return { kind: sessionDoc.billing_kind || 'trial', minutes: maxMin, existing: true };
    }
  }

  // Determine requested mode: 'trial' or 'paid'
  const isPaid = requestedKind === 'paid' || requestedKind === 'full';

  if (!isPaid) {
    // One trial per session, however many start requests arrive. Two starts
    // in flight together (each takes seconds against Atlas) both passed the
    // "already active?" check above and each charged a trial. Claiming the
    // session document is a single atomic update, so only one caller wins.
    if (sessionId) {
      const claimed = await col('call_sessions').findOneAndUpdate(
        { id: Number(sessionId), user_id: userId, trial_charged: { $ne: true } },
        { $set: { trial_charged: true } }
      );
      const claimedDoc = claimed && Object.prototype.hasOwnProperty.call(claimed, 'value') ? claimed.value : claimed;
      if (!claimedDoc) return { kind: 'trial', minutes: TRIAL_MINUTES, existing: true };
      // Sessions charged before this flag existed already have their row.
      const alreadyCharged = await col('trial_transactions').findOne({
        user_id: userId, type: 'TRIAL_CONSUMED', session_id: Number(sessionId),
      });
      if (alreadyCharged) return { kind: 'trial', minutes: TRIAL_MINUTES, existing: true };
    }

    // Free Trial requested
    const remainingTrials = await trialsRemaining(userId);
    if (remainingTrials <= 0) {
      if (sessionId) {
        await col('call_sessions').updateOne({ id: Number(sessionId), user_id: userId }, { $unset: { trial_charged: '' } });
      }
      const err = new Error('All 5 free trials have been used. Please purchase paid credits to continue.');
      err.code = 'no_trials_left';
      err.status = 409;
      throw err;
    }

    // Consume 1 complete trial immediately
    const id = await nextId('trial_transactions');
    await col('trial_transactions').insertOne({
      id,
      user_id: userId,
      type: 'TRIAL_CONSUMED',
      amount: -1,
      session_id: sessionId ? Number(sessionId) : null,
      admin_id: null,
      reason: '10-minute free trial session',
      created_at: nowSql(),
    });

    return { kind: 'trial', minutes: TRIAL_MINUTES };
  }

  // Paid Credits requested
  const paidCredits = await creditBalance(userId);
  if (paidCredits < MIN_PAID_CREDITS_TO_START) {
    const err = new Error('You need at least 0.5 paid credits (30 minutes) to start a paid session. Please purchase credits.');
    err.code = 'insufficient_credits';
    err.status = 402;
    throw err;
  }

  // Max duration allowed by user's paid credit balance (1 credit = 60 minutes)
  const maxMinutes = Math.floor(paidCredits * 60);
  return { kind: 'paid', minutes: maxMinutes };
}

/**
 * Settles a completed or stopped session:
 * - Free trial: Stamps end duration, charges 0 credits (trial was consumed at start).
 * - Paid session: Deducts credits based on Math.ceil(usageSeconds / 1800) * 0.5.
 * - Idempotent: Safely executed only once per session via atomic check on settled_at.
 */
async function settleSession(session) {
  if (!session || session.settled_at) return null;

  const started = session.started_at;
  const ended = session.ended_at || nowSql();
  const startMs = parseSql(started);
  const endMs = parseSql(ended);
  const usageSeconds = Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.max(0, Math.floor((endMs - startMs) / 1000))
    : 0;

  const stamped = await col('call_sessions').findOneAndUpdate(
    { id: session.id, settled_at: null },
    { $set: { settled_at: nowSql(), duration_seconds: usageSeconds } },
    { returnDocument: 'after' }
  );
  const updated = stamped && stamped.id ? stamped : stamped && stamped.value;
  if (!updated) return null;

  if (session.billing_kind === 'unlimited') {
    await col('call_sessions').updateOne({ id: session.id }, { $set: { credits_charged: 0 } });
    return { kind: 'unlimited', duration_seconds: usageSeconds, minutes: round2(usageSeconds / 60), credits: 0 };
  }

  if (session.billing_kind === 'trial' || session.plan === 'free') {
    await col('call_sessions').updateOne({ id: session.id }, { $set: { credits_charged: 0 } });
    return { kind: 'trial', duration_seconds: usageSeconds, minutes: round2(usageSeconds / 60), credits: 0, trials_deducted: 1 };
  }

  // Paid Session: Apply half-hour block billing rules
  const creditsToDeduct = calculatePaidCreditsToDeduct(usageSeconds);
  if (creditsToDeduct > 0) {
    const id = await nextId('credit_transactions');
    await col('credit_transactions').insertOne({
      id,
      user_id: session.user_id,
      type: 'CONSUME',
      amount: -creditsToDeduct,
      session_id: session.id,
      usage_minutes: round2(usageSeconds / 60),
      reason: `Paid session usage (${Math.round(usageSeconds / 60)} min)`,
      created_at: nowSql(),
    });
  }

  await col('call_sessions').updateOne({ id: session.id }, { $set: { credits_charged: creditsToDeduct } });
  return { kind: 'paid', duration_seconds: usageSeconds, minutes: round2(usageSeconds / 60), credits: creditsToDeduct };
}

async function accountSummary(userId) {
  const [trialRem, trialUsed, paidBal, unlimited] = await Promise.all([
    trialsRemaining(userId),
    trialsUsed(userId),
    creditBalance(userId),
    isUnlimited(userId),
  ]);

  const [grantedRows, consumedRows] = await Promise.all([
    col('credit_transactions').aggregate([
      { $match: { user_id: userId, amount: { $gt: 0 } } },
      { $group: { _id: null, v: { $sum: '$amount' } } },
    ]).toArray(),
    col('credit_transactions').aggregate([
      { $match: { user_id: userId, type: 'CONSUME' } },
      { $group: { _id: null, v: { $sum: { $abs: '$amount' } } } },
    ]).toArray(),
  ]);

  const paidGranted = round2(grantedRows[0]?.v || 0);
  const paidUsed = round2(consumedRows[0]?.v || 0);

  return {
    unlimited,
    credits: paidBal,
    credits_granted: paidGranted,
    credits_used: paidUsed,
    entitlement_minutes: unlimited ? UNLIMITED_MINUTES : Math.round(paidBal * 60),
    trials_total: DEFAULT_FREE_TRIALS,
    trials_used: trialUsed,
    trials_remaining: trialRem,
    trial_minutes: TRIAL_MINUTES,
  };
}

module.exports = {
  DEFAULT_FREE_TRIALS,
  UNLIMITED_MINUTES,
  TRIAL_MINUTES,
  MIN_PAID_CREDITS_TO_START,
  isUnlimited,
  creditBalance,
  trialsRemaining,
  trialsUsed,
  calculatePaidCreditsToDeduct,
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
