import fs from 'fs';
import path from 'path';
import type { Express, Request, Response } from 'express';
import {
  createVendorApplicationStore,
  parseVendorFulfillment,
  publicApplication,
  validateVendorApplication,
} from './vendor-applications';
import { APPLICANT_LOGIN_REQUIRED, hashPassword, type PublicUser } from '../auth/auth';
import { parseDataUrl, saveUpload, UPLOAD_MAX_BYTES, uploadsDir } from '../auth/avatar';
import { createVendorStore } from './vendor-store';
import { persistListingImages } from './listing-media';
import { personNameFromParts, profileFromApplication, publicVendorFile } from './vendor-profile';
import { parseVendorSocials, type VendorSocials } from './vendor-socials';
import { LISTING_MIN_IMAGES, validateVendorListing } from './vendor-listings';
import { isStockMediaUrl } from '../../core/utils/catalogMedia';

const LISTING_PHOTOS_REQUIRED = 'أضف صورتين حقيقيتين للمنتج من جهازك — ما نعرض صور وهمية';

/** Photos that would survive `persistListingImages`, counted without writing anything. */
function countUsableListingImages(images: unknown, legacyImage?: unknown): number {
  const raw = [...(Array.isArray(images) ? images : []), legacyImage].map((item) => String(item || '').trim());
  const existing = new Set<string>();
  let fresh = 0;
  for (const value of raw) {
    if (!value || isStockMediaUrl(value)) continue;
    if (value.startsWith('/uploads/')) existing.add(value);
    // Each data URL becomes its own file, so identical ones still count separately.
    else if (value.startsWith('data:image/') && parseDataUrl(value, UPLOAD_MAX_BYTES)) fresh += 1;
  }
  return existing.size + fresh;
}

function removeUploads(dataDir: string, urls: string[]) {
  for (const url of urls) {
    if (!url.startsWith('/uploads/')) continue;
    try {
      fs.unlinkSync(path.join(uploadsDir(dataDir), path.basename(url)));
    } catch {
      /* already gone */
    }
  }
}

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
  checkApplicantAccount: (
    input: { email: string; phone: string },
    actorId: string | null | undefined,
  ) => 'new' | 'self' | 'conflict';
  ensureApplicantUser?: (
    input: {
      name: string;
      email: string;
      phone: string;
      passwordHash: string;
      avatarUrl?: string;
    },
    actorId?: string | null,
  ) => PublicUser;
  startSession?: (res: Response, userId: string, remember?: boolean) => string;
  findUserByEmail?: (email: string) => { id: string; email: string; role?: string } | null;
};

export function registerVendorApplicationRoutes(app: Express, auth: AuthApi, dataDir: string) {
  const store = createVendorApplicationStore(dataDir);
  const workspaces = createVendorStore(dataDir);
  const adminOnly = auth.requireRole(['admin']);

  app.post('/api/vendor-applications', (req: Request, res: Response) => {
    // Uploads written during this request, removed again if it fails.
    const written: string[] = [];
    try {
      const body = { ...(req.body || {}) };
      delete body.logoUrl;
      const listingBody = body.listing && typeof body.listing === 'object' ? body.listing : body;
      const rawImages = listingBody.images || listingBody.listingImages || body.listingImageDataUrls;
      const listingDraft = {
        title: listingBody.title || listingBody.listingTitle,
        category: listingBody.category || listingBody.listingCategory,
        shortDesc: listingBody.shortDesc || listingBody.listingShortDesc,
        price: listingBody.price ?? listingBody.listingPrice,
        priceUnit: listingBody.priceUnit || listingBody.listingPriceUnit,
        cities: listingBody.cities || listingBody.listingCities,
        images: [] as string[],
        fulfillment: listingBody.fulfillment || body.fulfillment,
        bookingMode: listingBody.bookingMode || listingBody.listingBookingMode,
        vendorName: String(body.projectName || ''),
      };

      // ─── Validate everything before a single byte is written ───
      if (countUsableListingImages(rawImages, listingBody.image) < LISTING_MIN_IMAGES) {
        throw new Error(LISTING_PHOTOS_REQUIRED);
      }
      validateVendorListing(listingDraft);
      validateVendorApplication(body);
      parseVendorFulfillment(body.fulfillment);
      parseVendorSocials(body, { requireAtLeastOne: true });
      const existingApplication = store.findByEmail(String(body.email || ''));
      if (existingApplication?.status === 'pending') {
        throw new Error('هذا البريد عليه طلب مورّد بانتظار موافقة إدارة يوصل');
      }
      if (existingApplication?.status === 'approved') {
        throw new Error('هذا البريد مسجّل كمورّد معتمد. استخدم تسجيل الدخول');
      }

      // An application may only name the requester's own account (or a new one).
      const actor = auth.userFromRequest(req);
      const ownership = auth.checkApplicantAccount(
        { email: String(body.email || ''), phone: String(body.phone || '') },
        actor?.id,
      );
      if (ownership === 'conflict') {
        return res.status(409).json({ success: false, error: APPLICANT_LOGIN_REQUIRED });
      }

      // ─── Persist ───
      if (body.logoDataUrl) {
        const logoUrl = saveUpload(dataDir, 'vendor-logo', String(body.logoDataUrl));
        if (logoUrl) {
          body.logoUrl = logoUrl;
          written.push(logoUrl);
        }
      }
      const listingImages = persistListingImages(dataDir, rawImages, listingBody.image);
      for (const url of listingImages) {
        if (!(Array.isArray(rawImages) ? rawImages : []).includes(url) && url !== listingBody.image) written.push(url);
      }
      if (listingImages.length < LISTING_MIN_IMAGES) {
        throw new Error(LISTING_PHOTOS_REQUIRED);
      }
      listingDraft.images = listingImages;
      validateVendorListing(listingDraft, { requireImages: true });
      const passwordHash = hashPassword(String(req.body?.password || ''));
      const created = store.submit(body, passwordHash);
      written.length = 0;
      const personName = personNameFromParts(created);
      const user = auth.ensureApplicantUser?.(
        {
          name: personName || created.projectName,
          email: created.email,
          phone: created.phone,
          passwordHash,
          avatarUrl: created.logoUrl,
        },
        actor?.id,
      );
      if (user && auth.startSession && ownership === 'new') auth.startSession(res, user.id);
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
      removeUploads(dataDir, written);
      const status = (error as { status?: number })?.status === 409 ? 409 : 400;
      res.status(status).json({
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
