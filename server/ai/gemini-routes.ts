import type { Express } from 'express';
import { GoogleGenAI } from '@google/genai';
import {
  catalogSize,
  compactCatalogForPrompt,
  hydrateBundleIds,
  liveCatalog,
  matchBundlesFromCatalog,
  type CatalogCard,
  type MatchInput,
} from './catalog-match';
import type { AiRouter } from './ai-providers';
import { clientIp, createSlidingWindowLimiter } from '../shared/booking-guards';
import { effectiveKey } from './integrations-store';
import { createVendorStore } from '../vendors/vendor-store';
import { listApprovedCatalogServices, vendorUsersFromDataDir } from '../shared/approved-catalog';

export type GeminiRouteDeps = {
  /** موجّه المزودين (Gemini / Claude / OpenAI) القادم من لوحة التكاملات. */
  ai?: AiRouter;
  dataDir?: string;
  /**
   * Approved vendor accounts (`auth.listVendorUsers`). The AI catalog only shows
   * their listings, like `/api/catalog/listings`. Defaults to reading users.json.
   */
  listVendorUsers?: () => Array<{ id: string }>;
};

/** رسالة موحّدة حين لا يوجد مزود ذكاء مُعد — لا نختلق نتيجة بديلة. */
export const AI_NOT_CONFIGURED =
  'المساعد الذكي غير مفعّل حالياً — لم يُضبط مزود ذكاء (Gemini أو Claude أو OpenAI) على الخادم. أضف المفتاح من لوحة الإدارة › تكاملات ومفاتيح API.';
/** مسارات قدرات جوجل (صوت، موسيقى، بحث، خرائط) تحتاج مفتاح Gemini تحديداً. */
export const GEMINI_NOT_CONFIGURED =
  'هذه الميزة تحتاج مفتاح Gemini على الخادم وهو غير مضبوط حالياً. أضفه من لوحة الإدارة › تكاملات ومفاتيح API.';
export const AI_PROVIDER_FAILED = 'تعذر الاتصال بمزود الذكاء الآن. أعد المحاولة بعد قليل.';

function notConfigured(res: import('express').Response, message = AI_NOT_CONFIGURED) {
  return res.status(503).json({ success: false, aiAvailable: false, aiGenerated: false, error: message });
}

function providerFailed(res: import('express').Response, message = AI_PROVIDER_FAILED) {
  return res.status(502).json({ success: false, aiAvailable: true, aiGenerated: false, error: message });
}

function marketplaceCards(dataDir?: string, listVendorUsers?: () => Array<{ id: string }>): CatalogCard[] {
  if (!dataDir) return liveCatalog();
  try {
    const store = createVendorStore(dataDir);
    return listApprovedCatalogServices(store, listVendorUsers || vendorUsersFromDataDir(dataDir))
      .map((item) => ({
        id: String(item.id),
        title: String(item.title || ''),
        category: String(item.category || ''),
        categoryName: item.categoryName,
        price: Number(item.price) || 0,
        cities: Array.isArray(item.cities) ? item.cities : [],
        audience: item.audience,
        occasions: item.occasions,
        tags: item.tags,
        shortDesc: item.shortDesc,
        providerName: item.provider?.name,
      }));
  } catch {
    return liveCatalog();
  }
}

/**
 * Every `/api/gemini/*` route is deliberately open to anonymous visitors — the
 * voice assistant and the planner run before a guest ever signs in. That makes
 * the throttle below the ONLY thing standing between a scripted caller and an
 * unbounded bill on the provider key, so it is applied to the whole prefix
 * rather than per-route, and a newly added route inherits it automatically.
 */
const AI_TEXT_LIMIT_PER_MIN = 20;
/** Image, music and audio calls cost orders of magnitude more than text. */
const AI_HEAVY_LIMIT_PER_MIN = 4;
const AI_WINDOW_MS = 60_000;
const AI_HEAVY_PATHS = new Set(['/generate-image', '/generate-music', '/transcribe-audio']);
const AI_RATE_LIMITED = 'تجاوزت حد طلبات المساعد الذكي. انتظر دقيقة ثم أعد المحاولة.';

export function registerGeminiRoutes(app: Express, deps: GeminiRouteDeps = {}) {
  const textLimiter = createSlidingWindowLimiter(AI_TEXT_LIMIT_PER_MIN, AI_WINDOW_MS);
  const heavyLimiter = createSlidingWindowLimiter(AI_HEAVY_LIMIT_PER_MIN, AI_WINDOW_MS);

  app.use('/api/gemini', (req, res, next) => {
    // GET /status is a free local read — no provider call behind it.
    if (req.method !== 'POST') return next();
    const heavy = AI_HEAVY_PATHS.has(req.path);
    const limiter = heavy ? heavyLimiter : textLimiter;
    if (!limiter.allow(`${heavy ? 'heavy' : 'text'}:${clientIp(req)}`)) {
      return res.status(429).json({ success: false, error: AI_RATE_LIMITED });
    }
    next();
  });

  // Lazy-initialized Gemini client
  const getGeminiClient = () => {
    const apiKey = geminiKey();
    if (!apiKey) {
      return null;
    }
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  };

  /** مفتاح Gemini للمسارات التي تحتاج قدرات جوجل تحديداً (صور، صوت، بحث). */
  const geminiKey = () => {
    const saved = deps.ai ? effectiveKey(deps.ai.settings(), 'gemini') : '';
    return saved || process.env.GEMINI_API_KEY || '';
  };

  /**
   * عميل نصي بشكل @google/genai لكن ينفّذ على المزود الافتراضي المختار في اللوحة.
   * حين لا يوجد موجّه مزودين نرجع إلى Gemini وحده كما كان.
   */
  const getTextClient = () => (deps.ai ? deps.ai.textClient() : getGeminiClient());

  const activeTextProvider = () => (deps.ai ? deps.ai.activeProvider() : geminiKey() ? 'gemini' : null);

  app.post('/api/gemini/generate-review', async (req, res) => {
    try {
      const { role, partyName, serviceTitle, rating = 5, highlights = '', tone = 'friendly' } = req.body;
      const ai = getTextClient();

      if (!ai) return notConfigured(res);

      const prompt = `أنت خبير ذكاء اصطناعي لمنصة يوصل السعودية (Usil) — سوق توريد المناسبات. لا تقل أصيل أو مضياف أو Aseel أبداً.
  اكتب تقييماً احترافياً بنظام التقييم المزدوج الأعمى (Blind Reviews).
  البيانات:
  - الدور: ${role === 'client' ? 'العميل يقيّم مزود الخدمة' : 'مزود الخدمة يقيّم العميل'}
  - الطرف المقيَّم: ${partyName || 'الطرف الآخر'}
  - الخدمة: ${serviceTitle || 'خدمة مناسبة'}
  - التقييم بالنجوم: ${rating} من 5
  - ملاحظات المدخلة: ${highlights || 'خدمة ممتازة وتنسيق رائع'}
  - النمط/النبرة: ${tone}

  المطلوب:
  1. صياغة تقييم عربي خليجي راقٍ أو فصيح أنيق (سطرين إلى 3 أسطر) بدون مبالغات زائفة.
  2. اقتراح 3 وسوم مميزة (Short badges with emojis).

  أرجع النتيجة بصيغة JSON حصراً بهذا المخطط:
  {
    "review": "نص التقييم هنا...",
    "tags": ["وسم 1", "وسم 2", "وسم 3"]
  }`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.7-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
        },
      });

      const parsed = JSON.parse(response.text || '{}');
      if (typeof parsed.review !== 'string' || !parsed.review.trim()) {
        return providerFailed(res, 'لم يرجع مزود الذكاء نص تقييم. اكتب التقييم بنفسك أو أعد المحاولة.');
      }
      res.json({
        review: parsed.review,
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
        aiGenerated: true,
      });
    } catch (error: any) {
      console.error('Error generating review with Gemini:', error);
      return providerFailed(res);
    }
  });

  // Endpoint: AI Review Sentiment & Reputation Analyzer
  app.post('/api/gemini/analyze-reviews', async (req, res) => {
    try {
      const { targetName, targetType, reviews } = req.body;
      const ai = getTextClient();

      if (!ai) return notConfigured(res);

      const prompt = `قم بتحليل مراجعات التقييم المزدوج للطرف (${targetType === 'vendor' ? 'مزود الخدمة' : 'العميل'}) باسم "${targetName}".
  التقييمات:
  ${JSON.stringify(reviews, null, 2)}

  المطلوب:
  1. كتابة ملخص موجز من سطرين يبرز الانطباع العام.
  2. استخراج 3 إلى 4 نقاط قوة رئيسية واضحة.
  3. تحديد نسبة موثوقية ذكية (AI Trust Score) كرقم بين 85 و 100.

  أرجع النتيجة بصيغة JSON فقط:
  {
    "summary": "...",
    "strengths": ["...", "...", "..."],
    "aiTrustScore": 98
  }`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.7-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
        },
      });

      const parsed = JSON.parse(response.text || '{}');
      if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
        return providerFailed(res, 'لم يرجع مزود الذكاء تحليلاً للتقييمات. أعد المحاولة بعد قليل.');
      }
      const score = Number(parsed.aiTrustScore);
      res.json({
        summary: parsed.summary,
        strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
        // لا نخترع نسبة موثوقية إن لم يرجعها المزود
        aiTrustScore: Number.isFinite(score) && score >= 0 && score <= 100 ? score : null,
        aiGenerated: true,
      });
    } catch (error: any) {
      console.error('Error analyzing reviews with Gemini:', error);
      return providerFailed(res);
    }
  });

  // In-memory OTP storage
  const otpStore = new Map<string, { code: string; expiresAt: number; destination: string; channel: string }>();

  // Endpoint: Password Login (Phone or Email + Password)
  app.post('/api/gemini/voice-assistant', async (req, res) => {
    try {
      const { userSpeech, conversationHistory = [], currentCity = 'الرياض', guestCount = 50 } = req.body;
      const ai = getTextClient();
      const cards = marketplaceCards(deps.dataDir, deps.listVendorUsers);

      const systemPrompt = `أنت "وكيل يوصل الصوتي الذكي" (Usil Voice AI Concierge) — مساعد صوتي لمنصة يوصل (Usil)، سوق توريد المناسبات السعودي. لا تقل أصيل أو مضياف أو Aseel أو Midyaf أبداً. اسمك يوصل بالعربية وUsil بالإنجليزية.
  صوتك وشخصيتك: دافئة، مرحبة بالأسلوب السعودي والخليجي الراقي ("أهلاً وسهلاً بك في يوصل"، "يا هلا"، "سمّ طال عمرك"، "أبشر بعزك").
  تحدث بجمل قصيرة وواضحة وطبيعية جداً تناسب النطق الصوتي البشري المسموع (Voice Speech Synthesis).

  الخدمات المتوفرة في المنصة (منتجات مورّدين معتمدين فقط — المعرّف | العنوان | الفئة | السعر | المدن). لا تقترح أي خدمة أو سعر خارج هذه القائمة:
${compactCatalogForPrompt(cards) || 'لا توجد منتجات معتمدة في السوق حالياً — لا تقترح خدمات ولا أسعاراً.'}

  المطلوب:
  1. الرد بصوت طبيعي كأنك تتحدث هاتفياً أو عبر مكالمة صوتية حية (سطرين إلى 3 أسطر كحد أقصى لتكون مريحة للمستمع).
  2. اقتراح الإجراء الذكي المناسب (action):
     - 'recommend_service' (إذا سأل عن خدمة أو طلب اقتراح)
     - 'add_to_cart' (إذا قال أضف هذا أو احجز لي هذا)
     - 'calculate_budget' (إذا سأل عن الميزانية أو لعدد ضيوف معين)
     - 'filter_category' (إذا طلب تصفية مثل بوفيهات، قهوة، تصوير)
     - 'faq' (إذا كان استفساراً عاماً عن الدفع والضمان)
  3. اقتراح الخدمات المرتبطة بالطلب (serviceIds) وحساب التكلفة التقديرية.

  أرجع النتيجة بصيغة JSON حصراً بهذا المخطط:
  {
    "spokenResponse": "النص الصوتي المسموع بالعربي الودود...",
    "action": "recommend_service", 
    "suggestedServiceIds": [],
    "estimatedBudget": 2650,
    "bundleDiscount": 15,
    "quickOptions": ["حجز الباقة المقترحة", "تعديل عدد الضيوف", "التحدث مع مستشار بشري"]
  }`;

      if (!ai) {
        // بلا مزود ذكاء: مطابقة كلمات على منتجات المورّدين المعتمدين فقط، بلا نص مختلق
        const text = (userSpeech || '').toLowerCase();
        const liveIds = cards.slice(0, 2).map((row) => row.id);
        let spoken =
          cards.length === 0
            ? 'يا هلا فيك في يوصل. السوق يعرض منتجات المورّدين المعتمدين فقط، وما فيه كتالوج وهمي. اكتب طلبك أو اترك طلب مدينة من الصفحة الرئيسية.'
            : 'يا هلا فيك في يوصل. هذي منتجات مورّدين معتمدين من السوق الحي. وش تبي نجهّز لك؟';
        let action = 'recommend_service';
        let serviceIds = liveIds;
        let budget = liveIds.reduce((sum, id) => sum + (cards.find((row) => row.id === id)?.price || 0), 0);

        if (text.includes('قهوة') || text.includes('ضيافة')) {
          const hit = cards.filter((row) => row.category === 'hospitality').slice(0, 2);
          serviceIds = hit.map((row) => row.id);
          spoken =
            hit.length > 0
              ? `لقينا ${hit.map((row) => row.title).join(' و')} من مورّدين معتمدين. تبي تفاصيل أكثر؟`
              : 'ما فيه منتج ضيافة من مورّد معتمد في السوق حالياً.';
        } else if (text.includes('عشاء') || text.includes('بوفيه') || text.includes('أكل')) {
          const hit = cards.filter((row) => row.category === 'buffet').slice(0, 2);
          action = 'calculate_budget';
          serviceIds = hit.map((row) => row.id);
          spoken =
            hit.length > 0
              ? `لقينا ${hit.map((row) => row.title).join(' و')} في كتالوج المورّدين.`
              : 'ما فيه بوفيه من مورّد معتمد في السوق حالياً.';
        } else if (text.includes('تصوير') || text.includes('فيديو')) {
          const hit = cards.filter((row) => row.category === 'photography').slice(0, 2);
          serviceIds = hit.map((row) => row.id);
          spoken =
            hit.length > 0
              ? `لقينا ${hit.map((row) => row.title).join(' و')} للتوثيق.`
              : 'ما فيه تصوير من مورّد معتمد في السوق حالياً.';
        } else if (text.includes('سعر') || text.includes('تكلفة') || text.includes('احسب')) {
          action = 'calculate_budget';
          spoken =
            cards.length > 0
              ? 'أقدر أحسب ميزانيتك من منتجات المورّدين المعتمدين في السوق، بدون أسعار وهمية.'
              : 'ما نقدر نحسب باقة قبل ما يضيف مورّد معتمد منتجاً في السوق.';
        }
        budget = serviceIds.reduce((sum, id) => sum + (cards.find((row) => row.id === id)?.price || 0), 0);

        return res.json({
          spokenResponse: spoken,
          action,
          suggestedServiceIds: serviceIds,
          estimatedBudget: budget,
          bundleDiscount: 0,
          quickOptions: ['عرض منتجات السوق', 'اترك طلب مدينة', 'التحدث مع الدعم'],
          aiGenerated: false,
        });
      }

      const response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: [
          { role: 'user', parts: [{ text: `${systemPrompt}\n\nسياق المحادثة: المدينة (${currentCity})، الضيوف (${guestCount}).\nكلام المستخدم الصوتي المسموع: "${userSpeech}"` }] }
        ],
        config: {
          responseMimeType: 'application/json',
        },
      });

      let parsed: any = {};
      try {
        parsed = JSON.parse(response.text || '{}');
      } catch {
        parsed = {};
      }

      if (parsed.suggestedServiceIds && typeof parsed.spokenResponse === 'string' && parsed.spokenResponse.trim()) {
        // لا نمرّر معرّفاً أو ميزانية لا وجود لهما في الكتالوج المعتمد
        const knownIds = (Array.isArray(parsed.suggestedServiceIds) ? parsed.suggestedServiceIds : [])
          .map((id: unknown) => String(id))
          .filter((id: string) => cards.some((row) => row.id === id));
        res.json({
          spokenResponse: parsed.spokenResponse,
          action: parsed.action || 'recommend_service',
          suggestedServiceIds: knownIds,
          estimatedBudget: knownIds.reduce(
            (sum: number, id: string) => sum + (cards.find((row) => row.id === id)?.price || 0),
            0,
          ),
          bundleDiscount: 0,
          quickOptions: parsed.quickOptions || ['إضافة للسلة', 'تفاصيل الخدمة'],
          aiGenerated: true,
        });
      } else {
        return providerFailed(res, 'لم يرجع المساعد رداً مفهوماً. أعد صياغة طلبك أو حاول بعد قليل.');
      }
    } catch (error: any) {
      console.error('Error in Voice AI assistant:', error);
      return providerFailed(res);
    }
  });

  // Endpoint: AI Image Generation & Editing (gemini-3.1-flash-image)
  app.post('/api/gemini/generate-image', async (req, res) => {
    try {
      const { prompt, base64Image, mimeType = 'image/png', aspectRatio = '1:1', imageSize = '1K' } = req.body;
      const ai = getGeminiClient();

      if (!ai) {
        return res.status(503).json({
          imageUrl: '',
          prompt: prompt || '',
          aiGenerated: false,
          error: 'مولّد الصور غير مفعّل. ارفع صورة منتجك من جهازك.',
        });
      }

      const parts: any[] = [];
      if (base64Image) {
        parts.push({
          inlineData: {
            data: base64Image.replace(/^data:image\/[a-z]+;base64,/, ''),
            mimeType,
          },
        });
        parts.push({
          text: `تعديل وتحسين هذا التصميم للمناسبات السعودية الفاخرة: ${prompt}`,
        });
      } else {
        parts.push({
          text: `Saudi luxury event & royal hospitality visual: ${prompt}. Ultra-realistic, 8k resolution, elegant warm lighting, Arabian coffee dallah and floral setup, cinematic atmosphere.`,
        });
      }

      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-image',
        contents: { parts },
        config: {
          imageConfig: {
            aspectRatio: aspectRatio as any,
            imageSize: (imageSize || '1K') as any,
          },
        },
      });

      let generatedImageUrl = '';
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          generatedImageUrl = `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
          break;
        }
      }

      if (!generatedImageUrl) {
        return res.status(502).json({
          imageUrl: '',
          prompt,
          aiGenerated: false,
          error: 'تعذر توليد صورة. ارفع صورة المنتج من جهازك.',
        });
      }

      return res.json({
        imageUrl: generatedImageUrl,
        prompt,
        aiGenerated: !!generatedImageUrl,
      });
    } catch (error: any) {
      console.error('Error generating image with Gemini:', error);
      return res.status(502).json({
        imageUrl: '',
        prompt: req.body.prompt,
        aiGenerated: false,
        error: error.message,
      });
    }
  });

  // Endpoint: AI Music Generation (lyria-3-clip-preview)
  app.post('/api/gemini/generate-music', async (req, res) => {
    try {
      const { prompt = 'موسيقى زفة ودخول ملكية مع إيقاعات العود والدفوف السعودية التراثية الهادئة', base64Image } = req.body;
      const ai = getGeminiClient();

      if (!ai) return notConfigured(res, GEMINI_NOT_CONFIGURED);

      const contents: any = base64Image
        ? {
            parts: [
              { text: `Generate a 30-second Saudi luxury event background music and royal entrance theme: ${prompt}` },
              { inlineData: { data: base64Image.replace(/^data:image\/[a-z]+;base64,/, ''), mimeType: 'image/jpeg' } },
            ],
          }
        : `Generate a 30-second Saudi luxury event background music, royal traditional entrance with serene oud and authentic rhythms: ${prompt}`;

      const response = await ai.models.generateContentStream({
        model: 'lyria-3-clip-preview',
        contents,
      });

      let audioBase64 = '';
      let lyrics = '';
      let mimeType = 'audio/wav';

      for await (const chunk of response) {
        const parts = chunk.candidates?.[0]?.content?.parts;
        if (!parts) continue;
        for (const part of parts) {
          if (part.inlineData?.data) {
            if (!audioBase64 && part.inlineData.mimeType) {
              mimeType = part.inlineData.mimeType;
            }
            audioBase64 += part.inlineData.data;
          }
          if (part.text && !lyrics) {
            lyrics = part.text;
          }
        }
      }

      if (!audioBase64) {
        return providerFailed(res, 'لم يرجع مولّد الموسيقى مقطعاً صوتياً. أعد المحاولة بعد قليل.');
      }
      return res.json({
        audioBase64,
        mimeType,
        lyrics: lyrics || 'نغمات تراثية تحتفي بضيوفكم الكرام',
        title: 'مقطوعة يوصل التراثية المخصصة',
        durationSeconds: 30,
        aiGenerated: !!audioBase64,
      });
    } catch (error: any) {
      console.error('Error generating music with Lyria:', error);
      return providerFailed(res);
    }
  });

  // Endpoint: AI Audio Transcription (gemini-3.5-flash)
  app.post('/api/gemini/transcribe-audio', async (req, res) => {
    try {
      const { base64Audio, mimeType = 'audio/webm' } = req.body;
      const ai = getGeminiClient();

      if (!ai) return notConfigured(res, GEMINI_NOT_CONFIGURED);
      if (!base64Audio || typeof base64Audio !== 'string') {
        return res.status(400).json({ success: false, error: 'أرسل التسجيل الصوتي أولاً.' });
      }

      const cleanBase64 = base64Audio.replace(/^data:audio\/[a-z0-9]+;base64,/, '');

      const response = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  data: cleanBase64,
                  mimeType,
                },
              },
              {
                text: `أنت خبير تفريغ وتحليل طلبات المناسبات لمنصة يوصل (Usil). لا تقل أصيل أو مضياف. اسم المنصة يوصل.
  قم بتفريغ التسجيل الصوتي بدقة باللهجة السعودية / الفصحى، ثم استخرج بيانات المناسبة بصيغة JSON:
  {
    "transcription": "نص الكلام المسموع بدقة...",
    "structuredEvent": {
      "guestCount": 50,
      "city": "الرياض",
      "eventDate": "التاريخ أو اليوم",
      "requestedServices": ["خدمة 1", "خدمة 2"],
      "estimatedBudget": 3000,
      "notes": "أي ملاحظات خاصة أو تفضيلات"
    }
  }`,
              },
            ],
          },
        ],
        config: {
          responseMimeType: 'application/json',
        },
      });

      const parsed = JSON.parse(response.text || '{}');
      if (typeof parsed.transcription !== 'string' || !parsed.transcription.trim()) {
        return providerFailed(res, 'تعذر تفريغ التسجيل. أعد التسجيل بصوت أوضح أو اكتب طلبك.');
      }
      return res.json({
        transcription: parsed.transcription,
        // لا نملأ بيانات مناسبة من عندنا إن لم يستخرجها المزود
        structuredEvent:
          parsed.structuredEvent && typeof parsed.structuredEvent === 'object' ? parsed.structuredEvent : null,
        aiGenerated: true,
      });
    } catch (error: any) {
      console.error('Error transcribing audio with Gemini:', error);
      return providerFailed(res);
    }
  });

  // Endpoint: Live Search Grounding (gemini-3.5-flash with googleSearch)
  app.post('/api/gemini/search-grounding', async (req, res) => {
    try {
      const { query = 'أسعار البن الخولاني والهيل وأسعار خدمات الضيافة والمناسبات في السعودية 2026' } = req.body;
      const ai = getGeminiClient();

      if (!ai) return notConfigured(res, GEMINI_NOT_CONFIGURED);

      const response = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: `أنت مستشار سوق الضيافة والمناسبات في السعودية لمنصة يوصل (Usil). لا تقل أصيل أو مضياف.
  أجب بدقة وشمولية مدعومة ببيانات محرك البحث المباشرة عن السؤال التالي:
  ${query}

  قدم الإجابة بنقاط واضحة وأسعار تقريبية واقعية بالريال السعودي.`,
        config: {
          tools: [{ googleSearch: {} }],
        },
      });

      const answer = response.text || '';
      if (!answer.trim()) return providerFailed(res, 'لم يرجع البحث المباشر نتيجة. أعد المحاولة بعد قليل.');
      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      const groundingSources = chunks
        .map((c: any) => c.web)
        .filter(Boolean)
        .slice(0, 5);

      return res.json({
        answer,
        groundingSources,
        aiGenerated: true,
      });
    } catch (error: any) {
      console.error('Error in search grounding:', error);
      return providerFailed(res);
    }
  });

  // Endpoint: Maps Grounding (gemini-3.5-flash with googleMaps)
  app.post('/api/gemini/maps-grounding', async (req, res) => {
    try {
      const { query = 'أفضل قاعات المناسبات ومحامص القهوة المختصة الفاخرة في الرياض', latitude, longitude } = req.body;
      const ai = getGeminiClient();

      if (!ai) return notConfigured(res, GEMINI_NOT_CONFIGURED);

      const config: any = {
        tools: [{ googleMaps: {} }],
      };

      if (latitude && longitude) {
        config.toolConfig = {
          retrievalConfig: {
            latLng: {
              latitude: Number(latitude),
              longitude: Number(longitude),
            },
          },
        };
      }

      const response = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: `أنت دليل المواقع والضيافة لمنصة يوصل (Usil). لا تقل أصيل أو مضياف. حدد أفضل قاعات المناسبات أو محامص القهوة أو مواقع الفعاليات بناءً على الطلب:
  ${query}
  اذكر الأسماء والمناطق بدقة.`,
        config,
      });

      const answer = response.text || '';
      if (!answer.trim()) return providerFailed(res, 'لم يرجع بحث الخرائط نتيجة. أعد المحاولة بعد قليل.');
      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      const mapsSources = chunks
        .map((c: any) => c.maps)
        .filter(Boolean)
        .slice(0, 6);

      return res.json({
        answer,
        mapsSources,
        aiGenerated: true,
      });
    } catch (error: any) {
      console.error('Error in maps grounding:', error);
      return providerFailed(res);
    }
  });

  // Endpoint: Multi-turn Gemini Chatbot Concierge (gemini-3.5-flash / gemini-3.1-pro-preview)
  app.post('/api/gemini/chat', async (req, res) => {
    try {
      const { messages = [], currentCity = 'الرياض', usePro = false } = req.body;
      const ai = getTextClient();
      if (!ai) return notConfigured(res);
      const chatCards = marketplaceCards(deps.dataDir, deps.listVendorUsers);

      const systemInstruction = `أنت "مستشار يوصل الذكي لتوريد المناسبات" (Usil AI Event Concierge). أنت يوصل (Usil)، سوق توريد مناسبات سعودي. لا تقل أبداً أصيل أو مضياف أو Aseel أو Midyaf. اسم المنصة بالعربية يوصل وبالإنجليزية Usil.
  خبرتك: توريد ضيافة الأعراس، حفلات التخرج، الاستقبالات الرسمية، والمناسبات العائلية في السعودية.
  أسلوبك: راقٍ ومرحّب، تقدم اقتراحات دقيقة للباقات والميزانيات وإتيكيت الضيافة السعودية.
  الخدمات المتاحة (منتجات مورّدين معتمدين فقط — المعرّف | العنوان | الفئة | السعر | المدن). لا تذكر خدمة أو سعراً خارج هذه القائمة:
${compactCatalogForPrompt(chatCards) || 'لا توجد منتجات معتمدة في السوق حالياً — لا تقترح خدمات ولا أسعاراً.'}`;

      const modelName = usePro ? 'gemini-3.6-flash' : 'gemini-3.6-flash';
      const formattedContents = messages.map((m: any) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

      const response = await ai.models.generateContent({
        model: modelName,
        contents: formattedContents,
        config: {
          systemInstruction,
          temperature: 0.7,
        },
      });

      const reply = response.text || '';
      if (!reply.trim()) return providerFailed(res, 'لم يرجع مزود الذكاء رداً. أعد المحاولة بعد قليل.');
      return res.json({
        reply,
        suggestedActions: ['حساب الميزانية التقديرية', 'عرض منتجات السوق', 'اترك طلب مدينة'],
        aiGenerated: true,
      });
    } catch (error: any) {
      console.error('Error in Gemini Chatbot:', error);
      return providerFailed(res);
    }
  });

  app.get('/api/gemini/status', (_req, res) => {
    res.json({
      available: Boolean(activeTextProvider()),
      catalogSize: catalogSize(marketplaceCards(deps.dataDir, deps.listVendorUsers)),
      vendor: activeTextProvider() || 'gemini',
      geminiAvailable: Boolean(geminiKey()),
    });
  });

  app.post('/api/gemini/match-packages', async (req, res) => {
    const input: MatchInput = {
      brief: String(req.body?.brief || '').trim(),
      occasion: String(req.body?.occasion || '').trim(),
      city: String(req.body?.city || '').trim(),
      budget: Number(req.body?.budget) || 0,
      guests: Number(req.body?.guests) || 0,
    };
    const cards = marketplaceCards(deps.dataDir, deps.listVendorUsers);
    const fallback = matchBundlesFromCatalog(input, cards);
    const keyMissing = !activeTextProvider();

    if (!input.brief && !input.occasion && !input.budget) {
      return res.status(400).json({
        success: false,
        error: 'اكتب وصف المناسبة أو اختر نوع الحفل والمدينة والميزانية.',
        aiAvailable: !keyMissing,
        catalogSize: cards.length,
        bundles: [],
      });
    }

    const attachServices = (bundles: typeof fallback) =>
      bundles.map((bundle) => ({
        ...bundle,
        services: bundle.serviceIds
          .map((id) => cards.find((item) => item.id === id))
          .filter(Boolean)
          .map((item) => ({
            id: item!.id,
            title: item!.title,
            category: item!.category,
            categoryName: item!.categoryName,
            price: item!.price,
            cities: item!.cities,
            shortDesc: item!.shortDesc,
            providerName: item!.providerName,
          })),
      }));

    if (keyMissing) {
      return res.json({
        success: true,
        aiAvailable: false,
        aiGenerated: false,
        catalogSize: cards.length,
        error:
          'ما فيه مزود ذكاء مُعد على الخادم (Gemini أو Claude أو OpenAI). أضف المفتاح من لوحة الإدارة › تكاملات ومفاتيح API. لم نختلق مورّداً ثانياً — هذه باقات من الكتالوج الحي حتى يعمل الزر.',
        summary: input.brief
          ? `مطابقة كتالوج لوصفك: ${input.brief.slice(0, 120)}`
          : `مطابقة كتالوج لـ ${input.occasion || 'المناسبة'} في ${input.city || 'مدن يوصل'}.`,
        bundles: attachServices(fallback),
      });
    }

    try {
      const ai = getTextClient();
      if (!ai) {
        return res.json({
          success: true,
          aiAvailable: false,
          aiGenerated: false,
          catalogSize: cards.length,
          error: 'تعذر تهيئة مزود الذكاء. عُرضت باقات من الكتالوج الحي.',
          summary: 'مطابقة كتالوج مباشرة',
          bundles: attachServices(fallback),
        });
      }

      const prompt = `أنت مستشار توريد مناسبات في منصة يوصل السعودية (Usil). لا تقل أصيل أو مضياف أو Aseel. اسمك يوصل.
اختر فقط معرفات من الكتالوج التالي (لا تخترع خدمة):
${compactCatalogForPrompt(cards)}

طلب العميل:
- الوصف: ${input.brief || 'غير مذكور'}
- المناسبة: ${input.occasion || 'غير محددة'}
- المدينة: ${input.city || 'جميع المدن'}
- الميزانية التقريبية بالريال: ${input.budget || 'غير محددة'}
- الضيوف: ${input.guests || 'غير محدد'}

أرجع JSON فقط:
{
  "summary": "فقرة عربية قصيرة تطابق المورّدين مع الطلب",
  "bundles": [
    {
      "title": "اسم الباقة بالعربي",
      "badge": "وسم قصير",
      "description": "لماذا هذه الباقة تناسب الطلب",
      "serviceIds": ["id-من-الكتالوج", "id-آخر"]
    }
  ]
}
مطلوب 2 أو 3 باقات. كل باقة خدمتان إلى أربع من فئات مختلفة. التزم بالمدينة إن وُجدت.`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: prompt,
        config: { responseMimeType: 'application/json' },
      });
      let parsed: { summary?: string; bundles?: Array<{ title?: string; badge?: string; description?: string; serviceIds?: string[] }> } = {};
      try {
        parsed = JSON.parse(response.text || '{}');
      } catch {
        parsed = {};
      }
      const hydrated = hydrateBundleIds(parsed.bundles || [], cards);
      const bundles = hydrated.length >= 2 ? hydrated : fallback;
      return res.json({
        success: true,
        aiAvailable: true,
        aiGenerated: hydrated.length >= 2,
        catalogSize: cards.length,
        summary: parsed.summary || 'مطابقة ذكية من كتالوج يوصل الحي.',
        bundles: attachServices(bundles),
      });
    } catch (error) {
      console.error('Error matching packages with Gemini:', error);
      return res.json({
        success: true,
        aiAvailable: true,
        aiGenerated: false,
        catalogSize: cards.length,
        error: 'تعذر الاتصال بمزود الذكاء الآن. عُرضت باقات من الكتالوج الحي حتى لا يبقى الزر فارغاً.',
        summary: 'مطابقة كتالوج بعد تعذر مزود الذكاء',
        bundles: attachServices(fallback),
      });
    }
  });
}
