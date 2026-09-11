import fs from 'fs';
import path from 'path';
import { readJsonFile, writeJsonFile } from './../shared/json-file.ts';

export const SEO_PAGE_KEYS = [
  'home',
  'privacy',
  'terms',
  'refund',
  'support',
  'hospitality',
  'about',
  'courier',
  'ai-packages',
] as const;
export type SeoPageKey = (typeof SEO_PAGE_KEYS)[number];

export type SeoPageOverride = {
  title: string;
  titleEn: string;
  description: string;
  descriptionEn: string;
};

export type SeoSettings = {
  title: string;
  titleEn: string;
  description: string;
  descriptionEn: string;
  keywords: string;
  keywordsEn: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  ogSiteName: string;
  twitterCard: 'summary' | 'summary_large_image';
  twitterTitle: string;
  twitterDescription: string;
  twitterImage: string;
  canonicalBaseUrl: string;
  robotsTxt: string;
  googleSiteVerification: string;
  googleHtmlFileToken: string;
  analyticsId: string;
  pages: Record<SeoPageKey, SeoPageOverride>;
  updatedAt: string;
};

const DEFAULT_TITLE = 'يوصل | سوق توريد المناسبات في السعودية';
const DEFAULT_DESCRIPTION =
  'اطلب الضيافة والقاعات والتصوير والديكور من مزودين موثّقين بسعر نهائي شامل الضريبة.';
const DEFAULT_KEYWORDS = 'يوصل, ضيافة, مناسبات, توريد حفلات, قهوة عربية, قاعات, الرياض, جدة';
const DEFAULT_CANONICAL = 'https://usil.app';
const DEFAULT_OG_IMAGE = `${DEFAULT_CANONICAL}/og/og-default.png`;
// SVG لا تعرضه واتساب ولا إكس ولا فيسبوك، فأي إعداد محفوظ يشير للأيقونة يُرقّى
const LEGACY_OG_IMAGES = [`${DEFAULT_CANONICAL}/favicon.svg`, '/favicon.svg'];
const DEFAULT_ROBOTS = `User-agent: *
Allow: /

Sitemap: https://usil.app/sitemap.xml
`;

export function defaultSeoSettings(): SeoSettings {
  return {
    title: DEFAULT_TITLE,
    titleEn: 'Usil | Event supply marketplace in Saudi Arabia',
    description: DEFAULT_DESCRIPTION,
    descriptionEn:
      'Book hospitality, halls, photography, and décor from verified suppliers at a final VAT-inclusive price.',
    keywords: DEFAULT_KEYWORDS,
    keywordsEn: 'Usil, hospitality, events, catering, Arabic coffee, halls, Riyadh, Jeddah',
    ogTitle: DEFAULT_TITLE,
    ogDescription: DEFAULT_DESCRIPTION,
    ogImage: DEFAULT_OG_IMAGE,
    ogSiteName: 'يوصل',
    twitterCard: 'summary_large_image',
    twitterTitle: DEFAULT_TITLE,
    twitterDescription: DEFAULT_DESCRIPTION,
    twitterImage: DEFAULT_OG_IMAGE,
    canonicalBaseUrl: DEFAULT_CANONICAL,
    robotsTxt: DEFAULT_ROBOTS,
    googleSiteVerification: '',
    googleHtmlFileToken: '',
    analyticsId: '',
    pages: {
      home: {
        title: DEFAULT_TITLE,
        titleEn: 'Usil | Event supply marketplace in Saudi Arabia',
        description: DEFAULT_DESCRIPTION,
        descriptionEn:
          'Book hospitality, halls, photography, and décor from verified suppliers at a final VAT-inclusive price.',
      },
      privacy: {
        title: 'سياسة الخصوصية | يوصل',
        titleEn: 'Privacy Policy | Usil',
        description:
          'سياسة خصوصية يوصل: بيانات الحساب والحجز تُعالج في السعودية لتشغيل الخدمة ومنع الاحتيال — دون بيع بياناتك لإعلانات طرف ثالث.',
        descriptionEn: 'Usil privacy policy: account and booking data are processed in Saudi Arabia to run the service.',
      },
      terms: {
        title: 'شروط الاستخدام | يوصل',
        titleEn: 'Terms of Use | Usil',
        description:
          'شروط استخدام يوصل: وسيط توريد مناسبات، سعر نهائي يشمل ضريبة القيمة المضافة 15%، سياسة إلغاء مكتوبة، وضمان إذا تخلّف مورّد.',
        descriptionEn: 'Usil terms: event-supply marketplace, final price includes 15% VAT, written cancellation policy.',
      },
      refund: {
        title: 'سياسة الاسترجاع | يوصل',
        titleEn: 'Refund Policy | Usil',
        description:
          'سياسة استرجاع يوصل: كامل قبل 7 أيام، 50٪ من 3 إلى أقل من 7، ولا استرجاع بعد ذلك. اعتذار المورّد يعيد كامل ما تؤكده ميسر.',
        descriptionEn: 'Usil refunds: 100% 7+ days out, 50% from 3 to under 7 days, none after that. Vendor cancel returns the Moyasar-confirmed amount.',
      },
      support: {
        title: 'الدعم والتواصل | يوصل',
        titleEn: 'Support | Usil',
        description:
          'تواصل مع يوصل: واتساب خدمة العملاء، المدن المغطاة، وسياسة الخصوصية والشروط. وسيط توريد — لا ننظّم الحفل نيابة عنك.',
        descriptionEn: 'Contact Usil support via WhatsApp or email. We enable suppliers — we do not run the event for you.',
      },
      hospitality: {
        title: 'ضيافة وقهوة عربية | يوصل',
        titleEn: 'Arabic hospitality & coffee | Usil',
        description:
          'اطلب ركن القهوة العربية والضيافة من مزودين موثّقين في الرياض وجدة وباقي مدن السعودية، بسعر نهائي شامل الضريبة.',
        descriptionEn:
          'Book Arabic coffee and hospitality from verified suppliers across Saudi Arabia at a final VAT-inclusive price.',
      },
      about: {
        title: 'عن يوصل | سوق توريد المناسبات',
        titleEn: 'About Usil | Event supply marketplace',
        description:
          'يوصل (Usil) سوق إلكتروني لتوريد المناسبات في السعودية: مورّدون موثّقون، سعر نهائي شامل الضريبة، ووسيط يتابع التنفيذ.',
        descriptionEn:
          'Usil is a Saudi event-supply store: verified vendors, final VAT-inclusive prices, and a marketplace that follows through until delivery.',
      },
      courier: {
        title: 'انضم كمندوب توصيل | يوصل',
        titleEn: 'Join as a courier | Usil',
        description:
          'قدّم طلب انضمام كمندوب يوصل داخل مدن السعودية: توصيل تجهيزات المناسبات من المورّد إلى موقع الحفل، بعد توثيق الهوية.',
        descriptionEn: 'Apply to join Usil as a courier delivering event supplies across Saudi cities.',
      },
      'ai-packages': {
        title: 'باقات التوفير الذكية | يوصل',
        titleEn: 'Smart savings packages | Usil',
        description:
          'باقات توفير يوصل: تجميع خدمات مورّدين موثّقين لمناسبتك بسعر نهائي شامل الضريبة، حسب المدينة ونوع الحفل.',
        descriptionEn: 'Usil smart packages bundle verified suppliers at a final VAT-inclusive price.',
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function safeHttpUrl(value: string, fallback = ''): string {
  const raw = value.trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    return url.toString();
  } catch {
    return fallback;
  }
}

function safeShareImage(value: string): string {
  const url = safeHttpUrl(value, DEFAULT_OG_IMAGE) || DEFAULT_OG_IMAGE;
  return LEGACY_OG_IMAGES.includes(url.replace(/\/$/, '')) ? DEFAULT_OG_IMAGE : url;
}

function safeCanonical(value: string): string {
  const url = safeHttpUrl(value, DEFAULT_CANONICAL) || DEFAULT_CANONICAL;
  return url.replace(/\/$/, '');
}

function safeAnalyticsId(value: string): string {
  const raw = value.trim();
  if (!raw) return '';
  if (/^(GTM-[A-Z0-9]+|G-[A-Z0-9]+|UA-\d+-\d+)$/i.test(raw)) return raw;
  return '';
}

function safeTwitterCard(value: unknown): SeoSettings['twitterCard'] {
  return value === 'summary' ? 'summary' : 'summary_large_image';
}

export function normalizeHtmlFileToken(raw: string): string {
  const trimmed = asString(raw).trim();
  if (!trimmed) return '';
  const base = trimmed.replace(/^https?:\/\/[^/]+\//i, '').replace(/^\//, '');
  const name = /\.html$/i.test(base) ? base : /^google/i.test(base) ? `${base}.html` : `google${base}.html`;
  if (!/^google[a-zA-Z0-9_-]+\.html$/i.test(name)) return '';
  return name;
}

function mergePage(input: unknown, fallback: SeoPageOverride): SeoPageOverride {
  const row = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return {
    title: clip(asString(row.title, fallback.title).trim(), 180),
    titleEn: clip(asString(row.titleEn, fallback.titleEn).trim(), 180),
    description: clip(asString(row.description, fallback.description).trim(), 400),
    descriptionEn: clip(asString(row.descriptionEn, fallback.descriptionEn).trim(), 400),
  };
}

export function sanitizeSeoSettings(input: unknown, previous?: SeoSettings): SeoSettings {
  const defaults = defaultSeoSettings();
  const base = previous ? { ...defaults, ...previous, pages: { ...defaults.pages, ...previous.pages } } : defaults;
  const row = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const pagesIn = row.pages && typeof row.pages === 'object' ? (row.pages as Record<string, unknown>) : {};
  const pages = { ...base.pages };
  for (const key of SEO_PAGE_KEYS) {
    pages[key] = mergePage(pagesIn[key], base.pages[key]);
  }

  return {
    title: clip(asString(row.title, base.title).trim() || defaults.title, 180),
    titleEn: clip(asString(row.titleEn, base.titleEn).trim(), 180),
    description: clip(asString(row.description, base.description).trim() || defaults.description, 400),
    descriptionEn: clip(asString(row.descriptionEn, base.descriptionEn).trim(), 400),
    keywords: clip(asString(row.keywords, base.keywords).trim() || defaults.keywords, 400),
    keywordsEn: clip(asString(row.keywordsEn, base.keywordsEn).trim(), 400),
    ogTitle: clip(asString(row.ogTitle, base.ogTitle).trim() || defaults.title, 180),
    ogDescription: clip(asString(row.ogDescription, base.ogDescription).trim() || defaults.description, 400),
    ogImage: safeShareImage(asString(row.ogImage, base.ogImage)),
    ogSiteName: clip(asString(row.ogSiteName, base.ogSiteName).trim() || 'يوصل', 80),
    twitterCard: safeTwitterCard(row.twitterCard ?? base.twitterCard),
    twitterTitle: clip(asString(row.twitterTitle, base.twitterTitle).trim() || defaults.title, 180),
    twitterDescription: clip(asString(row.twitterDescription, base.twitterDescription).trim() || defaults.description, 400),
    twitterImage: safeShareImage(asString(row.twitterImage, base.twitterImage)),
    canonicalBaseUrl: safeCanonical(asString(row.canonicalBaseUrl, base.canonicalBaseUrl)),
    robotsTxt: clip(asString(row.robotsTxt, base.robotsTxt).replace(/\r\n/g, '\n'), 20_000) || defaults.robotsTxt,
    googleSiteVerification: clip(asString(row.googleSiteVerification, base.googleSiteVerification).trim(), 200),
    googleHtmlFileToken: normalizeHtmlFileToken(asString(row.googleHtmlFileToken, base.googleHtmlFileToken)),
    analyticsId: safeAnalyticsId(asString(row.analyticsId, base.analyticsId)),
    pages,
    updatedAt: new Date().toISOString(),
  };
}

export function pathToPageKey(pathname: string): SeoPageKey {
  const path = pathname.replace(/\/$/, '') || '/';
  if (path === '/' || path === '' || path === '/ai-studio' || path === '/ai-packages') return 'home';
  if (path === '/cancellation') return 'refund';
  const key = path.replace(/^\//, '');
  if ((SEO_PAGE_KEYS as readonly string[]).includes(key)) return key as SeoPageKey;
  return 'home';
}

export function publicSeoPayload(settings: SeoSettings) {
  return {
    title: settings.title,
    titleEn: settings.titleEn,
    description: settings.description,
    descriptionEn: settings.descriptionEn,
    keywords: settings.keywords,
    keywordsEn: settings.keywordsEn,
    ogTitle: settings.ogTitle,
    ogDescription: settings.ogDescription,
    ogImage: settings.ogImage,
    ogSiteName: settings.ogSiteName,
    twitterCard: settings.twitterCard,
    twitterTitle: settings.twitterTitle,
    twitterDescription: settings.twitterDescription,
    twitterImage: settings.twitterImage,
    canonicalBaseUrl: settings.canonicalBaseUrl,
    googleSiteVerification: settings.googleSiteVerification,
    analyticsId: settings.analyticsId,
    pages: settings.pages,
    updatedAt: settings.updatedAt,
  };
}

export function createSeoStore(dataDir: string) {
  const file = path.join(dataDir, 'seo.json');

  function readFile(): SeoSettings {
    const stored = readJsonFile<unknown>(file, null);
    return stored === null ? defaultSeoSettings() : sanitizeSeoSettings(stored);
  }

  function writeFile(settings: SeoSettings) {
    writeJsonFile(file, settings);
  }

  function load(): SeoSettings {
    const current = readFile();
    if (!fs.existsSync(file)) {
      try {
        writeFile(current);
      } catch {
        /* volume missing or read-only — still serve defaults */
      }
    }
    return current;
  }

  function save(input: unknown): SeoSettings {
    const next = sanitizeSeoSettings(input, readFile());
    writeFile(next);
    return next;
  }

  return { file, load, save };
}
