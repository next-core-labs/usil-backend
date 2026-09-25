import { hasCheckoutPrice, isPublicMarketplaceListing } from '../../core/utils/catalogMedia.ts';
import { enrichVendorService } from '../../core/data/saudiMarket.ts';
import { listingToServiceItem, requiresVendorApproval, type VendorListing } from '../vendors/vendor-listings.ts';
import type { PlatformBookingItem } from './booking-store.ts';

/**
 * Server-side checkout quote. Mirrors the cart total in `BookingDrawer.tsx`
 * (Σ listing price × quantity — no guest multiplier, add-ons or VAT line),
 * but reads every price from the stored listing, so a client-sent price or
 * total never reaches an invoice.
 */

/** Riyadh is a fixed UTC+3 offset with no daylight saving. */
const RIYADH_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;
export const MAX_LINE_QUANTITY = 999;

export const LISTING_UNAVAILABLE = 'المنتج غير متاح للطلب حالياً. حدّث الصفحة واختر منتجاً معروضاً.';
export const BAD_QUANTITY = `الكمية لكل منتج رقم صحيح من 1 إلى ${MAX_LINE_QUANTITY}`;
export const EMPTY_CART = 'السلة فارغة. أضف منتجاً قبل تأكيد الطلب.';
export const NO_REAL_PRICE =
  'ثبّت سعر المنتج قبل الدفع الإلكتروني. ميسر ما يخصم إلا بعد سعر حقيقي من المورّد.';

export type PricedListing = Pick<VendorListing, 'id' | 'vendorId' | 'title' | 'price'> &
  Partial<Pick<VendorListing, 'bookingMode' | 'images' | 'image' | 'fulfillment' | 'priceUnit' | 'cities'>>;

export type BookingQuote =
  | {
      ok: true;
      totalAmount: number;
      lines: PlatformBookingItem[];
      vendorIds: string[];
      needsVendorApproval: boolean;
    }
  | { ok: false; error: string };

/** Today on the Riyadh calendar as `YYYY-MM-DD`. */
export function riyadhToday(now: Date = new Date()): string {
  return new Date(now.getTime() + RIYADH_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/** A real calendar date in `YYYY-MM-DD` form. */
export function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

/**
 * Same test the public catalog applies (`GET /api/catalog/listings`): the
 * vendor is an approved vendor account and the card has a real photo and price.
 */
export function isOrderableListing(listing: PricedListing, approvedVendorIds: ReadonlySet<string>): boolean {
  if (!approvedVendorIds.has(String(listing.vendorId || ''))) return false;
  try {
    const card = enrichVendorService(
      listingToServiceItem({
        cities: [],
        fulfillment: [],
        ...listing,
      } as VendorListing),
    );
    return isPublicMarketplaceListing(card);
  } catch {
    return false;
  }
}

function roundSar(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Cart rows arrive as `{ id, quantity }`; any `price` or `title` on them is
 * ignored. With no rows, the single `serviceId` is booked once.
 */
export function quoteBooking(input: {
  serviceId?: unknown;
  items?: unknown;
  listings: PricedListing[];
  approvedVendorIds: ReadonlySet<string>;
}): BookingQuote {
  const rawRows = Array.isArray(input.items) && input.items.length
    ? input.items
    : input.serviceId
      ? [{ id: input.serviceId, quantity: 1 }]
      : [];
  if (!rawRows.length) return { ok: false, error: EMPTY_CART };

  const quantities = new Map<string, number>();
  for (const row of rawRows) {
    const id = String((row as { id?: unknown })?.id ?? '').trim();
    if (!id) return { ok: false, error: LISTING_UNAVAILABLE };
    const rawQty = (row as { quantity?: unknown })?.quantity;
    const qty = rawQty === undefined || rawQty === null || rawQty === '' ? 1 : Number(rawQty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_LINE_QUANTITY) return { ok: false, error: BAD_QUANTITY };
    const merged = (quantities.get(id) || 0) + qty;
    if (merged > MAX_LINE_QUANTITY) return { ok: false, error: BAD_QUANTITY };
    quantities.set(id, merged);
  }

  const byId = new Map(input.listings.map((listing) => [String(listing.id), listing]));
  const lines: PlatformBookingItem[] = [];
  let total = 0;
  let needsVendorApproval = false;
  for (const [id, quantity] of quantities) {
    const listing = byId.get(id);
    if (!listing || !isOrderableListing(listing, input.approvedVendorIds)) {
      return { ok: false, error: LISTING_UNAVAILABLE };
    }
    const price = Number(listing.price);
    if (!hasCheckoutPrice(price)) return { ok: false, error: NO_REAL_PRICE };
    if (requiresVendorApproval(listing.bookingMode)) needsVendorApproval = true;
    lines.push({ id, title: listing.title, quantity, price, vendorId: String(listing.vendorId) });
    total += price * quantity;
  }

  const totalAmount = roundSar(total);
  if (!hasCheckoutPrice(totalAmount)) return { ok: false, error: NO_REAL_PRICE };
  return {
    ok: true,
    totalAmount,
    lines,
    vendorIds: Array.from(new Set(lines.map((line) => line.vendorId))),
    needsVendorApproval,
  };
}
