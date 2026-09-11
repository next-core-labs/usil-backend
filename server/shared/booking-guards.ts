/** Public POST /api/bookings guards: Saudi mobile + IP sliding window. */

export function normalizeSaudiMobile(raw: string): string | null {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('00966')) digits = digits.slice(2);
  if (digits.startsWith('966')) digits = `0${digits.slice(3)}`;
  if (digits.length === 9 && digits.startsWith('5')) digits = `0${digits}`;
  if (/^05[0-9]{8}$/.test(digits)) return digits;
  return null;
}

export function isValidSaudiMobile(raw: string): boolean {
  return normalizeSaudiMobile(raw) !== null;
}

export function clientIp(req: {
  headers?: Record<string, unknown>;
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  if (forwarded) return forwarded;
  if (req.ip) return req.ip;
  return req.socket?.remoteAddress || 'unknown';
}

export function createSlidingWindowLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return {
    allow(key: string, now = Date.now()): boolean {
      const next = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (next.length >= limit) {
        hits.set(key, next);
        return false;
      }
      next.push(now);
      hits.set(key, next);
      return true;
    },
  };
}
