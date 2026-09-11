import type { Express, Request, Response } from 'express';
import { createVendorApplicationStore, publicApplication } from './vendor-applications';
import { hashPassword, type PublicUser } from '../auth/auth';
import { saveUpload } from '../auth/avatar';
import { createVendorStore } from './vendor-store';
import { persistListingImages } from './listing-media';
import { personNameFromParts, profileFromApplication, publicVendorFile } from './vendor-profile';
import type { VendorSocials } from './vendor-socials';
import { LISTING_MIN_IMAGES, validateVendorListing } from './vendor-listings';

type AuthApi = {
  userFromRequest: (req: Request) => PublicUser | null;
  requireRole: (roles: Array<'client' | 'vendor' | 'admin'>) => (
    req: Request,
    res: Response,
    next: () => void,
  ) => void;
  addVendorUser: (input: {
    name: string;
    email: string;
    phone: string;
    passwordHash: string;
    avatarUrl?: string;
    socials?: VendorSocials;
  }) => PublicUser;
  ensureApplicantUser?: (input: {
    name: string;
    email: string;
    phone: string;
    passwordHash: string;
    avatarUrl?: string;
  }) => PublicUser;
  startSession?: (res: Response, userId: string, remember?: boolean) => string;
  findUserByEmail?: (email: string) => { id: string; email: string; role?: string } | null;
};

export function registerVendorApplicationRoutes(app: Express, auth: AuthApi, dataDir: string) {
  const store = createVendorApplicationStore(dataDir);
  const workspaces = createVendorStore(dataDir);
  const adminOnly = auth.requireRole(['admin']);

  app.post('/api/vendor-applications', (req: Request, res: Response) => {
    try {
      const body = { ...(req.body || {}) };
      if (body.logoDataUrl) {
        const logoUrl = saveUpload(dataDir, 'vendor-logo', String(body.logoDataUrl));
        if (logoUrl) body.logoUrl = logoUrl;
      }
      const listingBody = body.listing && typeof body.listing === 'object' ? body.listing : body;
      const listingImages = persistListingImages(
        dataDir,
        listingBody.images || listingBody.listingImages || body.listingImageDataUrls,
        listingBody.image,
      );
      if (listingImages.length < LISTING_MIN_IMAGES) {
        throw new Error('أضف صورتين حقيقيتين للمنتج من جهازك — ما نعرض صور وهمية');
      }
      const listingDraft = {
        title: listingBody.title || listingBody.listingTitle,
        category: listingBody.category || listingBody.listingCategory,
        shortDesc: listingBody.shortDesc || listingBody.listingShortDesc,
        price: listingBody.price ?? listingBody.listingPrice,
        priceUnit: listingBody.priceUnit || listingBody.listingPriceUnit,
        cities: listingBody.cities || listingBody.listingCities,
        images: listingImages,
        fulfillment: listingBody.fulfillment || body.fulfillment,
        bookingMode: listingBody.bookingMode || listingBody.listingBookingMode,
        vendorName: String(body.projectName || ''),
      };
      validateVendorListing(listingDraft, { requireImages: true });
      const passwordHash = hashPassword(String(req.body?.password || ''));
      const created = store.submit(body, passwordHash);
      const personName = personNameFromParts(created);
      const user = auth.ensureApplicantUser?.({
        name: personName || created.projectName,
        email: created.email,
        phone: created.phone,
        passwordHash,
        avatarUrl: created.logoUrl,
      });
      if (user && auth.startSession) auth.startSession(res, user.id);
      const vendorId = user?.id || created.id;
      workspaces.seedWorkspaceFromApplication(vendorId, created);
      const listing = workspaces.addListing(vendorId, listingDraft, created.projectName);
      const profile = profileFromApplication(created, vendorId, { listingCount: 1 });
      res.status(201).json({
        success: true,
        application: publicApplication(created),
        user: user || null,
        profile,
        file: publicVendorFile(profile),
        listing,
        message: 'وصل طلبك مع صور المنتج والسعر. يظهر في السوق بعد موافقة الإدارة.',
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'تعذر إرسال طلب المورّد',
      });
    }
  });

  app.get('/api/me/vendor-file', (req: Request, res: Response) => {
    const user = auth.userFromRequest(req);
    if (!user) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
    const application = store.findByEmail(user.email);
    const ws = workspaces.hasWorkspace(user.id) ? workspaces.getWorkspace(user.id) : null;
    const profile = application
      ? profileFromApplication(application, user.id, { listingCount: ws?.listings.length || 0 })
      : workspaces.ownProfile(user.id);
    if (!profile) {
      return res.json({
        success: true,
        application: null,
        profile: null,
        file: null,
        workspace: null,
      });
    }
    res.json({
      success: true,
      application: application ? publicApplication(application) : null,
      profile,
      file: application?.status === 'approved' || user.role === 'vendor' ? publicVendorFile({ ...profile, status: 'approved' }) : publicVendorFile(profile),
      workspace: ws
        ? {
            listings: ws.listings,
            socials: ws.socials,
            profile: ws.profile,
          }
        : null,
    });
  });

  app.get('/api/admin/vendor-applications', adminOnly, (_req: Request, res: Response) => {
    res.json({
      success: true,
      data: store.list().map(publicApplication),
    });
  });

  app.post('/api/admin/vendor-applications/:id/approve', adminOnly, (req: Request, res: Response) => {
    try {
      const actor = auth.userFromRequest(req);
      const row = store.decide(req.params.id, 'approved', actor?.name || 'إدارة يوصل');
      if (!row) return res.status(404).json({ success: false, error: 'الطلب غير موجود' });
      const previous = auth.findUserByEmail?.(row.email);
      const user = auth.addVendorUser({
        name: personNameFromParts(row) || row.projectName,
        email: row.email,
        phone: row.phone,
        passwordHash: row.passwordHash,
        avatarUrl: row.logoUrl,
        socials: row.socials,
      });
      if (previous?.id && previous.id !== user.id) {
        workspaces.moveWorkspace(previous.id, user.id);
      }
      const workspace = workspaces.seedWorkspaceFromApplication(user.id, row);
      res.json({
        success: true,
        application: publicApplication(row),
        user,
        profile: workspaces.ownProfile(user.id, row),
        workspace: {
          listings: workspace.listings,
          profile: workspace.profile,
        },
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'تعذر اعتماد الطلب',
      });
    }
  });

  app.post('/api/admin/vendor-applications/:id/reject', adminOnly, (req: Request, res: Response) => {
    try {
      const actor = auth.userFromRequest(req);
      const row = store.decide(
        req.params.id,
        'rejected',
        actor?.name || 'إدارة يوصل',
        String(req.body?.reason || 'رفض إداري'),
      );
      if (!row) return res.status(404).json({ success: false, error: 'الطلب غير موجود' });
      res.json({ success: true, application: publicApplication(row) });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'تعذر رفض الطلب',
      });
    }
  });

  return store;
}
