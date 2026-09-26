import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { registerSeoRoutes } from './seo-routes.ts';
import { buildSitemapXml, injectSeoIntoHtml, mergeRobotsTxt } from './seo-html.ts';
import { seoMetaPaths } from './seo-meta.ts';
import { defaultSeoSettings, pickSeoPatch, sanitizeSeoSettings } from './seo-store.ts';
import { createVendorStore } from '../vendors/vendor-store.ts';
import {
  listApprovedCatalogServices,
  serviceSeoFrom,
  vendorUsersFromDataDir,
} from '../shared/approved-catalog.ts';
import { seedApprovedAndRejected } from '../shared/approved-catalog.fixtures.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-seo-api-'));
}

function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function fakeAuth(role: 'admin' | 'vendor' | null) {
  return {
    userFromRequest: () =>
      role ? { id: 'usr-x', name: 'مستخدم', email: 'x@usil.app', phone: '0500000000', role } : null,
    requireRole: (roles: string[]) => (req: Request, res: Response, next: NextFunction) => {
      if (!role) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
      if (!roles.includes(role)) {
        return res.status(403).json({ success: false, error: 'ليست لديك صلاحية هذا الإجراء.' });
      }
      next();
    },
  };
}

describe('seo-routes', () => {
  it('exposes public SEO without auth', async () => {
    const app = express();
    app.use(express.json());
    registerSeoRoutes(app, fakeAuth(null) as any, tmpDir());
    const { url, close } = await listen(app);
    const res = await fetch(`${url}/api/seo/public`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.equal(json.data.title, 'يوصل | سوق توريد المناسبات في السعودية');
    assert.equal(json.data.robotsTxt, undefined);
    await close();
  });

  it('rejects non-admin from reading or writing admin SEO', async () => {
    const dir = tmpDir();
    const guestApp = express();
    guestApp.use(express.json());
    registerSeoRoutes(guestApp, fakeAuth(null) as any, dir);
    const vendorApp = express();
    vendorApp.use(express.json());
    registerSeoRoutes(vendorApp, fakeAuth('vendor') as any, dir);

    const guest = await listen(guestApp);
    const vendor = await listen(vendorApp);
    assert.equal((await fetch(`${guest.url}/api/admin/seo`)).status, 401);
    assert.equal((await fetch(`${vendor.url}/api/admin/seo`)).status, 403);
    const put = await fetch(`${vendor.url}/api/admin/seo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'قرصنة' }),
    });
    assert.equal(put.status, 403);
    await guest.close();
    await vendor.close();
  });

  it('lets admin save SEO and serves robots plus a valid sitemap', async () => {
    const app = express();
    app.use(express.json());
    registerSeoRoutes(app, fakeAuth('admin') as any, tmpDir(), {
      getServiceEntries: () => [{ id: 'royal-saudi-coffee', title: 'ركن الضيافة' }],
    });
    const { url, close } = await listen(app);
    const saved = await fetch(`${url}/api/admin/seo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'يوصل للدعم | سوق المناسبات',
        googleHtmlFileToken: 'googleabc123.html',
      }),
    });
    assert.equal(saved.status, 200);
    const robots = await fetch(`${url}/robots.txt`);
    const robotsText = await robots.text();
    assert.match(robotsText, /User-agent: \*/);
    assert.match(robotsText, /User-agent: GPTBot/);
    assert.match(robotsText, /Sitemap: https:\/\/usil.app\/sitemap.xml/);

    const sitemap = await fetch(`${url}/sitemap.xml`);
    const xml = await sitemap.text();
    assert.equal(sitemap.headers.get('content-type')?.includes('xml'), true);
    assert.match(xml, /<urlset /);
    assert.match(xml, /https:\/\/usil.app\/<\/loc>/);
    assert.match(xml, /https:\/\/usil.app\/privacy/);
    assert.match(xml, /https:\/\/usil.app\/terms/);
    assert.match(xml, /https:\/\/usil.app\/refund/);
    assert.match(xml, /https:\/\/usil.app\/about/);
    assert.match(xml, /https:\/\/usil.app\/support/);
    assert.match(xml, /https:\/\/usil.app\/courier/);
    assert.doesNotMatch(xml, /https:\/\/usil.app\/ai-studio/);
    assert.doesNotMatch(xml, /https:\/\/usil.app\/ai-packages/);
    assert.match(xml, /https:\/\/usil.app\/hospitality/);
    assert.match(xml, /https:\/\/usil.app\/service\/royal-saudi-coffee/);

    const verify = await fetch(`${url}/googleabc123.html`);
    assert.equal(verify.status, 200);
    assert.match(await verify.text(), /google-site-verification: googleabc123.html/);
    await close();
  });

  it('injects title, description, OG, and verification into HTML', () => {
    const settings = defaultSeoSettings();
    settings.googleSiteVerification = 'gsc-token';
    settings.analyticsId = 'G-TEST123';
    const html = `<!DOCTYPE html><html><head><title>قديم</title><meta name="description" content="قديم" /></head><body></body></html>`;
    const out = injectSeoIntoHtml(html, settings, '/hospitality');
    assert.match(out, /<title>ضيافة وقهوة عربية بالرياض - صبابين وقهوجيات \| يوصل<\/title>/);
    assert.match(out, /property="og:title"/);
    assert.match(out, /name="google-site-verification" content="gsc-token"/);
    assert.match(out, /gtag\/js\?id=G-TEST123/);
    const htmlCourier = injectSeoIntoHtml(html, settings, '/courier');
    assert.match(htmlCourier, /<title>مندوب توصيل مناسبات - انضم كمندوب بالرياض وجدة \| يوصل<\/title>/);
    const htmlPkgs = injectSeoIntoHtml(html, settings, '/ai-packages');
    assert.match(htmlPkgs, /<title>يوصل \| سوق توريد المناسبات في السعودية<\/title>/);
    assert.match(out, /rel="canonical" href="https:\/\/usil.app\/hospitality"/);
  });

  it('embeds the refund table in HTML so /refund is readable without JavaScript', () => {
    const settings = defaultSeoSettings();
    const html = '<html><head><title>قديم</title></head><body><div id="root"></div></body></html>';
    const refund = injectSeoIntoHtml(html, settings, '/refund');
    assert.match(refund, /سياسة الاسترجاع/);
    assert.match(refund, /قبل 7 أيام كاملة أو أكثر/);
    assert.match(refund, /استرجاع 50٪/);
    const cancel = injectSeoIntoHtml(html, settings, '/cancellation');
    assert.match(cancel, /استرجاع كامل \(100٪\)/);
  });

  it('gives every service page its own title instead of the homepage title', () => {
    const settings = defaultSeoSettings();
    const html = `<!DOCTYPE html><html><head><title>قديم</title></head><body></body></html>`;
    const home = injectSeoIntoHtml(html, settings, '/');
    const homeTitle = /<title>([\s\S]*?)<\/title>/.exec(home)?.[1];

    const seen = new Set<string>();
    for (const path of seoMetaPaths().filter((entry) => entry.startsWith('/service/'))) {
      const title = /<title>([\s\S]*?)<\/title>/.exec(injectSeoIntoHtml(html, settings, path))?.[1] || '';
      assert.ok(title.length > 0, `${path} has no title`);
      assert.notEqual(title, homeTitle, `${path} reuses the homepage title`);
      assert.ok(!seen.has(title), `duplicate title on ${path}: ${title}`);
      seen.add(title);
    }
    assert.equal(seen.size, 63);
  });

  it('points share images at a real PNG rather than the SVG favicon', () => {
    const settings = defaultSeoSettings();
    assert.match(settings.ogImage, /^https:\/\/usil\.app\/og\/og-default\.png$/);
    const html = injectSeoIntoHtml('<html><head></head><body></body></html>', settings, '/');
    assert.match(html, /property="og:image" content="https:\/\/usil\.app\/og\/og-default\.png"/);
    assert.match(html, /property="og:image:width" content="1200"/);
    assert.match(html, /property="og:image:height" content="630"/);
    assert.doesNotMatch(html, /og:image" content="[^"]*favicon\.svg/);
  });

  it('upgrades a stored favicon.svg share image to the PNG default', () => {
    const saved = sanitizeSeoSettings({ ogImage: 'https://usil.app/favicon.svg', twitterImage: 'https://usil.app/favicon.svg' });
    assert.equal(saved.ogImage, 'https://usil.app/og/og-default.png');
    assert.equal(saved.twitterImage, 'https://usil.app/og/og-default.png');
  });

  it('emits Organization JSON-LD on the homepage and Service JSON-LD on service pages', () => {
    const settings = defaultSeoSettings();
    const html = '<html><head></head><body></body></html>';

    const home = injectSeoIntoHtml(html, settings, '/');
    const homeBlocks = [...home.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.equal(homeBlocks.length, 1);
    const homeGraph = JSON.parse(homeBlocks[0][1].replace(/\\u003c/g, '<'))['@graph'];
    assert.equal(homeGraph[0]['@type'], 'Organization');
    assert.equal(homeGraph[0].logo.url, 'https://usil.app/og/logo-512.png');
    assert.equal(homeGraph[1]['@type'], 'WebSite');

    const service = injectSeoIntoHtml(html, settings, '/service/royal-saudi-coffee');
    const serviceBlock = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(service);
    assert.ok(serviceBlock);
    const graph = JSON.parse(serviceBlock[1].replace(/\\u003c/g, '<'))['@graph'];
    assert.equal(graph[0]['@type'], 'Service');
    assert.equal(graph[0].url, 'https://usil.app/service/royal-saudi-coffee');
    assert.equal(graph[0].provider['@id'], 'https://usil.app/#organization');
    assert.equal(graph[1]['@type'], 'BreadcrumbList');

    assert.equal(/ld\+json/.test(injectSeoIntoHtml(html, settings, '/privacy')), false);
  });

  it('re-injects cleanly instead of stacking JSON-LD blocks', () => {
    const settings = defaultSeoSettings();
    const once = injectSeoIntoHtml('<html><head></head><body></body></html>', settings, '/');
    const twice = injectSeoIntoHtml(once, settings, '/');
    assert.equal(twice.split('application/ld+json').length - 1, 1);
  });

  it('lets an admin override beat the built-in per-path defaults', () => {
    const settings = defaultSeoSettings();
    settings.pages.hospitality.title = 'عنوان الأدمن';
    settings.pages.hospitality.description = 'وصف الأدمن';
    const html = injectSeoIntoHtml('<html><head></head><body></body></html>', settings, '/hospitality');
    assert.match(html, /<title>عنوان الأدمن<\/title>/);
    assert.match(html, /name="description" content="وصف الأدمن"/);
  });

  it('does not copy a short homepage admin title onto service pages', () => {
    const settings = defaultSeoSettings();
    settings.title = 'يوصل';
    settings.pages.home.title = 'يوصل';
    settings.ogTitle = 'يوصل | سوق توريد المناسبات في السعودية';
    const html = '<html><head><title>قديم</title></head><body><div id="root"></div></body></html>';
    const service = injectSeoIntoHtml(html, settings, '/service/photobooth-instant-prints');
    const title = /<title>([\s\S]*?)<\/title>/.exec(service)?.[1] || '';
    assert.notEqual(title, 'يوصل');
    assert.match(title, /فوتوبوث/);
    assert.match(service, /property="og:title" content="[^"]*فوتوبوث/);
    assert.match(service, /<h1>فوتوبوث يطبع لضيوفك فوراً<\/h1>/);
    const home = injectSeoIntoHtml(html, settings, '/');
    assert.match(home, /<title>يوصل<\/title>/);
  });

  it('rejects an empty or unusable admin SEO update and never resets missing fields', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'seo.json');
    const stored = {
      ...defaultSeoSettings(),
      title: 'عنوان محفوظ | يوصل',
      ogImage: 'https://usil.app/favicon.svg',
      twitterImage: 'https://usil.app/favicon.svg',
      updatedAt: '2026-09-02T22:54:20.840Z',
    };
    fs.writeFileSync(file, JSON.stringify(stored));
    const app = express();
    app.use(express.json());
    registerSeoRoutes(app, fakeAuth('admin') as any, dir);
    const { url, close } = await listen(app);
    try {
      for (const body of ['{}', '[]', JSON.stringify({ nonsense: 1, ogImage: 42, pages: { home: { title: 7 } } })]) {
        const res = await fetch(`${url}/api/admin/seo`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        assert.equal(res.status, 400, body);
        assert.match((await res.json()).error, /لا توجد حقول صالحة/);
      }
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), stored);

      const partial = await fetch(`${url}/api/admin/seo`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'وصف جديد للموقع.', pages: { about: { title: 'عن يوصل الجديد' } } }),
      });
      assert.equal(partial.status, 200);
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      assert.equal(raw.description, 'وصف جديد للموقع.');
      assert.equal(raw.pages.about.title, 'عن يوصل الجديد');
      assert.equal(raw.pages.privacy.title, stored.pages.privacy.title);
      assert.equal(raw.title, 'عنوان محفوظ | يوصل');
      assert.equal(raw.ogImage, 'https://usil.app/favicon.svg');
      assert.equal(raw.twitterImage, 'https://usil.app/favicon.svg');
    } finally {
      await close();
    }
    assert.equal(pickSeoPatch({}), null);
    assert.deepEqual(pickSeoPatch({ title: 'x', junk: 1 }), { title: 'x' });
  });

  it('renders an approved vendor listing\'s own title, description and image on /service/<id>', () => {
    const settings = defaultSeoSettings();
    const html = '<html><head><title>قديم</title></head><body><div id="root"></div></body></html>';
    const homeTitle = /<title>([\s\S]*?)<\/title>/.exec(injectSeoIntoHtml(html, settings, '/'))?.[1];
    const page = injectSeoIntoHtml(html, settings, '/service/lst-abc', {
      title: 'قهوة المورد المعتمد',
      description: 'ركن قهوة سعودية مع مباشر لخمسين ضيفاً.',
      image: '/uploads/listing-abc.jpg',
    });
    assert.match(page, /<title>قهوة المورد المعتمد \| يوصل<\/title>/);
    assert.notEqual(/<title>([\s\S]*?)<\/title>/.exec(page)?.[1], homeTitle);
    assert.match(page, /name="description" content="ركن قهوة سعودية مع مباشر لخمسين ضيفاً."/);
    assert.match(page, /property="og:title" content="قهوة المورد المعتمد \| يوصل"/);
    assert.match(page, /property="og:image" content="https:\/\/usil\.app\/uploads\/listing-abc\.jpg"/);
    assert.match(page, /name="twitter:image" content="https:\/\/usil\.app\/uploads\/listing-abc\.jpg"/);
    assert.match(page, /<h1>قهوة المورد المعتمد<\/h1>/);

    // Unknown IDs keep the default.
    const unknown = injectSeoIntoHtml(html, settings, '/service/lst-unknown', null);
    assert.equal(/<title>([\s\S]*?)<\/title>/.exec(unknown)?.[1], settings.title);
    assert.match(unknown, /property="og:image" content="https:\/\/usil\.app\/og\/og-default\.png"/);
  });

  it('serves listing meta and a sitemap from approved vendors only', async () => {
    const dir = tmpDir();
    seedApprovedAndRejected(dir);
    const indexHtmlPath = path.join(dir, 'index.html');
    fs.writeFileSync(indexHtmlPath, '<html><head><title>قديم</title></head><body><div id="root"></div></body></html>');
    const vendorStore = createVendorStore(dir);
    const approved = () => listApprovedCatalogServices(vendorStore, vendorUsersFromDataDir(dir));
    const app = express();
    app.use(express.json());
    const { sendSpa } = registerSeoRoutes(app, fakeAuth(null) as any, dir, {
      indexHtmlPath,
      getServiceEntries: () => approved().map((item) => ({ id: item.id, title: item.title })),
      getServiceSeo: (id) => serviceSeoFrom(approved().find((item) => item.id === id)),
    });
    app.get('*', sendSpa);
    const { url, close } = await listen(app);
    try {
      const xml = await (await fetch(`${url}/sitemap.xml`)).text();
      assert.match(xml, /\/service\/lst-approved/);
      assert.doesNotMatch(xml, /lst-rejected/);

      const ok = await (await fetch(`${url}/service/lst-approved`)).text();
      assert.match(ok, /<title>قهوة المورد المعتمد \| يوصل<\/title>/);
      assert.match(ok, /og:image" content="https:\/\/usil\.app\/uploads\/listing-lst-approved\.jpg"/);

      const rejected = await (await fetch(`${url}/service/lst-rejected`)).text();
      assert.doesNotMatch(rejected, /المورد المرفوض/);
      assert.match(rejected, /<title>يوصل \| سوق توريد المناسبات في السعودية<\/title>/);
    } finally {
      await close();
    }
  });

  it('lists public vendor pages in the sitemap with the same rule as /api/vendors/:id', async () => {
    const dir = tmpDir();
    seedApprovedAndRejected(dir);
    // The vendor role is what makes a vendor public, even with a rejected later application.
    const users = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf-8'));
    users.push({ id: 'usr-vendor-rejected', email: 'gone@vendor.sa', name: 'مرفوض', role: 'vendor' });
    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(users));
    fs.writeFileSync(
      path.join(dir, 'vendor-applications.json'),
      JSON.stringify([{ id: 'vap-gone', email: 'gone@vendor.sa', status: 'rejected' }]),
    );
    const app = express();
    registerSeoRoutes(app, fakeAuth(null) as any, dir);
    const { url, close } = await listen(app);
    try {
      const xml = await (await fetch(`${url}/sitemap.xml`)).text();
      assert.match(xml, /<loc>https:\/\/usil\.app\/vendor\/usr-approved<\/loc>/);
      assert.doesNotMatch(xml, /\/vendor\/usr-rejected/);
      assert.match(xml, /\/vendor\/usr-vendor-rejected/);
    } finally {
      await close();
    }
  });

  it('adds AI crawler allows and a sitemap line without dropping admin robots rules', () => {
    const merged = mergeRobotsTxt('User-agent: *\nAllow: /\nDisallow: /api/\n', 'https://usil.app');
    assert.match(merged, /User-agent: \*/);
    assert.match(merged, /Disallow: \/api\//);
    for (const agent of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended']) {
      assert.match(merged, new RegExp(`User-agent: ${agent}\\nAllow: /`));
    }
    assert.match(merged, /Sitemap: https:\/\/usil\.app\/sitemap\.xml/);

    // الأدمن حجب GPTBot عمدًا، فلا نعيد السماح له من تحته
    const admin = mergeRobotsTxt('User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n', 'https://usil.app');
    assert.match(admin, /User-agent: GPTBot\nDisallow: \//);
    assert.equal(admin.match(/User-agent: GPTBot/g)?.length, 1);
    // ولا نكرّر سطر Sitemap إن كتبه بنفسه
    assert.equal(
      mergeRobotsTxt('User-agent: *\nAllow: /\n\nSitemap: https://usil.app/sitemap.xml\n', 'https://usil.app').match(
        /Sitemap:/g,
      )?.length,
      1,
    );
  });

  it('builds a sitemap without invented changefreq or priority', () => {
    const settings = defaultSeoSettings();
    const xml = buildSitemapXml(settings, [{ path: '/service/royal-saudi-coffee', lastmod: '2026-03-01' }]);
    assert.doesNotMatch(xml, /changefreq|priority/);
    assert.match(xml, /<lastmod>2026-03-01<\/lastmod>/);
    assert.match(xml, /<loc>https:\/\/usil\.app\/service\/royal-saudi-coffee<\/loc>/);
    assert.equal(xml.match(/<url>/g)?.length, xml.match(/<loc>/g)?.length);
  });
});
