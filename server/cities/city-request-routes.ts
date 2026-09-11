import type { Express, Request, Response } from 'express';
import {
  createCityDemandStore,
  isDemandStatus,
  validateCityDemandInput,
} from './city-requests';
import { clientIp, createSlidingWindowLimiter } from '../shared/booking-guards';
import type { PublicUser } from '../auth/auth';

type AuthApi = {
  requireRole: (roles: Array<'client' | 'vendor' | 'admin'>) => (
    req: Request,
    res: Response,
    next: () => void,
  ) => void;
  userFromRequest?: (req: Request) => PublicUser | null;
};

const demandLimiter = createSlidingWindowLimiter(8, 60 * 60 * 1000);

export function registerCityRequestRoutes(app: Express, auth: AuthApi, dataDir: string) {
  const store = createCityDemandStore(dataDir);
  const adminOnly = auth.requireRole(['admin']);

  app.post('/api/city-requests', (req: Request, res: Response) => {
    if (!demandLimiter.allow(`demand:${clientIp(req)}`)) {
      return res.status(429).json({ success: false, error: 'محاولات كثيرة. حاول بعد قليل.' });
    }
    const parsed = validateCityDemandInput(req.body || {});
    if (parsed.ok === false) return res.status(400).json({ success: false, error: parsed.error });
    const row = store.add(parsed.value);
    return res.status(201).json({ success: true, data: row });
  });

  app.get('/api/admin/city-requests', adminOnly, (_req: Request, res: Response) => {
    return res.json({ success: true, data: store.list() });
  });

  app.patch('/api/admin/city-requests/:id', adminOnly, (req: Request, res: Response) => {
    const status = String(req.body?.status || '');
    if (!isDemandStatus(status)) {
      return res.status(400).json({ success: false, error: 'حالة الطلب غير صحيحة.' });
    }
    const row = store.setStatus(String(req.params.id || ''), status);
    if (!row) return res.status(404).json({ success: false, error: 'الطلب غير موجود.' });
    return res.json({ success: true, data: row });
  });
}
