import type { Express, Request, Response } from 'express';
import { createSlidingWindowLimiter } from '../shared/booking-guards';
import {
  applyMoyasarRuntime,
  loadMoyasarSettings,
  publicMoyasarStatus,
  sanitizeMoyasarPublishable,
  sanitizeMoyasarSecret,
  saveMoyasarSettings,
} from './moyasar-store';
import { ensureMoyasarWebhook, moyasarWebhookUrl, verifyMoyasarSecretKey } from './moyasar';

type AuthLike = {
  requireRole: (roles: Array<'client' | 'vendor' | 'admin'>) => (
    req: Request,
    res: Response,
    next: () => void,
  ) => void;
};

export type MoyasarAdminRouteOptions = {
  fetchImpl?: typeof fetch;
};

export function registerMoyasarAdminRoutes(
  app: Express,
  auth: AuthLike,
  dataDir: string,
  options: MoyasarAdminRouteOptions = {},
) {
  const requireAdmin = auth.requireRole(['admin']);
  const saveLimiter = createSlidingWindowLimiter(8, 60_000);
  const fetchImpl = options.fetchImpl;

  applyMoyasarRuntime(dataDir);

  app.get('/api/admin/moyasar', requireAdmin, (_req: Request, res: Response) => {
    applyMoyasarRuntime(dataDir);
    res.json({ success: true, data: publicMoyasarStatus(dataDir, moyasarWebhookUrl()) });
  });

  app.put('/api/admin/moyasar', requireAdmin, async (req: Request, res: Response) => {
    if (!saveLimiter.allow('admin-moyasar-save')) {
      return res.status(429).json({
        success: false,
        error: 'كثرت محاولات الحفظ. انتظر دقيقة ثم أعد المحاولة.',
      });
    }

    const previous = loadMoyasarSettings(dataDir);
    const incomingSecret = sanitizeMoyasarSecret(req.body?.secretKey);
    const clearPublishable = req.body?.clearPublishable === true;
    const incomingPublishable = clearPublishable ? '' : sanitizeMoyasarPublishable(req.body?.publishableKey);
    const secretKey = incomingSecret || previous.secretKey;
    const publishableKey = clearPublishable
      ? ''
      : incomingPublishable || previous.publishableKey;

    if (!secretKey) {
      return res.status(400).json({
        success: false,
        error: 'الصق Secret Key من لوحة ميسر (يبدأ بـ sk_live_ أو sk_test_). اضغط العين بجانب المفتاح وانسخه كاملاً بدون نجوم.',
      });
    }
    if (req.body?.secretKey && !incomingSecret) {
      return res.status(400).json({
        success: false,
        error: 'المفتاح ناقص أو فيه نجوم أو pk_. اضغط العين بجانب Secret Key وانسخ sk_ الكامل.',
      });
    }
    if (req.body?.publishableKey && !clearPublishable && !incomingPublishable) {
      return res.status(400).json({
        success: false,
        error: 'المفتاح العام يبدأ بـ pk_test_ أو pk_live_. اتركه فارغاً إن كنت تستخدم فاتورة ميسر المستضافة فقط.',
      });
    }

    const verified = await verifyMoyasarSecretKey(secretKey, fetchImpl);
    if (verified.ok === false) {
      return res.status(400).json({ success: false, error: verified.error });
    }

    saveMoyasarSettings(dataDir, { secretKey, publishableKey, updatedAt: '' });
    applyMoyasarRuntime(dataDir);

    const webhook = await ensureMoyasarWebhook(fetchImpl);
    res.json({
      success: true,
      data: publicMoyasarStatus(dataDir, moyasarWebhookUrl()),
      webhook:
        webhook.ok === true
          ? { ok: true, status: webhook.status }
          : { ok: false, error: webhook.error },
    });
  });
}
