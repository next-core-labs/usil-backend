import type { ServiceItem } from '../../core/types.ts';
import { CANCELLING_BOOKING_STATUSES, type PlatformBooking } from '../bookings/booking-store.ts';

/**
 * «ترند هالأسبوع» — which listings are moving this week.
 *
 * The rank is computed from what really happened on the platform, never from
 * the listing's own numbers (`rating` and `reviewsCount` are 0 for every real
 * listing, so sorting by them is a coin toss):
 *
 * - a paid booking line in the window          → PAID_BOOKING_POINTS
 * - an unpaid but still-open booking line      → OPEN_BOOKING_POINTS
 * - a cancelled or vendor-rejected line         → nothing
 * - a product-page open (`listing-views.json`)  → VIEW_POINTS
 *
 * Quantity is deliberately ignored: 200 chairs on one order are one decision,
 * not two hundred.
 *
 * A young marketplace has weeks with no signal at all, so the shelf is padded
 * with the newest listings (flagged `isNew`) up to `limit`. The storefront only
 * draws the section with three or more rows.
 */
export const TRENDING_WINDOW_DAYS = 7;
export const TRENDING_DEFAULT_LIMIT = 8;
export const TRENDING_MAX_LIMIT = 24;

export const PAID_BOOKING_POINTS = 5;
export const OPEN_BOOKING_POINTS = 2;
export const VIEW_POINTS = 0.25;

export type TrendingStats = {
  rank: number;
  /** Weighted score behind the rank; the storefront draws it as a relative bar. */
  score: number;
  /** Booking lines in the window that were not cancelled or rejected. */
  bookings: number;
  /** Of those, the lines whose order Moyasar settled. */
  paidBookings: number;
  /** Product-page opens in the window. */
  views: number;
  /** The listing was created inside the window. */
  isNew: boolean;
  windowDays: number;
};

export type TrendingService = ServiceItem & { trending: TrendingStats };

export type TrendingInput = {
  /** The public catalog, exactly as `GET /api/catalog/listings` serves it. */
  services: ServiceItem[];
  /** Platform bookings (`bookings.json`). Only lines for listed services count. */
  bookings: PlatformBooking[];
  /** Product-page opens per listing id over the same window. */
  views: Map<string, number>;
  /** `createdAt` per listing id, for the newness pad and the final tie-break. */
  createdAt: Map<string, string>;
  now: Date;
  windowDays?: number;
  limit?: number;
};

/**
 * Bookings are stamped `YYYY-MM-DD HH:mm` in UTC without a zone marker
 * (`booking-routes.ts`); older rows may carry a full ISO string.
 */
export function parseBookingTime(raw: unknown): number | null {
  const text = String(raw || '').trim();
  if (!text) return null;
  let iso = text.replace(' ', 'T');
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(iso)) iso = `${iso}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function parseAnyTime(raw: unknown): number | null {
  const text = String(raw || '').trim();
  if (!text) return null;
  const ms = Date.parse(text);
  if (!Number.isNaN(ms)) return ms;
  return parseBookingTime(text);
}

function clampLimit(limit: unknown): number {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n < 1) return TRENDING_DEFAULT_LIMIT;
  return Math.min(n, TRENDING_MAX_LIMIT);
}

type Tally = { bookings: number; paidBookings: number; views: number; score: number };

/** Booking lines per listing id inside the window, split by payment state. */
export function tallyBookings(
  bookings: PlatformBooking[],
  listingIds: Set<string>,
  sinceMs: number,
  untilMs: number,
): Map<string, { bookings: number; paidBookings: number }> {
  const tally = new Map<string, { bookings: number; paidBookings: number }>();
  for (const booking of bookings) {
    if (!booking || typeof booking !== 'object') continue;
    if (CANCELLING_BOOKING_STATUSES.includes(String(booking.status || ''))) continue;
    const placedAt = parseBookingTime(booking.createdAt);
    if (placedAt === null || placedAt < sinceMs || placedAt > untilMs) continue;
    const paid = booking.paymentStatus === 'paid';
    const lines = Array.isArray(booking.items) && booking.items.length ? booking.items : [{ id: booking.serviceId }];
    const seen = new Set<string>();
    for (const line of lines) {
      const id = String((line as { id?: unknown })?.id || '').trim();
      if (!id || seen.has(id) || !listingIds.has(id)) continue;
      seen.add(id);
      const row = tally.get(id) || { bookings: 0, paidBookings: 0 };
      row.bookings += 1;
      if (paid) row.paidBookings += 1;
      tally.set(id, row);
    }
  }
  return tally;
}

export function rankTrending(input: TrendingInput): TrendingService[] {
  const windowDays = input.windowDays && input.windowDays > 0 ? input.windowDays : TRENDING_WINDOW_DAYS;
  const limit = clampLimit(input.limit);
  const untilMs = input.now.getTime();
  const sinceMs = untilMs - windowDays * 24 * 60 * 60 * 1000;

  const byId = new Map<string, ServiceItem>();
  for (const service of input.services) {
    const id = String(service?.id || '').trim();
    if (id && !byId.has(id)) byId.set(id, service);
  }
  const bookingTally = tallyBookings(input.bookings, new Set(byId.keys()), sinceMs, untilMs);

  const createdMs = (id: string) => parseAnyTime(input.createdAt.get(id)) ?? 0;

  const rows = Array.from(byId.entries()).map(([id, service]) => {
    const booked = bookingTally.get(id) || { bookings: 0, paidBookings: 0 };
    const views = Math.max(0, Math.floor(input.views.get(id) || 0));
    const score =
      booked.paidBookings * PAID_BOOKING_POINTS +
      (booked.bookings - booked.paidBookings) * OPEN_BOOKING_POINTS +
      views * VIEW_POINTS;
    const tally: Tally = { ...booked, views, score };
    return { id, service, tally, isNew: createdMs(id) >= sinceMs && createdMs(id) > 0 };
  });

  rows.sort((a, b) => {
    if (b.tally.score !== a.tally.score) return b.tally.score - a.tally.score;
    if (b.tally.bookings !== a.tally.bookings) return b.tally.bookings - a.tally.bookings;
    if (b.tally.views !== a.tally.views) return b.tally.views - a.tally.views;
    const created = createdMs(b.id) - createdMs(a.id);
    if (created !== 0) return created;
    return a.id.localeCompare(b.id);
  });

  return rows.slice(0, limit).map((row, index) => ({
    ...row.service,
    trending: {
      rank: index + 1,
      score: Math.round(row.tally.score * 100) / 100,
      bookings: row.tally.bookings,
      paidBookings: row.tally.paidBookings,
      views: row.tally.views,
      isNew: row.isNew,
      windowDays,
    },
  }));
}
