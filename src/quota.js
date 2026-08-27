// Token quota — now a cost safety-rail, not a user entitlement.
//
// token_quota predates the credit system. It capped how many OpenAI tokens a
// user could spend per month and blocked answers, transcription, vision and
// notes with a 429 when exhausted. That made it a SECOND entitlement gate: a
// user holding valid credits could still be refused, for a reason unrelated to
// anything they bought.
//
// Credits are now the single source of truth for what a user is entitled to.
// A paid session's length is bounded by its credit balance, and a trial by ten
// minutes, so usage is already bounded by the thing the user paid for.
//
// What is kept, and why:
//
//   * The `usage` table still records every call's real token cost. That is
//     genuine operational data — it is what the cost-per-hour figures and the
//     admin usage views are built from — and nothing about it blocks a user.
//
//   * token_quota itself is retained as an OPT-IN backstop against runaway
//     spend (a stuck retry loop, an abusive account). It is OFF by default.
//     Set ENFORCE_TOKEN_QUOTA=1 to re-arm it.
//
// With enforcement off, `blocked` is always false and callers fall back to
// their own maximum output budget.

const ENFORCED = process.env.ENFORCE_TOKEN_QUOTA === '1';

/**
 * Should this request be refused on token grounds?
 *
 * @param {object} user     the authenticated user row
 * @param {number} used     tokens already spent this month
 * @param {number} needed   tokens this request needs at minimum
 * @returns {{ enforced: boolean, blocked: boolean, remaining: number }}
 */
function check(user, used, needed = 0) {
  const remaining = Math.max(0, (user.token_quota || 0) - used);
  if (!ENFORCED) {
    // Credits are the gate. Report the figure for display, never block on it.
    return { enforced: false, blocked: false, remaining };
  }
  return { enforced: true, blocked: remaining <= needed, remaining };
}

/**
 * Output budget for a request. With enforcement off this is simply the route's
 * own cap — the quota must not silently shrink an answer.
 */
function outputBudget(cap, remaining, promptEstimate = 0) {
  if (!ENFORCED) return cap;
  return Math.min(cap, Math.max(0, remaining - promptEstimate));
}

module.exports = { ENFORCED, check, outputBudget };
