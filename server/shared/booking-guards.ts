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

type ClientIpEnv = { CLIENT_IP_HEADER?: string; NODE_ENV?: string };

function runtimeEnv(): ClientIpEnv {
  const proc = (globalThis as { process?: { env?: ClientIpEnv } }).process;
  return proc?.env || {};
}

function firstHeaderValue(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || '')
    .split(',')[0]
    .trim();
}

/**
 * The caller's IP, for rate-limit keys. Production runs Cloudflare → Caddy →
 * node, so the raw `X-Forwarded-For` is caller-controlled and never read here —
 * trusting it let anyone reset their rate-limit budget per request.
 *
 * - `CLIENT_IP_HEADER` set: that header (first value), e.g. `cf-connecting-ip`.
 * - otherwise in production: `cf-connecting-ip`, which Cloudflare overwrites.
 * - fallback: the TCP peer (`socket.remoteAddress`).
 */
export function clientIp(
  req: {
    headers?: Record<string, unknown>;
    socket?: { remoteAddress?: string };
  },
  env: ClientIpEnv = runtimeEnv(),
): string {
  const configured = String(env.CLIENT_IP_HEADER || '').trim().toLowerCase();
  const header = configured || (env.NODE_ENV === 'production' ? 'cf-connecting-ip' : '');
  if (header) {
    const value = firstHeaderValue(req.headers?.[header]);
    if (value) return value;
  }
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
