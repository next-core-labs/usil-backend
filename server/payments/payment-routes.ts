import type { Express, Request, Response } from 'express';
import { clientIp, createSlidingWindowLimiter } from '../shared/booking-guards.ts';
import { publicSiteUrl } from '../auth/email-verification.ts';
import type { BookingStore } from '../bookings/booking-store.ts';
import {
  createInvoice,
  fetchPayment,
  isSafeMoyasarId,
  moyasarConfigured,
  moyasarFormReady,
  moyasarPublishableKey,
  moyasarWebhookAuthorized,
  moyasarWebhookUrl,
  verifyMoyasarCheckout,
} from './moyasar.ts';

type Deps = {
  /** Platform bookings, settled when the provider confirms a payment. */
  bookings: BookingStore;
  /** Port to fall back on when no public site URL is configured. */
  port: string | number;
};

/**
 * Guest checkout means invoice creation cannot require a session, so it is
 * throttled per IP instead — each accepted call raises a real invoice.
 */
const INVOICE_LIMIT = 10;
const INVOICE_WINDOW_MS = 60_000;
const INVOICE_RATE_LIMIT = 'تجاوزت حد طلبات الدفع. انتظر دقيقة ثم أعد المحاولة.';

/** Moyasar caps metadata values; keep them short and stringy. */
const METADATA_MAX_LEN = 120;

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

    const amount = Number(req.body?.amount);
    const description = String(req.body?.description || '').trim();
    const metadataRaw = req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {};
    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(metadataRaw as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) metadata[key] = value.trim().slice(0, METADATA_MAX_LEN);
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
      const bookingId = metadata.bookingId || metadata.order_id || '';
      if (bookingId) {
        bookings.markPaidFromMoyasar({ invoiceId: invoice.id, bookingId, status: invoice.status });
      }
      res.json({ id: invoice.id, url: invoice.url });
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
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
        bookings.markPaidFromMoyasar({
          paymentId: payment.id,
          invoiceId: payment.invoice_id || payment.invoiceId,
          bookingId: payment.bookingId || payment.metadata?.order_id || payment.metadata?.bookingId,
          status: payment.status,
        });
        console.log('[moyasar] payment paid', payment.id, payment.metadata?.order_id || payment.bookingId || '');
      }
      res.json({ received: true });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/api/payments/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id || '').trim();
    if (!isSafeMoyasarId(id)) {
      return res.status(400).json({ error: 'رقم عملية ميسر غير صالح.' });
    }
    try {
      const payment = await fetchPayment(id);
      res.json({
        id: payment.id,
        status: payment.status,
        // Moyasar works in halalas; this API surface is in riyals.
        amount: payment.amount / 100,
        description: payment.description,
        metadata: payment.metadata,
      });
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });

  /** Browser returning from the hosted invoice — verified server-side. */
  app.post('/api/payments/moyasar/callback', async (req: Request, res: Response) => {
    const moyasarId = String(req.body?.id || req.query?.id || '');
    if (!moyasarId) return res.status(400).json({ success: false, error: 'عملية ميسر ناقصة.' });

    const verified = await verifyMoyasarCheckout(moyasarId);
    if (verified.ok === false) {
      return res.status(400).json({ success: false, error: verified.error });
    }

    const status = verified.kind === 'payment' ? verified.payment.status : verified.invoice.status;
    if (verified.kind === 'payment') {
      bookings.markPaidFromMoyasar({
        paymentId: verified.payment.id,
        invoiceId: verified.payment.invoiceId,
        bookingId: verified.payment.bookingId,
        status,
      });
    } else {
      bookings.markPaidFromMoyasar({ invoiceId: verified.invoice.id, status });
    }

    const transactionUrl = verified.kind === 'payment' ? verified.payment.transactionUrl : undefined;
    res.json({ success: true, status, transactionUrl: transactionUrl || null });
  });
}
