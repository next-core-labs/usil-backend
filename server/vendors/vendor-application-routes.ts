import { fs } from '../shared/data-fs.ts';
import path from 'path';
import type { Express, Request, Response } from 'express';
import {
  COMPLETION_FIELDS,
  createVendorApplicationStore,
  missingForApproval,
  parseVendorFulfillment,
  publicApplication,
  validateQuickSignup,
  validateVendorApplication,
  type VendorApplication,
} from './vendor-applications';
import { APPLICANT_LOGIN_REQUIRED, hashPassword, type PublicUser } from '../auth/auth';
import { notifyVendorApplicationDecision, notifyVendorApplicationReceived } from '../shared/optional-mail';
import { saveUpload, uploadsDir } from '../auth/avatar';
import { createVendorStore } from './vendor-store';
import { dataUrlDigest, persistListingImages } from './listing-media';
import { personNameFromParts, profileFromApplication, publicVendorFile } from './vendor-profile';
import { parseVendorSocials, type VendorSocials } from './vendor-socials';
import { LISTING_MIN_IMAGES, validateVendorListing } from './vendor-listings';
import { isStockMediaUrl } from '../../core/utils/catalogMedia';
import { clientIp, createSlidingWindowLimiter } from '../shared/booking-guards';

/** Each application can write ~16 MB of photos and emails the address it names. */
/** Vendor accounts one device may open per hour. Only sign-ups that pass the checks count. */
const APPLY_LIMIT = 10;
/** Every attempt, mistakes included: high enough for someone fixing typos, low enough to stop a flood. */
const APPLY_ATTEMPT_LIMIT = 60;
const APPLY_WINDOW_MS = 60 * 60 * 1000;
const APPLY_RATE_LIMITED = 'طلبات كثيرة من هذا الجهاز. انتظر ساعة ثم أعد المحاولة.';

const LISTING_PHOTOS_REQUIRED = 'أضف صورتين حقيقيتين للمنتج من جهازك — ما نعرض صور وهمية';

/** Photos that would survive `persistListingImages`, counted without writing anything. */
function countUsableListingImages(images: unknown, legacyImage?: unknown): number {
  const raw = [...(Array.isArray(images) ? images : []), legacyImage].map((item) => String(item || '').trim());
  const existing = new Set<string>();
  const fresh = new Set<string>();
  for (const value of raw) {
    if (!value || isStockMediaUrl(value)) continue;
    if (value.startsWith('/uploads/')) existing.add(value);
    // The same photo picked twice counts once — a single placeholder must not meet the two-photo minimum.
    else if (value.startsWith('data:image/')) {
      const digest = dataUrlDigest(value);
      if (digest) fresh.add(digest);
    }
  }
  return existing.size + fresh.size;
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
  const applyLimiter = createSlidingWindowLimiter(APPLY_LIMIT, APPLY_WINDOW_MS);
  const attemptLimiter = createSlidingWindowLimiter(APPLY_ATTEMPT_LIMIT, APPLY_WINDOW_MS);

  /** The workspace an application's products and socials live in: the applicant's account, or the application id. */
  function workspaceIdFor(row: VendorApplication): string {
    return auth.findUserByEmail?.(row.email)?.id || row.id;
  }

  /** Products and linked socials count toward approval wherever the vendor added them. */
  function progressFor(row: VendorApplication) {
    const id = workspaceIdFor(row);
    const ws = workspaces.hasWorkspace(id) ? workspaces.getWorkspace(id) : null;
    const handles = new Set(
      [...(ws?.socials?.links || []), ...(row.socials?.links || [])]
        .filter((link) => String(link.handle || '').trim())
        .map((link) => link.network),
    );
    const listingCount = ws?.listings.length || 0;
    return { listingCount, missing: missingForApproval(row, { listingCount, socialCount: handles.size }) };
  }

  /**
   * The vendor console's short sign-up. The applicant is signed in straight
   * away as a client account and works in the vendor dashboard while pending —
   * nothing they add is public until the owner approves (see
   * `isPublicVendorAccount`).
   */
  app.post('/api/vendor-signup', (req: Request, res: Response) => {
    if (!attemptLimiter.allow(`vendor-apply:${clientIp(req)}`)) {
      return res.status(429).json({ success: false, error: APPLY_RATE_LIMITED });
    }
    try {
      const body = req.body || {};
      validateQuickSignup(body);
      const existing = store.findByEmail(String(body.email || ''));
      if (existing?.status === 'pending') {
        throw new Error('هذا البريد عليه طلب مورّد بانتظار موافقة إدارة يوصل. سجّل الدخول لإكماله');
      }
      if (existing?.status === 'approved') throw new Error('هذا البريد مسجّل كمورّد معتمد. استخدم تسجيل الدخول');
      const actor = auth.userFromRequest(req);
      const ownership = auth.checkApplicantAccount(
        { email: String(body.email || ''), phone: String(body.phone || '') },
        actor?.id,
      );
      if (ownership === 'conflict') {
        return res.status(409).json({ success: false, error: APPLICANT_LOGIN_REQUIRED });
      }
      // Counted only now: a form sent back for a typo must not lock the device out.
      if (!applyLimiter.allow(`vendor-apply:${clientIp(req)}`)) {
        return res.status(429).json({ success: false, error: APPLY_RATE_LIMITED });
      }
      const passwordHash = hashPassword(String(body.password || ''));
      const created = store.submitQuick(body, passwordHash);
      const user = auth.ensureApplicantUser?.(
        { name: personNameFromParts(created) || created.projectName, email: created.email, phone: created.phone, passwordHash },
        actor?.id,
      );
      if (user && auth.startSession && ownership === 'new') auth.startSession(res, user.id);
      workspaces.seedWorkspaceFromApplication(user?.id || created.id, created);
      notifyVendorApplicationReceived(created.email, created.projectName);
      res.status(201).json({
        success: true,
        application: publicApplication(created),
        user: user || null,
        missing: progressFor(created).missing,
        message: 'أهلاً بك في يوصل! أضف منتجاتك وأكمل ملفك، وتظهر في السوق بعد موافقة الإدارة.',
      });
    } catch (error) {
      res.status((error as { status?: number })?.status === 409 ? 409 : 400).json({
        success: false,
        error: error instanceof Error ? error.message : 'تعذر التسجيل',
      });
    }
  });

  /**
   * A pending vendor completes their file: names, ID, bank, lanes, logo. A
   * vendor approved with a short file keeps completing it here, limited to
   * `COMPLETION_FIELDS`.
   */
  app.put('/api/vendor/application', (req: Request, res: Response) => {
    const user = auth.userFromRequest(req);
    if (!user) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
    const own = store.findByEmail(user.email);
    const approved = own?.status === 'approved' && user.role === 'vendor';
    if (!own || (own.status !== 'pending' && !approved)) {
      return res.status(404).json({ success: false, error: 'لا يوجد طلب انضمام قيد المراجعة لهذا الحساب' });
    }
    if (approved) {
      const raw = (req.body || {}) as Record<string, unknown>;
      const body = Object.fromEntries(COMPLETION_FIELDS.filter((key) => key in raw).map((key) => [key, raw[key]]));
      try {
        const row = store.updateDetails(own.id, body);
        if (!row) return res.status(404).json({ success: false, error: 'الطلب غير موجود' });
        // Only what changed here: the brand screen owns the store name and logo now.
        workspaces.saveVendorWorkspace(user.id, {
          profile: { personName: personNameFromParts(row) || undefined, fulfillment: row.fulfillment },
        });
        return res.json({ success: true, application: publicApplication(row), missing: progressFor(row).missing });
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'تعذر حفظ البيانات',
        });
      }
    }
    const written: string[] = [];
    try {
      const body = { ...(req.body || {}) };
      delete body.logoUrl;
      if (body.logoDataUrl) {
        const logoUrl = saveUpload(dataDir, 'vendor-logo', String(body.logoDataUrl));
        if (!logoUrl) throw new Error('ارفع شعاراً jpg أو png أو webp حتى 2 ميغابايت.');
        body.logoUrl = logoUrl;
        written.push(logoUrl);
      }
      const row = store.updateDetails(own.id, body);
      if (!row) return res.status(404).json({ success: false, error: 'الطلب غير موجود' });
      written.length = 0;
      const vendorId = workspaceIdFor(row);
      workspaces.seedWorkspaceFromApplication(vendorId, row);
      res.json({
        success: true,
        application: publicApplication(row),
        missing: progressFor(row).missing,
      });
    } catch (error) {
      removeUploads(dataDir, written);
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'تعذر حفظ البيانات',
      });
    }
  });

  app.post('/api/vendor-applications', (req: Request, res: Response) => {
    if (!applyLimiter.allow(`vendor-apply:${clientIp(req)}`)) {
      return res.status(429).json({ success: false, error: APPLY_RATE_LIMITED });
    }
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
      notifyVendorApplicationReceived(created.email, created.projectName);
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
      missing: application && application.status !== 'rejected' ? progressFor(application).missing : [],
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
      data: store.list().map((row) => ({ ...publicApplication(row), ...progressFor(row) })),
    });
  });

  app.post('/api/admin/vendor-applications/:id/approve', adminOnly, (req: Request, res: Response) => {
    try {
      const actor = auth.userFromRequest(req);
      const pending = store.findById(req.params.id);
      if (!pending) return res.status(404).json({ success: false, error: 'الطلب غير موجود' });
      if (pending.status === 'pending') {
        const { missing } = progressFor(pending);
        // The owner may approve a short file on purpose; the vendor keeps the list to finish.
        if (missing.length && req.body?.allowIncomplete !== true) {
          return res.status(400).json({
            success: false,
            error: `ملف المورّد ناقص: ${missing.map((item) => item.label).join('، ')}`,
            missing,
          });
        }
      }
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
      notifyVendorApplicationDecision(row.email, row.projectName, 'approved');
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
      // Submitting seeded a workspace and a listing under the application id or
      // the applicant's new client account. A rejected applicant keeps neither;
      // a vendor or staff account that applied again is never touched.
      const account = auth.findUserByEmail?.(row.email);
      const leftovers = [row.id];
      if (account && account.role === 'client') leftovers.push(account.id);
      for (const id of leftovers) workspaces.removeWorkspace(id);
      notifyVendorApplicationDecision(row.email, row.projectName, 'rejected', row.rejectReason);
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
