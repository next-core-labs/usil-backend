/**
 * One row of `sessions.json`, keyed by the cookie token. Rows carry their own
 * expiry, so a copied token stops working when its cookie would have — the
 * cookie's Max-Age alone only binds an honest browser. A bare user id is a row
 * from before expiries existed; boot gives it one (see `LEGACY_SESSION_TTL_MS`).
 */
export type SessionRow = string | { userId: string; expiresAt: number };

export const SESSION_DAY_MS = 24 * 60 * 60 * 1000;
/** What a pre-expiry session gets when it is first seen: the longest «remember me». */
export const LEGACY_SESSION_TTL_MS = 30 * SESSION_DAY_MS;

export function sessionUserId(row: unknown): string {
  if (typeof row === 'string') return row;
  if (row && typeof row === 'object' && typeof (row as { userId?: unknown }).userId === 'string') {
    return (row as { userId: string }).userId;
  }
  return '';
}

export function sessionExpired(row: unknown, nowMs: number): boolean {
  if (typeof row === 'string') return false;
  const expiresAt = Number((row as { expiresAt?: unknown } | null)?.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= nowMs;
}
