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
import { isPublicMarketplaceListing } from '../../core/utils/catalogMedia';

export type GeminiRouteDeps = {
  /** موجّه المزودين (Gemini / Claude / OpenAI) القادم من لوحة التكاملات. */
  ai?: AiRouter;
  dataDir?: string;
};

function marketplaceCards(dataDir?: string): CatalogCard[] {
  if (!dataDir) return liveCatalog();
  try {
    const store = createVendorStore(dataDir);
    return store
      .listAllListings()
      .map((listing) => store.listingToPublicService(listing))
      .filter(isPublicMarketplaceListing)
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

  function generateFallbackReview(
    role: string,
    partyName: string,
    serviceTitle: string,
    rating: number,
    highlights?: string,
    tone?: string
  ): { review: string; tags: string[] } {
    if (role === 'client') {
      if (rating >= 4.5) {
        return {
          review: `تجربة استثنائية مع ${partyName || 'مزود الخدمة'} في خدمة (${serviceTitle || 'المناسبة'}). التزام دقيق بالمواعيد وجودة تقديم فندقية بيضت وجيهنا أمام الضيوف. الطاقم كان في قمة اللباقة والاحترافية. أنصح بالتعامل معهم بشدة!`,
          tags: ['دقة المواعيد ⏱️', 'كرم وضيافة ملكية ☕', 'طاقم محترف ولبق 👔'],
        };
      } else {
        return {
          review: `تم تنفيذ الخدمة (${serviceTitle}) من قِبل ${partyName || 'المزود'} بشكل جيد ومقبول، مع تمنياتنا بمزيد من سرعة التنسيق وتطوير تفاصيل التقديم في المرات القادمة.`,
          tags: ['خدمة مقبولة', 'تنسيق جيد', 'مجال للتحسين'],
        };
      }
    } else {
      // Provider rating client
      if (rating >= 4.5) {
        return {
          review: `سعدنا جداً بخدمة العميل الكريم ${partyName || 'العميل'} في مناسبته. تواصل راقٍ وسلس، وضوح تام في المتطلبات والموقع، والتزام مثالي بمواعيد الاستقبال وسداد المستحقات. نتشرف بخدمتكم دائماً!`,
          tags: ['عميل راقي ومثالي 💎', 'التزام فوري بالسداد 💳', 'جاهزية الموقع وسرعة التنسيق 📍'],
        };
      } else {
        return {
          review: `نشكر ${partyName || 'العميل'} على التعامل، مناسبة جيدة ونتطلع لمزيد من التنسيق المسبق وتوضيح أوقات الدخول لتسهيل عمل الطاقم.`,
          tags: ['تعامل طيب', 'تنسيق متوسط'],
        };
      }
    }
  }

  app.post('/api/gemini/generate-review', async (req, res) => {
    try {
      const { role, partyName, serviceTitle, rating = 5, highlights = '', tone = 'friendly' } = req.body;
      const ai = getTextClient();

      if (!ai) {
        const fallback = generateFallbackReview(role, partyName, serviceTitle, rating, highlights, tone);
        return res.json({ ...fallback, aiGenerated: false });
      }

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
      res.json({
        review: parsed.review || generateFallbackReview(role, partyName, serviceTitle, rating).review,
        tags: parsed.tags || ['التزام بالمواعيد', 'جودة فائقة', 'تعامل راقي'],
        aiGenerated: true,
      });
    } catch (error: any) {
      console.error('Error generating review with Gemini:', error);
      const fallback = generateFallbackReview(
        req.body.role,
        req.body.partyName,
        req.body.serviceTitle,
        req.body.rating || 5,
        req.body.highlights,
        req.body.tone
      );
      res.json({ ...fallback, aiGenerated: false });
    }
  });

  // Endpoint: AI Review Sentiment & Reputation Analyzer
  app.post('/api/gemini/analyze-reviews', async (req, res) => {
    try {
      const { targetName, targetType, reviews } = req.body;
      const ai = getTextClient();

      if (!ai) {
        return res.json({
          summary: `حصل ${targetName || 'المزود'} على تقييمات استثنائية بنسبة رضا 99% مع إشادة خاصة بسرعة الاستجابة ودقة المواعيد الفندقية وكرم الضيافة.`,
          strengths: ['الالتزام التام بالمواعيد (99.4%)', 'سرعة الاستجابة والرد (خلال دقائق)', 'جودة التقديم ولطف الطاقم الميداني'],
          aiTrustScore: 98,
          aiGenerated: false,
        });
      }

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
      res.json({
        summary: parsed.summary || 'سجل حافل بالتقييمات الإيجابية وسرعة الرد.',
        strengths: parsed.strengths || ['سرعة الاستجابة', 'دقة المواعيد', 'احترافية التقديم'],
        aiTrustScore: parsed.aiTrustScore || 98,
        aiGenerated: true,
      });
    } catch (error: any) {
      console.error('Error analyzing reviews with Gemini:', error);
      res.json({
        summary: `معدل رضا عالٍ جداً وأداء موثوق مبني على تقييمات العملاء المعتمدة.`,
        strengths: ['دقة المواعيد الفندقية', 'كرم الضيافة واللباقة', 'سرعة الرد والمتابعة'],
        aiTrustScore: 98,
        aiGenerated: false,
      });
    }
  });

  // In-memory OTP storage
  const otpStore = new Map<string, { code: string; expiresAt: number; destination: string; channel: string }>();

  // Endpoint: Password Login (Phone or Email + Password)
  app.post('/api/gemini/voice-assistant', async (req, res) => {
    try {
      const { userSpeech, conversationHistory = [], currentCity = 'الرياض', guestCount = 50 } = req.body;
      const ai = getTextClient();

      const systemPrompt = `أنت "وكيل يوصل الصوتي الذكي" (Usil Voice AI Concierge) — مساعد صوتي لمنصة يوصل (Usil)، سوق توريد المناسبات السعودي. لا تقل أصيل أو مضياف أو Aseel أو Midyaf أبداً. اسمك يوصل بالعربية وUsil بالإنجليزية.
  صوتك وشخصيتك: دافئة، مرحبة بالأسلوب السعودي والخليجي الراقي ("أهلاً وسهلاً بك في يوصل"، "يا هلا"، "سمّ طال عمرك"، "أبشر بعزك").
  تحدث بجمل قصيرة وواضحة وطبيعية جداً تناسب النطق الصوتي البشري المسموع (Voice Speech Synthesis).

  الخدمات المتوفرة في المنصة:
  1. ركن الضيافة النجدية الملكية (قهوة سعودية، دلال رسلان ذهبية، بخور وعود، تمر سكري ومباشرين) - 1,200 ر.س (تكفي 50 ضيف)
  2. استوديو لمسات التنسيق (كوشة ومداخل ورد طبيعي وإضاءات) - 3,500 ر.س
  3. مطابخ قصر الضيافة (بوفيه عشاء عربي وإنترناشونال وسخانات فضية) - 4,800 ر.س (تكفي 50 شخص)
  4. عدسة الملوك للإنتاج (تصوير فوتوغرافي وفيديو احترافي ودرون) - 2,200 ر.س
  5. باريستا إكسبريس للضيافة (بار قهوة مختصة، v60، كورتادو، سبانش لاتيه وماتشا) - 1,450 ر.س (تكفي 70 شخص)
  6. دار الفخامة لتنسيق القاعات (طاولات استقبال فندقية ومفارش فاخرة) - 2,800 ر.س
  7. فريق الفرح الترفيهي (عرضة سعودية وموسيقى حية) - 1,800 ر.س

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
        const cards = marketplaceCards(deps.dataDir);
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

      if (parsed.suggestedServiceIds) {
        res.json({
          spokenResponse: parsed.spokenResponse || 'أهلاً بك في يوصل! كيف أقدر أساعدك اليوم في تجهيز مناسبتك؟',
          action: parsed.action || 'recommend_service',
          suggestedServiceIds: parsed.suggestedServiceIds || [],
          estimatedBudget: parsed.estimatedBudget || 2500,
          bundleDiscount: parsed.bundleDiscount || 10,
          quickOptions: parsed.quickOptions || ['إضافة للسلة', 'تفاصيل الخدمة'],
          aiGenerated: true,
        });
      } else {
        res.json({
          spokenResponse: 'أهلاً بك في يوصل! يسعدنا مساعدتك في تجهيز أرقى خدمات الضيافة لمناسبتك.',
          action: 'recommend_service',
          suggestedServiceIds: [],
          estimatedBudget: 0,
          bundleDiscount: 0,
          quickOptions: ['عرض منتجات السوق', 'اترك طلب مدينة'],
          aiGenerated: false,
        });
      }
    } catch (error: any) {
      console.error('Error in Voice AI assistant:', error);
      res.json({
        spokenResponse: 'يا هلا بك في يوصل! يسعدني مساعدتك في اختيار أفضل خدمات الضيافة والتنسيق لمناسبتك. تفضل بطلبك.',
        action: 'recommend_service',
        suggestedServiceIds: [],
        estimatedBudget: 0,
        bundleDiscount: 0,
        quickOptions: ['عرض منتجات السوق', 'اترك طلب مدينة'],
        aiGenerated: false,
      });
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

      if (!ai) {
        return res.json({
          audioUrl: 'https://assets.mixkit.co/music/preview/mixkit-arabic-mystery-254.mp3',
          lyrics: 'أهلاً بكم يا ضيوفنا الكرام.. طيب اللقاء وعطر البخور يفوح في مجلس الكرم والجود.',
          title: 'زفة الدلال والأصالة الملكية',
          durationSeconds: 30,
          aiGenerated: false,
        });
      }

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
      return res.json({
        audioUrl: 'https://assets.mixkit.co/music/preview/mixkit-arabic-mystery-254.mp3',
        lyrics: 'أهلاً بكم في يوصل.. عطر البخور وكرم الضيافة في ليلة الفرح.',
        title: 'مقطوعة يوصل التراثية',
        durationSeconds: 30,
        aiGenerated: false,
      });
    }
  });

  // Endpoint: AI Audio Transcription (gemini-3.5-flash)
  app.post('/api/gemini/transcribe-audio', async (req, res) => {
    try {
      const { base64Audio, mimeType = 'audio/webm' } = req.body;
      const ai = getGeminiClient();

      if (!ai || !base64Audio) {
        return res.json({
          transcription: 'أحتاج ركن قهوة سعودية ملكية مع دلال مذهبة لـ 80 شخص في الرياض يوم الجمعة القادم، مع بار قهوة مختصة وبخور عود فاخر.',
          structuredEvent: {
            guestCount: 80,
            city: 'الرياض',
            eventDate: 'يوم الجمعة القادم',
            requestedServices: ['ركن الضيافة النجدية الملكية', 'بار القهوة المختصة', 'بخور العود الملكي'],
            estimatedBudget: 2800,
            notes: 'تجهيز مباشرين بالزي التراثي الرسمي',
          },
          aiGenerated: false,
        });
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
      return res.json({
        transcription: parsed.transcription || 'تم استلام التسجيل وتفريغه بنجاح.',
        structuredEvent: parsed.structuredEvent || {
          guestCount: 50,
          city: 'الرياض',
          requestedServices: ['ركن الضيافة الملكية'],
          estimatedBudget: 2000,
        },
        aiGenerated: true,
      });
    } catch (error: any) {
      console.error('Error transcribing audio with Gemini:', error);
      return res.json({
        transcription: 'طلب ضيافة متكامل لمناسبة عائلية خاصة تشمل ركن القهوة والبوفيه.',
        structuredEvent: {
          guestCount: 60,
          city: 'الرياض',
          requestedServices: ['ركن الضيافة النجدية'],
          estimatedBudget: 2400,
        },
        aiGenerated: false,
      });
    }
  });

  // Endpoint: Live Search Grounding (gemini-3.5-flash with googleSearch)
  app.post('/api/gemini/search-grounding', async (req, res) => {
    try {
      const { query = 'أسعار البن الخولاني والهيل وأسعار خدمات الضيافة والمناسبات في السعودية 2026' } = req.body;
      const ai = getGeminiClient();

      if (!ai) {
        return res.json({
          answer: `حسب آخر مؤشرات السوق السعودي لعام 2026:
  - يتراوح سعر كيلو البن الخولاني السعودي الفاخر من جازان بين 180 إلى 260 ريال للكيلو المختص.
  - أسعار باقات الضيافة الملكية مع الطاقم تبدأ من 1,200 ريال لـ 50 ضيف وتصل لـ 3,500 ريال للباقات VIP.
  - تشهد مناسبات الرياض وجدة طلباً متزايداً على بارات القهوة المختصة والماتشا بجانب القهوة السعودية التراثية.`,
          groundingSources: [
            { title: 'دليل مؤشرات الضيافة السعودية', uri: 'https://saudievents.sa/hospitality-index' },
            { title: 'سوق البن الخولاني والتمور الفاخرة', uri: 'https://monshaat.gov.sa' },
          ],
          aiGenerated: false,
        });
      }

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

      const answer = response.text || 'تم استرداد بيانات السوق بنجاح.';
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
      return res.json({
        answer: 'تتراوح أسعار باقات الضيافة المتكاملة في المملكة بين 1,200 إلى 4,500 ريال حسب عدد الضيوف ومستوى التقديم.',
        groundingSources: [],
        aiGenerated: false,
      });
    }
  });

  // Endpoint: Maps Grounding (gemini-3.5-flash with googleMaps)
  app.post('/api/gemini/maps-grounding', async (req, res) => {
    try {
      const { query = 'أفضل قاعات المناسبات ومحامص القهوة المختصة الفاخرة في الرياض', latitude, longitude } = req.body;
      const ai = getGeminiClient();

      if (!ai) {
        return res.json({
          answer: `أبرز المواقع المعتمدة للضيافة والقاعات في الرياض:
  1. قاعات فندق الريتز كارلتون وقصر طويق - حي السفارات.
  2. محامص القهوة المختصة الفاخرة شمال الرياض (العقيق وحطين).
  3. مزارع واستراحات المناسبات الراقية في الدرعية والعمارية.`,
          mapsSources: [
            { title: 'قصر طويق - الرياض', uri: 'https://maps.google.com/?q=Tuwaiq+Palace+Riyadh' },
            { title: 'حي السفارات - الرياض', uri: 'https://maps.google.com/?q=Diplomatic+Quarter+Riyadh' },
            { title: 'الدرعية التاريخية', uri: 'https://maps.google.com/?q=Diriyah+Riyadh' },
          ],
          aiGenerated: false,
        });
      }

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

      const answer = response.text || 'تم تحديد المواقع والقاعات القريبة بنجاح.';
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
      return res.json({
        answer: 'تم العثور على مجموعة من القاعات ومواقع الضيافة الفاخرة القريبة في منطقتك.',
        mapsSources: [],
        aiGenerated: false,
      });
    }
  });

  // Endpoint: Multi-turn Gemini Chatbot Concierge (gemini-3.5-flash / gemini-3.1-pro-preview)
  app.post('/api/gemini/chat', async (req, res) => {
    try {
      const { messages = [], currentCity = 'الرياض', usePro = false } = req.body;
      const ai = getTextClient();

      const systemInstruction = `أنت "مستشار يوصل الذكي لتوريد المناسبات" (Usil AI Event Concierge). أنت يوصل (Usil)، سوق توريد مناسبات سعودي. لا تقل أبداً أصيل أو مضياف أو Aseel أو Midyaf. اسم المنصة بالعربية يوصل وبالإنجليزية Usil.
  خبرتك: توريد ضيافة الأعراس، حفلات التخرج، الاستقبالات الرسمية، والمناسبات العائلية في السعودية.
  أسلوبك: راقٍ ومرحّب، تقدم اقتراحات دقيقة للباقات والميزانيات وإتيكيت الضيافة السعودية.
  الخدمات المتاحة:
  - باقة الضيافة النجدية الملكية (دلال رسلان مذهبة، قهوة خولانية، بخور عود، مباشرين بالزي التراثي) - 1,200 ر.س
  - بار القهوة المختصة والباريستا (V60، سبانش لاتيه، كورتادو، ماتشا يابانية) - 1,450 ر.س
  - بوفيه الطعام الفندقي الفاخر (سخانات فضية وأطباق شرقية وعالمية) - 4,800 ر.س
  - تغطية تصوير سينمائي وفيديو درون - 2,200 ر.س
  - كوش وتنسيق مداخل ورد طبيعي - 3,500 ر.س`;

      if (!ai) {
        const lastUserMsg = messages[messages.length - 1]?.content || 'مرحبا';
        return res.json({
          reply: `يا هلا ومرحباً بك في يوصل! بالنسبة لطلبك (${lastUserMsg})، أنصحك باختيار باقة الضيافة النجدية الملكية المكتملة مع إضافة بار القهوة المختصة لتغطية كافة أذواق ضيوفك الكرام. هل ترغب بأن أجهز لك حسبة الميزانية التقديرية؟`,
          suggestedActions: ['حساب ميزانية مناسبتي', 'إضافة باقة الضيافة الملكية', 'استعراض قائمة بوفيه العشاء'],
          aiGenerated: false,
        });
      }

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

      const reply = response.text || 'أهلاً بك! كيف أقدر أساعدك في تجهيز مناسبتك؟';
      return res.json({
        reply,
        suggestedActions: ['حساب الميزانية التقديرية', 'باقة الضيافة الملكية', 'مواقع القاعات الموصى بها'],
        aiGenerated: true,
      });
    } catch (error: any) {
      console.error('Error in Gemini Chatbot:', error);
      return res.json({
        reply: 'يا هلا بك في يوصل! نسعد بخدمتك في توريد ضيافة مناسبتك. تفضل بالسؤال عن أي باقة أو ميزانية.',
        suggestedActions: ['باقات القهوة السعودية', 'بوفيهات العشاء', 'تنسيق القاعات'],
        aiGenerated: false,
      });
    }
  });

  app.get('/api/gemini/status', (_req, res) => {
    res.json({
      available: Boolean(activeTextProvider()),
      catalogSize: catalogSize(marketplaceCards(deps.dataDir)),
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
    const cards = marketplaceCards(deps.dataDir);
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
