/**
 * Subscription plan enforcement.
 * Plans: free | pro | premium
 * All limits enforced server-side only.
 */
const { col, nextId, nowSql, startOfMonthSql } = require('./db');

// Monthly feature limits per plan
const PLAN_LIMITS = {
  free: {
    resume_analyses: 3,
    ai_generations: 10,
    job_matches: 5,
    cover_letters: 3,
    interview_prep: 3,
  },
  pro: {
    resume_analyses: 30,
    ai_generations: 100,
    job_matches: 50,
    cover_letters: 30,
    interview_prep: 30,
  },
  premium: {
    resume_analyses: Infinity,
    ai_generations: Infinity,
    job_matches: Infinity,
    cover_letters: Infinity,
    interview_prep: Infinity,
  },
};

// Get user's current plan (server-side read from DB)
async function getUserPlan(userId) {
  const user = await col('users').findOne({ id: userId });
  if (!user) return 'free';
  // Owner role is always unlimited (maps to premium)
  if (user.role === 'owner') return 'premium';
  const status = user.subscription_status;
  if (status === 'active' || status === 'trialing') {
    return user.plan || 'free';
  }
  return 'free';
}

// Count how many times a feature was used this month
async function featureUsedThisMonth(userId, feature) {
  const monthStart = startOfMonthSql();
  const rows = await col('ai_usage').aggregate([
    {
      $match: {
        user_id: userId,
        feature,
        created_at: { $gte: monthStart },
      },
    },
    { $count: 'total' },
  ]).toArray();
  return rows[0] ? rows[0].total : 0;
}

// Check if user can use a feature, returns { allowed, used, limit, plan }
async function checkFeatureLimit(userId, feature) {
  const plan = await getUserPlan(userId);
  const limit = (PLAN_LIMITS[plan] || PLAN_LIMITS.free)[feature];
  if (!limit && limit !== 0) return { allowed: true, used: 0, limit: Infinity, plan };
  if (limit === Infinity) return { allowed: true, used: 0, limit: Infinity, plan };
  const used = await featureUsedThisMonth(userId, feature);
  return { allowed: used < limit, used, limit, plan };
}

// Track a feature usage event
async function trackFeatureUsage(userId, feature, metadata = {}) {
  const id = await nextId('ai_usage');
  await col('ai_usage').insertOne({
    id,
    user_id: userId,
    feature,
    metadata,
    created_at: nowSql(),
  });
}

/**
 * Express middleware factory.
 * Usage: router.post('/analyze', requirePlan('pro'), handler)
 */
function requirePlan(minimumPlan) {
  const planRank = { free: 0, pro: 1, premium: 2 };
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
      const plan = await getUserPlan(req.user.id);
      if ((planRank[plan] || 0) < (planRank[minimumPlan] || 1)) {
        return res.status(403).json({
          error: 'plan_required',
          message: `This feature requires the ${minimumPlan} plan or higher.`,
          required_plan: minimumPlan,
          current_plan: plan,
          upgrade_url: '/pricing',
        });
      }
      req.userPlan = plan;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Express middleware factory that checks AND tracks feature usage.
 * Usage: router.post('/analyze', enforceFeatureLimit('resume_analyses'), handler)
 */
function enforceFeatureLimit(feature) {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
      const { allowed, used, limit, plan } = await checkFeatureLimit(req.user.id, feature);
      if (!allowed) {
        return res.status(429).json({
          error: 'feature_limit_reached',
          message: `You've reached your monthly limit of ${limit} ${feature.replace(/_/g, ' ')} on the ${plan} plan.`,
          used,
          limit,
          plan,
          upgrade_url: '/pricing',
        });
      }
      req.userPlan = plan;
      req.featureCheck = { used, limit, plan };
      // Track usage (fire-and-forget — don't block the response)
      trackFeatureUsage(req.user.id, feature, {}).catch(console.error);
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = {
  PLAN_LIMITS,
  getUserPlan,
  checkFeatureLimit,
  trackFeatureUsage,
  requirePlan,
  enforceFeatureLimit,
};
