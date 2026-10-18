import { randomInt } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import {
  BOOKING_COMPLETED_STATUS,
  BOOKING_CONFIRMED_STATUS,
  BOOKING_IN_PROGRESS_STATUS,
  CANCELLING_BOOKING_STATUSES,
  CLOSED_BOOKING_STATUSES,
  bookedListingIds,
  bookingRefundPending,
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
  type MoyasarSettlement,
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
  BOOKING_REJECTED_STATUS,
} from '../vendors/vendor-listings.ts';
import { createVendorStore } from '../vendors/vendor-store.ts';
import { MOYASAR_NOT_CONFIGURED, cancelMoyasarInvoice, createMoyasarInvoice } from '../payments/moyasar.ts';
import {
  findSlotConflict,
  staleCheckoutsOn,
  type SlotConflict,
  type VendorCalendarBooking,
} from './slot-holds.ts';
import { isIsoDate, quoteBooking, riyadhToday, type PricedListing } from './booking-pricing.ts';
import { cityFilterMatches, isSaudiPlaceName } from '../../core/data/saudiPlaces.ts';
import { notifyBookingApproved, notifyBookingRejected, notifyVendorNewOrder } from '../shared/optional-mail.ts';

export type BookingActor = { id: string; role: string; email?: string; phone?: string; emailVerified?: boolean };

type AuthApi = {
  userFromRequest: (req: Request) => BookingActor | null;
  requireRole: (
    roles: Array<'client' | 'vendor' | 'admin'>,
    options?: { exact?: boolean },
  ) => (
    req: Request,
    res: Response,
    next: () => void,
  ) => void;
  /**
   * Approved vendor accounts — the same source the public catalog filters on.
   * A vendor's id is its account id, so this is also where their email is.
   */
  listVendorUsers?: () => Array<{ id: string; email?: string }>;
  /** Whether an email belongs to an account, so a guest cannot file orders into it. */
  findUserByEmail?: (email: string) => { id: string } | null;
};

type Deps = {
  /** Every stored listing, with its vendor — prices and approval mode come from here. */
  listListings: () => PricedListing[];
  /** Defaults to the vendor accounts `auth.listVendorUsers` reports. */
  approvedVendorIds?: () => Iterable<string>;
  /** Defaults to reading the vendor workspace (read-only). */
  blockedDatesFor?: (vendorId: string) => Array<{ date: string }>;
  /** Bookings the vendor recorded in their calendar; they hold a listing's date too. */
  vendorBookingsFor?: (vendorId: string) => VendorCalendarBooking[];
  now?: () => Date;
};

/** Platform bookings plus the ownership rule, shared with the payment routes. */
export type BookingService = BookingStore & {
  actorFromRequest: (req: Request) => BookingActor | null;
  canRead: (actor: BookingActor | null, booking: PlatformBooking) => boolean;
  /** Another live booking holding this order's listings on its date (`null` = the date is its own). */
  slotConflictFor: (booking: PlatformBooking) => SlotConflict | null;
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
/** Longest rejection or cancellation reason kept on an order. */
const REASON_MAX = 300;
const BAD_EVENT_CITY = 'اختر مدينة المناسبة من القائمة.';
const outOfCoverage = (title: string, city: string) =>
  `«${title}» ما يخدم ${city}. اختر مدينة يغطيها المورّد أو منتجاً آخر.`;
const tooSoon = (title: string) => `«${title}» يحتاج يوماً للتجهيز. اختر تاريخاً من بكرة فصاعداً.`;
export const SLOT_TAKEN = 'هذا المنتج محجوز في التاريخ المختار. اختر تاريخاً آخر.';
const SLOT_TAKEN_OWN = 'عندك طلب على هذا المنتج في نفس التاريخ. تابعه أو ألغه من «طلباتي» قبل طلب جديد.';
const SLOT_BUSY = 'يتم حجز هذا التاريخ الآن لطلب آخر. حاول بعد لحظات.';
export const SLOT_TAKEN_CONFIRM = 'هذا المنتج محجوز لطلب آخر في نفس التاريخ. ارفض هذا الطلب أو غيّر التاريخ مع العميل.';
const STALE_CHECKOUT_NOTE = 'انتهت مهلة الدفع وحُجز التاريخ لطلب آخر.';
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
const APPROVAL_NEEDS_LOGIN =
  'طلبك يشمل منتجاً بموافقة المورّد، والدفع يكون بعد موافقته. سجّل الدخول لنبلغك ونرسل لك رابط الدفع.';
const EMAIL_HAS_ACCOUNT = 'هذا البريد مسجّل لحساب في يوصل. سجّل الدخول لإكمال الطلب.';
const UNPAID_NOT_STARTED = 'الطلب لم يُدفع بعد. ابدأ التنفيذ أو أكمله بعد دفع العميل.';
const UNPAID_INSTANT_CONFIRM = 'الطلب الفوري يتأكد تلقائياً بعد دفع العميل.';
const BAD_EVENT_TIME = 'اختر وقت المناسبة بصيغة صحيحة (HH:mm) بين 00:00 و23:59.';
const VENDOR_BACK_TO_PENDING = 'لا يمكن إرجاع الطلب إلى «بانتظار موافقة المورّد». وافق عليه أو ارفضه.';
const CONFIRM_PAST_DATE = 'موعد المناسبة مضى، ولا يمكن تأكيد الطلب. ارفضه أو ألغه.';
const CONFIRM_BLOCKED_DATE = 'تاريخ المناسبة مغلق في تقويم المورّد. افتح التاريخ من التقويم أولاً أو ارفض الطلب.';
const NO_PENDING_REFUND = 'لا يوجد استرجاع معلّق على هذا الطلب.';
const DELETE_PAID_OR_REFUND =
  'لا يمكن حذف طلب مدفوع أو عليه استرجاع معلّق — يبقى سجلّه للمحاسبة. ألغِه بدلاً من حذفه.';
const ADMIN_ONLY = 'هذا الإجراء لمدير كل الحسابات فقط.';
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

/** `HH:mm` on a 24-hour clock. */
export function isClockTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** A 6-digit `BK-` id; a 9-digit one only if the short space is somehow crowded. */
function bookingIdCandidate(attempt: number): string {
  return attempt < 20 ? `BK-${randomInt(100000, 1000000)}` : `BK-${randomInt(100000000, 1000000000)}`;
}

/**
 * A booking id no stored or in-flight order has. Six random digits collide
 * often enough at scale that the store must be checked, not trusted.
 */
export function uniqueBookingId(
  isTaken: (id: string) => boolean,
  candidate: (attempt: number) => string = bookingIdCandidate,
): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const id = candidate(attempt);
    if (!isTaken(id)) return id;
  }
  throw new Error('could not allocate a booking id');
}

/** What a duplicate checkout answer carries, so the client can resume the first order. */
function duplicateSummary(row: PlatformBooking) {
  const awaitingApproval = row.status === BOOKING_PENDING_APPROVAL_STATUS;
  return {
    id: row.id,
    status: row.status,
    paymentUrl: awaitingApproval ? null : row.paymentUrl || null,
    awaitingApproval,
  };
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
  /** `HH:mm`, or '' when the customer gave no time. */
  eventTime: string;
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
  const eventTime = text('eventTime', 20);
  if ([name, phone, email, serviceId, serviceName, notes, city, eventDate].some((value) => value === null)) {
    return { ok: false, error: BAD_FIELDS };
  }
  if (!name || !phone) return { ok: false, error: NAME_AND_PHONE };
  // Optional; when sent it must be a real time, not free text.
  if (eventTime === null || (eventTime && !isClockTime(eventTime))) return { ok: false, error: BAD_EVENT_TIME };

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
      eventTime: eventTime || '',
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
  const vendorBookingsFor = (vendorId: string): VendorCalendarBooking[] =>
    deps.vendorBookingsFor ? deps.vendorBookingsFor(vendorId) : vendorStore.getWorkspace(vendorId).bookings;

  /** Live bookings already holding any of these listings on `date` (see slot-holds.ts). */
  function slotConflict(
    listingIds: string[],
    vendorIds: string[],
    date: string,
    excludeId?: string,
    ignoreOrder?: (row: PlatformBooking) => boolean,
  ): SlotConflict | null {
    return findSlotConflict({
      listingIds,
      date,
      orders: store.list(),
      vendorBookings: vendorIds.flatMap((vendorId) => vendorBookingsFor(vendorId)),
      excludeId,
      ignoreOrder,
      nowMs: now().getTime(),
    });
  }
  /** An order the vendor already accepted outranks others still waiting on the vendor. */
  const slotConflictFor = (booking: PlatformBooking) =>
    slotConflict(
      bookedListingIds(booking),
      (booking.vendorIds || []).map(String),
      booking.eventDate,
      booking.id,
      booking.status === BOOKING_NEW_STATUS || booking.status === BOOKING_PENDING_APPROVAL_STATUS
        ? undefined
        : (row) => row.status === BOOKING_PENDING_APPROVAL_STATUS,
    );
  /** listing#date pairs a checkout is taking right now, so two buyers can't both pass the check. */
  const slotsInFlight = new Set<string>();

  /**
   * A new order took a date that an abandoned checkout (unpaid past its window)
   * still sat on: end that checkout and close its invoice, so the old pay link
   * can't later sell the same date a second time.
   */
  function lapseStaleCheckouts(booking: PlatformBooking) {
    const stale = staleCheckoutsOn({
      listingIds: bookedListingIds(booking),
      date: booking.eventDate,
      orders: store.list(),
      nowMs: now().getTime(),
    });
    for (const row of stale) {
      if (row.id === booking.id) continue;
      const ended = store.cancel(row.id, {
        cancelledAt: now().toISOString(),
        cancelledBy: 'admin',
        refundPercent: 0,
        refundHalalas: 0,
        refundStatus: 'not_applicable',
        note: STALE_CHECKOUT_NOTE,
      });
      if (ended) cancelUnpaidInvoice(ended);
    }
  }
  const ownListingIds = (vendorId: string): Set<string> =>
    new Set(
      deps
        .listListings()
        .filter((listing) => String(listing.vendorId) === vendorId)
        .map((listing) => String(listing.id)),
    );

  /** Ids handed out to checkouts still raising their invoice — not yet in the store. */
  const reservedIds = new Set<string>();
  const newBookingId = () => uniqueBookingId((id) => reservedIds.has(id) || Boolean(store.findById(id)));

  /** A vendor's id is their account id; their account email is where order notices go. */
  function vendorEmail(vendorId: string): string {
    const user = (auth.listVendorUsers?.() || []).find((row) => String(row.id) === vendorId);
    return String(user?.email || '').trim();
  }

  /** Tells every vendor on the order about it, naming only their own lines. */
  function notifyVendorsOfOrder(booking: PlatformBooking, needsApproval: boolean) {
    for (const vendorId of booking.vendorIds || []) {
      const email = vendorEmail(vendorId);
      if (!email) continue;
      const own = (Array.isArray(booking.items) ? booking.items : [])
        .filter((line) => (line as { vendorId?: unknown })?.vendorId === vendorId)
        .map((line) => String((line as { title?: unknown })?.title || ''))
        .filter(Boolean);
      notifyVendorNewOrder(email, booking.id, own.join(' + ') || booking.serviceName, needsApproval);
    }
  }

  /**
   * An order cancelled before payment: close its Moyasar invoice so the old
   * link cannot take money for it. Best-effort — the cancellation stands
   * whatever Moyasar answers.
   */
  function cancelUnpaidInvoice(booking: PlatformBooking) {
    if (booking.paymentStatus === 'paid' || !booking.moyasarInvoiceId) return;
    const invoiceId = booking.moyasarInvoiceId;
    void cancelMoyasarInvoice(invoiceId)
      .then((out) => {
        if (out.ok === false && out.code !== 'not_configured') {
          console.warn('[bookings] could not cancel the Moyasar invoice of', booking.id, invoiceId, out.code);
        }
      })
      .catch(() => undefined);
  }

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
    if (isSupervisor(user.role)) {
      // Supervising one vendor's back office: exactly the rows (and trimmed
      // view) that vendor would see.
      const vendorId = typeof req.query.vendorId === 'string' ? req.query.vendorId.trim() : '';
      if (vendorId) {
        const own = ownListingIds(vendorId);
        const rows = store.listForVendor(vendorId, own).map((row) => vendorViewOfBooking(vendorId, own, row));
        return res.json({ success: true, data: rows });
      }
      return res.json({ success: true, data: store.list() });
    }
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
    const { name, phone, email, serviceId, serviceName, notes, city, eventDate: date, eventTime, items } = parsed.fields;
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

    if (!isSaudiPlaceName(city)) {
      return res.status(400).json({ success: false, error: BAD_EVENT_CITY });
    }

    const listings = deps.listListings();
    const quote = quoteBooking({
      serviceId,
      items,
      listings,
      approvedVendorIds: approvedVendorIds(),
    });
    if (quote.ok === false) {
      return res.status(400).json({ success: false, error: quote.error });
    }
    // Every listing on the order has to serve the event's city, and a listing
    // without an hour or same-day lane needs the day to prepare («قبل يوم للتجهيز»).
    const listingById = new Map(listings.map((listing) => [String(listing.id), listing]));
    for (const line of quote.lines) {
      const listing = listingById.get(line.id);
      const cities = Array.isArray(listing?.cities) ? listing.cities : [];
      if (cities.length && !cityFilterMatches(cities, city)) {
        return res.status(409).json({ success: false, error: outOfCoverage(line.title, city), listingId: line.id });
      }
      const lanes = Array.isArray(listing?.fulfillment) ? listing.fulfillment.map(String) : [];
      const sameDay = lanes.includes('hour') || lanes.includes('same_day');
      if (!sameDay && lanes.includes('tomorrow') && date === riyadhToday(now())) {
        return res.status(409).json({ success: false, error: tooSoon(line.title), listingId: line.id });
      }
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
    // Approval orders are paid after the vendor accepts, through the account
    // that placed them — a guest would have no way back to the pay link.
    if (quote.needsVendorApproval && !sessionUser) {
      return res.status(401).json({ success: false, error: APPROVAL_NEEDS_LOGIN, needsLogin: true });
    }
    // A signed-in order carries its own account email. A guest may not type an
    // email that belongs to an account: verified emails see orders placed with
    // them, so that would file a stranger's order into someone's account.
    if (!sessionUser && email && auth.findUserByEmail?.(email)) {
      return res.status(409).json({ success: false, error: EMAIL_HAS_ACCOUNT, needsLogin: true });
    }
    const orderEmail = String(sessionUser?.email || email || '').trim();
    const listingIds = quote.lines.map((line) => line.id);
    const nowMs = now().getTime();

    const duplicate = store.findRecentDuplicate({
      userId: sessionUser?.id,
      email: orderEmail,
      phone: saudiPhone,
      listingIds,
      eventDate: date,
      eventTime: eventTime || '',
      quantities: quote.lines.map((line) => ({ id: line.id, quantity: line.quantity })),
      windowMs: DUPLICATE_WINDOW_MS,
      now: nowMs,
    });
    if (duplicate) {
      const summary = duplicateSummary(duplicate);
      // Only the account that placed it gets the full row back.
      if (sessionUser && duplicate.userId === sessionUser.id) {
        return res.json({
          success: true,
          booking: duplicate,
          duplicate: true,
          ...(summary.awaitingApproval ? { awaitingApproval: true } : {}),
        });
      }
      // Same phone and email (or device) as the first order: enough to resume
      // it — its id, status and pay link — but not the stored row.
      return res.status(409).json({ success: false, error: DUPLICATE_ORDER, duplicate: true, booking: summary });
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
        return res
          .status(409)
          .json({ success: false, error: DUPLICATE_ORDER, duplicate: true, booking: duplicateSummary(earlierRow) });
      }
    }
    // "Your own order" only for the account that placed it, or a guest matching its
    // email *and* phone (as the duplicate check) — never someone who knows one of them.
    const ownOrder = (row: PlatformBooking) =>
      (sessionUser && row.userId === sessionUser.id) ||
      (!sessionUser &&
        Boolean(orderEmail) &&
        row.email.toLowerCase() === orderEmail.toLowerCase() &&
        row.phone === saudiPhone);
    // One event per listing per day: a date someone already holds can't be sold again.
    // Someone else's request still waiting on the vendor doesn't hold it: an unpaid,
    // unanswered request must not shut everyone else out. The vendor approves one of
    // the requests, and approving needs the date free (SLOT_TAKEN_CONFIRM).
    const conflict = slotConflict(
      listingIds,
      quote.vendorIds,
      date,
      undefined,
      (row) => row.status === BOOKING_PENDING_APPROVAL_STATUS && !ownOrder(row),
    );
    if (conflict) {
      const own = conflict.kind === 'order' && Boolean(ownOrder(conflict.booking));
      return res.status(409).json({
        success: false,
        error: own ? SLOT_TAKEN_OWN : SLOT_TAKEN,
        slotTaken: true,
        listingId: conflict.listingId,
        ...(own && conflict.kind === 'order' ? { booking: duplicateSummary(conflict.booking) } : {}),
      });
    }
    const slotKeys = listingIds.map((id) => `${id}#${date}`);
    if (slotKeys.some((key) => slotsInFlight.has(key))) {
      return res.status(409).json({ success: false, error: SLOT_BUSY, slotTaken: true });
    }

    const bookingId = newBookingId();
    reservedIds.add(bookingId);
    inFlight.add(flightKey);
    for (const key of slotKeys) slotsInFlight.add(key);

    try {
      const booking: PlatformBooking = {
        id: bookingId,
        userId: sessionUser?.id || undefined,
        name,
        phone: saudiPhone,
        email: orderEmail,
        serviceId: quote.lines[0].id,
        serviceName: serviceName || quote.lines.map((line) => line.title).join(' + ') || 'باقة مخصصة',
        notes,
        city,
        eventDate: date,
        ...(eventTime ? { eventTime } : {}),
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

      // Nothing is charged before the vendor accepts: the invoice is raised on
      // approval (see the PATCH route) and the client pays from «طلباتي».
      if (quote.needsVendorApproval) {
        store.add(booking);
        lapseStaleCheckouts(booking);
        notifyVendorsOfOrder(booking, true);
        return res.status(201).json({ success: true, booking, awaitingApproval: true });
      }

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
      lapseStaleCheckouts(booking);
      if (anonymous) recentGuestCheckouts.set(flightKey, { bookingId: booking.id, at: nowMs });
      res.status(201).json({ success: true, booking });
    } finally {
      inFlight.delete(flightKey);
      reservedIds.delete(bookingId);
      for (const key of slotKeys) slotsInFlight.delete(key);
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
    cancelUnpaidInvoice(updated);
    res.json({ success: true, booking: updated, refund: { percent: refundPercent, amountSar: refundHalalas / 100 } });
  });

  // تحديث حالة الحجز
  app.patch('/api/bookings/:id', auth.requireRole(['vendor', 'admin']), async (req: Request, res: Response) => {
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
    // «بانتظار موافقة المورّد» is where checkout puts an approval order — a
    // vendor moving an instant order there could then «approve» it unpaid.
    if (by === 'vendor' && status === BOOKING_PENDING_APPROVAL_STATUS && current.status !== status) {
      return res.status(409).json({ success: false, error: VENDOR_BACK_TO_PENDING });
    }

    // Confirming commits the vendor to the date: it must still be ahead and
    // open in their calendar (it may have been blocked since checkout).
    const confirming =
      status === BOOKING_CONFIRMED_STATUS &&
      (current.status === BOOKING_PENDING_APPROVAL_STATUS || current.status === BOOKING_NEW_STATUS);
    if (confirming) {
      if (isIsoDate(current.eventDate) && current.eventDate < riyadhToday(now())) {
        return res.status(409).json({ success: false, error: CONFIRM_PAST_DATE });
      }
      const day = String(current.eventDate || '').slice(0, 10);
      const blocked = (current.vendorIds || []).some((vendorId) =>
        blockedDatesFor(vendorId).some((row) => String(row?.date || '').slice(0, 10) === day),
      );
      if (blocked) return res.status(409).json({ success: false, error: CONFIRM_BLOCKED_DATE });
    }

    // Unpaid orders: work starts only after payment, and an instant order is
    // confirmed by its payment, not by hand. Approving an approval order is
    // the one confirmation that comes before money. Admins may override.
    let paymentOverride = false;
    if (current.paymentStatus !== 'paid' && status !== current.status) {
      const startsWork = status === BOOKING_IN_PROGRESS_STATUS || status === BOOKING_COMPLETED_STATUS;
      // Only a real approval order (checkout put it in pending) is confirmed before payment.
      const approvingApprovalOrder =
        current.status === BOOKING_PENDING_APPROVAL_STATUS && current.bookingMode !== 'instant';
      const confirmsUnpaidInstant = status === BOOKING_CONFIRMED_STATUS && !approvingApprovalOrder;
      if (startsWork || confirmsUnpaidInstant) {
        if (by === 'vendor') {
          return res.status(409).json({ success: false, error: startsWork ? UNPAID_NOT_STARTED : UNPAID_INSTANT_CONFIRM });
        }
        paymentOverride = true;
      }
    }

    // Confirming takes the listing's date: another customer must not already hold it.
    // A second order also still waiting on the vendor doesn't count — approving one
    // is how the vendor picks between them.
    if (confirming) {
      const taken = slotConflict(
        bookedListingIds(current),
        (current.vendorIds || []).map(String),
        String(current.eventDate || '').slice(0, 10),
        current.id,
        (row) => row.status === BOOKING_PENDING_APPROVAL_STATUS,
      );
      if (taken) return res.status(409).json({ success: false, error: SLOT_TAKEN_CONFIRM, slotTaken: true });
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
      const rejected = status === BOOKING_REJECTED_STATUS;
      const reason =
        typeof req.body?.reason === 'string' ? req.body.reason.replace(/\s+/g, ' ').trim().slice(0, REASON_MAX) : '';
      cancellation = {
        cancelledAt: now().toISOString(),
        cancelledBy: by,
        refundPercent: paid ? 100 : 0,
        refundHalalas,
        refundStatus: !paid ? 'not_applicable' : refundHalalas > 0 ? 'pending' : 'none',
        note: !paid
          ? rejected
            ? 'رفضه المورّد قبل الدفع — لا يوجد مبلغ للاسترجاع.'
            : 'أُلغي قبل الدفع — لا يوجد مبلغ للاسترجاع.'
          : 'ألغته إدارة يوصل بعد الدفع — يُعاد كامل المبلغ عبر ميسر بنفس وسيلة الدفع.',
        ...(reason ? { reason } : {}),
      };
    }

    let booking = store.updateStatus(current.id, status, { by, cancellation });
    if (!booking) return res.status(404).json({ success: false, error: NOT_FOUND });
    // Rows carry no status history; the log is the record of an admin override.
    if (transition.override || paymentOverride) {
      console.warn('[bookings] admin status override', booking.id, current.status, '->', status, 'by', user.id);
    }
    if (cancellation) {
      cancelUnpaidInvoice(booking);
      notifyBookingRejected(booking.email, booking.id, booking.serviceName);
    }

    // Approved: now the client can pay. Raise the invoice and tell them; if
    // Moyasar is down the approval stands and «طلباتي» raises it on demand.
    const approved =
      current.status === BOOKING_PENDING_APPROVAL_STATUS &&
      status === BOOKING_CONFIRMED_STATUS &&
      booking.paymentStatus !== 'paid';
    if (approved) {
      if (!booking.paymentUrl) {
        const invoice = await createMoyasarInvoice({
          amountSar: Number(booking.totalAmount),
          description: `طلب يوصل ${booking.id} — ${booking.serviceName}`,
          bookingId: booking.id,
        });
        if (invoice.ok) booking = store.attachInvoice(booking.id, invoice.invoice) || booking;
      }
      notifyBookingApproved(booking.email, booking.id, booking.serviceName, booking.paymentUrl);
    }
    res.json({ success: true, booking });
  });

  /**
   * The refund was sent by hand from the Moyasar dashboard: close the pending
   * refund so the order stops showing money owed. (Refunds Moyasar reports
   * through the webhook close themselves.)
   */
  app.post('/api/bookings/:id/refund-done', auth.requireRole(['admin']), (req: Request, res: Response) => {
    const user = auth.userFromRequest(req);
    if (!user) return res.status(401).json({ success: false, error: NEEDS_LOGIN });
    if (!isSupervisor(user.role)) return res.status(403).json({ success: false, error: FORBIDDEN });
    const current = store.findById(String(req.params.id));
    if (!current) return res.status(404).json({ success: false, error: NOT_FOUND });
    const booking = store.markRefundDone(current.id, now());
    if (!booking) return res.status(409).json({ success: false, error: NO_PENDING_REFUND });
    console.warn('[bookings] refund marked done by hand', booking.id, 'by', user.id);
    res.json({ success: true, booking });
  });

  // حذف حجز — لمدير كل الحسابات فقط، ولا يُحذف طلب فيه مال.
  app.delete('/api/bookings/:id', auth.requireRole(['admin'], { exact: true }), (req: Request, res: Response) => {
    const user = auth.userFromRequest(req);
    if (!user) return res.status(401).json({ success: false, error: NEEDS_LOGIN });
    if (user.role !== 'admin') return res.status(403).json({ success: false, error: ADMIN_ONLY });
    const current = store.findById(String(req.params.id));
    if (!current) return res.status(404).json({ success: false, error: NOT_FOUND });
    if (current.paymentStatus === 'paid' || bookingRefundPending(current)) {
      return res.status(409).json({ success: false, error: DELETE_PAID_OR_REFUND });
    }
    if (!store.remove(current.id)) {
      return res.status(404).json({ success: false, error: NOT_FOUND });
    }
    res.json({ success: true });
  });

  /**
   * Settlement goes through the store; an instant order that has just become
   * paid is now a confirmed order, so its vendors hear about it here.
   */
  // Captured before the service below replaces it with this wrapper.
  const settleInStore = store.markPaidFromMoyasar;
  function markPaidFromMoyasar(input: MoyasarSettlement): PlatformBooking | null {
    const before = store.findForMoyasar(input);
    const after = settleInStore(input);
    if (before && after && before.paymentStatus !== 'paid' && after.paymentStatus === 'paid') {
      if (after.bookingMode === 'instant') notifyVendorsOfOrder(after, false);
    }
    return after;
  }

  return Object.assign(store, { actorFromRequest: auth.userFromRequest, canRead, markPaidFromMoyasar, slotConflictFor });
}
