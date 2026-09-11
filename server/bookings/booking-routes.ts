import type { Express, Request, Response } from 'express';
import { createBookingStore, type BookingStore, type PlatformBooking } from './booking-store.ts';
import { clientIp, createSlidingWindowLimiter, normalizeSaudiMobile } from '../shared/booking-guards.ts';
import { hasCheckoutPrice } from '../../core/utils/catalogMedia.ts';
import {
  BOOKING_NEW_STATUS,
  BOOKING_PENDING_APPROVAL_STATUS,
  requiresVendorApproval,
} from '../vendors/vendor-listings.ts';
import { createMoyasarInvoice } from '../payments/moyasar.ts';

type Actor = { id: string; role: string; email?: string; phone?: string };

type AuthApi = {
  userFromRequest: (req: Request) => Actor | null;
  requireRole: (roles: Array<'client' | 'vendor' | 'admin'>) => (
    req: Request,
    res: Response,
    next: () => void,
  ) => void;
};

type Deps = {
  /** Used to decide whether any booked listing needs the vendor to approve. */
  listListings: () => Array<{ id: string; bookingMode?: unknown }>;
};

const BOOKING_LIMIT = 10;
const BOOKING_WINDOW_MS = 60_000;

const NEEDS_LOGIN = 'يلزم تسجيل الدخول.';
const RATE_LIMITED = 'تجاوزت حد الطلبات. انتظر دقيقة ثم أعد المحاولة.';
const NAME_AND_PHONE = 'الاسم ورقم الجوال مطلوبان';
const BAD_PHONE = 'أدخل جوالاً سعودياً صحيحاً بصيغة 05xxxxxxxx لتأكيد الطلب';
const NO_REAL_PRICE =
  'ثبّت سعر المنتج قبل الدفع الإلكتروني. ميسر ما يخصم إلا بعد سعر حقيقي من المورّد.';
const NOT_FOUND = 'الحجز غير موجود';

/** Every platform order settles through Moyasar. */
const SETTLEMENT_LABEL = 'ميسر — دفع إلكتروني (مدى / آبل باي / STC Pay)';

export function registerBookingRoutes(
  app: Express,
  auth: AuthApi,
  dataDir: string,
  deps: Deps,
): BookingStore {
  const store = createBookingStore(dataDir);
  const limiter = createSlidingWindowLimiter(BOOKING_LIMIT, BOOKING_WINDOW_MS);

  app.get('/api/bookings', (req: Request, res: Response) => {
    const user = auth.userFromRequest(req);
    if (!user) return res.status(401).json({ success: false, error: NEEDS_LOGIN });
    if (user.role === 'client') {
      return res.json({ success: true, data: store.listForClient(user) });
    }
    res.json({ success: true, data: store.list() });
  });

  /**
   * Open to guests: checkout happens before sign-in, so this is throttled per
   * IP rather than gated on a session.
   */
  app.post('/api/bookings', async (req: Request, res: Response) => {
    if (!limiter.allow(clientIp(req))) {
      return res.status(429).json({ success: false, error: RATE_LIMITED });
    }

    const { name, phone, email, serviceId, serviceName, notes, city, eventDate, items, totalAmount } =
      req.body || {};
    if (!name || !phone) {
      return res.status(400).json({ success: false, error: NAME_AND_PHONE });
    }
    const saudiPhone = normalizeSaudiMobile(String(phone));
    if (!saudiPhone) {
      return res.status(400).json({ success: false, error: BAD_PHONE });
    }
    if (!hasCheckoutPrice(totalAmount)) {
      return res.status(400).json({ success: false, error: NO_REAL_PRICE });
    }

    const sessionUser = auth.userFromRequest(req);
    const bookedIds = [
      String(serviceId || ''),
      ...(Array.isArray(items) ? items.map((row: { id?: unknown }) => String(row?.id || '')) : []),
    ].filter(Boolean);
    const needsVendorApproval = deps
      .listListings()
      .some((listing) => bookedIds.includes(String(listing.id)) && requiresVendorApproval(listing.bookingMode));

    const booking: PlatformBooking = {
      id: `BK-${Math.floor(100000 + Math.random() * 900000)}`,
      name,
      phone: saudiPhone,
      email: email || sessionUser?.email || '',
      serviceId,
      serviceName: serviceName || 'باقة مخصصة',
      notes: notes || '',
      city: city || '',
      eventDate: eventDate || '',
      paymentMethod: 'moyasar',
      settlement: SETTLEMENT_LABEL,
      items: Array.isArray(items) ? items : [],
      totalAmount: Number(totalAmount) || 0,
      bookingMode: needsVendorApproval ? 'approval' : 'instant',
      status: needsVendorApproval ? BOOKING_PENDING_APPROVAL_STATUS : BOOKING_NEW_STATUS,
      paymentStatus: 'unpaid',
      createdAt: new Date().toISOString().replace('T', ' ').substring(0, 16),
    };

    // The invoice is raised before the row is stored, so a provider failure
    // leaves no unpayable booking behind.
    const invoice = await createMoyasarInvoice({
      amountSar: Number(totalAmount) || 0,
      description: `طلب يوصل ${booking.id} — ${booking.serviceName}`,
      bookingId: booking.id,
    });
    if (invoice.ok === false) {
      return res.status(400).json({ success: false, error: invoice.error });
    }
    booking.moyasarInvoiceId = invoice.invoice.id;
    booking.paymentUrl = invoice.invoice.url;

    store.add(booking);
    res.status(201).json({ success: true, booking });
  });

  // تحديث حالة الحجز
  app.patch('/api/bookings/:id', auth.requireRole(['vendor', 'admin']), (req: Request, res: Response) => {
    const booking = store.updateStatus(String(req.params.id), req.body?.status);
    if (!booking) return res.status(404).json({ success: false, error: NOT_FOUND });
    res.json({ success: true, booking });
  });

  // حذف حجز
  app.delete('/api/bookings/:id', auth.requireRole(['admin']), (req: Request, res: Response) => {
    store.remove(String(req.params.id));
    res.json({ success: true });
  });

  return store;
}
