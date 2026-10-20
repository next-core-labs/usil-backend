import {
  BOOKING_COMPLETED_STATUS,
  CANCELLING_BOOKING_STATUSES,
  bookingRefundPending,
  vendorHasBooking,
  vendorViewOfBooking,
  type PlatformBooking,
} from '../bookings/booking-store.ts';

/**
 * Usil's share of every platform order: 15% of the order total as stored
 * (prices are VAT-inclusive; there is no separate VAT line). The same rate the
 * old vendor wallet showed (`PLATFORM_COMMISSION` in VendorFinancialSuite.tsx).
 */
export const PLATFORM_COMMISSION_RATE = 0.15;

/**
 * Where one paid order's money sits for the vendor:
 * - `pending` — paid, in escrow until the order is «مكتمل».
 * - `available` — completed; counts toward what the vendor can withdraw.
 * - `excluded` — cancelled/rejected, or a refund is still owed on it.
 */
export type EarningsBucket = 'pending' | 'available' | 'excluded';

export type EarningsOrder = {
  id: string;
  eventDate: string;
  createdAt: string;
  status: string;
  /** This vendor's share of the order (their own lines on a mixed cart), riyals. */
  gross: number;
  commission: number;
  net: number;
  bucket: EarningsBucket;
  refundPending: boolean;
};

export type PayoutLike = { status: string; amount: number };

export type VendorEarnings = {
  currency: 'SAR';
  commissionRate: number;
  /** In escrow: paid orders not yet completed. */
  pending: number;
  /** Completed net earnings minus every requested, approved or paid payout. Never below zero. */
  available: number;
  /** Payouts marked paid by the admin. */
  paidOut: number;
  /** Payouts requested or approved, not yet transferred. */
  inReview: number;
  /** Net earnings of completed orders, before payouts. */
  earned: number;
  orders: EarningsOrder[];
};

const toHalalas = (riyals: number): number => {
  const n = Number(riyals);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const toRiyals = (halalas: number): number => halalas / 100;

function bucketOf(row: PlatformBooking): EarningsBucket {
  if (CANCELLING_BOOKING_STATUSES.includes(row.status) || bookingRefundPending(row)) return 'excluded';
  return row.status === BOOKING_COMPLETED_STATUS ? 'available' : 'pending';
}

/**
 * A vendor's balance, computed from the platform orders on every call — there
 * is no stored balance to drift. Mixed-vendor carts count only this vendor's
 * own lines (`vendorViewOfBooking`). Unpaid orders are not money yet and are
 * left out of the breakdown.
 */
export function computeVendorEarnings(input: {
  vendorId: string;
  ownListingIds: ReadonlySet<string>;
  bookings: PlatformBooking[];
  payouts: PayoutLike[];
}): VendorEarnings {
  const { vendorId, ownListingIds } = input;
  let pendingH = 0;
  let earnedH = 0;
  const orders: EarningsOrder[] = [];

  for (const row of input.bookings) {
    if (row.paymentStatus !== 'paid') continue;
    if (!vendorHasBooking(vendorId, ownListingIds, row)) continue;
    const view = vendorViewOfBooking(vendorId, ownListingIds, row);
    const grossH = Math.max(0, toHalalas(view.totalAmount));
    const commissionH = Math.round(grossH * PLATFORM_COMMISSION_RATE);
    const netH = grossH - commissionH;
    const bucket = bucketOf(row);
    if (bucket === 'pending') pendingH += netH;
    if (bucket === 'available') earnedH += netH;
    orders.push({
      id: row.id,
      eventDate: row.eventDate,
      createdAt: row.createdAt,
      status: row.status,
      gross: toRiyals(grossH),
      commission: toRiyals(commissionH),
      net: toRiyals(netH),
      bucket,
      refundPending: bookingRefundPending(row),
    });
  }

  let paidH = 0;
  let reviewH = 0;
  for (const payout of input.payouts) {
    if (payout.status === 'paid') paidH += toHalalas(payout.amount);
    else if (payout.status === 'requested' || payout.status === 'approved') reviewH += toHalalas(payout.amount);
  }

  return {
    currency: 'SAR',
    commissionRate: PLATFORM_COMMISSION_RATE,
    pending: toRiyals(pendingH),
    available: toRiyals(Math.max(0, earnedH - paidH - reviewH)),
    paidOut: toRiyals(paidH),
    inReview: toRiyals(reviewH),
    earned: toRiyals(earnedH),
    orders,
  };
}

/** Completed earnings minus reserved payouts, unclamped — negative means over-committed. */
export function rawBalanceHalalas(earnings: Pick<VendorEarnings, 'earned' | 'paidOut' | 'inReview'>): number {
  return toHalalas(earnings.earned) - toHalalas(earnings.paidOut) - toHalalas(earnings.inReview);
}
