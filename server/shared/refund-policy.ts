/**
 * سياسة الاسترجاع — المصدر الوحيد للنسب والمهل.
 *
 * The tier table below is the canonical wording rendered by BOTH legal
 * surfaces (`legal-static.ts` for crawlers and `RefundPolicy.tsx` for the SPA),
 * so the published policy and the arithmetic can never drift apart.
 *
 * These helpers are pure preview/calculation only. Nothing here moves money or
 * writes to a booking ledger — an actual refund still goes through Moyasar and
 * the amount Moyasar confirms is the amount of record.
 */

/** Saudi Arabia is a fixed UTC+3 offset with no daylight saving. */
const RIYADH_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type RefundTier = {
  /** مهلة الإلغاء */
  window: string;
  /** يسترجع العميل */
  customer: string;
  /** يستحق المورّد */
  vendor: string;
  /** Percent of the paid amount (service + VAT) returned to the customer. */
  customerPercent: 100 | 50 | 0;
};

/** Ordered widest-notice first; `customerRefundPercent` walks it in order. */
export const REFUND_TIERS: readonly RefundTier[] = [
  {
    window: 'قبل 7 أيام كاملة أو أكثر من موعد التوريد',
    customer: 'استرجاع كامل (100٪)',
    vendor: 'لا يستحق شيئًا',
    customerPercent: 100,
  },
  {
    window: 'من 3 أيام كاملة إلى أقل من 7 أيام',
    customer: 'استرجاع 50٪',
    vendor: 'يستحق 50٪',
    customerPercent: 50,
  },
  {
    window: 'أقل من 3 أيام، أو بعد بدء التنفيذ',
    customer: 'لا استرجاع',
    vendor: 'يستحق كامل المبلغ',
    customerPercent: 0,
  },
] as const;

export const FULL_REFUND_MIN_DAYS = 7;
export const HALF_REFUND_MIN_DAYS = 3;

/** Calendar date in Riyadh, as milliseconds at midnight. */
function riyadhMidnightMs(value: Date): number {
  const shifted = value.getTime() + RIYADH_UTC_OFFSET_MS;
  return Math.floor(shifted / MS_PER_DAY) * MS_PER_DAY;
}

/**
 * Whole calendar days from `now` until `eventDate`, counted on the Riyadh
 * calendar — the policy promises "أيام كاملة حسب تقويم الرياض", so the time of
 * day a customer cancels never changes which tier they land in.
 *
 * Returns 0 for a malformed or past date, which maps to the no-refund tier.
 */
export function calendarDaysUntilEvent(eventDate: string, now: Date = new Date()): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(eventDate || '').trim());
  if (!match) return 0;

  const eventMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const days = Math.round((eventMs - riyadhMidnightMs(now)) / MS_PER_DAY);
  return days > 0 ? days : 0;
}

/** Percent of the paid amount owed back to the customer on their cancellation. */
export function customerRefundPercent(eventDate: string, now: Date = new Date()): 100 | 50 | 0 {
  const days = calendarDaysUntilEvent(eventDate, now);
  if (days >= FULL_REFUND_MIN_DAYS) return 100;
  if (days >= HALF_REFUND_MIN_DAYS) return 50;
  return 0;
}

/** The tier row whose wording matches this cancellation date. */
export function refundTierFor(eventDate: string, now: Date = new Date()): RefundTier {
  const percent = customerRefundPercent(eventDate, now);
  return REFUND_TIERS.find((tier) => tier.customerPercent === percent) ?? REFUND_TIERS[REFUND_TIERS.length - 1];
}

/**
 * Preview only — never written to a booking. Moyasar amounts are in halalas,
 * so this stays in halalas to avoid a float round-trip through riyals.
 */
export function previewCustomerRefundHalalas(
  paidHalalas: number,
  eventDate: string,
  now: Date = new Date(),
): number {
  const paid = Number(paidHalalas);
  if (!Number.isFinite(paid) || paid <= 0) return 0;
  const percent = customerRefundPercent(eventDate, now);
  if (percent === 0) return 0;
  if (percent === 100) return Math.round(paid);
  return Math.round((paid * percent) / 100);
}
