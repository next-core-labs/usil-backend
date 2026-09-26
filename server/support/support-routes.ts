import type { Express, Request, Response } from 'express';
import { createSupportStore, isSupportStatus, validateSupportMessage } from './support-store.ts';
import { clientIp, createSlidingWindowLimiter } from '../shared/booking-guards.ts';

type AuthApi = {
  requireRole: (roles: Array<'client' | 'vendor' | 'admin'>) => (
    req: Request,
    res: Response,
    next: () => void,
  ) => void;
};

/**
 * The form is open to anonymous visitors and writes to disk, so it needs its
 * own throttle. Kept generous because Saudi mobile carriers NAT many users
 * behind one address.
 */
const SUPPORT_LIMIT = 10;
const SUPPORT_WINDOW_MS = 60 * 60 * 1000;
const SUPPORT_RATE_LIMIT = 'وصلتنا رسائلك. انتظر قليلاً قبل إرسال المزيد.';

export function registerSupportRoutes(app: Express, auth: AuthApi, dataDir: string) {
  const store = createSupportStore(dataDir);
  const limiter = createSlidingWindowLimiter(SUPPORT_LIMIT, SUPPORT_WINDOW_MS);

  app.post('/api/support/messages', (req: Request, res: Response) => {
    if (!limiter.allow(`support:${clientIp(req)}`)) {
      return res.status(429).json({ success: false, error: SUPPORT_RATE_LIMIT });
    }
    const parsed = validateSupportMessage(req.body || {});
    if (parsed.ok === false) {
      return res.status(400).json({ success: false, error: parsed.error });
    }
    res.status(201).json({ success: true, message: store.add(parsed.value) });
  });

  app.get('/api/admin/support-messages', auth.requireRole(['admin']), (_req: Request, res: Response) => {
    res.json({ success: true, data: store.list() });
  });

  app.patch('/api/admin/support-messages/:id', auth.requireRole(['admin']), (req: Request, res: Response) => {
    const status = req.body?.status;
    if (!isSupportStatus(status)) {
      return res.status(400).json({ success: false, error: 'حالة الرسالة غير صالحة.' });
    }
    const row = store.setStatus(String(req.params.id), status);
    if (!row) return res.status(404).json({ success: false, error: 'الرسالة غير موجودة.' });
    res.json({ success: true, message: row });
  });

  return store;
}
