import type { Express, Request, Response } from 'express';
import { createCourierApplicationStore, publicCourierApplication } from './courier-applications';
import type { PublicUser } from '../auth/auth';
import { clientIp, normalizeSaudiMobile } from '../shared/booking-guards';
import { courierAccountNote, grantCourierRole, type CourierAccountOutcome } from './courier-role';

type AuthApi = {
  userFromRequest: (req: Request) => PublicUser | null;
  requireRole: (roles: Array<'client' | 'vendor' | 'admin'>) => (
    req: Request,
    res: Response,
    next: () => void,
  ) => void;
};

const APPLY_WINDOW_MS = 15 * 60 * 1000;
const APPLY_MAX = 5;
const applyHits = new Map<string, number[]>();

export function resetCourierApplyLimiter() {
  applyHits.clear();
}

function allowApply(req: Request): boolean {
  const key = clientIp(req);
  const now = Date.now();
  const recent = (applyHits.get(key) || []).filter((stamp) => now - stamp < APPLY_WINDOW_MS);
  if (recent.length >= APPLY_MAX) {
    applyHits.set(key, recent);
    return false;
  }
  recent.push(now);
  applyHits.set(key, recent);
  return true;
}

export function registerCourierApplicationRoutes(app: Express, auth: AuthApi, dataDir: string) {
  const store = createCourierApplicationStore(dataDir);
  const adminOnly = auth.requireRole(['admin']);

  app.post('/api/couriers/apply', (req: Request, res: Response) => {
    if (!allowApply(req)) {
      return res.status(429).json({
        success: false,
        error: 'أرسلت عدة طلبات متتالية. انتظر قليلاً ثم أعد المحاولة.',
      });
    }
    try {
      // Only a signed-in applicant is linked to an account (by id), so the
      // approval can hand that account the courier role. A guest's typed email
      // or phone is kept as contact info and never selects an account.
      const applicant = auth.userFromRequest(req);
      const body = req.body || {};
      const created = store.submit(
        {
          ...body,
          email: applicant?.email || body.email,
          phone: (applicant?.phone && normalizeSaudiMobile(applicant.phone)) || body.phone,
        },
        { applicantUserId: applicant?.id },
      );
      res.status(201).json({
        success: true,
        application: publicCourierApplication(created),
        message: 'استلمنا طلبك — نراجع البيانات ونتواصل معك',
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'تعذر إرسال طلب المندوب',
      });
    }
  });

  app.get('/api/admin/couriers', adminOnly, (_req: Request, res: Response) => {
    res.json({
      success: true,
      data: store.list().map((row) => publicCourierApplication(row, { revealId: true })),
    });
  });

  app.post('/api/admin/couriers/:id/approve', adminOnly, (req: Request, res: Response) => {
    try {
      const actor = auth.userFromRequest(req);
      const row = store.decide(req.params.id, 'approved', actor?.name || 'إدارة يوصل');
      if (!row) return res.status(404).json({ success: false, error: 'الطلب غير موجود' });
      let account: CourierAccountOutcome;
      try {
        account = grantCourierRole(dataDir, row.applicantUserId);
      } catch (roleError) {
        // The approval is already saved; report the role step instead of failing it.
        console.warn('[couriers] approved but could not update the account role', roleError);
        return res.json({
          success: true,
          application: publicCourierApplication(row, { revealId: true }),
          account: null,
          accountLinked: false,
          message: 'تم اعتماد الطلب، لكن تعذر تحديث دور الحساب. غيّر الدور يدوياً من إدارة الحسابات.',
        });
      }
      res.json({
        success: true,
        application: publicCourierApplication(row, { revealId: true }),
        account,
        accountLinked: account.status === 'promoted' || account.status === 'already_courier',
        message: courierAccountNote(account),
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'تعذر اعتماد الطلب',
      });
    }
  });

  app.post('/api/admin/couriers/:id/reject', adminOnly, (req: Request, res: Response) => {
    try {
      const actor = auth.userFromRequest(req);
      const row = store.decide(
        req.params.id,
        'rejected',
        actor?.name || 'إدارة يوصل',
        String(req.body?.reason || 'رفض إداري'),
      );
      if (!row) return res.status(404).json({ success: false, error: 'الطلب غير موجود' });
      res.json({ success: true, application: publicCourierApplication(row, { revealId: true }) });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'تعذر رفض الطلب',
      });
    }
  });

  return store;
}
