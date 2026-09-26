import path from 'path';
import { readJsonArray, writeJsonFile } from '../shared/json-file.ts';
import {
  BOOKING_NEW_STATUS,
  BOOKING_PENDING_APPROVAL_STATUS,
  BOOKING_REJECTED_STATUS,
} from '../vendors/vendor-listings.ts';

/**
 * حجوزات المنصة — الطلبات القادمة من متجر يوصل نفسه.
 *
 * Distinct from `external-bookings.ts`, which holds offline bookings a courier
 * files by hand. These rows are created by guest or signed-in checkout and are
 * the records Moyasar webhooks settle against.
 */
export type PlatformBookingItem = {
  id: string;
  title: string;
  quantity: number;
  /** Unit price in riyals, copied from the listing at checkout — never from the client. */
  price: number;
  vendorId: string;
};

export type BookingCancellation = {
  cancelledAt: string;
  /** `admin` covers supervisors; a vendor may only cancel or reject an unpaid order. */
  cancelledBy: 'client' | 'vendor' | 'admin';
  /** Percent of the paid amount owed back, from `refund-policy.ts`. */
  refundPercent: 100 | 50 | 0;
  /** Owed back in halalas. Moyasar's confirmed refund stays the amount of record. */
  refundHalalas: number;
  /** `pending` = owed, not yet sent through Moyasar. Nothing here moves money. */
  refundStatus: 'pending' | 'none' | 'not_applicable';
  note: string;
};

export type PlatformBooking = {
  id: string;
  /** Session account that placed the order; absent for guest checkout. */
  userId?: string;
  name: string;
  phone: string;
  email: string;
  serviceId?: unknown;
  serviceName: string;
  notes: string;
  city: string;
  eventDate: string;
  paymentMethod: string;
  settlement: string;
  items: unknown[];
  /** Vendors whose listings are on this order — the vendor ownership key. */
  vendorIds?: string[];
  totalAmount: number;
  bookingMode: 'instant' | 'approval';
  status: string;
  paymentStatus: 'unpaid' | 'paid';
  createdAt: string;
  moyasarInvoiceId?: string;
  moyasarPaymentId?: string;
  paymentUrl?: string;
  cancellation?: BookingCancellation;
};

/** Identifiers a Moyasar callback or webhook can arrive with. */
export type MoyasarSettlement = {
  paymentId?: string;
  invoiceId?: string;
  bookingId?: string;
  status: string;
  /**
   * Amount Moyasar itself reports (halalas), read from the verified provider
   * record. A booking is only marked paid when this covers its total.
   */
  amountHalalas?: number;
  currency?: string;
};

export const BOOKING_CONFIRMED_STATUS = 'مؤكد';
export const BOOKING_IN_PROGRESS_STATUS = 'قيد التنفيذ';
export const BOOKING_COMPLETED_STATUS = 'مكتمل';
export const BOOKING_CANCELLED_STATUS = 'ملغي';

/**
 * The only statuses a platform order can hold — the same list the admin
 * dashboard offers (`STATUS_OPTIONS` in AdminDashboard.tsx).
 */
export const PLATFORM_BOOKING_STATUSES = [
  BOOKING_NEW_STATUS,
  BOOKING_PENDING_APPROVAL_STATUS,
  BOOKING_CONFIRMED_STATUS,
  BOOKING_REJECTED_STATUS,
  BOOKING_IN_PROGRESS_STATUS,
  BOOKING_COMPLETED_STATUS,
  BOOKING_CANCELLED_STATUS,
] as const;

export type PlatformBookingStatus = (typeof PLATFORM_BOOKING_STATUSES)[number];

export function isPlatformBookingStatus(value: unknown): value is PlatformBookingStatus {
  return typeof value === 'string' && (PLATFORM_BOOKING_STATUSES as readonly string[]).includes(value);
}

/** Statuses after which nothing is left to cancel. */
export const CLOSED_BOOKING_STATUSES: readonly string[] = [
  BOOKING_CANCELLED_STATUS,
  BOOKING_REJECTED_STATUS,
  BOOKING_COMPLETED_STATUS,
];

/** Statuses that end an order without it happening — the ones that owe a paid customer a refund. */
export const CANCELLING_BOOKING_STATUSES: readonly string[] = [BOOKING_CANCELLED_STATUS, BOOKING_REJECTED_STATUS];

export type StatusChanger = 'vendor' | 'admin';

export type StatusTransition =
  | { ok: true; /** An admin did what the vendor rule forbids — worth recording. */ override: boolean }
  | { ok: false; reason: 'final' | 'back_to_new' };

/**
 * Status rule. Cancelled, rejected and completed are final, and no order goes
 * back to «جديد» (that would put a handled order back in the new queue).
 * Admins may override either rule to fix a mistake; the result says so.
 * Re-saving the current status is always a no-op.
 */
export function checkStatusTransition(from: string, to: string, by: StatusChanger): StatusTransition {
  if (from === to) return { ok: true, override: false };
  const reason = CLOSED_BOOKING_STATUSES.includes(from)
    ? 'final'
    : to === BOOKING_NEW_STATUS
      ? 'back_to_new'
      : null;
  if (!reason) return { ok: true, override: false };
  if (by === 'admin') return { ok: true, override: true };
  return { ok: false, reason };
}

const PAID_SETTLEMENT_LABEL = 'ميسر — دفع إلكتروني';

/** Riyals → halalas without a float drift. */
export function bookingTotalHalalas(booking: Pick<PlatformBooking, 'totalAmount'>): number {
  const n = Number(booking.totalAmount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

/** Listing ids on a booking: the headline service plus every cart line. */
export function bookedListingIds(booking: Pick<PlatformBooking, 'serviceId' | 'items'>): string[] {
  const ids = [
    String(booking.serviceId ?? ''),
    ...(Array.isArray(booking.items) ? booking.items.map((row) => String((row as { id?: unknown })?.id ?? '')) : []),
  ].filter(Boolean);
  return Array.from(new Set(ids));
}

/** `createdAt` is stored as UTC `YYYY-MM-DD HH:mm`. */
export function bookingCreatedAtMs(createdAt: string): number {
  const ms = Date.parse(`${String(createdAt || '').replace(' ', 'T')}:00Z`);
  return Number.isFinite(ms) ? ms : 0;
}

export type ClientIdentity = { id?: string; email?: string; emailVerified?: boolean };

/**
 * A client owns an order placed from their session, or one checked out with
 * their email once that email is verified. Phone numbers never grant access —
 * anyone can type someone else's number at checkout or on their profile.
 */
export function clientOwnsBooking(identity: ClientIdentity, row: PlatformBooking): boolean {
  if (identity.id && row.userId && row.userId === identity.id) return true;
  const email = String(identity.email || '').trim().toLowerCase();
  if (identity.emailVerified === true && email && String(row.email || '').trim().toLowerCase() === email) {
    return true;
  }
  return false;
}

/**
 * Vendor ownership: the vendor's id is stamped on the row, or (for rows from
 * before stamping) one of the booked listings is theirs.
 */
export function vendorHasBooking(vendorId: string, ownListingIds: ReadonlySet<string>, row: PlatformBooking): boolean {
  if (!vendorId) return false;
  if (Array.isArray(row.vendorIds) && row.vendorIds.includes(vendorId)) return true;
  return bookedListingIds(row).some((id) => ownListingIds.has(id));
}

/** Every line on the order is this vendor's — the bar for changing its status. */
export function vendorOwnsWholeBooking(
  vendorId: string,
  ownListingIds: ReadonlySet<string>,
  row: PlatformBooking,
): boolean {
  if (!vendorId) return false;
  if (Array.isArray(row.vendorIds) && row.vendorIds.length) {
    return row.vendorIds.every((id) => id === vendorId);
  }
  const ids = bookedListingIds(row);
  return ids.length > 0 && ids.every((id) => ownListingIds.has(id));
}

/**
 * What one vendor may see of an order. A mixed-vendor order is trimmed to this
 * vendor's own lines and subtotal, so it never exposes another vendor's items,
 * prices or payment references.
 */
export function vendorViewOfBooking(
  vendorId: string,
  ownListingIds: ReadonlySet<string>,
  row: PlatformBooking,
): PlatformBooking {
  if (vendorOwnsWholeBooking(vendorId, ownListingIds, row)) return row;
  const items = (Array.isArray(row.items) ? row.items : []).filter((line) => {
    const item = line as Partial<PlatformBookingItem> | null;
    return item?.vendorId === vendorId || ownListingIds.has(String(item?.id ?? ''));
  });
  const subtotal = items.reduce<number>((sum, line) => {
    const item = line as Partial<PlatformBookingItem>;
    const amount = Number(item.price) * Number(item.quantity || 1);
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);
  const { moyasarInvoiceId: _invoice, moyasarPaymentId: _payment, ...rest } = row;
  const headlineIsOwn = ownListingIds.has(String(row.serviceId ?? ''));
  return {
    ...rest,
    items,
    vendorIds: [vendorId],
    totalAmount: subtotal,
    ...(headlineIsOwn ? {} : { serviceId: undefined, serviceName: '' }),
  };
}

export function createBookingStore(dataDir: string) {
  const file = path.join(dataDir, 'bookings.json');

  function list(): PlatformBooking[] {
    return readJsonArray<PlatformBooking>(file);
  }

  function save(rows: PlatformBooking[]) {
    writeJsonFile(file, rows);
  }

  function findById(id: string): PlatformBooking | null {
    const key = String(id || '').trim();
    if (!key) return null;
    return list().find((row) => row.id === key) || null;
  }

  /** See `clientOwnsBooking`: session id, or verified email. Never phone. */
  function listForClient(identity: ClientIdentity): PlatformBooking[] {
    return list().filter((row) => clientOwnsBooking(identity, row));
  }

  function listForVendor(vendorId: string, ownListingIds: Iterable<string>): PlatformBooking[] {
    const own = new Set(ownListingIds);
    return list().filter((row) => vendorHasBooking(vendorId, own, row));
  }

  function count(): number {
    return list().length;
  }

  /** Newest first. */
  function add(booking: PlatformBooking): PlatformBooking {
    const rows = list();
    rows.unshift(booking);
    save(rows);
    return booking;
  }

  /**
   * An unpaid, uncancelled order for the same buyer, listings and date placed
   * within `windowMs` — a double-tapped checkout, not a second order.
   *
   * "Same buyer" is the phone plus the same account or the same email. Phone
   * alone is not enough: anyone who knows a number could type it at checkout
   * and lock its owner out for the whole window. Guests with neither are
   * caught by the route's per-device check instead.
   */
  function findRecentDuplicate(input: {
    userId?: string;
    email?: string;
    phone?: string;
    listingIds: string[];
    eventDate: string;
    windowMs: number;
    now?: number;
  }): PlatformBooking | null {
    const now = input.now ?? Date.now();
    const wanted = [...input.listingIds].sort().join('|');
    const email = String(input.email || '').trim().toLowerCase();
    return (
      list().find((row) => {
        if (row.paymentStatus !== 'unpaid') return false;
        if (CLOSED_BOOKING_STATUSES.includes(row.status)) return false;
        if (row.eventDate !== input.eventDate) return false;
        if (bookedListingIds(row).sort().join('|') !== wanted) return false;
        const age = now - bookingCreatedAtMs(row.createdAt);
        if (age < 0 || age > input.windowMs) return false;
        if (!input.phone || row.phone !== input.phone) return false;
        if (input.userId && row.userId) return row.userId === input.userId;
        return Boolean(email) && String(row.email || '').trim().toLowerCase() === email;
      }) || null
    );
  }

  /**
   * Callers validate `status` with `isPlatformBookingStatus` and
   * `checkStatusTransition`; a bad status or a refused change is `null` here
   * too. `by` defaults to the stricter vendor rule.
   */
  function updateStatus(
    id: string,
    status: string,
    options: { by?: StatusChanger; cancellation?: BookingCancellation } = {},
  ): PlatformBooking | null {
    if (!isPlatformBookingStatus(status)) return null;
    const rows = list();
    const item = rows.find((row) => row.id === id);
    if (!item) return null;
    if (!checkStatusTransition(item.status, status, options.by || 'vendor').ok) return null;
    item.status = status;
    if (options.cancellation) item.cancellation = options.cancellation;
    save(rows);
    return item;
  }

  /** Records a customer cancellation; the route decides whether policy allows it. */
  function cancel(id: string, cancellation: BookingCancellation): PlatformBooking | null {
    const rows = list();
    const item = rows.find((row) => row.id === id);
    if (!item) return null;
    item.status = BOOKING_CANCELLED_STATUS;
    item.cancellation = cancellation;
    save(rows);
    return item;
  }

  /** `false` when no row had that id. */
  function remove(id: string): boolean {
    const rows = list();
    const next = rows.filter((row) => row.id !== id);
    if (next.length === rows.length) return false;
    save(next);
    return true;
  }

  /** Links a freshly raised invoice to a booking without touching its payment state. */
  function attachInvoice(id: string, invoice: { id: string; url: string }): PlatformBooking | null {
    const rows = list();
    const item = rows.find((row) => row.id === id);
    if (!item) return null;
    item.moyasarInvoiceId = invoice.id;
    item.paymentUrl = invoice.url;
    save(rows);
    return item;
  }

  /**
   * Settle a booking from a Moyasar payment, invoice, or booking id — a
   * webhook and a browser callback each carry a different subset, so all
   * three are accepted for lookup.
   *
   * Only ever called with fields read back from Moyasar's API. Even so, the
   * booking id comes from invoice metadata that a caller could once choose,
   * so a row is marked paid only when Moyasar's own amount covers the stored
   * total in SAR.
   *
   * Returns `null` when no row matches, which is normal: invoices are also
   * raised for things that are not platform bookings.
   */
  function markPaidFromMoyasar(input: MoyasarSettlement): PlatformBooking | null {
    const bookingId = String(input.bookingId || '').trim();
    const paymentId = String(input.paymentId || '').trim();
    const invoiceId = String(input.invoiceId || '').trim();

    const rows = list();
    const item =
      (invoiceId && rows.find((row) => row.moyasarInvoiceId === invoiceId)) ||
      (paymentId && rows.find((row) => row.moyasarInvoiceId === paymentId || row.moyasarPaymentId === paymentId)) ||
      (bookingId && rows.find((row) => row.id === bookingId)) ||
      null;
    if (!item) return null;

    const amount = Number(input.amountHalalas);
    const currency = String(input.currency || 'SAR').toUpperCase();
    const covers =
      Number.isFinite(amount) && amount > 0 && currency === 'SAR' && amount >= bookingTotalHalalas(item);
    if (input.status !== 'paid' || !covers) {
      if (input.status === 'paid') {
        console.warn('[moyasar] paid amount does not cover booking', item.id, amount, bookingTotalHalalas(item));
      }
      return item;
    }

    if (paymentId) item.moyasarPaymentId = paymentId;
    if (invoiceId && !item.moyasarInvoiceId) item.moyasarInvoiceId = invoiceId;
    item.paymentStatus = 'paid';
    item.settlement = PAID_SETTLEMENT_LABEL;
    // Paid after the order was already cancelled or rejected unpaid: the whole
    // payment is owed back, whatever tier the date falls in.
    if (CANCELLING_BOOKING_STATUSES.includes(item.status) && item.cancellation?.refundStatus === 'not_applicable') {
      item.cancellation = {
        ...item.cancellation,
        refundPercent: 100,
        refundHalalas: Math.round(amount),
        refundStatus: 'pending',
        note: 'وصل الدفع بعد إلغاء الطلب — يُسترجع كامل المبلغ.',
      };
    }
    save(rows);
    return item;
  }

  return {
    list,
    findById,
    listForClient,
    listForVendor,
    count,
    add,
    findRecentDuplicate,
    updateStatus,
    cancel,
    remove,
    attachInvoice,
    markPaidFromMoyasar,
  };
}

export type BookingStore = ReturnType<typeof createBookingStore>;
