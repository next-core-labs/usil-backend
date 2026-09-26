import type { SeoPageKey, SeoSettings } from './seo-store';
import { defaultSeoSettings, pathToPageKey } from './seo-store';
import { normalizeSeoPath, seoMetaForPath } from './seo-meta';
import { jsonLdForPath, jsonLdScript } from './seo-jsonld';
import { staticLegalRootHtml } from './legal-static';

/**
 * Share metadata for an approved vendor listing rendered at `/service/<id>`.
 * Callers look it up in the approved public catalog; an unknown ID passes null
 * and the page falls back to the built-in map or the site default.
 */
export type ServicePageSeo = { title: string; description?: string; image?: string };

const SERVICE_TITLE_SUFFIX = ' | يوصل';
const SERVICE_DESCRIPTION_MAX = 300;

function absoluteShareImage(image: string | undefined, baseUrl: string): string {
  const raw = String(image || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/') && !raw.startsWith('//')) return `${baseUrl}${raw}`;
  return '';
}

function serviceTitle(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim();
  return clean.endsWith(SERVICE_TITLE_SUFFIX.trim()) ? clean : `${clean}${SERVICE_TITLE_SUFFIX}`;
}

function clipText(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function escapeAttr(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export type ResolvedPageSeo = {
  path: string;
  pageKey: SeoPageKey;
  title: string;
  description: string;
  h1: string;
  keywords: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  ogSiteName: string;
  twitterCard: SeoSettings['twitterCard'];
  twitterTitle: string;
  twitterDescription: string;
  twitterImage: string;
  canonical: string;
  googleSiteVerification: string;
  analyticsId: string;
};

// قيمة الأدمن تُعتمد فقط إن كانت تختلف عن الافتراضي المدفون في الكود، وإلا
// فالصفحة لم تُحرَّر يدويًا وخريطة الميتا أدق منها.
function adminEdit(value: string | undefined, builtIn: string | undefined): string {
  const current = (value || '').trim();
  if (!current) return '';
  return current === (builtIn || '').trim() ? '' : current;
}

/** عنوان الأدمن للرئيسية لا يُنسخ على /service/* لأن pathToPageKey يرجع home لأي مسار غير مجدول. */
export function adminOverrideApplies(pathname: string, pageKey: SeoPageKey): boolean {
  const path = pathname.replace(/\/$/, '') || '/';
  if (pageKey === 'home') return path === '/' || path === '/ai-studio' || path === '/ai-packages';
  return path === `/${pageKey}`;
}

export function resolvePageSeo(
  settings: SeoSettings,
  pathname: string,
  service?: ServicePageSeo | null,
): ResolvedPageSeo {
  const normalized = normalizeSeoPath(pathname);
  const pageKey = pathToPageKey(normalized);
  const page = settings.pages[pageKey];
  const builtIn = defaultSeoSettings().pages[pageKey];
  // خريطة الميتا تُطابق المسار الكامل، فتغطي صفحات الخدمات التي لا مفتاح أدمن لها
  const meta = seoMetaForPath(normalized);
  // منتج مورّد معتمد على /service/<id>: عنوانه ووصفه وصورته هو، لا عنوان الرئيسية
  const listing = normalized.startsWith('/service/') && service?.title?.trim() ? service : null;

  const useAdmin = adminOverrideApplies(normalized, pageKey);
  const title = listing
    ? serviceTitle(listing.title)
    : (useAdmin ? adminEdit(page?.title, builtIn?.title) : '') || meta?.title || page?.title || settings.title;
  const description =
    (listing?.description?.trim() ? clipText(listing.description, SERVICE_DESCRIPTION_MAX) : '') ||
    (useAdmin ? adminEdit(page?.description, builtIn?.description) : '') ||
    meta?.description ||
    page?.description ||
    settings.description;
  const listingImage = listing ? absoluteShareImage(listing.image, settings.canonicalBaseUrl) : '';

  const canonicalPath = normalized === '/' ? '/' : normalized;
  // مشاركة واتساب/جوجل لازم تطابق عنوان الصفحة، مو عنوان الرئيسية العام
  const ogTitle = title;
  const ogDescription = description;
  return {
    path: canonicalPath,
    pageKey,
    title,
    description,
    h1: listing ? listing.title.trim() : meta?.h1 || '',
    keywords: settings.keywords,
    ogTitle,
    ogDescription,
    ogImage: listingImage || settings.ogImage,
    ogSiteName: settings.ogSiteName,
    twitterCard: settings.twitterCard,
    twitterTitle:
      useAdmin && settings.twitterTitle && settings.twitterTitle !== settings.title ? settings.twitterTitle : title,
    twitterDescription:
      useAdmin && settings.twitterDescription && settings.twitterDescription !== settings.description
        ? settings.twitterDescription
        : description,
    twitterImage: listingImage || settings.twitterImage || settings.ogImage,
    canonical: `${settings.canonicalBaseUrl}${canonicalPath}`,
    googleSiteVerification: settings.googleSiteVerification,
    analyticsId: settings.analyticsId.trim(),
  };
}

function upsertMeta(html: string, attr: 'name' | 'property', key: string, content: string): string {
  const tag = `<meta ${attr}="${key}" content="${escapeAttr(content)}" />`;
  const re = new RegExp(`<meta\\s+${attr}=["']${key}["'][^>]*>`, 'i');
  if (re.test(html)) return html.replace(re, tag);
  return html.replace(/<\/head>/i, `    ${tag}\n  </head>`);
}

function upsertLink(html: string, rel: string, href: string): string {
  const tag = `<link rel="${rel}" href="${escapeAttr(href)}" />`;
  const re = new RegExp(`<link\\s+rel=["']${rel}["'][^>]*>`, 'i');
  if (re.test(html)) return html.replace(re, tag);
  return html.replace(/<\/head>/i, `    ${tag}\n  </head>`);
}

function upsertTitle(html: string, title: string): string {
  const safe = escapeAttr(title);
  if (/<title>[\s\S]*?<\/title>/i.test(html)) {
    return html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${safe}</title>`);
  }
  return html.replace(/<\/head>/i, `    <title>${safe}</title>\n  </head>`);
}

function stripManagedScripts(html: string): string {
  return html
    .replace(/\s*<!-- usil-jsonld -->[\s\S]*?<!-- \/usil-jsonld -->/g, '')
    .replace(/\s*<!-- usil-seo-analytics -->[\s\S]*?<!-- \/usil-seo-analytics -->/g, '')
    .replace(/\s*<script[^>]*src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=[^"]+"[^>]*><\/script>/gi, '')
    .replace(/\s*<script[^>]*src="https:\/\/www\.googletagmanager\.com\/gtm\.js\?id=[^"]+"[^>]*><\/script>/gi, '');
}

function analyticsSnippet(id: string): string {
  if (!id) return '';
  if (/^GTM-/i.test(id)) {
    const safe = escapeAttr(id);
    return `
    <!-- usil-seo-analytics -->
    <script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':Date.now(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${safe}');</script>
    <!-- /usil-seo-analytics -->`;
  }
  if (/^(G-|UA-)/i.test(id)) {
    const safe = escapeAttr(id);
    return `
    <!-- usil-seo-analytics -->
    <script async src="https://www.googletagmanager.com/gtag/js?id=${safe}"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${safe}');</script>
    <!-- /usil-seo-analytics -->`;
  }
  return '';
}

export function injectSeoIntoHtml(
  html: string,
  settings: SeoSettings,
  pathname: string,
  service?: ServicePageSeo | null,
): string {
  const page = resolvePageSeo(settings, pathname, service);
  let next = stripManagedScripts(html);
  next = upsertTitle(next, page.title);
  next = upsertMeta(next, 'name', 'description', page.description);
  next = upsertMeta(next, 'name', 'keywords', page.keywords);
  next = upsertLink(next, 'canonical', page.canonical);
  next = upsertMeta(next, 'property', 'og:type', 'website');
  next = upsertMeta(next, 'property', 'og:url', page.canonical);
  next = upsertMeta(next, 'property', 'og:title', page.ogTitle);
  next = upsertMeta(next, 'property', 'og:description', page.ogDescription);
  next = upsertMeta(next, 'property', 'og:image', page.ogImage);
  // واتساب وإكس يتجاهلان الصورة بلا أبعاد معلنة، وSVG لا يُعرض أصلًا
  if (/\.png($|\?)/i.test(page.ogImage)) {
    next = upsertMeta(next, 'property', 'og:image:type', 'image/png');
    next = upsertMeta(next, 'property', 'og:image:width', '1200');
    next = upsertMeta(next, 'property', 'og:image:height', '630');
  }
  next = upsertMeta(next, 'property', 'og:image:alt', page.ogTitle);
  next = upsertMeta(next, 'property', 'og:site_name', page.ogSiteName);
  next = upsertMeta(next, 'property', 'og:locale', 'ar_SA');
  next = upsertMeta(next, 'name', 'twitter:card', page.twitterCard);
  next = upsertMeta(next, 'name', 'twitter:title', page.twitterTitle);
  next = upsertMeta(next, 'name', 'twitter:description', page.twitterDescription);
  next = upsertMeta(next, 'name', 'twitter:image', page.twitterImage);
  next = upsertLink(next, 'icon', '/og/logo-512.png');
  next = upsertLink(next, 'apple-touch-icon', '/og/logo-512.png');
  if (page.googleSiteVerification) {
    next = upsertMeta(next, 'name', 'google-site-verification', page.googleSiteVerification);
  }
  const blocks = jsonLdForPath({
    baseUrl: settings.canonicalBaseUrl,
    pathname,
    title: page.title,
    description: page.description,
  });
  if (blocks.length > 0) {
    const scripts = blocks.map((block) => `    ${jsonLdScript(block)}`).join('\n');
    next = next.replace(/<\/head>/i, `    <!-- usil-jsonld -->\n${scripts}\n    <!-- /usil-jsonld -->\n  </head>`);
  }
  const snippet = analyticsSnippet(page.analyticsId);
  if (snippet) {
    next = next.replace(/<\/head>/i, `${snippet}\n  </head>`);
  }
  const legalRoot = staticLegalRootHtml(pathname);
  if (legalRoot) {
    if (/<div id="root">[\s\S]*?<\/div>/i.test(next)) {
      next = next.replace(/<div id="root">[\s\S]*?<\/div>/i, `<div id="root">${legalRoot}</div>`);
    } else if (/<body[^>]*>/i.test(next)) {
      next = next.replace(/<body([^>]*)>/i, `<body$1>\n    <div id="root">${legalRoot}</div>`);
    }
  } else {
    const h1 = page.h1;
    if (h1 && /<div id="root"><\/div>/i.test(next) && !/<h1[\s>]/i.test(next)) {
      next = next.replace(
        /<div id="root"><\/div>/i,
        `<div id="root"><h1>${escapeAttr(h1)}</h1></div>`,
      );
    }
  }
  return next;
}

// زواحف محركات البحث بالذكاء الاصطناعي. الحجب يمنع التدريب والاستشهاد معًا،
// وسوق مثل توريد المناسبات يُسأل عنه داخل ChatGPT وPerplexity مباشرة.
export const AI_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'PerplexityBot',
  'Google-Extended',
] as const;

/** يضيف مجموعات الزواحف الذكية وسطر Sitemap دون المساس بما كتبه الأدمن. */
export function mergeRobotsTxt(adminRobots: string, canonicalBaseUrl: string): string {
  const base = String(adminRobots || '').replace(/\r\n/g, '\n').trimEnd();
  const declared = new Set(
    base
      .split('\n')
      .map((line) => /^\s*user-agent\s*:\s*(.+?)\s*$/i.exec(line)?.[1]?.toLowerCase())
      .filter((agent): agent is string => Boolean(agent)),
  );
  const missing = AI_CRAWLERS.filter((agent) => !declared.has(agent.toLowerCase()));

  const parts = [base];
  if (missing.length > 0) {
    parts.push(
      [
        '# السماح لزواحف محركات البحث بالذكاء الاصطناعي',
        ...missing.map((agent) => `User-agent: ${agent}\nAllow: /`),
      ].join('\n\n'),
    );
  }
  if (!/^\s*sitemap\s*:/im.test(base)) {
    parts.push(`Sitemap: ${canonicalBaseUrl}/sitemap.xml`);
  }
  return `${parts.filter(Boolean).join('\n\n')}\n`;
}

export function xmlEscape(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildSitemapXml(
  settings: SeoSettings,
  extras: Array<{ path: string; lastmod?: string }> = [],
): string {
  // changefreq وpriority تتجاهلهما جوجل منذ سنوات، وإعلان قيم مخترعة يضعف الثقة
  const fallbackLastmod = (settings.updatedAt || new Date().toISOString()).slice(0, 10);
  const seen = new Set<string>();
  const urls: Array<{ loc: string; lastmod: string }> = [];
  const push = (rawPath: string, lastmod?: string) => {
    const path = rawPath.startsWith('http') ? new URL(rawPath).pathname : rawPath;
    const normalized = normalizeSeoPath(path);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    urls.push({
      loc: `${settings.canonicalBaseUrl}${normalized}`,
      lastmod: (lastmod || fallbackLastmod).slice(0, 10),
    });
  };

  push('/');
  push('/hospitality');
  push('/about');
  push('/support');
  push('/courier');
  push('/privacy');
  push('/terms');
  push('/refund');
  push('/cancellation');
  for (const extra of extras) push(extra.path, extra.lastmod);

  const body = urls
    .map(
      (url) => `  <url>
    <loc>${xmlEscape(url.loc)}</loc>
    <lastmod>${url.lastmod}</lastmod>
  </url>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

export function googleHtmlVerificationPage(tokenFile: string): string {
  const content = tokenFile.replace(/\.html$/i, '');
  return `<!DOCTYPE html>
<html>
  <head>
    <meta name="google-site-verification" content="${escapeAttr(content)}" />
    <title>Google Site Verification</title>
  </head>
  <body>google-site-verification: ${escapeAttr(tokenFile)}</body>
</html>
`;
}
