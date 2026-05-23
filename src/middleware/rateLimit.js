export function createFixedWindowRateLimiter({
  windowMs = 60000,
  max = 30,
  keyGenerator = (req) => req.ip ?? req.headers['x-forwarded-for'] ?? 'unknown'
} = {}) {
  const buckets = new Map();

  return function fixedWindowRateLimiter(req, res, next) {
    const now = Date.now();
    const key = keyGenerator(req);
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, {
        count: 1,
        resetAt: now + windowMs
      });
      next();
      return;
    }

    bucket.count += 1;

    if (bucket.count <= max) {
      next();
      return;
    }

    const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
    req.log?.warn(
      {
        correlationId: req.correlationId,
        rateLimitKey: key,
        retryAfterSeconds
      },
      'Webhook rate limit exceeded'
    );

    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({
      status: 'error',
      message: 'Too many webhook requests'
    });
  };
}
