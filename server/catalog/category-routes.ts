import type { Express, Request, Response } from 'express';
import { CategoryStoreError, createCategoryStore } from './category-store.ts';

type AuthLike = {
  requireRole: (
    roles: Array<'client' | 'vendor' | 'admin'>,
    options?: { exact?: boolean },
  ) => (req: Request, res: Response, next: () => void) => void;
};

export type CategoryRouteOptions = {
  /** Every vendor listing's category id — the owner sees how many products each category holds. */
  listListingCategories?: () => string[];
};

export function registerCategoryRoutes(app: Express, auth: AuthLike, dataDir: string, options: CategoryRouteOptions = {}) {
  const store = createCategoryStore(dataDir);
  /** Categories shape the whole storefront, so only «مدير كل الحسابات» changes them, like appearance and SEO. */
  const requireOwnerAdmin = auth.requireRole(['admin'], { exact: true });

  function withCounts() {
    const counts = new Map<string, number>();
    for (const id of options.listListingCategories?.() || []) counts.set(id, (counts.get(id) || 0) + 1);
    const { categories, updatedAt } = store.load();
    return { categories: categories.map((row) => ({ ...row, listingCount: counts.get(row.id) || 0 })), updatedAt };
  }

  function fail(res: Response, error: unknown, fallback: string) {
    if (error instanceof CategoryStoreError) return res.status(error.status).json({ success: false, error: error.message });
    return res.status(500).json({ success: false, error: fallback });
  }

  app.get('/api/categories', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: store.load() });
  });

  app.get('/api/admin/categories', requireOwnerAdmin, (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: withCounts() });
  });

  app.post('/api/admin/categories', requireOwnerAdmin, (req: Request, res: Response) => {
    try {
      const { category } = store.add(req.body);
      res.status(201).json({ success: true, data: { category, ...withCounts() } });
    } catch (error) {
      fail(res, error, 'تعذر حفظ التصنيف.');
    }
  });

  app.delete('/api/admin/categories/:id', requireOwnerAdmin, (req: Request, res: Response) => {
    try {
      store.remove(String(req.params.id || ''));
      res.json({ success: true, data: withCounts() });
    } catch (error) {
      fail(res, error, 'تعذر حذف التصنيف.');
    }
  });

  return store;
}
