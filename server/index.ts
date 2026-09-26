// Loads .env for local runs. In Docker, compose-injected vars win — dotenv never overrides existing values.
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';

import { createAuth } from './auth/auth.ts';
import { registerAuthRoutes } from './auth/auth-routes.ts';
import { brandedAvatarSvg, setUploadsHeaders, uploadsDir } from './auth/avatar.ts';
import { registerGeminiRoutes } from './ai/gemini-routes.ts';
import { registerIntegrationsRoutes } from './ai/integrations-routes.ts';
import { registerBookingRoutes } from './bookings/booking-routes.ts';
import { registerExternalBookingRoutes, type CourierOption } from './bookings/external-booking-routes.ts';
import { registerCityRequestRoutes } from './cities/city-request-routes.ts';
import { registerCourierApplicationRoutes } from './couriers/courier-application-routes.ts';
import { registerLegacyRoutes } from './legacy-routes.ts';
import { registerMoyasarAdminRoutes } from './payments/moyasar-admin-routes.ts';
import { applyMoyasarRuntime } from './payments/moyasar-store.ts';
import { registerPaymentRoutes } from './payments/payment-routes.ts';
import { registerSeoRoutes } from './seo/seo-routes.ts';
import { registerSupportRoutes } from './support/support-routes.ts';
import { registerVendorApplicationRoutes } from './vendors/vendor-application-routes.ts';
import { registerVendorRoutes } from './vendors/vendor-routes.ts';
import { SERVICES as CATALOG_SERVICES } from '../core/data/services.ts';
import { listApprovedCatalogServices, serviceSeoFrom } from './shared/approved-catalog.ts';
import { isKnownSpaPath } from '../core/utils/siteRoutes.ts';

/**
 * Composition root. This file wires the application together and owns nothing
 * else — every route handler and every store lives in its domain folder under
 * `server/`. If you are about to add business logic here, it belongs in a
 * `server/<domain>/` module instead.
 */

// Paths resolve against the working directory, not this file: the bundled
// server runs as `node build/server.cjs` from the project root, so `data/`,
// `dist/` and `public/` sit beside the process, not beside the source.
const rootDir = process.cwd();

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(rootDir, 'data');
const isProduction = process.env.NODE_ENV === 'production';

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Nothing embeds Usil in a frame; refusing it rules out clickjacking the checkout and admin screens.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

// Product images travel as base64 data URLs, so the cap must clear 5MB × ~1.37 overhead.
app.use(express.json({ limit: '16mb' }));

// ─── Startup ───
applyMoyasarRuntime(DATA_DIR);
fs.writeFileSync(
  path.join(uploadsDir(DATA_DIR), 'avatar-supervisor.svg'),
  brandedAvatarSvg('مشرف يوصل'),
  'utf-8',
);
const auth = createAuth(DATA_DIR);

// ─── API ───
registerAuthRoutes(app, auth, DATA_DIR);

const { ai: aiRouter } = registerIntegrationsRoutes(app, auth, DATA_DIR);
registerMoyasarAdminRoutes(app, auth, DATA_DIR);
registerGeminiRoutes(app, { ai: aiRouter, dataDir: DATA_DIR, listVendorUsers: () => auth.listVendorUsers() });

registerSupportRoutes(app, auth, DATA_DIR);
registerCityRequestRoutes(app, auth, DATA_DIR);

const vendorStore = registerVendorRoutes(app, auth, DATA_DIR);
vendorStore.stripCatalogClonedListings(
  (Array.isArray(CATALOG_SERVICES) ? CATALOG_SERVICES : []).map((item: { id?: string }) => String(item.id || '')),
);
registerVendorApplicationRoutes(app, auth, DATA_DIR);

// Bookings must know which listings need vendor approval before checkout.
const bookingStore = registerBookingRoutes(app, auth, DATA_DIR, {
  listListings: () => vendorStore.listAllListings(),
});

// Payments settle against platform bookings.
registerPaymentRoutes(app, { bookings: bookingStore, port: PORT });

const courierStore = registerCourierApplicationRoutes(app, auth, DATA_DIR);
registerExternalBookingRoutes(app, auth, DATA_DIR, {
  listCourierOptions: (): CourierOption[] => {
    const accounts = auth.listUsersByRole('courier').map((user) => ({
      id: user.id,
      name: user.name,
      source: 'account' as const,
    }));
    const accountIds = new Set(accounts.map((row) => row.id));
    const approved = courierStore
      .list()
      // An application already linked to a listed courier account is the same person.
      .filter((row) => row.status === 'approved' && !(row.applicantUserId && accountIds.has(row.applicantUserId)))
      .map((row) => ({
        id: row.id,
        name: `${row.firstName} ${row.familyName}`.trim(),
        source: 'application' as const,
      }));
    return [...accounts, ...approved];
  },
});

registerLegacyRoutes(app, { aiAvailable: () => Boolean(aiRouter.activeProvider()) });

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    server: 'SCCC Cloud ECS Instance',
    database: 'Persistent Store Active',
    totalBookings: bookingStore.count(),
  });
});

// ─── SEO + the SPA shell ───
// Registered after the API so no crawler route can shadow an endpoint. The SPA
// itself is built in the web project and copied here by `npm run sync:web`.
const { sendSpa } = registerSeoRoutes(app, auth, DATA_DIR, {
  indexHtmlPath: path.join(rootDir, 'dist', 'index.html'),
  // Same approved-vendor-only source as GET /api/catalog/listings.
  getServiceEntries: () => {
    const live = listApprovedCatalogServices(vendorStore, () => auth.listVendorUsers()).map((item) => ({
      id: item.id,
      title: item.title,
    }));
    if (live.length > 0) return live;
    return Array.isArray(CATALOG_SERVICES)
      ? CATALOG_SERVICES.map((item: { id?: string | number; title?: string; name?: string }) => ({
          id: item.id,
          title: item.title || item.name,
        }))
      : [];
  },
  getServiceSeo: (id) =>
    serviceSeoFrom(
      listApprovedCatalogServices(vendorStore, () => auth.listVendorUsers()).find((item) => String(item.id) === id),
    ),
});

// ─── Frontend Static Files ───
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use(
  '/uploads',
  express.static(path.join(DATA_DIR, 'uploads'), { fallthrough: false, setHeaders: setUploadsHeaders }),
);
// The server bundle used to be built into dist/ and was downloadable with its source map.
// It now lives in build/; this keeps a stale copy in an old dist/ from ever being served.
app.use(/^\/server\.cjs(\.map)?$/, (_req: Request, res: Response) => {
  res.status(404).json({ success: false, error: 'Not found' });
});
app.use(
  express.static(path.join(rootDir, 'dist'), {
    etag: false,
    lastModified: false,
    index: false,
    setHeaders: (res, filePath) => {
      // Vite content-hashes everything under assets/, so a changed file always gets a new name.
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }),
);
app.use(express.static(path.join(rootDir, 'public')));

// Retired AI studio / smart bundles — old links land on the store.
app.get(['/ai-studio', '/ai-packages'], (_req: Request, res: Response) => res.redirect(301, '/'));

app.get(
  [
    '/',
    '/privacy',
    '/terms',
    '/refund',
    '/cancellation',
    '/support',
    '/about',
    '/hospitality',
    '/courier',
    '/offline',
    '/payment/success',
    '/payment/cancelled',
  ],
  sendSpa,
);

app.get('*', (req: Request, res: Response) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  if (!isKnownSpaPath(req.path)) {
    res.status(404);
  }
  sendSpa(req, res);
});

/**
 * Last-resort error handler.
 *
 * Express's body parser reports a malformed body as 400 (`entity.parse.failed`)
 * and an oversized one as 413 (`entity.too.large`). Those are the caller's
 * problem, not ours, so the status and a usable message are passed through —
 * collapsing them into a 500 "unexpected error" told clients nothing and made
 * an over-limit image upload look like a server fault.
 */
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const fault = err as { statusCode?: number; status?: number; type?: string };
  const status = Number(fault?.statusCode || fault?.status) || 500;
  const isClientFault = status >= 400 && status < 500;

  // Only a genuine server fault is worth a stack trace in the logs.
  if (!isClientFault) console.error(err);
  if (res.headersSent) return;

  if (fault?.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'حجم الطلب كبير. صغّر الصور ثم أعد المحاولة.' });
  }
  if (fault?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'صيغة الطلب غير صحيحة.' });
  }
  if (isClientFault) {
    return res.status(status).json({ success: false, error: 'الطلب غير صالح.' });
  }
  res.status(500).json({ success: false, error: 'حدث خطأ غير متوقع. حاول مرة أخرى.' });
});

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`🚀 يوصل (Usil) يعمل بكامل ميزاته على بورت ${PORT}`);
});
