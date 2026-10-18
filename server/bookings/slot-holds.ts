/**
 * حجز التاريخ — one listing serves one event per day. A date is taken for a
 * listing by any live order or vendor-recorded booking on it, so the store
 * can't sell the same day twice.
 *
 * What holds a listing's date:
 * - a paid platform order that is still going ahead;
 * - an order waiting on the vendor, approved, in progress or completed
 *   (approved-but-unpaid included: the vendor said yes to that customer);
 * - a fresh unpaid instant order, for `CHECKOUT_HOLD_MS` — the customer is on
 *   Moyasar's page. After that an abandoned checkout stops holding the date;
 *   whoever books the date next makes it lapse (see `staleCheckoutsOn`);
 * - a booking the vendor recorded in their own calendar (phone, Instagram, POS…)
 *   against that listing, unless it was cancelled.
 */
import { BOOKING_CANCELLED_STATUS, bookedListingIds, bookingCreatedAtMs, type PlatformBooking } from './booking-store.ts';
import { BOOKING_NEW_STATUS, BOOKING_REJECTED_STATUS } from '../vendors/vendor-listings.ts';

export const CHECKOUT_HOLD_MS = 45 * 60_000;

/** Vendor calendar statuses that mean the booking is off. */
const VENDOR_CANCELLED = new Set(['cancelled', 'ملغي', BOOKING_REJECTED_STATUS]);

export type VendorCalendarBooking = { id?: string; serviceId?: string; date?: string; status?: string };

function isEnded(row: Pick<PlatformBooking, 'status'>): boolean {
  return row.status === BOOKING_CANCELLED_STATUS || row.status === BOOKING_REJECTED_STATUS;
}

/** An unpaid instant order past its payment window: it no longer holds its date. */
export function isStaleCheckout(row: PlatformBooking, nowMs: number): boolean {
  return (
    !isEnded(row) &&
    row.paymentStatus !== 'paid' &&
    row.status === BOOKING_NEW_STATUS &&
    nowMs - bookingCreatedAtMs(row.createdAt) > CHECKOUT_HOLD_MS
  );
}

/** Does this platform order hold the date of the listings on it? */
export function platformOrderHoldsDate(row: PlatformBooking, nowMs: number): boolean {
  if (isEnded(row)) return false;
  if (row.paymentStatus === 'paid') return true;
  if (row.status !== BOOKING_NEW_STATUS) return true;
  return !isStaleCheckout(row, nowMs);
}

export type SlotConflict =
  | { kind: 'order'; listingId: string; booking: PlatformBooking }
  | { kind: 'vendor'; listingId: string; bookingId?: string };

/** The first live booking holding any of `listingIds` on `date`, other than `excludeId`. */
export function findSlotConflict(input: {
  listingIds: readonly string[];
  date: string;
  orders: readonly PlatformBooking[];
  vendorBookings?: readonly VendorCalendarBooking[];
  excludeId?: string;
  /** Orders that don't count here (approval: another order also waiting on the vendor). */
  ignoreOrder?: (row: PlatformBooking) => boolean;
  nowMs: number;
}): SlotConflict | null {
  const wanted = new Set(input.listingIds.map(String).filter(Boolean));
  if (!wanted.size || !input.date) return null;
  for (const row of input.orders) {
    if (row.id === input.excludeId || row.eventDate !== input.date) continue;
    if (!platformOrderHoldsDate(row, input.nowMs) || input.ignoreOrder?.(row)) continue;
    const hit = bookedListingIds(row).find((id) => wanted.has(id));
    if (hit) return { kind: 'order', listingId: hit, booking: row };
  }
  for (const row of input.vendorBookings || []) {
    if (!row || String(row.date || '').slice(0, 10) !== input.date) continue;
    if (VENDOR_CANCELLED.has(String(row.status || ''))) continue;
    const listingId = String(row.serviceId || '');
    if (wanted.has(listingId)) return { kind: 'vendor', listingId, bookingId: row.id };
  }
  return null;
}

/** Abandoned checkouts on these listings and date: they lapse when someone else books it. */
export function staleCheckoutsOn(input: {
  listingIds: readonly string[];
  date: string;
  orders: readonly PlatformBooking[];
  nowMs: number;
}): PlatformBooking[] {
  const wanted = new Set(input.listingIds.map(String));
  return input.orders.filter(
    (row) =>
      row.eventDate === input.date &&
      isStaleCheckout(row, input.nowMs) &&
      bookedListingIds(row).some((id) => wanted.has(id)),
  );
}

/** Dates (YYYY-MM-DD, from `fromDate` on) a listing is already taken on. */
export function takenDatesForListing(input: {
  listingId: string;
  orders: readonly PlatformBooking[];
  vendorBookings?: readonly VendorCalendarBooking[];
  fromDate: string;
  nowMs: number;
}): string[] {
  const out = new Set<string>();
  for (const row of input.orders) {
    if (row.eventDate < input.fromDate) continue;
    if (!platformOrderHoldsDate(row, input.nowMs)) continue;
    if (bookedListingIds(row).includes(input.listingId)) out.add(row.eventDate);
  }
  for (const row of input.vendorBookings || []) {
    const date = String(row?.date || '').slice(0, 10);
    if (!date || date < input.fromDate || VENDOR_CANCELLED.has(String(row.status || ''))) continue;
    if (String(row.serviceId || '') === input.listingId) out.add(date);
  }
  return Array.from(out).sort();
}
