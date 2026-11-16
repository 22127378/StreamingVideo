/**
 * Rate limit theo IP, cửa sổ cố định, lưu trong bộ nhớ.
 * Mỗi pod đếm riêng, nên giới hạn thực tế là max * số pod. Đủ để chặn một client
 * gọi liên tục tạo upload; muốn giới hạn chung cho cả cụm thì dùng AWS WAF rate-based rule.
 * @param {{ max: number, windowSeconds: number, now?: () => number }} options
 */
export function createRateLimiter({ max, windowSeconds, now = Date.now }) {
  const hits = new Map();
  const windowMs = windowSeconds * 1000;

  // Dọn các IP đã hết cửa sổ để Map không phình mãi
  const sweeper = setInterval(() => {
    const t = now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= t) hits.delete(key);
    }
  }, windowMs);
  sweeper.unref();

  return function rateLimit(req, res, next) {
    if (!max) return next();

    const key = req.ip || 'unknown';
    const t = now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - t) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        success: false,
        message: `Quá nhiều request, thử lại sau ${retryAfter}s`,
      });
    }
    next();
  };
}
