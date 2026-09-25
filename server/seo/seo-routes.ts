import type { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { createSeoStore, normalizeHtmlFileToken, pickSeoPatch, publicSeoPayload, type SeoSettings } from './seo-store';
import {
  buildSitemapXml,
  googleHtmlVerificationPage,
  injectSeoIntoHtml,
  mergeRobotsTxt,
  type ServicePageSeo,
} from './seo-html';

type AuthLike = {
  userFromRequest: (req: Request) => { role?: string } | null;
  requireRole: (roles: Array<'client' | 'vendor' | 'admin'>) => (
    req: Request,
    res: Response,
    next: () => void,
  ) => void;
};

export type SeoRouteOptions = {
  getServiceEntries?: () => Array<{ id: string | number; title?: string; name?: string; updatedAt?: string }>;
  /**
   * Title, description and image for `/service/<id>` when the ID is an approved
   * vendor listing (same source as `/api/catalog/listings`); null otherwise.
   */
  getServiceSeo?: (id: string) => ServicePageSeo | null;
  indexHtmlPath?: string;
};

function serviceIdFromPath(pathname: string): string {
  const match = /^\/service\/([^/]+)\/?$/.exec(pathname);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

export function registerSeoRoutes(app: Express, auth: AuthLike, dataDir: string, options: SeoRouteOptions = {}) {
  const store = createSeoStore(dataDir);
  const requireAdmin = auth.requireRole(['admin']);

  const extraPaths = () => {
    const entries = options.getServiceEntries?.() || [];
    return entries
      .map((item) => ({ id: String(item.id || '').trim(), lastmod: isoDate(item.updatedAt) }))
      .filter((item) => Boolean(item.id))
      .map((item) => ({ path: `/service/${item.id}`, lastmod: item.lastmod }));
  };

  app.get('/api/seo/public', (_req: Request, res: Response) => {
    res.json({ success: true, data: publicSeoPayload(store.load()) });
  });

  app.get('/api/admin/seo', requireAdmin, (_req: Request, res: Response) => {
    res.json({ success: true, data: store.load() });
  });

  app.put('/api/admin/seo', requireAdmin, (req: Request, res: Response) => {
    const patch = pickSeoPatch(req.body);
    if (!patch) {
      return res.status(400).json({ success: false, error: 'لا توجد حقول صالحة لحفظها في إعدادات الظهور.' });
    }
    try {
      const saved = store.save(patch);
      res.json({ success: true, data: saved });
    } catch {
      res.status(400).json({ success: false, error: 'تعذر حفظ إعدادات الظهور.' });
    }
  });

  app.get('/robots.txt', (_req: Request, res: Response) => {
    const settings = store.load();
    res.type('text/plain').send(mergeRobotsTxt(settings.robotsTxt, settings.canonicalBaseUrl));
  });

  app.get('/sitemap.xml', (_req: Request, res: Response) => {
    const xml = buildSitemapXml(store.load(), extraPaths());
    res.type('application/xml').send(xml);
  });

  app.get('/favicon.ico', (_req: Request, res: Response, next) => {
    const file = path.join(process.cwd(), 'public', 'og', 'logo-512.png');
    if (!fs.existsSync(file)) return next();
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type('png').sendFile(file);
  });

  app.get(/^\/google[a-zA-Z0-9_-]+\.html$/, (req: Request, res: Response, next) => {
    const wanted = normalizeHtmlFileToken(req.path.replace(/^\//, ''));
    const saved = normalizeHtmlFileToken(store.load().googleHtmlFileToken);
    if (!wanted || !saved || wanted.toLowerCase() !== saved.toLowerCase()) return next();
    res.type('html').send(googleHtmlVerificationPage(saved));
  });

  return {
    store,
    sendSpa: (req: Request, res: Response) =>
      sendSeoSpa(res, store.load(), options.indexHtmlPath, req.path, lookupServiceSeo(req.path)),
  };

  function lookupServiceSeo(pathname: string): ServicePageSeo | null {
    const id = serviceIdFromPath(pathname);
    if (!id || !options.getServiceSeo) return null;
    try {
      return options.getServiceSeo(id);
    } catch {
      return null;
    }
  }
}

export function sendSeoSpa(
  res: Response,
  settings: SeoSettings,
  indexHtmlPath: string | undefined,
  pathname: string,
  service?: ServicePageSeo | null,
) {
  const indexPath = indexHtmlPath || path.join(process.cwd(), 'dist', 'index.html');
  try {
    const html = injectSeoIntoHtml(fs.readFileSync(indexPath, 'utf-8'), settings, pathname, service);
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(html);
  } catch {
    res.sendFile(indexPath);
  }
}
