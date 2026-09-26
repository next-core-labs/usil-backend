import type { Express, Request, Response } from 'express';
import { createVendorStore, VendorStoreError } from './vendor-store';
import { enrichVendorServices } from '../../core/data/saudiMarket';
import { isPublicMarketplaceListing } from '../../core/utils/catalogMedia';
import { createVendorApplicationStore } from './vendor-applications';
import {
  SOCIAL_NETWORKS,
  emptyVendorSocials,
  type SocialNetwork,
  type VendorSocials,
} from './vendor-socials';
import type { PublicUser } from '../auth/auth';
import { isVendorSupervisor } from '../auth/roles';
import { buildVendorHubs } from './vendor-hubs';

type AuthApi = {
  userFromRequest: (req: Request) => { id: string; role: string; name?: string; email?: string } | null;
  requireRole: (roles: Array<'client' | 'vendor' | 'admin' | 'accounts_manager'>) => (
    req: Request,
    res: Response,
    next: () => void,
  ) => void;
  saveUserSocials?: (userId: string, socials: VendorSocials) => PublicUser | null;
  findUserByEmail?: (email: string) => { id: string; email: string; socials?: VendorSocials } | null;
  listVendorUsers?: () => PublicUser[];
};

function statusOf(error: unknown): number {
  return error instanceof VendorStoreError ? error.status : 400;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function vendorIdFrom(req: Request): string | null {
  const user = (req as Request & { user?: { id: string; role: string } }).user;
  if (!user) return null;
  if (isVendorSupervisor(user.role) && typeof req.query.vendorId === 'string' && req.query.vendorId) {
    return req.query.vendorId;
  }
  return user.id;
}

export function registerVendorRoutes(app: Express, auth: AuthApi, dataDir: string) {
  const store = createVendorStore(dataDir);
  const applications = createVendorApplicationStore(dataDir);
  const guard = auth.requireRole(['vendor', 'admin']);

  /** Vendor-typed handles/URLs — always re-parsed, verification never taken from the body. */
  function persistSocials(vendorId: string, socials: unknown) {
    const saved = store.saveSocials(vendorId, socials);
    auth.saveUserSocials?.(vendorId, saved);
    return saved;
  }

  /** Admin-reviewed socials copied across from an application. */
  function syncReviewedSocials(vendorId: string, socials: VendorSocials) {
    const saved = store.replaceSocials(vendorId, socials);
    auth.saveUserSocials?.(vendorId, saved);
    return saved;
  }

  /** The application behind a public vendor id, so the public file can fall back to it. */
  function publicVendor(id: string) {
    const vendors = auth.listVendorUsers?.() || [];
    const user = vendors.find((item) => item.id === id);
    const application = user ? applications.findByEmail(user.email) : applications.findById(id);
    return { vendorId: user?.id, application };
  }

  app.get('/api/vendor/workspace', guard, (req: Request, res: Response) => {
    const vendorId = vendorIdFrom(req);
    if (!vendorId) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
    res.json({ success: true, data: store.getWorkspace(vendorId) });
  });

  app.put('/api/vendor/workspace', guard, (req: Request, res: Response) => {
    const vendorId = vendorIdFrom(req);
    if (!vendorId) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
    try {
      const user = auth.userFromRequest(req);
      const saved = store.saveVendorWorkspace(vendorId, req.body || {}, user?.name);
      res.json({ success: true, data: saved });
    } catch (error) {
      res.status(statusOf(error)).json({ success: false, error: messageOf(error, 'تعذر حفظ مساحة المورّد') });
    }
  });

  app.get('/api/vendor/summary', guard, (req: Request, res: Response) => {
    const vendorId = vendorIdFrom(req);
    if (!vendorId) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
    res.json({ success: true, data: store.summary(vendorId) });
  });

  app.post('/api/vendor/bookings', guard, (req: Request, res: Response) => {
    const vendorId = vendorIdFrom(req);
    if (!vendorId) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
    try {
      const booking = store.addBooking(vendorId, req.body || {});
      res.status(201).json({ success: true, booking });
    } catch (error) {
      res.status(statusOf(error)).json({ success: false, error: messageOf(error, 'تعذر إنشاء الحجز') });
    }
  });

  app.patch('/api/vendor/bookings/:id', guard, (req: Request, res: Response) => {
    const vendorId = vendorIdFrom(req);
    if (!vendorId) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
    try {
      const booking = store.updateBooking(vendorId, req.params.id, req.body || {});
      if (!booking) return res.status(404).json({ success: false, error: 'الحجز غير موجود' });
      res.json({ success: true, booking });
    } catch (error) {
      res.status(statusOf(error)).json({ success: false, error: messageOf(error, 'تعذر تعديل الحجز') });
    }
  });

  app.delete('/api/vendor/bookings/:id', guard, (req: Request, res: Response) => {
    const vendorId = vendorIdFrom(req);
    if (!vendorId) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
    const ok = store.removeBooking(vendorId, req.params.id);
    if (!ok) return res.status(404).json({ success: false, error: 'الحجز غير موجود' });
    res.json({ success: true });
  });

  app.post('/api/vendor/blocked-dates', guard, (req: Request, res: Response) => {
    const vendorId = vendorIdFrom(req);
    if (!vendorId) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
    try {
      const { blockedDate, created } = store.blockDate(vendorId, req.body || {});
      res.status(created ? 201 : 200).json({ success: true, blockedDate, created });
    } catch (error) {
      res.status(statusOf(error)).json({ success: false, error: messageOf(error, 'تعذر الإغلاق') });
    }
  });

  app.delete('/api/vendor/blocked-dates/:id', guard, (req: Request, res: Response) => {
    const vendorId = vendorIdFrom(req);
    if (!vendorId) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
    const ok = store.removeBlockedDate(vendorId, req.params.id);
    if (!ok) return res.status(404).json({ success: false, error: 'التاريخ غير موجود' });
    res.json({ success: true });
  });

  app.get('/api/catalog/listings', (_req: Request, res: Response) => {
    const approvedIds = new Set((auth.listVendorUsers?.() || []).map((user) => user.id));
    const listings = store.listAllListings().filter((listing) => approvedIds.has(listing.vendorId));
    res.json({
      success: true,
      data: enrichVendorServices(listings.map((listing) => store.listingToPublicService(listing))).filter(
        isPublicMarketplaceListing,
      ),
    });
  });

  app.get('/api/vendors/:id', (req: Request, res: Response) => {
    const { vendorId, application } = publicVendor(String(req.params.id || ''));
    if (!vendorId) {
      return res.status(404).json({ success: false, error: 'المورد غير موجود أو لم يُعتمد بعد' });
    }
    if (application && application.status !== 'approved') {
      return res.status(404).json({ success: false, error: 'المورد غير موجود أو لم يُعتمد بعد' });
    }
    const file = store.getPublicFile(vendorId, application);
    if (!file) {
      return res.status(404).json({ success: false, error: 'المورد غير موجود أو لم يُعتمد بعد' });
    }
    const listings = store.getWorkspace(vendorId).listings.map((listing) => store.listingToPublicService(listing));
    res.json({
      success: true,
      data: {
        ...file,
        listings: enrichVendorServices(listings).filter(isPublicMarketplaceListing),
      },
    });
  });

  app.get('/api/vendor/socials', guard, (req: Request, res: Response) => {
    const vendorId = vendorIdFrom(req);
    if (!vendorId) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
    res.json({ success: true, data: store.getSocials(vendorId) });
  });

  app.put('/api/vendor/socials', guard, (req: Request, res: Response) => {
    const vendorId = vendorIdFrom(req);
    if (!vendorId) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
    try {
      const saved = persistSocials(vendorId, req.body || {});
      res.json({ success: true, data: saved });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'تعذر حفظ حسابات التواصل',
      });
    }
  });

  app.get('/api/vendors/:id/socials', (req: Request, res: Response) => {
    // Same gate as GET /api/vendors/:id: only an approved vendor account is public.
    const { vendorId, application } = publicVendor(String(req.params.id || ''));
    const isPublic = Boolean(vendorId) && (!application || application.status === 'approved');
    const socials = isPublic && vendorId ? store.getPublicSocials(vendorId, application) : [];
    res.json({
      success: true,
      data: socials,
      empty: !socials.length,
      message: socials.length ? undefined : 'المورد ما ربط حسابات بعد',
    });
  });

  app.get('/api/vendor/listings', guard, (req: Request, res: Response) => {
    const vendorId = vendorIdFrom(req);
    if (!vendorId) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
    res.json({ success: true, data: store.getWorkspace(vendorId).listings });
  });

  app.post('/api/vendor/listings', guard, (req: Request, res: Response) => {
    const vendorId = vendorIdFrom(req);
    if (!vendorId) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
    try {
      const user = auth.userFromRequest(req);
      const listing = store.addListing(vendorId, req.body || {}, (user as { name?: string } | null)?.name);
      res.status(201).json({ success: true, listing });
    } catch (error) {
      res.status(statusOf(error)).json({
        success: false,
        error: messageOf(error, 'تعذر حفظ المنتج'),
      });
    }
  });

  app.patch('/api/vendor/listings/:id', guard, (req: Request, res: Response) => {
    const vendorId = vendorIdFrom(req);
    if (!vendorId) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
    try {
      const user = auth.userFromRequest(req);
      const listing = store.updateListing(
        vendorId,
        req.params.id,
        req.body || {},
        (user as { name?: string } | null)?.name,
      );
      if (!listing) return res.status(404).json({ success: false, error: 'المنتج غير موجود' });
      res.json({ success: true, listing });
    } catch (error) {
      res.status(statusOf(error)).json({
        success: false,
        error: messageOf(error, 'تعذر تعديل المنتج'),
      });
    }
  });

  app.delete('/api/vendor/listings/:id', guard, (req: Request, res: Response) => {
    const vendorId = vendorIdFrom(req);
    if (!vendorId) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
    const ok = store.removeListing(vendorId, req.params.id);
    if (!ok) return res.status(404).json({ success: false, error: 'المنتج غير موجود' });
    res.json({ success: true });
  });

  const adminOnly = auth.requireRole(['admin']);

  app.get('/api/admin/vendor-hubs', adminOnly, (req: Request, res: Response) => {
    const actor = auth.userFromRequest(req);
    if (!actor) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
    const hubs = buildVendorHubs({
      actor: { id: actor.id, email: actor.email || '' },
      vendors: auth.listVendorUsers?.() || [],
      applications: applications.list().map((row) => ({
        id: row.id,
        email: row.email,
        firstName: row.firstName,
        familyName: row.familyName,
        projectName: row.projectName,
        status: row.status,
      })),
      summaries: store.listSummaries(),
    });
    res.json({ success: true, data: hubs });
  });

  app.get('/api/admin/vendor-socials', adminOnly, (_req: Request, res: Response) => {
    const users = auth.listVendorUsers?.() || [];
    const workspaceRows = store.listSocials();
    const byId = new Map<string, { vendorId: string; name: string; email?: string; projectName?: string; socials: VendorSocials; source: string }>();

    for (const user of users) {
      const ws = store.getSocials(user.id);
      byId.set(user.id, {
        vendorId: user.id,
        name: user.name,
        email: user.email,
        socials: ws.links.length ? ws : user.socials || emptyVendorSocials(),
        source: 'user',
      });
    }
    for (const row of workspaceRows) {
      const existing = byId.get(row.vendorId);
      if (existing) {
        existing.socials = row.socials;
        continue;
      }
      byId.set(row.vendorId, {
        vendorId: row.vendorId,
        name: 'مورّد يوصل',
        socials: row.socials,
        source: 'workspace',
      });
    }
    for (const app of applications.list()) {
      if (!app.socials?.links?.length) continue;
      const user = auth.findUserByEmail?.(app.email);
      if (user && byId.has(user.id)) {
        const current = byId.get(user.id)!;
        if (!current.socials.links.length) current.socials = app.socials;
        current.projectName = app.projectName;
        continue;
      }
      byId.set(app.id, {
        vendorId: app.id,
        name: `${app.firstName} ${app.familyName}`.trim(),
        email: app.email,
        projectName: app.projectName,
        socials: app.socials,
        source: 'application',
      });
    }

    res.json({ success: true, data: Array.from(byId.values()) });
  });

  function resolveVerifyTarget(id: string): { kind: 'user' | 'application'; id: string } {
    if (applications.findById(id)) return { kind: 'application', id };
    return { kind: 'user', id };
  }

  function applyAdminVerify(id: string, network: SocialNetwork, verified: boolean, actorName: string) {
    const target = resolveVerifyTarget(id);
    if (target.kind === 'application') {
      const row = applications.verifySocial(id, network, verified, actorName);
      if (!row) throw new Error('الطلب غير موجود');
      const user = auth.findUserByEmail?.(row.email);
      if (user) {
        syncReviewedSocials(user.id, row.socials || emptyVendorSocials());
      }
      return row.socials;
    }
    const socials = store.verifySocial(id, network, verified, actorName);
    auth.saveUserSocials?.(id, socials);
    return socials;
  }

  app.post('/api/admin/vendor-socials/:id/:network/verify', adminOnly, (req: Request, res: Response) => {
    try {
      const network = String(req.params.network) as SocialNetwork;
      if (!SOCIAL_NETWORKS.includes(network)) {
        return res.status(400).json({ success: false, error: 'شبكة غير معروفة' });
      }
      const actor = auth.userFromRequest(req);
      const socials = applyAdminVerify(req.params.id, network, true, actor?.name || 'إدارة يوصل');
      res.json({ success: true, data: socials });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'تعذر توثيق الحساب',
      });
    }
  });

  app.post('/api/admin/vendor-socials/:id/:network/unverify', adminOnly, (req: Request, res: Response) => {
    try {
      const network = String(req.params.network) as SocialNetwork;
      if (!SOCIAL_NETWORKS.includes(network)) {
        return res.status(400).json({ success: false, error: 'شبكة غير معروفة' });
      }
      const actor = auth.userFromRequest(req);
      const socials = applyAdminVerify(req.params.id, network, false, actor?.name || 'إدارة يوصل');
      res.json({ success: true, data: socials });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'تعذر إلغاء التوثيق',
      });
    }
  });

  app.get('/api/admin/listings', adminOnly, (_req: Request, res: Response) => {
    res.json({ success: true, data: store.listAllListings() });
  });

  app.patch('/api/admin/listings/:id', adminOnly, (req: Request, res: Response) => {
    try {
      const listing = store.updateListingAdmin(req.params.id, req.body || {});
      if (!listing) return res.status(404).json({ success: false, error: 'المنتج غير موجود' });
      res.json({ success: true, listing });
    } catch (error) {
      res.status(statusOf(error)).json({
        success: false,
        error: messageOf(error, 'تعذر تعديل مسار المنتج'),
      });
    }
  });

  return store;
}
