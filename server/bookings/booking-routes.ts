import type { Express, Request, Response } from 'express';
import {
  BOOKING_IN_PROGRESS_STATUS,
  CANCELLING_BOOKING_STATUSES,
  CLOSED_BOOKING_STATUSES,
  bookingTotalHalalas,
  checkStatusTransition,
  clientOwnsBooking,
  createBookingStore,
  isPlatformBookingStatus,
  vendorHasBooking,
  vendorViewOfBooking,
  vendorOwnsWholeBooking,
  type BookingCancellation,
  type BookingStore,
  type PlatformBooking,
} from './booking-store.ts';
import { clientIp, createSlidingWindowLimiter, normalizeSaudiMobile } from '../shared/booking-guards.ts';
import {
  customerRefundPercent,
  previewCustomerRefundHalalas,
  refundTierFor,
} from '../shared/refund-policy.ts';
import {
  BOOKING_NEW_STATUS,
  BOOKING_PENDING_APPROVAL_STATUS,
} from '../vendors/vendor-listings.ts';
import { createVendorStore } from '../vendors/vendor-store.ts';
import { MOYASAR_NOT_CONFIGURED, createMoyasarInvoice } from '../payments/moyasar.ts';
import { isIsoDate, quoteBooking, riyadhToday, type PricedListing } from './booking-pricing.ts';

export type BookingActor = { id: string; role: string; email?: string; phone?: string; emailVerified?: boolean };

type AuthApi = {
  userFromRequest: (req: Request) => BookingActor | null;
  requireRole: (roles: Array<'client' | 'vendor' | 'admin'>) => (
    req: Request,
    res: Response,
    next: () => void,
  ) => void;
  /** Approved vendor accounts — the same source the public catalog filters on. */
  listVendorUsers?: () => Array<{ id: string }>;
};

type Deps = {
  /** Every stored listing, with its vendor — prices and approval mode come from here. */
  listListings: () => PricedListing[];
  /** Defaults to the vendor accounts `auth.listVendorUsers` reports. */
  approvedVendorIds?: () => Iterable<string>;
  /** Defaults to reading the vendor workspace (read-only). */
  blockedDatesFor?: (vendorId: string) => Array<{ date: string }>;
  now?: () => Date;
};

/** Platform bookings plus the ownership rule, shared with the payment routes. */
export type BookingService = BookingStore & {
  actorFromRequest: (req: Request) => BookingActor | null;
  canRead: (actor: BookingActor | null, booking: PlatformBooking) => boolean;
};

const BOOKING_LIMIT = 10;
const BOOKING_WINDOW_MS = 60_000;
/** A second identical unpaid checkout inside this window is the same order. */
export const DUPLICATE_WINDOW_MS = 10 * 60_000;

const NEEDS_LOGIN = 'يلزم تسجيل الدخول.';
const FORBIDDEN = 'ليست لديك صلاحية هذا الإجراء.';
const RATE_LIMITED = 'تجاوزت حد الطلبات. انتظر دقيقة ثم أعد المحاولة.';
const NAME_AND_PHONE = 'الاسم ورقم الجوال مطلوبان';
const BAD_PHONE = 'أدخل جوالاً سعودياً صحيحاً بصيغة 05xxxxxxxx لتأكيد الطلب';
const NOT_FOUND = 'الحجز غير موجود';
const COURIER_NO_ORDERS = 'المندوب يرى حجوزاته الخارجية فقط من «حجوزاتي الخارجية».';
const BAD_EVENT_DATE = 'اختر تاريخ المناسبة بصيغة صحيحة (YYYY-MM-DD).';
const PAST_EVENT_DATE = 'تاريخ المناسبة مضى. اختر تاريخاً من اليوم فصاعداً.';
const BLOCKED_EVENT_DATE = 'المورّد مغلق في هذا التاريخ. اختر تاريخاً آخر.';
const PRICE_CHANGED =
  'تغيّر سعر السلة عن المعروض. حدّث الصفحة وراجع الإجمالي قبل الدفع.';
const DUPLICATE_ORDER =
  'عندك طلب بنفس المنتج والتاريخ قيد الدفع. أكمل دفعه أو انتظر دقائق قبل طلب جديد.';
const STATUS_REQUIRED = 'اختر حالة صحيحة للحجز.';
const VENDOR_SHARED_ORDER =
  'الطلب يضم منتجات مورّدين آخرين. إدارة يوصل تحدّث حالته.';
const ALREADY_CLOSED = 'الطلب ملغي أو منتهٍ، ولا يمكن إلغاؤه.';
const EXECUTION_STARTED =
  'بدأ تنفيذ الطلب، والإلغاء بعد بدء التنفيذ غير متاح حسب سياسة الاسترجاع. تواصل مع الدعم.';
const EVENT_PASSED = 'موعد المناسبة مضى، ولا يمكن إلغاء الطلب. للخدمة غير المطابقة افتح طلباً من صفحة الدعم.';
const BAD_FIELDS = 'بيانات الطلب غير صالحة. تأكد من الاسم والجوال والمدينة والملاحظات وحاول مرة أخرى.';
const BAD_ITEMS = 'محتوى السلة غير صالح. حدّث الصفحة وأعد إضافة المنتجات.';
const STATUS_FINAL = 'الطلب ملغي أو مرفوض أو مكتمل، ولا يمكن تغيير حالته. تواصل مع إدارة يوصل إن كان هناك خطأ.';
const STATUS_BACK_TO_NEW = 'لا يمكن إرجاع الطلب إلى «جديد». اختر حالة تالية.';
const PAID_NEEDS_ADMIN =
  'الطلب مدفوع، وإلغاؤه أو رفضه يحتاج استرجاع المبلغ للعميل. تواصل مع إدارة يوصل لإتمام ذلك.';

/** Caps for free-text checkout fields — enough for real input, small enough for the admin table. */
const MAX_NAME = 100;
const MAX_EMAIL = 254;
const MAX_CITY = 80;
const MAX_NOTES = 1000;
const MAX_SERVICE_NAME = 200;
const MAX_ID = 120;
const MAX_CART_LINES = 100;

/** Every platform order settles through Moyasar. */
const SETTLEMENT_LABEL = 'ميسر — دفع إلكتروني (مدى / آبل باي / STC Pay)';

function isSupervisor(role?: string): boolean {
  return role === 'admin' || role === 'accounts_manager';
}

type CheckoutFields = {
  name: string;
  phone: string;
  email: string;
  serviceId?: string;
  serviceName: string;
  notes: string;
  city: string;
  eventDate: string;
  items?: Array<Record<string, unknown>>;
};

/**
 * Checkout is open to guests, so every field is checked for shape before it
 * is stored: an object or array in `name` would be saved as-is and break
 * every screen that renders it. Strings are trimmed and capped; absent
 * optional fields become ''. Line quantities and prices are left to
 * `quoteBooking`, which reads prices from the listings anyway.
 */
export function readCheckoutFields(body: unknown): { ok: true; fields: CheckoutFields } | { ok: false; error: string } {
  const raw = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const text = (key: string, max: number): string | null => {
    const value = raw[key];
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') return null;
    return value.trim().slice(0, max);
  };

  const name = text('name', MAX_NAME);
  const phone = text('phone', 40);
  const email = text('email', MAX_EMAIL);
  const serviceId = text('serviceId', MAX_ID);
  const serviceName = text('serviceName', MAX_SERVICE_NAME);
  const notes = text('notes', MAX_NOTES);
  const city = text('city', MAX_CITY);
  // Not truncated to 10, so "2026-10-10junk" still fails the date check.
  const eventDate = text('eventDate', 40);
  if ([name, phone, email, serviceId, serviceName, notes, city, eventDate].some((value) => value === null)) {
    return { ok: false, error: BAD_FIELDS };
  }
  if (!name || !phone) return { ok: false, error: NAME_AND_PHONE };

  let items: Array<Record<string, unknown>> | undefined;
  if (raw.items !== undefined && raw.items !== null) {
    if (!Array.isArray(raw.items) || raw.items.length > MAX_CART_LINES) return { ok: false, error: BAD_ITEMS };
    const plain = raw.items.every(
      (line) =>
        Boolean(line) &&
        typeof line === 'object' &&
        !Array.isArray(line) &&
        typeof (line as { id?: unknown }).id === 'string' &&
        Boolean(((line as { id: string }).id).trim()) &&
        (line as { id: string }).id.length <= MAX_ID,
    );
    if (!plain) return { ok: false, error: BAD_ITEMS };
    items = raw.items as Array<Record<string, unknown>>;
  }

  return {
    ok: true,
    fields: {
      name: name!,
      phone: phone!,
      email: email!,
      serviceId: serviceId || undefined,
      serviceName: serviceName!,
      notes: notes!,
      city: city!,
      eventDate: eventDate!,
      items,
    },
  };
}

export function registerBookingRoutes(
  app: Express,
  auth: AuthApi,
  dataDir: string,
  deps: Deps,
): BookingService {
  const store = createBookingStore(dataDir);
  const limiter = createSlidingWindowLimiter(BOOKING_LIMIT, BOOKING_WINDOW_MS);
  const vendorStore = createVendorStore(dataDir);
  const now = deps.now || (() => new Date());
  /** Checkouts whose invoice is still being raised, so a double tap cannot race past the duplicate check. */
  const inFlight = new Set<string>();
  /**
   * Guest checkouts with no account and no email, keyed by device (IP) and
   * order. The stored-row check needs an account or email, so without this a
   * guest's second tap would raise a second invoice; keying on the IP keeps a
   * stranger who only knows the phone from blocking them.
   */
  const recentGuestCheckouts = new Map<string, { bookingId: string; at: number }>();
  const forgetStaleGuestCheckouts = (at: number) => {
    for (const [key, entry] of recentGuestCheckouts) {
      if (at - entry.at > DUPLICATE_WINDOW_MS) recentGuestCheckouts.delete(key);
    }
  };

  const approvedVendorIds = (): Set<string> =>
    new Set(
      Array.from(deps.approvedVendorIds?.() ?? (auth.listVendorUsers?.() || []).map((user) => user.id)).map(String),
    );
  const blockedDatesFor = (vendorId: string) =>
    deps.blockedDatesFor ? deps.blockedDatesFor(vendorId) : vendorStore.getWorkspace(vendorId).blockedDates;
  const ownListingIds = (vendorId: string): Set<string> =>
    new Set(
      deps
        .listListings()
        .filter((listing) => String(listing.vendorId) === vendorId)
        .map((listing) => String(listing.id)),
    );

  function canRead(actor: BookingActor | null, booking: PlatformBooking): boolean {
    if (!actor) return false;
    if (isSupervisor(actor.role)) return true;
    if (actor.role === 'client') return clientOwnsBooking(actor, booking);
    if (actor.role === 'vendor') return vendorHasBooking(actor.id, ownListingIds(actor.id), booking);
    return false;
  }

  app.get('/api/bookings', (req: Request, res: Response) => {
    const user = auth.userFromRequest(req);
    if (!user) return res.status(401).json({ success: false, error: NEEDS_LOGIN });
    if (isSupervisor(user.role)) return res.json({ success: true, data: store.list() });
    if (user.role === 'client') return res.json({ success: true, data: store.listForClient(user) });
    if (user.role === 'vendor') {
      const own = ownListingIds(user.id);
      const rows = store.listForVendor(user.id, own).map((row) => vendorViewOfBooking(user.id, own, row));
      return res.json({ success: true, data: rows });
    }
    return res.status(403).json({ success: false, error: COURIER_NO_ORDERS });
  });

  app.get('/api/bookings/:id', (req: Request, res: Response) => {
    const user = auth.userFromRequest(req);
    if (!user) return res.status(401).json({ success: false, error: NEEDS_LOGIN });
    const booking = store.findById(String(req.params.id));
    // Someone else's order answers exactly like a missing one.
    if (!booking || !canRead(user, booking)) return res.status(404).json({ success: false, error: NOT_FOUND });
    const view = user.role === 'vendor' ? vendorViewOfBooking(user.id, ownListingIds(user.id), booking) : booking;
    res.json({ success: true, booking: view });
  });

  /**
   * Open to guests: checkout happens before sign-in, so this is throttled per
   * IP rather than gated on a session.
   */
  app.post('/api/bookings', async (req: Request, res: Response) => {
    if (!limiter.allow(clientIp(req))) {
      return res.status(429).json({ success: false, error: RATE_LIMITED });
    }

    const parsed = readCheckoutFields(req.body);
    if (parsed.ok === false) {
      return res.status(400).json({ success: false, error: parsed.error });
    }
    const { name, phone, email, serviceId, serviceName, notes, city, eventDate: date, items } = parsed.fields;
    const totalAmount = req.body?.totalAmount;
    const saudiPhone = normalizeSaudiMobile(phone);
    if (!saudiPhone) {
      return res.status(400).json({ success: false, error: BAD_PHONE });
    }

    if (!isIsoDate(date)) {
      return res.status(400).json({ success: false, error: BAD_EVENT_DATE });
    }
    if (date < riyadhToday(now())) {
      return res.status(400).json({ success: false, error: PAST_EVENT_DATE });
    }

    const quote = quoteBooking({
      serviceId,
      items,
      listings: deps.listListings(),
      approvedVendorIds: approvedVendorIds(),
    });
    if (quote.ok === false) {
      return res.status(400).json({ success: false, error: quote.error });
    }
    // The client total is advisory: a mismatch means the cart shows stale
    // prices, so the customer re-checks rather than paying a surprise amount.
    const hasClientTotal = totalAmount !== undefined && totalAmount !== null && totalAmount !== '';
    if (hasClientTotal && (typeof totalAmount !== 'number' && typeof totalAmount !== 'string')) {
      return res.status(400).json({ success: false, error: BAD_FIELDS });
    }
    // NaN never compares greater, so a non-numeric total counts as a mismatch.
    if (hasClientTotal && !(Math.abs(Number(totalAmount) - quote.totalAmount) <= 0.009)) {
      return res.status(409).json({ success: false, error: PRICE_CHANGED, totalAmount: quote.totalAmount });
    }

    for (const vendorId of quote.vendorIds) {
      const blocked = blockedDatesFor(vendorId).some((row) => String(row?.date || '').slice(0, 10) === date);
      if (blocked) return res.status(409).json({ success: false, error: BLOCKED_EVENT_DATE });
    }

    const sessionUser = auth.userFromRequest(req);
    const orderEmail = String(email || sessionUser?.email || '').trim();
    const listingIds = quote.lines.map((line) => line.id);
    const nowMs = now().getTime();

    const duplicate = store.findRecentDuplicate({
      userId: sessionUser?.id,
      email: orderEmail,
      phone: saudiPhone,
      listingIds,
      eventDate: date,
      windowMs: DUPLICATE_WINDOW_MS,
      now: nowMs,
    });
    if (duplicate) {
      // Only the account that placed it gets the row (and its pay link) back.
      if (sessionUser && duplicate.userId === sessionUser.id) {
        return res.json({ success: true, booking: duplicate, duplicate: true });
      }
      return res.status(409).json({ success: false, error: DUPLICATE_ORDER });
    }
    const anonymous = !sessionUser && !orderEmail;
    const buyerKey = sessionUser?.id || orderEmail.toLowerCase() || `${clientIp(req)}|${saudiPhone}`;
    const flightKey = [buyerKey, [...listingIds].sort().join('|'), date].join('#');
    if (inFlight.has(flightKey)) {
      return res.status(409).json({ success: false, error: DUPLICATE_ORDER });
    }
    if (anonymous) {
      forgetStaleGuestCheckouts(nowMs);
      const earlier = recentGuestCheckouts.get(flightKey);
      const earlierRow = earlier ? store.findById(earlier.bookingId) : null;
      if (earlierRow && earlierRow.paymentStatus === 'unpaid' && !CLOSED_BOOKING_STATUSES.includes(earlierRow.status)) {
        return res.status(409).json({ success: false, error: DUPLICATE_ORDER });
      }
    }
    inFlight.add(flightKey);

    try {
      const booking: PlatformBooking = {
        id: `BK-${Math.floor(100000 + Math.random() * 900000)}`,
        userId: sessionUser?.id || undefined,
        name,
        phone: saudiPhone,
        email: orderEmail,
        serviceId: quote.lines[0].id,
        serviceName: serviceName || quote.lines.map((line) => line.title).join(' + ') || 'باقة مخصصة',
        notes,
        city,
        eventDate: date,
        paymentMethod: 'moyasar',
        settlement: SETTLEMENT_LABEL,
        items: quote.lines,
        vendorIds: quote.vendorIds,
        totalAmount: quote.totalAmount,
        bookingMode: quote.needsVendorApproval ? 'approval' : 'instant',
        status: quote.needsVendorApproval ? BOOKING_PENDING_APPROVAL_STATUS : BOOKING_NEW_STATUS,
        paymentStatus: 'unpaid',
        createdAt: now().toISOString().replace('T', ' ').substring(0, 16),
      };

      // The invoice is raised before the row is stored, so a provider failure
      // leaves no unpayable booking behind. Its amount is the server quote.
      const invoice = await createMoyasarInvoice({
        amountSar: quote.totalAmount,
        description: `طلب يوصل ${booking.id} — ${booking.serviceName}`,
        bookingId: booking.id,
      });
      if (invoice.ok === false) {
        if (invoice.code === 'not_configured') {
          return res.status(503).json({ success: false, error: MOYASAR_NOT_CONFIGURED });
        }
        return res.status(502).json({ success: false, error: invoice.error });
      }
      booking.moyasarInvoiceId = invoice.invoice.id;
      booking.paymentUrl = invoice.invoice.url;

      store.add(booking);
      if (anonymous) recentGuestCheckouts.set(flightKey, { bookingId: booking.id, at: nowMs });
      res.status(201).json({ success: true, booking });
    } finally {
      inFlight.delete(flightKey);
    }
  });

  /**
   * إلغاء العميل لطلبه — the refund tier comes from `refund-policy.ts`. This
   * records what is owed; the refund itself still goes through Moyasar.
   */
  app.post('/api/bookings/:id/cancel', (req: Request, res: Response) => {
    const user = auth.userFromRequest(req);
    if (!user) return res.status(401).json({ success: false, error: NEEDS_LOGIN });
    if (user.role !== 'client') return res.status(403).json({ success: false, error: FORBIDDEN });

    const booking = store.findById(String(req.params.id));
    if (!booking || !clientOwnsBooking(user, booking)) {
      return res.status(404).json({ success: false, error: NOT_FOUND });
    }
    if (CLOSED_BOOKING_STATUSES.includes(booking.status)) {
      return res.status(409).json({ success: false, error: ALREADY_CLOSED });
    }
    if (booking.status === BOOKING_IN_PROGRESS_STATUS) {
      return res.status(409).json({ success: false, error: EXECUTION_STARTED });
    }
    const at = now();
    if (isIsoDate(booking.eventDate) && booking.eventDate < riyadhToday(at)) {
      return res.status(409).json({ success: false, error: EVENT_PASSED });
    }

    const paid = booking.paymentStatus === 'paid';
    const tier = refundTierFor(booking.eventDate, at);
    const refundPercent = paid ? customerRefundPercent(booking.eventDate, at) : 0;
    const refundHalalas = paid ? previewCustomerRefundHalalas(bookingTotalHalalas(booking), booking.eventDate, at) : 0;
    const cancellation: BookingCancellation = {
      cancelledAt: at.toISOString(),
      cancelledBy: 'client',
      refundPercent,
      refundHalalas,
      refundStatus: !paid ? 'not_applicable' : refundHalalas > 0 ? 'pending' : 'none',
      note: !paid
        ? 'أُلغي قبل الدفع — لا يوجد مبلغ للاسترجاع.'
        : `${tier.customer} — ${tier.window}. يُعاد المبلغ عبر ميسر بنفس وسيلة الدفع.`,
    };

    const updated = store.cancel(booking.id, cancellation);
    if (!updated) return res.status(404).json({ success: false, error: NOT_FOUND });
    res.json({ success: true, booking: updated, refund: { percent: refundPercent, amountSar: refundHalalas / 100 } });
  });

  // تحديث حالة الحجز
  app.patch('/api/bookings/:id', auth.requireRole(['vendor', 'admin']), (req: Request, res: Response) => {
    const user = auth.userFromRequest(req);
    if (!user) return res.status(401).json({ success: false, error: NEEDS_LOGIN });

    const status = typeof req.body?.status === 'string' ? req.body.status.trim() : '';
    if (!isPlatformBookingStatus(status)) {
      return res.status(400).json({ success: false, error: STATUS_REQUIRED });
    }

    const current = store.findById(String(req.params.id));
    if (!current) return res.status(404).json({ success: false, error: NOT_FOUND });
    if (!isSupervisor(user.role)) {
      const own = ownListingIds(user.id);
      if (!vendorHasBooking(user.id, own, current)) {
        return res.status(404).json({ success: false, error: NOT_FOUND });
      }
      if (!vendorOwnsWholeBooking(user.id, own, current)) {
        return res.status(403).json({ success: false, error: VENDOR_SHARED_ORDER });
      }
    }

    const by = isSupervisor(user.role) ? 'admin' : 'vendor';
    const transition = checkStatusTransition(current.status, status, by);
    if (transition.ok === false) {
      return res
        .status(409)
        .json({ success: false, error: transition.reason === 'final' ? STATUS_FINAL : STATUS_BACK_TO_NEW });
    }

    // Ending an order records who ended it and what is owed, in the same shape
    // a client cancellation uses, so a refund is never lost. A paid order owes
    // the full amount (the customer did not cancel), which only an admin may
    // commit Usil to — a vendor is sent to administration instead.
    let cancellation: BookingCancellation | undefined;
    const ending = CANCELLING_BOOKING_STATUSES.includes(status) && !CANCELLING_BOOKING_STATUSES.includes(current.status);
    if (ending) {
      const paid = current.paymentStatus === 'paid';
      if (paid && by === 'vendor') {
        return res.status(409).json({ success: false, error: PAID_NEEDS_ADMIN });
      }
      const refundHalalas = paid ? bookingTotalHalalas(current) : 0;
      cancellation = {
        cancelledAt: now().toISOString(),
        cancelledBy: by,
        refundPercent: paid ? 100 : 0,
        refundHalalas,
        refundStatus: !paid ? 'not_applicable' : refundHalalas > 0 ? 'pending' : 'none',
        note: !paid
          ? 'أُلغي قبل الدفع — لا يوجد مبلغ للاسترجاع.'
          : 'ألغته إدارة يوصل بعد الدفع — يُعاد كامل المبلغ عبر ميسر بنفس وسيلة الدفع.',
      };
    }

    const booking = store.updateStatus(current.id, status, { by, cancellation });
    if (!booking) return res.status(404).json({ success: false, error: NOT_FOUND });
    // Rows carry no status history; the log is the record of an admin override.
    if (transition.override) {
      console.warn('[bookings] admin status override', booking.id, current.status, '->', status, 'by', user.id);
    }
    res.json({ success: true, booking });
  });

  // حذف حجز
  app.delete('/api/bookings/:id', auth.requireRole(['admin']), (req: Request, res: Response) => {
    if (!store.remove(String(req.params.id))) {
      return res.status(404).json({ success: false, error: NOT_FOUND });
    }
    res.json({ success: true });
  });

  return Object.assign(store, { actorFromRequest: auth.userFromRequest, canRead });
}
