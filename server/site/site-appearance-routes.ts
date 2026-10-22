import type { Express, Request, Response } from 'express';
import { createSiteAppearanceStore } from './site-appearance-store.ts';

type AuthLike = {
  requireRole: (
    roles: Array<'client' | 'vendor' | 'admin'>,
    options?: { exact?: boolean },
  ) => (req: Request, res: Response, next: () => void) => void;
};

export function registerSiteAppearanceRoutes(app: Express, auth: AuthLike, dataDir: string) {
  const store = createSiteAppearanceStore(dataDir);
  /** The storefront's look is changed by «مدير كل الحسابات» only, like site-wide SEO. */
  const requireOwnerAdmin = auth.requireRole(['admin'], { exact: true });

  app.get('/api/site/appearance', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: store.load() });
  });

  app.put('/api/admin/site/appearance', requireOwnerAdmin, (req: Request, res: Response) => {
    if (!req.body || typeof req.body !== 'object' || !Array.isArray(req.body.heroCards)) {
      return res.status(400).json({ success: false, error: 'أرسل بطاقات الواجهة (heroCards) لحفظها.' });
    }
    try {
      res.json({ success: true, data: store.save(req.body) });
    } catch {
      res.status(500).json({ success: false, error: 'تعذر حفظ مظهر الواجهة.' });
    }
  });

  return store;
}
