import type { Express, Request, Response } from 'express';
import { clientIp, createSlidingWindowLimiter } from '../shared/booking-guards.ts';
import { publicSiteUrl } from '../auth/email-verification.ts';
import type { BookingService } from '../bookings/booking-routes.ts';
import { CLOSED_BOOKING_STATUSES, clientOwnsBooking } from '../bookings/booking-store.ts';
import {
  MOYASAR_NOT_CONFIGURED,
  createInvoice,
  fetchMoyasarPayment,
  fetchPayment,
  isSafeMoyasarId,
  moyasarErrorCode,
  moyasarConfigured,
  moyasarFormReady,
  moyasarPublishableKey,
  moyasarWebhookAuthorized,
  moyasarWebhookUrl,
  verifyMoyasarCheckout,
  type MoyasarFailureCode,
} from './moyasar.ts';

type Deps = {
  /** Platform bookings (with their ownership rule), settled when the provider confirms a payment. */
  bookings: BookingService;
  /** Port to fall back on when no public site URL is configured. */
  port: string | number;
};

/**
 * Each accepted call raises a real invoice, so it is throttled per IP on top
 * of the session check. Guest checkout gets its invoice from POST /api/bookings.
 */
const INVOICE_LIMIT = 10;
const INVOICE_WINDOW_MS = 60_000;
const INVOICE_RATE_LIMIT = 'تجاوزت حد طلبات الدفع. انتظر دقيقة ثم أعد المحاولة.';

/** Moyasar caps metadata values; keep them short and stringy. */
const METADATA_MAX_LEN = 120;

/** Metadata keys that name a platform booking — see `bookingIdFromMetadata` in moyasar.ts. */
const BOOKING_METADATA_KEYS = ['bookingId', 'order_id', 'orderId'];

const INVOICE_NEEDS_LOGIN = 'سجّل الدخول بالحساب الذي أنشأ الطلب لإتمام دفعه.';
const INVOICE_BOOKING_NOT_FOUND = 'الحجز غير موجود';
const INVOICE_ALREADY_PAID = 'هذا الطلب مدفوع مسبقاً.';
const INVOICE_BOOKING_CLOSED = 'الطلب ملغي أو منتهٍ، ولا يمكن دفعه.';
const INVOICE_NEEDS_BOOKING = 'الدفع يكون لطلب محفوظ. أكمل الطلب من السلة ثم ادفع.';
const PAYMENT_NOT_FOUND = 'عملية الدفع غير موجودة.';
const PAYMENT_UPSTREAM = 'تعذر التواصل مع ميسر الآن. حاول بعد قليل.';
const INVOICE_UPSTREAM = 'تعذر إنشاء رابط الدفع من ميسر. حاول بعد قليل.';

/** Our missing key is 503 (retry later); Moyasar's own failure is 502. */
function moyasarFailureStatus(code: MoyasarFailureCode | null): number {
  if (code === 'not_configured') return 503;
  if (code === 'not_found') return 404;
  if (code === 'invalid') return 400;
  return 502;
}

function isSupervisor(role?: string): boolean {
  return role === 'admin' || role === 'accounts_manager';
}

export function registerPaymentRoutes(app: Express, deps: Deps) {
  const { bookings } = deps;
  const invoiceLimiter = createSlidingWindowLimiter(INVOICE_LIMIT, INVOICE_WINDOW_MS);

  const appBaseUrl = () => publicSiteUrl() || process.env.APP_URL || `http://localhost:${deps.port}`;

  // Registered before `/api/payments/:id` so the literal path is never
  // swallowed by the parameter route.
  app.get('/api/payments/moyasar', (_req: Request, res: Response) => {
    const publishableKey = moyasarPublishableKey();
    res.json({
      success: true,
      configured: moyasarConfigured(),
      form: moyasarFormReady(),
      publishableKey: publishableKey || null,
      provider: 'moyasar',
      webhookUrl: moyasarWebhookUrl(),
      methods: ['creditcard', 'applepay', 'stcpay'],
    });
  });

  app.post('/api/payments/invoice', async (req: Request, res: Response) => {
    if (!invoiceLimiter.allow(clientIp(req))) {
      return res.status(429).json({ error: INVOICE_RATE_LIMIT });
    }

    let amount = Number(req.body?.amount);
    let description = String(req.body?.description || '').trim();
    const metadataRaw = req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {};
    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(metadataRaw as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) metadata[key] = value.trim().slice(0, METADATA_MAX_LEN);
    }

    // An invoice that names a booking settles that booking, so it is only
    // raised for the booking's owner (or a supervisor), for an unpaid open
    // order, and always for the stored amount — never the client's.
    const requestedBookingId = BOOKING_METADATA_KEYS.map((key) => metadata[key]).find(Boolean) || '';
    const booking = requestedBookingId ? bookings.findById(requestedBookingId) : null;
    const actor = bookings.actorFromRequest(req);
    // A free amount is only for supervisors raising a manual invoice. The
    // storefront always names a booking (checkout raises its own invoice).
    if (!requestedBookingId && !isSupervisor(actor?.role)) {
      return res.status(actor ? 403 : 401).json({ error: actor ? INVOICE_NEEDS_BOOKING : INVOICE_NEEDS_LOGIN });
    }
    if (requestedBookingId) {
      if (!actor) return res.status(401).json({ error: INVOICE_NEEDS_LOGIN });
      const allowed =
        isSupervisor(actor.role) ||
        (actor.role === 'client' && Boolean(booking) && clientOwnsBooking(actor, booking!));
      if (!booking || !allowed) return res.status(404).json({ error: INVOICE_BOOKING_NOT_FOUND });
      if (booking.paymentStatus === 'paid') return res.status(409).json({ error: INVOICE_ALREADY_PAID });
      if (CLOSED_BOOKING_STATUSES.includes(booking.status)) {
        return res.status(409).json({ error: INVOICE_BOOKING_CLOSED });
      }
      amount = Number(booking.totalAmount);
      description = `طلب يوصل ${booking.id} — ${booking.serviceName}`.slice(0, 220);
      for (const key of BOOKING_METADATA_KEYS) delete metadata[key];
      metadata.bookingId = booking.id;
      metadata.order_id = booking.id;
    }

    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({ error: 'المبلغ (amount) بالريال مطلوب ولا يقل عن 1' });
    }
    if (!description) {
      return res.status(400).json({ error: 'وصف الطلب (description) مطلوب' });
    }

    const base = appBaseUrl();
    try {
      const invoice = await createInvoice({
        amountSar: amount,
        description,
        metadata,
        successUrl: `${base}/payment/success`,
        backUrl: `${base}/payment/cancelled`,
        callbackUrl: moyasarWebhookUrl(),
      });
      if (booking) bookings.attachInvoice(booking.id, { id: invoice.id, url: invoice.url });
      res.json({ id: invoice.id, url: invoice.url });
    } catch (error) {
      const code = moyasarErrorCode(error);
      if (code === 'not_configured') return res.status(503).json({ error: MOYASAR_NOT_CONFIGURED });
      if (code === 'invalid') return res.status(400).json({ error: (error as Error).message });
      if (!code) console.error('[moyasar] invoice route failed', error);
      res.status(502).json({ error: INVOICE_UPSTREAM });
    }
  });

  /**
   * Provider → us. Authenticated by the shared webhook secret only; the event
   * body is never trusted, so the payment is re-fetched from Moyasar before
   * anything is marked paid.
   */
  app.post('/api/payments/webhook', async (req: Request, res: Response) => {
    if (!moyasarWebhookAuthorized(req.body?.secret_token)) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const paymentId = req.body?.data?.id;
    if (typeof paymentId !== 'string') {
      return res.status(400).json({ error: 'حدث بدون معرّف دفعة' });
    }

    try {
      const payment = await fetchPayment(paymentId);
      if (payment.status === 'paid') {
        const settled = bookings.markPaidFromMoyasar({
          paymentId: payment.id,
          invoiceId: payment.invoice_id || payment.invoiceId,
          bookingId: payment.bookingId || payment.metadata?.order_id || payment.metadata?.bookingId,
          status: payment.status,
          // Amount and currency as Moyasar reports them, never the event body.
          amountHalalas: payment.amount,
          currency: payment.currency,
        });
        if (!settled) {
          // Invoices raised outside checkout settle nothing here; a 5xx would only make Moyasar retry.
          console.warn('[moyasar] webhook: paid payment matches no booking', payment.id);
          return res.json({ received: true, ignored: true });
        }
        console.log('[moyasar] payment paid', payment.id, payment.metadata?.order_id || payment.bookingId || '');
      }
      res.json({ received: true });
    } catch (error) {
      const code = moyasarErrorCode(error);
      // Retrying cannot make an unknown (or malformed) payment id exist.
      if (code === 'not_found' || code === 'invalid') {
        console.warn('[moyasar] webhook: payment unknown to Moyasar', paymentId);
        return res.json({ received: true, ignored: true });
      }
      if (!code) console.error('[moyasar] webhook failed', error);
      // Our own faults stay 5xx so Moyasar retries once we are back.
      if (code === 'not_configured') return res.status(503).json({ error: MOYASAR_NOT_CONFIGURED });
      res.status(code ? 502 : 500).json({ error: code ? PAYMENT_UPSTREAM : 'internal error' });
    }
  });

  app.get('/api/payments/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id || '').trim();
    if (!isSafeMoyasarId(id)) {
      return res.status(400).json({ error: 'رقم عملية ميسر غير صالح.' });
    }
    const out = await fetchMoyasarPayment(id);
    if (out.ok === false) {
      const status = moyasarFailureStatus(out.code);
      const error =
        out.code === 'not_configured' ? MOYASAR_NOT_CONFIGURED : out.code === 'not_found' ? PAYMENT_NOT_FOUND : PAYMENT_UPSTREAM;
      return res.status(status).json({ error });
    }
    // Public (no login): only what the payment result page shows. The
    // description and metadata carry order and customer details.
    res.json({
      status: out.payment.status,
      // Moyasar works in halalas; this API surface is in riyals.
      amount: out.payment.amount / 100,
    });
  });

  /** Browser returning from the hosted invoice — verified server-side. */
  app.post('/api/payments/moyasar/callback', async (req: Request, res: Response) => {
    const moyasarId = String(req.body?.id || req.query?.id || '');
    if (!moyasarId) return res.status(400).json({ success: false, error: 'عملية ميسر ناقصة.' });

    const verified = await verifyMoyasarCheckout(moyasarId);
    if (verified.ok === false) {
      const error =
        verified.code === 'not_configured'
          ? MOYASAR_NOT_CONFIGURED
          : verified.code === 'upstream'
            ? PAYMENT_UPSTREAM
            : verified.code === 'not_found'
              ? PAYMENT_NOT_FOUND
              : verified.error;
      return res.status(moyasarFailureStatus(verified.code)).json({ success: false, error });
    }

    const status = verified.kind === 'payment' ? verified.payment.status : verified.invoice.status;
    if (verified.kind === 'payment') {
      bookings.markPaidFromMoyasar({
        paymentId: verified.payment.id,
        invoiceId: verified.payment.invoiceId,
        bookingId: verified.payment.bookingId,
        status,
        amountHalalas: verified.payment.amount,
        currency: verified.payment.currency,
      });
    } else {
      bookings.markPaidFromMoyasar({
        invoiceId: verified.invoice.id,
        status,
        amountHalalas: verified.invoice.amount,
        currency: verified.invoice.currency,
      });
    }

    const transactionUrl = verified.kind === 'payment' ? verified.payment.transactionUrl : undefined;
    res.json({ success: true, status, transactionUrl: transactionUrl || null });
  });
}
