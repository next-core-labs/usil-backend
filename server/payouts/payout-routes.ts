import type { Express, Request, Response } from 'express';
import type { PlatformBooking } from '../bookings/booking-store.ts';
import { isVendorSupervisor } from '../auth/roles.ts';
import { notifyPayoutDecision, notifyPayoutRequested } from '../shared/optional-mail.ts';
import { computeVendorEarnings, rawBalanceHalalas, type VendorEarnings } from './earnings.ts';
import { createPayoutStore, parsePayoutInput, PayoutError, type PayoutRequest } from './payout-store.ts';

type Actor = { id: string; role: string; name?: string; email?: string };

type AuthApi = {
  requireRole: (roles: Array<'vendor' | 'admin'>) => (req: Request, res: Response, next: () => void) => void;
  /** Vendor accounts — a vendor's id is its account id. */
  listVendorUsers?: () => Array<{ id: string; name?: string; email?: string }>;
};

export type PayoutDeps = {
  bookings: { list: () => PlatformBooking[] };
  vendors: {
    listAllListings: () => Array<{ id: string; vendorId: string }>;
    getWorkspace: (vendorId: string) => { profile?: { projectName?: string } };
  };
  now?: () => Date;
};

const PICK_VENDOR = 'اختر المورّد أولاً.';
const NOT_A_VENDOR = 'هذا الحساب ليس مورّداً.';

function actorOf(req: Request): Actor | null {
  return (req as Request & { user?: Actor }).user || null;
}

function errorOut(res: Response, error: unknown, fallback: string) {
  if (error instanceof PayoutError) return res.status(error.status).json({ success: false, error: error.message });
  console.error('[payouts]', error);
  return res.status(500).json({ success: false, error: fallback });
}

/**
 * أرباح المورّد وطلبات السحب.
 *
 * Vendor side (a vendor, or a supervisor with `?vendorId=` — the same rule as
 * `vendorIdFrom` in vendor-routes.ts):
 *   GET  /api/vendor/earnings
 *   GET  /api/vendor/payouts
 *   POST /api/vendor/payouts
 * Admin side (admin + accounts_manager):
 *   GET   /api/admin/payouts
 *   PATCH /api/admin/payouts/:id
 *
 * The balance is always recomputed from the platform orders; nothing here
 * moves money — the owner transfers by hand and records the reference.
 */
export function registerPayoutRoutes(app: Express, auth: AuthApi, dataDir: string, deps: PayoutDeps) {
  const store = createPayoutStore(dataDir, deps.now);
  const vendorOrSupervisor = auth.requireRole(['vendor', 'admin']);
  const supervisorOnly = auth.requireRole(['admin']);

  const vendorUser = (vendorId: string) => (auth.listVendorUsers?.() || []).find((row) => String(row.id) === vendorId);

  function vendorName(vendorId: string, fallback = ''): string {
    let projectName = '';
    try {
      projectName = String(deps.vendors.getWorkspace(vendorId).profile?.projectName || '').trim();
    } catch {
      /* no workspace */
    }
    return projectName || String(vendorUser(vendorId)?.name || '').trim() || fallback;
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

  function earningsFor(vendorId: string): VendorEarnings {
    const own = new Set(
      deps.vendors
        .listAllListings()
        .filter((listing) => String(listing.vendorId) === vendorId)
        .map((listing) => String(listing.id)),
    );
    return computeVendorEarnings({
      vendorId,
      ownListingIds: own,
      bookings: deps.bookings.list(),
      payouts: store.listForVendor(vendorId),
    });
  }

  app.get('/api/vendor/earnings', vendorOrSupervisor, (req: Request, res: Response) => {
    const vendorId = targetVendor(req, res);
    if (!vendorId) return;
    try {
      res.json({ success: true, data: earningsFor(vendorId) });
    } catch (error) {
      errorOut(res, error, 'تعذر حساب الأرباح.');
    }
  });

  app.get('/api/vendor/payouts', vendorOrSupervisor, (req: Request, res: Response) => {
    const vendorId = targetVendor(req, res);
    if (!vendorId) return;
    res.json({ success: true, data: store.listForVendor(vendorId) });
  });

  app.post('/api/vendor/payouts', vendorOrSupervisor, (req: Request, res: Response) => {
    const vendorId = targetVendor(req, res);
    if (!vendorId) return;
    try {
      const input = parsePayoutInput(req.body);
      const mine = store.listForVendor(vendorId);
      if (mine.some((row) => row.status === 'requested')) {
        throw new PayoutError('لديك طلب سحب قيد المراجعة. انتظر قرار الإدارة قبل طلب جديد.', 409);
      }
      const { available } = earningsFor(vendorId);
      if (Math.round(input.amount * 100) > Math.round(available * 100)) {
        throw new PayoutError(`المبلغ أكبر من الرصيد المتاح للسحب (${available.toFixed(2)} ر.س).`);
      }
      const row = store.add(vendorId, vendorName(vendorId, 'مورّد'), input);
      notifyPayoutRequested(row.vendorName, row.amount, row.id);
      res.status(201).json({ success: true, data: row });
    } catch (error) {
      errorOut(res, error, 'تعذر إرسال طلب السحب.');
    }
  });

  app.get('/api/admin/payouts', supervisorOnly, (_req: Request, res: Response) => {
    const rows = store.list().map((row) => {
      const user = vendorUser(row.vendorId);
      return { ...row, vendorName: vendorName(row.vendorId, row.vendorName), vendorEmail: String(user?.email || '') };
    });
    res.json({ success: true, data: rows });
  });

  app.patch('/api/admin/payouts/:id', supervisorOnly, (req: Request, res: Response) => {
    const actor = actorOf(req);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    try {
      const current = store.findById(String(req.params.id));
      if (!current) throw new PayoutError('طلب السحب غير موجود.', 404);
      // An order may have been cancelled since the request: approving must still be covered.
      if (body.status === 'approved' && current.status === 'requested') {
        if (rawBalanceHalalas(earningsFor(current.vendorId)) < 0) {
          throw new PayoutError('رصيد المورّد المكتمل لم يعد يغطي هذا الطلب (أُلغي طلب بعد تقديمه). ارفضه أو انتظر.', 409);
        }
      }
      const row: PayoutRequest = store.decide(
        current.id,
        { status: body.status, reference: body.reference, adminNote: body.adminNote },
        String(actor?.name || actor?.email || actor?.id || ''),
      );
      const email = String(vendorUser(row.vendorId)?.email || '');
      if (email && (row.status === 'approved' || row.status === 'paid' || row.status === 'rejected')) {
        notifyPayoutDecision(email, {
          id: row.id,
          amount: row.amount,
          status: row.status,
          reference: row.reference,
          adminNote: row.adminNote,
        });
      }
      res.json({ success: true, data: { ...row, vendorName: vendorName(row.vendorId, row.vendorName), vendorEmail: email } });
    } catch (error) {
      errorOut(res, error, 'تعذر تحديث طلب السحب.');
    }
  });

  return store;
}
