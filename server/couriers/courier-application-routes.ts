import type { Express, Request, Response } from 'express';
import { createCourierApplicationStore, publicCourierApplication } from './courier-applications';
import type { PublicUser } from '../auth/auth';

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

function clientKey(req: Request): string {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return forwarded || req.ip || req.socket.remoteAddress || 'unknown';
}

function allowApply(req: Request): boolean {
  const key = clientKey(req);
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
      const created = store.submit(req.body || {});
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
      res.json({ success: true, application: publicCourierApplication(row, { revealId: true }) });
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
