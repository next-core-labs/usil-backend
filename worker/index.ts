import { DurableObject } from 'cloudflare:workers';
import { handleAsNodeRequest } from 'cloudflare:node';
import { createApp } from '../server/app.ts';
import { useDataFs } from '../server/shared/data-fs.ts';
import { createSqliteFs } from './sqlite-fs.ts';

/**
 * usil.app on Cloudflare.
 *
 * The Express app runs unchanged inside one Durable Object (`UsilApp`), whose
 * SQLite database stands in for `data/` (see `sqlite-fs.ts`). A single instance
 * matches the old single server: one process owning the JSON stores, with no
 * other writer to race. The Worker in front serves the SPA's static files from
 * Workers Assets and sends everything else to that instance.
 */

export interface Env {
  APP: DurableObjectNamespace<UsilApp>;
  ASSETS: Fetcher;
}

/**
 * The Durable Object that holds the site's data. Changing the name starts an empty
 * store; the old one is kept untouched, so setting the name back restores it.
 * 'main' (Oct 2026) held only the first launch's admin, whose password was lost.
 */
const DATA_INSTANCE = 'main-2';

/** The port Express listens on inside the isolate; nothing outside can reach it. */
const PORT = 8080;
/** Stands in for the project root, so `data/` resolves to `/usil/data` in SQLite. */
const ROOT_DIR = '/usil';

/** The SPA shell, read from the assets when the app starts. */
let indexHtml = '';
/**
 * Whether Express is already listening in this isolate. After an uncaught error
 * the runtime builds a new UsilApp in the same isolate, where the port is still
 * taken; the running app is reused, now reading the new instance's storage.
 */
let listening = false;

export class UsilApp extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    useDataFs(createSqliteFs(ctx.storage));
    if (listening) return;
    ctx.blockConcurrencyWhile(async () => {
      // A deploy starts a fresh isolate, so the shell read here is always the deployed one.
      const res = await env.ASSETS.fetch('https://assets.local/index.html');
      if (res.ok) indexHtml = await res.text();
      else console.error(`[worker] index.html missing from assets (${res.status})`);
      createApp({
        rootDir: ROOT_DIR,
        readIndexHtml: () => {
          if (!indexHtml) throw new Error('index.html is not in the deployed assets');
          return indexHtml;
        },
      }).listen(PORT);
      listening = true;
    });
  }

  fetch(request: Request): Promise<Response> {
    // `Expect: 100-continue` makes the Node HTTP layer answer 100 first, which a Workers
    // Response cannot carry. The body is already here, so there is nothing to wait for.
    if (request.headers.has('expect')) {
      const headers = new Headers(request.headers);
      headers.delete('expect');
      request = new Request(request, { headers });
    }
    return handleAsNodeRequest(PORT, request);
  }
}

/** Served by the app even though they look like files: they are generated per request. */
const GENERATED_FILES = /^\/(robots\.txt|sitemap\.xml|google[a-zA-Z0-9_-]+\.html)$/;

/** The headers the Express app sets on every response, for the files served without it. */
function withSiteHeaders(res: Response, pathname: string): Response {
  const out = new Response(res.body, res);
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  out.headers.set('X-Frame-Options', 'DENY');
  out.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  out.headers.set('Strict-Transport-Security', 'max-age=15552000');
  // Vite content-hashes everything under assets/, so a changed file always gets a new name.
  if (pathname.startsWith('/assets/')) out.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    const isAppPath =
      pathname === '/api' ||
      pathname.startsWith('/api/') ||
      pathname.startsWith('/uploads/') ||
      GENERATED_FILES.test(pathname) ||
      // The raw shell has no SEO or analytics injected; the app redirects it to `/`.
      pathname === '/index.html';

    if (isRead && !isAppPath) {
      if (pathname === '/favicon.ico') {
        const icon = await env.ASSETS.fetch(new URL('/og/logo-512.png', url));
        if (icon.ok) {
          const res = withSiteHeaders(icon, pathname);
          res.headers.set('Cache-Control', 'public, max-age=86400');
          return res;
        }
      }
      // Only paths that look like files; page routes always get the SEO-rendered shell.
      if (/\.[a-zA-Z0-9]+$/.test(pathname)) {
        const asset = await env.ASSETS.fetch(request);
        if (asset.status !== 404) return withSiteHeaders(asset, pathname);
      }
    }

    return env.APP.get(env.APP.idFromName(DATA_INSTANCE)).fetch(request);
  },
};
