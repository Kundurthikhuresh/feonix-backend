// Shared in-memory sliding-window rate limiter. Extracted out of auth.js
// (which had this same function private to itself) so the AI/STT/vision
// endpoints below can reuse it instead of each hand-rolling their own —
// those are the ones that actually cost money per request and had no
// request-rate protection at all before, only the economic credit/quota
// gate in credits.js/quota.js.
const buckets = new Map();

function rateLimit({ windowMs, max, keyFn, errorCode = 'rate_limited', messagePrefix = 'Too many requests' }) {
  return (req, res, next) => {
    // Local dev/test traffic isn't worth throttling — same carve-out auth.js
    // already used for its own limiters.
    if (process.env.NODE_ENV !== 'production' || req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1') {
      return next();
    }
    const key = keyFn(req);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: errorCode,
        message: `${messagePrefix}. Try again in ${retryAfter}s.`,
      });
    }
    return next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

module.exports = { rateLimit };
