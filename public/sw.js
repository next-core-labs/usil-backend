/**
 * عامل الخدمة (Service Worker) لمنصة يوصل — بلا أي حزمة خارجية.
 *
 * كُتب يدويًا عمدًا: `next-pwa` وأمثاله يولّدون قواعد تخزين واسعة يصعب تدقيقها،
 * وقرار «ما الذي يُخزَّن» هنا قرار أمني لا قرار أداء (انظر `shouldCache` أدناه).
 *
 * الاستراتيجيات:
 *   - صفحات التنقّل  → network-first، والرجوع لـ `/offline` عند فشل الشبكة.
 *   - `/_next/static/*` → stale-while-revalidate (أسماؤها مبصومة بالمحتوى، فلا تتعارض).
 *   - ما عدا ذلك      → شبكة مباشرة بلا تخزين.
 *
 * الملف يُخدَم من `/sw.js` بنطاق الجذر، فيتحكم بكل مسارات الموقع.
 */

/**
 * رقم الإصدار — أي تعديل على منطق هذا الملف أو على قائمة `PRECACHE_URLS`
 * يجب أن يرفعه. عند التفعيل تُحذف كل الكاشات التي لا تحمل هذا الإصدار،
 * فلا يبقى أصل قديم يُخدَم لمستخدم بعد النشر.
 */
const CACHE_VERSION = 'v5';
const CACHE_PREFIX = 'usil-';
const PAGES_CACHE = `${CACHE_PREFIX}pages-${CACHE_VERSION}`;
const ASSETS_CACHE = `${CACHE_PREFIX}assets-${CACHE_VERSION}`;

/** صفحة انقطاع الاتصال أهم أصل هنا: بدونها يرى المستخدم خطأ المتصفح الافتراضي. */
const OFFLINE_URL = '/offline';

/**
 * الحد الأدنى فقط. كل أصل إضافي هنا يعني تثبيتًا أبطأ واحتمال فشل التثبيت كاملًا
 * إن سقط أحد الطلبات، فلا نضع فيه إلا ما لا تعمل الصفحة بدونه.
 */
const PRECACHE_URLS = [OFFLINE_URL, '/manifest.webmanifest', '/icon.svg'];

/**
 * المسارات الممنوع تخزينها إطلاقًا.
 *
 * ⚠️ شرط أمني لا تحسين أداء:
 * كاش عامل الخدمة يعيش في القرص باسم النطاق لا باسم المستخدم. لو خزّنّا استجابة
 * `/dashboard` أو `/api/...` فإن نسخة من بيانات مزوّد — حجوزاته، مستحقاته، أرقام
 * عملائه — تبقى على الجهاز بعد تسجيل الخروج، ويقدر أي مستخدم لاحق على نفس الجهاز
 * (أو نفس الملف الشخصي في المتصفح) أن يراها دون أي مصادقة، وقد تُخدَم له من الكاش
 * حتى لو أبطل الخادم جلسته. `/login` ممنوعة كذلك لأنها تحمل رموز CSRF ونماذج
 * لا يصح أن تُعاد من نسخة قديمة.
 *
 * القاعدة: لا يُخزَّن إلا ما هو عام ومتاح لأي زائر بلا تسجيل دخول.
 */
/*
 * `/bookings` مضاف: صفحة متابعة الحجز تعرض اسم العميل وتاريخ مناسبته
 * ومبالغه. تخزينها على القرص يعني بقاءها على جهاز مشترك — عائلي أو
 * مكتبي — بعد إغلاق المتصفح، ويصل إليها من يفتح نفس الرابط لاحقًا.
 */
const NEVER_CACHE_PREFIXES = ['/api/', '/dashboard', '/admin', '/login', '/bookings'];

/** الأصول الثابتة المبصومة بالمحتوى — آمنة للتخزين الطويل. */
const STATIC_PREFIXES = ['/_next/static/'];

/**
 * قرار التخزين — دالة نقية، وهي المرجع الوحيد للسياسة في هذا الملف.
 * تُصدَّر في نهاية الملف لتُختبر في `tests/pwa.test.ts` بدل تكرار المنطق هناك،
 * لأن سياسة مكرّرة في الاختبار تختبر نسخة الاختبار لا نسخة الإنتاج.
 *
 * @param {string} url — رابط الطلب كاملًا أو مسارًا.
 * @param {string} method — فعل HTTP.
 * @returns {boolean} هل يجوز تخزين استجابة هذا الطلب؟
 */
function shouldCache(url, method) {
  // الطفرات لا تُخزَّن أبدًا: استجابتها تخص عملية واحدة، وإعادتها من الكاش
  // تعني إظهار نتيجة عملية سابقة كأنها نتيجة العملية الحالية.
  if (typeof method === 'string' && method.toUpperCase() !== 'GET') return false;

  let pathname;
  try {
    // قاعدة وهمية تكفي للمسارات النسبية؛ الروابط المطلقة تتجاوزها.
    pathname = new URL(url, 'http://localhost').pathname;
  } catch {
    return false;
  }

  // مسار خاص محمي: `/dashboard` نفسها و`/dashboard/...` كلاهما ممنوع،
  // بينما مسار عام مثل `/logins` أو `/administration` لا يقع تحت المنع.
  for (const prefix of NEVER_CACHE_PREFIXES) {
    if (prefix.endsWith('/')) {
      if (pathname.startsWith(prefix)) return false;
    } else if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return false;
    }
  }

  return true;
}

/** هل هذا أصل ثابت مبصوم بالمحتوى؟ */
function isStaticAsset(url) {
  let pathname;
  try {
    pathname = new URL(url, 'http://localhost').pathname;
  } catch {
    return false;
  }
  return STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// ــــــ دورة الحياة ــــــ

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PAGES_CACHE);
      // `addAll` تفشل كلها لو سقط أصل واحد، فنخزّن كلًا على حدة حتى لا يمنع
      // أصل ثانوي مفقود صفحةَ `/offline` من الوصول للكاش.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            const response = await fetch(url, { cache: 'reload' });
            if (response.ok) await cache.put(url, response);
          } catch {
            // تجاهل: التثبيت ينجح ولو تعذّر أصل ثانوي.
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (key) =>
              (key.startsWith(CACHE_PREFIX) || key.startsWith('midyaf-')) &&
              key !== PAGES_CACHE &&
              key !== ASSETS_CACHE,
          )
          .map((key) => caches.delete(key)),
      );
      // لا نستخدم clients.claim(): الاستيلاء على التبويب المفتوح يعيد تحميل
      // الصفحة بعد ثانية ويظهر للمستخدم كأنها اختفت.
    })(),
  );
});

// ــــــ الاعتراض ــــــ

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // طلبات النطاقات الأخرى تمر كما هي: لا نتحكم بسياسة كاش خادم لا نملكه.
  if (new URL(request.url).origin !== self.location.origin) return;

  // الفحص الأمني أولًا وقبل أي استراتيجية.
  if (!shouldCache(request.url, request.method)) return;

  // صفحات التنقّل للمتصفح مباشرة. اعتراضها عبر العامل كان يستبدل الصفحة
  // بعد التحميل (خصوصاً خلف Cloudflare أو المعاينة) فتختفي الشاشة.
  if (request.mode === 'navigate') return;

  if (isStaticAsset(request.url)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

/**
 * network-first للصفحات: المحتوى — الأسعار والتوفر — يتغيّر، وعرض نسخة قديمة
 * منه أسوأ من انتظار الشبكة. الكاش هنا شبكة أمان لا مصدر أول.
 */
async function networkFirstPage(request) {
  const cache = await caches.open(PAGES_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;

    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;

    return new Response('لا يوجد اتصال بالإنترنت.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/**
 * stale-while-revalidate للأصول الثابتة: أسماؤها مبصومة بالمحتوى، فالنسخة
 * المخزّنة لا تكون «قديمة» أبدًا لنفس الرابط — نخدمها فورًا ونحدّث في الخلفية.
 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSETS_CACHE);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);

  if (cached) return cached;

  const response = await network;
  if (response) return response;

  return new Response('', { status: 504 });
}

// يُستورد في الاختبار فقط؛ المتصفح يتجاهل هذا الفرع لأن `module` غير معرّف.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { shouldCache, isStaticAsset, CACHE_VERSION, NEVER_CACHE_PREFIXES };
}
