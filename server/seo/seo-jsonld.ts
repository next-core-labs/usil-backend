// بيانات منظمة تُحقن في الـ HTML من الخادم، فتصل الزاحف في أول استجابة
// بخلاف الحقن من العميل الذي قد لا يُنفَّذ أصلًا.
import { normalizeSeoPath, seoMetaForPath } from './seo-meta';

export function jsonLdScript(data: object): string {
  // المحتوى من كودنا لا من إدخال مستخدم؛ و`</` تُهرَّب لئلا تُغلق الوسم مبكرًا
  const payload = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${payload}</script>`;
}

export function organizationJsonLd(baseUrl: string, description: string) {
  const orgId = `${baseUrl}/#organization`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': orgId,
        name: 'يوصل',
        alternateName: 'Usil',
        url: `${baseUrl}/`,
        logo: { '@type': 'ImageObject', url: `${baseUrl}/og/logo-512.png`, width: 512, height: 512 },
        description,
        areaServed: [
          { '@type': 'City', name: 'الرياض' },
          { '@type': 'City', name: 'جدة' },
        ],
        address: { '@type': 'PostalAddress', addressCountry: 'SA' },
      },
      {
        '@type': 'WebSite',
        '@id': `${baseUrl}/#website`,
        url: `${baseUrl}/`,
        name: 'يوصل',
        inLanguage: 'ar-SA',
        publisher: { '@id': orgId },
      },
    ],
  };
}

// Offer وAggregateRating متروكان عمدًا: إعلان سعر أو تقييم غير معروض للمستخدم
// على الصفحة نفسها مخالفة لإرشادات جوجل وتُسقط النتيجة المنسّقة.
export function serviceJsonLd(opts: {
  baseUrl: string;
  path: string;
  name: string;
  description: string;
}) {
  const url = `${opts.baseUrl}${opts.path}`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Service',
        '@id': `${url}#service`,
        name: opts.name,
        description: opts.description,
        url,
        provider: { '@id': `${opts.baseUrl}/#organization` },
        areaServed: [
          { '@type': 'City', name: 'الرياض' },
          { '@type': 'City', name: 'جدة' },
        ],
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'الرئيسية', item: `${opts.baseUrl}/` },
          { '@type': 'ListItem', position: 2, name: opts.name },
        ],
      },
    ],
  };
}

export function jsonLdForPath(opts: {
  baseUrl: string;
  pathname: string;
  title: string;
  description: string;
}): object[] {
  const path = normalizeSeoPath(opts.pathname);
  if (path === '/') return [organizationJsonLd(opts.baseUrl, opts.description)];
  if (!path.startsWith('/service/')) return [];

  const meta = seoMetaForPath(path);
  // عنوان الخدمة بلا لاحقة العلامة: الاسم في schema اسم الخدمة لا اسم الصفحة
  const name = (meta?.h1 || opts.title).replace(/\s*\|\s*يوصل\s*$/, '').trim();
  if (!name) return [];
  return [
    serviceJsonLd({
      baseUrl: opts.baseUrl,
      path,
      name,
      description: meta?.description || opts.description,
    }),
  ];
}
