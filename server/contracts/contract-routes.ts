import type { Express, Request, Response } from 'express';
import { isVendorSupervisor } from '../auth/roles.ts';
import { publicSiteUrl } from '../auth/email-verification.ts';
import { clientIp, createSlidingWindowLimiter } from '../shared/booking-guards.ts';
import { notifyContractSigned } from '../shared/optional-mail.ts';
import {
  ContractError,
  createContractStore,
  parseContractInput,
  parseSignInput,
  type Contract,
} from './contract-store.ts';

type Actor = { id: string; role: string; name?: string; email?: string };

type AuthApi = {
  requireRole: (roles: Array<'vendor' | 'admin'>) => (req: Request, res: Response, next: () => void) => void;
  listVendorUsers?: () => Array<{ id: string; name?: string; email?: string }>;
};

/** Brand shown on the public signing page. Everything optional. */
export type VendorBrand = { name?: string; logoUrl?: string; crNumber?: string; email?: string };

export type ContractDeps = {
  /** The vendor's old dashboard rows (workspace `contracts`), imported once. */
  legacyContracts: (vendorId: string) => unknown[];
  /** Project name and brand (office `brandSettings` / workspace profile). */
  vendorBrand: (vendorId: string) => VendorBrand;
  now?: () => Date;
  /** Per-IP budgets for the public routes; tests lower them. */
  publicReadLimit?: number;
  publicSignLimit?: number;
};

const PICK_VENDOR = 'اختر المورّد أولاً.';
const NOT_A_VENDOR = 'هذا الحساب ليس مورّداً.';
const LINK_INVALID = 'رابط العقد غير صالح أو أُلغي. تواصل مع المورّد ليرسل لك رابطاً جديداً.';
const TOO_MANY = 'محاولات كثيرة. انتظر دقيقة ثم حاول مرة أخرى.';

function actorOf(req: Request): Actor | null {
  return (req as Request & { user?: Actor }).user || null;
}

function errorOut(res: Response, error: unknown, fallback: string) {
  if (error instanceof ContractError) {
    return res.status(error.status).json({ success: false, error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  console.error('[contracts]', error);
  return res.status(500).json({ success: false, error: fallback });
}

export function signUrlFor(token: string): string {
  return `${publicSiteUrl()}/sign/${token}`;
}

/** Only a server upload or an https image is passed to the public page — never a large inline blob. */
function safeLogo(raw: unknown): string | undefined {
  const value = String(raw || '').trim();
  if (/^\/uploads\/[A-Za-z0-9._-]+$/.test(value)) return value;
  if (/^https:\/\/[^\s"'<>]+$/.test(value) && value.length <= 500) return value;
  return undefined;
}

/** What the vendor console sees: everything but the raw token, plus the link built from it. */
function vendorView(row: Contract, withImage: boolean) {
  const { shareToken, signature, ...rest } = row;
  return {
    ...rest,
    ...(signature
      ? { signature: withImage ? signature : { ...signature, image: '', hasImage: Boolean(signature.image) } }
      : {}),
    ...(shareToken ? { signUrl: signUrlFor(shareToken) } : {}),
  };
}

/** What the client sees on `/sign/<token>` — no vendor id, no internals. */
export function publicView(row: Contract, brand: VendorBrand) {
  const phone = String(row.client.phone || '');
  return {
    number: row.number,
    vendorName: row.vendorName,
    vendor: {
      name: brand.name || row.vendorName,
      ...(safeLogo(brand.logoUrl) ? { logoUrl: safeLogo(brand.logoUrl) } : {}),
      ...(brand.crNumber ? { crNumber: String(brand.crNumber).slice(0, 30) } : {}),
    },
    client: {
      name: row.client.name,
      ...(phone.length > 4 ? { phoneMasked: `${'•'.repeat(Math.max(0, phone.length - 3))}${phone.slice(-3)}` } : {}),
    },
    event: row.event,
    amounts: row.amounts,
    terms: row.terms,
    ...(row.notes ? { notes: row.notes } : {}),
    status: row.status,
    contentHash: row.contentHash,
    ...(row.vendorSignature ? { issuedBy: row.vendorSignature } : {}),
    ...(row.sentAt ? { sentAt: row.sentAt } : {}),
    ...(row.status === 'signed' && row.signature
      ? { signedAt: row.signedAt || row.signature.signedAt, signature: { name: row.signature.name, signedAt: row.signature.signedAt } }
      : {}),
  };
}

/**
 * العقود الإلكترونية.
 *
 * Vendor side (a vendor, or a supervisor with `?vendorId=` — the rule of
 * `vendorIdFrom` in vendor-routes.ts; a supervisor must name the vendor):
 *   GET    /api/vendor/contracts            list (imports the old dashboard's rows once)
 *   GET    /api/vendor/contracts/:id        one, with the signature image
 *   POST   /api/vendor/contracts            new draft
 *   PATCH  /api/vendor/contracts/:id        edit (draft or sent)
 *   DELETE /api/vendor/contracts/:id        drafts only
 *   POST   /api/vendor/contracts/:id/send   issue the signing link
 *   POST   /api/vendor/contracts/:id/cancel
 * Public (no account, rate-limited per IP):
 *   GET    /api/contracts/sign/:token
 *   POST   /api/contracts/sign/:token
 */
export function registerContractRoutes(app: Express, auth: AuthApi, dataDir: string, deps: ContractDeps) {
  const store = createContractStore(dataDir, deps.now);
  const vendorOrSupervisor = auth.requireRole(['vendor', 'admin']);
  const readLimiter = createSlidingWindowLimiter(deps.publicReadLimit ?? 60, 60_000);
  const signLimiter = createSlidingWindowLimiter(deps.publicSignLimit ?? 10, 60_000);

  const vendorUser = (vendorId: string) => (auth.listVendorUsers?.() || []).find((row) => String(row.id) === vendorId);

  function brandOf(vendorId: string): VendorBrand {
    try {
      return deps.vendorBrand(vendorId) || {};
    } catch {
      return {};
    }
  }

  function vendorName(vendorId: string): string {
    return String(brandOf(vendorId).name || vendorUser(vendorId)?.name || '').trim() || 'المورّد';
  }

  /** The vendor this call is about, or an error already sent. */
  function targetVendor(req: Request, res: Response): string | null {
    const actor = actorOf(req);
    if (!actor) {
      res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
      return null;
    }
    if (!isVendorSupervisor(actor.role)) return actor.id;
    const vendorId = typeof req.query.vendorId === 'string' ? req.query.vendorId.trim() : '';
    if (!vendorId) {
      res.status(400).json({ success: false, error: PICK_VENDOR });
      return null;
    }
    if (!vendorUser(vendorId)) {
      res.status(404).json({ success: false, error: NOT_A_VENDOR });
      return null;
    }
    return vendorId;
  }

  function importLegacy(vendorId: string) {
    let rows: unknown[] = [];
    try {
      rows = deps.legacyContracts(vendorId) || [];
    } catch {
      rows = [];
    }
    store.importLegacyOnce(vendorId, vendorName(vendorId), rows);
  }

  app.get('/api/vendor/contracts', vendorOrSupervisor, (req: Request, res: Response) => {
    const vendorId = targetVendor(req, res);
    if (!vendorId) return;
    try {
      importLegacy(vendorId);
      res.json({ success: true, data: store.listForVendor(vendorId).map((row) => vendorView(row, false)) });
    } catch (error) {
      errorOut(res, error, 'تعذر تحميل العقود.');
    }
  });

  app.get('/api/vendor/contracts/:id', vendorOrSupervisor, (req: Request, res: Response) => {
    const vendorId = targetVendor(req, res);
    if (!vendorId) return;
    const row = store.findForVendor(vendorId, String(req.params.id));
    if (!row) return res.status(404).json({ success: false, error: 'العقد غير موجود.' });
    res.json({ success: true, data: vendorView(row, true) });
  });

  app.post('/api/vendor/contracts', vendorOrSupervisor, (req: Request, res: Response) => {
    const vendorId = targetVendor(req, res);
    if (!vendorId) return;
    try {
      importLegacy(vendorId);
      const row = store.create(vendorId, vendorName(vendorId), parseContractInput(req.body));
      res.status(201).json({ success: true, data: vendorView(row, true) });
    } catch (error) {
      errorOut(res, error, 'تعذر حفظ العقد.');
    }
  });

  app.patch('/api/vendor/contracts/:id', vendorOrSupervisor, (req: Request, res: Response) => {
    const vendorId = targetVendor(req, res);
    if (!vendorId) return;
    try {
      const row = store.update(vendorId, String(req.params.id), vendorName(vendorId), parseContractInput(req.body));
      res.json({ success: true, data: vendorView(row, true) });
    } catch (error) {
      errorOut(res, error, 'تعذر حفظ العقد.');
    }
  });

  app.delete('/api/vendor/contracts/:id', vendorOrSupervisor, (req: Request, res: Response) => {
    const vendorId = targetVendor(req, res);
    if (!vendorId) return;
    try {
      store.remove(vendorId, String(req.params.id));
      res.json({ success: true });
    } catch (error) {
      errorOut(res, error, 'تعذر حذف العقد.');
    }
  });

  app.post('/api/vendor/contracts/:id/send', vendorOrSupervisor, (req: Request, res: Response) => {
    const vendorId = targetVendor(req, res);
    if (!vendorId) return;
    try {
      const row = store.send(vendorId, String(req.params.id), vendorName(vendorId));
      res.json({ success: true, data: vendorView(row, true), signUrl: signUrlFor(row.shareToken as string) });
    } catch (error) {
      errorOut(res, error, 'تعذر إرسال العقد.');
    }
  });

  app.post('/api/vendor/contracts/:id/cancel', vendorOrSupervisor, (req: Request, res: Response) => {
    const vendorId = targetVendor(req, res);
    if (!vendorId) return;
    try {
      const row = store.cancel(vendorId, String(req.params.id));
      res.json({ success: true, data: vendorView(row, true) });
    } catch (error) {
      errorOut(res, error, 'تعذر إلغاء العقد.');
    }
  });

  /* ── Public signing page ─────────────────────────────────────────── */

  function publicHeaders(res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }

  app.get('/api/contracts/sign/:token', (req: Request, res: Response) => {
    publicHeaders(res);
    if (!readLimiter.allow(clientIp(req))) return res.status(429).json({ success: false, error: TOO_MANY });
    const row = store.findByToken(String(req.params.token || ''));
    if (!row || row.status === 'cancelled' || row.status === 'draft') {
      return res.status(404).json({ success: false, error: LINK_INVALID });
    }
    res.json({ success: true, data: publicView(row, brandOf(row.vendorId)) });
  });

  app.post('/api/contracts/sign/:token', (req: Request, res: Response) => {
    publicHeaders(res);
    if (!signLimiter.allow(clientIp(req))) return res.status(429).json({ success: false, error: TOO_MANY });
    const token = String(req.params.token || '');
    try {
      const existing = store.findByToken(token);
      if (!existing || existing.status === 'cancelled' || existing.status === 'draft') {
        throw new ContractError(LINK_INVALID, 404);
      }
      if (existing.status === 'signed') {
        return res.status(409).json({
          success: false,
          code: 'already_signed',
          error: 'هذا العقد موقّع من قبل.',
          data: publicView(existing, brandOf(existing.vendorId)),
        });
      }
      const input = parseSignInput(req.body);
      const row = store.sign(token, input, {
        ip: clientIp(req),
        userAgent: String(req.headers['user-agent'] || ''),
      });
      const brand = brandOf(row.vendorId);
      const email = String(vendorUser(row.vendorId)?.email || brand.email || '');
      if (email) {
        notifyContractSigned(email, {
          number: row.number,
          clientName: row.client.name,
          signedByName: row.signature?.name || '',
          service: row.event.service,
        });
      }
      res.json({ success: true, data: publicView(row, brand) });
    } catch (error) {
      errorOut(res, error, 'تعذر حفظ التوقيع. حاول مرة أخرى.');
    }
  });

  return store;
}
