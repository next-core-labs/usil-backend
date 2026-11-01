import type { Express, Request, Response } from 'express';
import { isVendorSupervisor } from '../auth/roles.ts';
import { publicSiteUrl } from '../auth/email-verification.ts';
import { createSlidingWindowLimiter } from '../shared/booking-guards.ts';
import { pushPayLinkPaid } from '../push/push-notices.ts';
import {
  MOYASAR_NOT_CONFIGURED,
  cancelMoyasarInvoice,
  createInvoice,
  moyasarErrorCode,
  moyasarWebhookUrl,
} from '../payments/moyasar.ts';
import type { VendorOffice } from './vendor-office.ts';
import {
  PAY_LINK_KINDS,
  PAY_LINK_SOURCE,
  PayLinkError,
  applyPaymentToOffice,
  createPayLinkStore,
  payableFor,
  type PayLinkKind,
  type VendorPayLink,
} from './vendor-pay-links.ts';

type AuthApi = {
  requireRole: (roles: Array<'vendor' | 'admin'>) => (req: Request, res: Response, next: () => void) => void;
};

export type PayLinkDeps = {
  vendors: {
    getOffice: (vendorId: string) => VendorOffice;
    patchOffice: (vendorId: string, body: unknown) => VendorOffice;
    getWorkspace: (vendorId: string) => { profile?: { projectName?: string } };
  };
  /** Port to fall back on when no public site URL is configured. */
  port?: string | number;
  now?: () => Date;
  /** Tests stand in for Moyasar. */
  createInvoice?: typeof createInvoice;
};

/** A Moyasar result as the webhook or the browser callback saw it. */
export type PayLinkSettlement = {
  payLinkId?: string;
  invoiceId?: string;
  paymentId?: string;
  status: string;
  amountHalalas: number;
  currency: string;
};

/** Each link raises a real Moyasar invoice. */
const LINK_LIMIT = 20;
const LINK_WINDOW_MS = 60_000;

const KIND_LABEL: Record<PayLinkKind, string> = { invoice: 'فاتورة', quotation: 'عربون عرض السعر' };

function actorOf(req: Request): { id: string; role: string } | null {
  return (req as Request & { user?: { id: string; role: string } }).user || null;
}

/** Same rule as `vendorIdFrom` in vendor-routes.ts. */
function vendorIdFrom(req: Request): string | null {
  const user = actorOf(req);
  if (!user) return null;
  if (isVendorSupervisor(user.role) && typeof req.query.vendorId === 'string' && req.query.vendorId) {
    return req.query.vendorId;
  }
  return user.id;
}

/**
 * روابط دفع الفواتير وعروض الأسعار:
 *   GET  /api/vendor/pay-links          — the vendor's links and their status
 *   POST /api/vendor/pay-links          — `{ kind, docId }` → a Moyasar link
 * Returns the settle functions the payment webhook and callback call.
 */
export function registerVendorPayLinkRoutes(app: Express, auth: AuthApi, dataDir: string, deps: PayLinkDeps) {
  const store = createPayLinkStore(dataDir, deps.now);
  const vendorOrSupervisor = auth.requireRole(['vendor', 'admin']);
  const limiter = createSlidingWindowLimiter(LINK_LIMIT, LINK_WINDOW_MS);
  const raiseInvoice = deps.createInvoice || createInvoice;
  const now = deps.now || (() => new Date());
  const siteUrl = () => publicSiteUrl() || process.env.APP_URL || `http://localhost:${deps.port || 3000}`;

  function vendorName(vendorId: string): string {
    try {
      return String(deps.vendors.getWorkspace(vendorId).profile?.projectName || '').trim();
    } catch {
      return '';
    }
  }

  app.get('/api/vendor/pay-links', vendorOrSupervisor, (req: Request, res: Response) => {
    const vendorId = vendorIdFrom(req);
    if (!vendorId) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
    res.json({ success: true, data: store.listForVendor(vendorId) });
  });

  app.post('/api/vendor/pay-links', vendorOrSupervisor, async (req: Request, res: Response) => {
    const vendorId = vendorIdFrom(req);
    if (!vendorId) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
    if (!limiter.allow(vendorId)) {
      return res.status(429).json({ success: false, error: 'طلبت روابط كثيرة. انتظر دقيقة ثم حاول.' });
    }
    const kind = req.body?.kind as PayLinkKind;
    const docId = String(req.body?.docId || '').trim();
    if (!PAY_LINK_KINDS.includes(kind) || !docId) {
      return res.status(400).json({ success: false, error: 'حدّد الفاتورة أو عرض السعر.' });
    }

    try {
      const payable = payableFor(deps.vendors.getOffice(vendorId), kind, docId);
      // One payable link per document: resend the same one while the amount holds.
      const open = store.openFor(vendorId, kind, docId);
      if (open && open.amount === payable.amount) return res.json({ success: true, data: open, reused: true });

      const brand = vendorName(vendorId);
      const description = [`${KIND_LABEL[kind]} ${payable.docNumber}`.trim(), brand].filter(Boolean).join(' — ');
      const base = siteUrl();
      const docRef = `${vendorId}:${kind}:${docId}`;
      const invoice = await raiseInvoice({
        amountSar: payable.amount,
        description,
        successUrl: `${base}/payment/success`,
        backUrl: `${base}/payment/cancelled`,
        callbackUrl: moyasarWebhookUrl(),
        metadata: { source: PAY_LINK_SOURCE, vendorId: vendorId.slice(0, 120), doc: docRef.slice(0, 120) },
      });
      const link = store.add({
        vendorId,
        kind,
        docId,
        docNumber: payable.docNumber,
        clientName: payable.clientName,
        clientPhone: payable.clientPhone,
        amount: payable.amount,
        description,
        moyasarInvoiceId: invoice.id,
        url: invoice.url,
      });
      if (open) {
        // The document's amount changed; the old link should no longer be paid.
        store.update(open.id, { status: 'replaced' });
        void cancelMoyasarInvoice(open.moyasarInvoiceId).catch(() => undefined);
      }
      res.status(201).json({ success: true, data: link });
    } catch (error) {
      if (error instanceof PayLinkError) return res.status(error.status).json({ success: false, error: error.message });
      const code = moyasarErrorCode(error);
      if (code === 'not_configured') return res.status(503).json({ success: false, error: MOYASAR_NOT_CONFIGURED });
      if (code === 'invalid') return res.status(400).json({ success: false, error: (error as Error).message });
      if (!code) console.error('[pay-links] create failed', error);
      res.status(502).json({ success: false, error: 'تعذر إنشاء رابط الدفع من ميسر. حاول بعد قليل.' });
    }
  });

  /**
   * A payment Moyasar confirmed. Null when it is not one of ours, so the
   * caller tries the store orders next. Settling twice changes nothing.
   */
  function settlePaid(input: PayLinkSettlement): VendorPayLink | null {
    const link = store.findForMoyasar(input);
    if (!link) return null;
    if (link.status === 'paid' || link.status === 'refunded') return link;
    if (input.status !== 'paid') return link;
    if (input.currency !== 'SAR' || input.amountHalalas !== Math.round(link.amount * 100)) {
      console.warn('[pay-links] amount mismatch', link.id, input.amountHalalas, input.currency);
      return link;
    }
    const paidAt = now().toISOString();
    const paid = store.update(link.id, { status: 'paid', paymentId: input.paymentId, paidAt }) || link;
    try {
      const patch = applyPaymentToOffice(deps.vendors.getOffice(link.vendorId), paid, paidAt);
      if (patch) deps.vendors.patchOffice(link.vendorId, patch);
    } catch (error) {
      // The money is recorded on the link either way; the document is a convenience.
      console.error('[pay-links] could not update the paid document', link.id, error);
    }
    pushPayLinkPaid(paid.vendorId, paid);
    return paid;
  }

  /** Refunded through Moyasar: the payment leaves the vendor's balance. */
  function settleRefunded(input: Pick<PayLinkSettlement, 'payLinkId' | 'invoiceId'>): VendorPayLink | null {
    const link = store.findForMoyasar(input);
    if (!link) return null;
    if (link.status !== 'paid') return link;
    return store.update(link.id, { status: 'refunded', refundedAt: now().toISOString() });
  }

  return { settlePaid, settleRefunded, listForVendor: store.listForVendor };
}

export type PayLinkService = ReturnType<typeof registerVendorPayLinkRoutes>;
