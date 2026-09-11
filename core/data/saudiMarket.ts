import { FulfillmentLane, ServiceCategory, ServiceItem } from '../types';
import { resolveCatalogAvatar } from '../utils/brandedAvatar';
import { stripCatalogCommerce, stripStockServiceMedia } from '../utils/catalogMedia';

export const FULFILLMENT_IDS: FulfillmentLane[] = ['hour', 'same_day', 'tomorrow', 'instant'];

export type FulfillmentFilter = 'all' | FulfillmentLane;

export const FULFILLMENT_LANES: {
  id: FulfillmentLane;
  chip: string;
  meaning: string;
  examples: string;
}[] = [
  {
    id: 'hour',
    chip: 'يوصل ساعة',
    meaning: 'يبدأ التجهيز أو يصل خلال نحو ساعة داخل المدينة — إن كان الطاقم والمؤن قريبين.',
    examples: 'قهوجي، ضيافة خفيفة، طاقم قريب',
  },
  {
    id: 'same_day',
    chip: 'يوصل اليوم',
    meaning: 'نفس اليوم إذا طُلب قبل حد القطع نحو الساعة ٢ مساءً. ليس توصيل ربع ساعة.',
    examples: 'كراسي صغيرة، كيك، دعوات',
  },
  {
    id: 'tomorrow',
    chip: 'يوصل بكرا',
    meaning: 'اليوم التالي للتجهيز الأكبر الذي يحتاج تحميل أو طاقم إضافي.',
    examples: 'تأجير أكبر، ديكور، تصوير',
  },
  {
    id: 'instant',
    chip: 'حجز فوري',
    meaning: 'تثبيت تاريخ فوري (قفل الموعد) — القاعة أو الباقة تُحجز على التاريخ، وليست ساعيًا يتتبع على الخريطة.',
    examples: 'قاعات، استراحات، باقات بتاريخ',
  },
];

export const FULFILLMENT_FILTER_CHIPS: { id: FulfillmentFilter; chip: string }[] = [
  { id: 'all', chip: 'الكل' },
  ...FULFILLMENT_LANES.map((lane) => ({ id: lane.id, chip: lane.chip })),
];

export const FULFILLMENT_LANE_BY_ID: Record<FulfillmentLane, (typeof FULFILLMENT_LANES)[number]> =
  FULFILLMENT_LANES.reduce(
    (acc, lane) => {
      acc[lane.id] = lane;
      return acc;
    },
    {} as Record<FulfillmentLane, (typeof FULFILLMENT_LANES)[number]>,
  );

/** Category defaults so no store lane is empty. Halls lock a date; coffee is near-term. */
export function defaultFulfillmentForCategory(category: string): FulfillmentLane[] {
  switch (category) {
    case 'hospitality':
      return ['hour', 'same_day'];
    case 'servers':
      return ['hour', 'same_day'];
    case 'condolence':
      return ['hour', 'same_day'];
    case 'parking':
      return ['hour', 'same_day'];
    case 'cakes':
      return ['same_day'];
    case 'invitations':
      return ['same_day'];
    case 'rental':
      return ['same_day', 'tomorrow'];
    case 'buffet':
      return ['same_day', 'tomorrow'];
    case 'decoration':
      return ['tomorrow'];
    case 'photography':
      return ['tomorrow'];
    case 'entertainment':
      return ['tomorrow'];
    case 'av':
      return ['tomorrow'];
    case 'tents':
      return ['tomorrow'];
    case 'halls':
      return ['instant'];
    case 'zaffa':
      return ['instant'];
    default:
      return ['same_day', 'tomorrow'];
  }
}

export function normalizeFulfillment(raw: unknown, fallback: FulfillmentLane[] = ['same_day']): FulfillmentLane[] {
  const list = Array.isArray(raw) ? raw : [];
  const lanes = list.filter((item): item is FulfillmentLane =>
    FULFILLMENT_IDS.includes(item as FulfillmentLane),
  );
  return lanes.length ? Array.from(new Set(lanes)) : fallback;
}

export function serviceMatchesFulfillment(item: ServiceItem, lane: string): boolean {
  if (!lane || lane === 'all') return true;
  return (item.fulfillment || []).includes(lane as FulfillmentLane);
}

export type AudienceFilter = 'all' | 'women' | 'men' | 'family' | 'corporate';

export const AUDIENCE_OPTIONS: { id: AudienceFilter; label: string }[] = [
  { id: 'all', label: 'كل المناسبات' },
  { id: 'women', label: 'قسم نسائي' },
  { id: 'men', label: 'قسم رجالي' },
  { id: 'family', label: 'عائلي' },
  { id: 'corporate', label: 'شركات ومعارض' },
];

export const AUDIENCE_LABEL: Record<Exclude<AudienceFilter, 'all'>, string> = {
  women: 'نسائي',
  men: 'رجالي',
  family: 'عائلي',
  corporate: 'شركات',
};

export const SAUDI_SEASON = [
  { month: 'رمضان', hint: 'ضيافة استقبال وإفطار — احجز قبل أسبوعين', query: 'رمضان' },
  { month: 'العيد', hint: 'بوفيهات وكراسي وحدائق — أعلى طلب في السنة', query: 'عيد' },
  { month: 'اليوم الوطني', hint: 'ديكور أخضر وفعاليات شركات', query: 'اليوم الوطني' },
  { month: 'موسم الرياض / جدة', hint: 'مؤتمرات وضيافة تشغيل عالي', query: 'مؤتمر' },
  { month: 'التخرج', hint: 'تصوير + مدخل + ضيافة خفيفة', query: 'تخرج' },
  { month: 'موسم الأعراس', hint: 'قاعات منفصلة + بوفيه + عقد واضح', query: 'عرس' },
];

export const WHY_USIL = [
  'سعر نهائي يشمل الضريبة 15%',
  'مورّد موثّق قبل الظهور في السوق',
  'نتابع التوريد حتى يصل',
  'إذا تخلّف مورّد نتحمّل المسؤولية',
];

export const PRICE_RANGES = [
  { id: 'all', label: 'كل الأسعار' },
  { id: 'lt1000', label: 'أقل من 1,000 ر.س' },
  { id: '1k3k', label: '1,000 – 3,000 ر.س' },
  { id: '3k8k', label: '3,000 – 8,000 ر.س' },
  { id: 'gt8000', label: 'أكثر من 8,000 ر.س' },
] as const;

export type PriceRangeId = (typeof PRICE_RANGES)[number]['id'];

export function serviceMatchesPriceRange(price: number, range: string): boolean {
  if (range === 'lt1000') return price < 1000;
  if (range === '1k3k') return price >= 1000 && price <= 3000;
  if (range === '3k8k') return price >= 3000 && price <= 8000;
  if (range === 'gt8000') return price > 8000;
  return true;
}

export const OCCASION_PACKAGES = [
  {
    id: 'wedding',
    title: 'عرس',
    blurb: 'ضيافة + بوفيه + تصوير على نفس التاريخ — بدون تعارض قاعة ومورّد.',
    category: 'hospitality',
    audience: 'family' as const,
  },
  {
    id: 'graduation',
    title: 'تخرج',
    blurb: 'مدخل تصوير، ضيافة خفيفة، وتوثيق لعدد ضيوف واضح.',
    category: 'decoration',
    audience: 'family' as const,
  },
  {
    id: 'malakah',
    title: 'ملكة',
    blurb: 'ضيافة نسائية، حلويات، وتصوير قسم نساء — بدون اختلاط طاقم.',
    category: 'hospitality',
    audience: 'women' as const,
  },
  {
    id: 'corporate',
    title: 'مؤتمر / إطلاق',
    blurb: 'حجز قاعة، فاتورة شاملة الضريبة، وطاقم يصل قبل الضيوف.',
    category: 'halls',
    audience: 'corporate' as const,
  },
  {
    id: 'ramadan',
    title: 'استقبال رمضاني',
    blurb: 'قهوة وتمر وبوفيه إفطار بسعر نهائي يشمل النقل.',
    category: 'hospitality',
    audience: 'family' as const,
  },
  {
    id: 'condolence',
    title: 'عزاء',
    blurb: 'تجهيز مجلس بهدوء: كراسي وسجاد وضيافة قهوة وتمر.',
    category: 'condolence',
    audience: 'men' as const,
  },
];

export const MARKET_SOLUTIONS = [
  {
    pain: 'السعر يطلع بعد الاتفاق',
    fix: 'السعر المعروض نهائي ويشمل الضريبة والتجهيز.',
  },
  {
    pain: 'المورد يتأخر يوم الحفل',
    fix: 'تتبع من الحجز حتى نهاية المناسبة، وضمان إذا تخلّف مورّد.',
  },
  {
    pain: 'عروض واتساب غير قابلة للمقارنة',
    fix: 'بطاقات موحّدة: مدينة، سعة، إشعار مسبق، وإلغاء.',
  },
  {
    pain: 'قاعة رجال/نساء غير موضحة',
    fix: 'فلتر قسم نسائي / رجالي / عائلي / شركات.',
  },
  {
    pain: 'مورد بدون رخصة مطبخ',
    fix: 'تسجيل مورّد بمراجعة الإدارة ووثائق قبل الظهور.',
  },
  {
    pain: 'عربون وإلغاء بالكلام',
    fix: 'سياسة إلغاء مكتوبة على البطاقة وعقد من استوديو المورّد.',
  },
];

const AUDIENCE_BY_CATEGORY: Record<string, ServiceItem['audience']> = {
  hospitality: 'family',
  buffet: 'family',
  decoration: 'family',
  photography: 'family',
  entertainment: 'family',
  halls: 'corporate',
  rental: 'family',
  servers: 'family',
  av: 'corporate',
  tents: 'family',
  zaffa: 'family',
  cakes: 'family',
  invitations: 'family',
  parking: 'corporate',
  condolence: 'men',
};

const OCCASIONS_BY_CATEGORY: Record<string, string[]> = {
  hospitality: ['عرس', 'رمضان', 'عيد', 'استقبال', 'تخرج', 'ملكة', 'عزاء', 'مؤتمر'],
  buffet: ['عرس', 'تخرج', 'مؤتمر', 'عيد', 'رمضان'],
  decoration: ['عرس', 'تخرج', 'اليوم الوطني', 'ملكة'],
  photography: ['عرس', 'تخرج', 'مؤتمر', 'ملكة'],
  entertainment: ['أطفال', 'تخرج', 'عيد'],
  halls: ['مؤتمر', 'عرس', 'معرض', 'استراحة'],
  rental: ['عرس', 'عزاء', 'مؤتمر', 'عيد'],
  servers: ['عرس', 'مؤتمر', 'استقبال', 'ملكة'],
  av: ['مؤتمر', 'عرس', 'معرض', 'تخرج'],
  tents: ['عرس', 'عيد', 'استراحة', 'اليوم الوطني'],
  zaffa: ['عرس', 'ملكة'],
  cakes: ['عرس', 'ملكة', 'تخرج', 'عيد'],
  invitations: ['عرس', 'ملكة', 'تخرج', 'مؤتمر'],
  parking: ['مؤتمر', 'معرض', 'عرس'],
  condolence: ['عزاء'],
};

const HOSPITALITY_DEFAULT_TAGS = [
  'ضيافة',
  'قهوة',
  'قهوة عربية',
  'استقبال الضيوف',
];

const HOSPITALITY_DEFAULT_ALIASES = [
  'ضيافة',
  'قهوجي',
  'مباشرين',
  'hospitality',
  'coffee',
  'catering welcome',
];

const CATEGORY_DEFAULT_TAGS: Partial<Record<ServiceCategory, string[]>> = {
  hospitality: HOSPITALITY_DEFAULT_TAGS,
  rental: ['كراسي', 'طاولات', 'تأجير', 'مفارش'],
  servers: ['صبابين', 'صبابات', 'طاقم ضيافة'],
  av: ['صوت', 'إضاءة', 'شاشة', 'LED'],
  tents: ['خيمة', 'مظلات', 'خيام'],
  zaffa: ['زفة', 'فرقة شعبية', 'عرضة'],
  cakes: ['كيك', 'حلويات المناسبات'],
  invitations: ['دعوات', 'هدايا تذكارية'],
  parking: ['مواقف', 'حشود', 'تنظيم دخول'],
  condolence: ['عزاء', 'مجلس عزاء', 'تجهيز مجالس'],
  halls: ['قاعة', 'استراحة', 'حجز قاعة'],
};

const CATEGORY_DEFAULT_ALIASES: Partial<Record<ServiceCategory, string[]>> = {
  hospitality: HOSPITALITY_DEFAULT_ALIASES,
  rental: ['كراسي', 'طاولات', 'مفارش', 'سجاد', 'تأجير'],
  servers: ['صبابين', 'صبابات', 'صباب', 'طاقم ضيافة'],
  av: ['LED', 'led', 'سماعة', 'منصة', 'شاشة'],
  tents: ['خيمة', 'خيام', 'مظلة', 'مظلات'],
  zaffa: ['زفة', 'عرضة', 'فرقة شعبية'],
  cakes: ['كيك', 'كيكة', 'حلويات'],
  invitations: ['دعوات', 'دعوة', 'توزيعات', 'هدايا'],
  parking: ['مواقف', 'فاليت', 'حشود'],
  condolence: ['عزاء', 'مجلس عزاء', 'عزا'],
  halls: ['قاعة', 'قاعات', 'استراحة', 'استراحات'],
};

export const SEARCH_PLACEHOLDER = 'ابحث عن ضيافة، قاعة، كراسي…';

export const HOSPITALITY_SEARCH_CHIPS = [
  'ضيافة',
  'قهوجي',
  'قهوة عربية',
  'مباشرين',
  'تمر وقهوة',
  'بوفيه ضيافة',
  'ضيافة أفراح',
  'ضيافة رجال',
  'ضيافة نساء',
  'ضيافة ملكية',
  'ضيافة مؤتمرات',
  'شاي',
  'معمول',
  'استقبال الضيوف',
  'ضيافة متنقلة',
  'دلال قهوة',
  'فناجين',
  'ضيافة تخرج',
  'ضيافة رمضان',
  'ضيافة عزاء',
  'ضيافة ملكة',
];

/** Featured marketplace aliases — chips + datalist. */
export const CATALOG_SEARCH_CHIPS = Array.from(
  new Set([
    'قهوجي',
    'قاعة',
    'استراحة',
    'كراسي',
    'مفارش',
    'صبابين',
    'صبابات',
    'كوش',
    'زفة',
    'خيمة',
    'LED',
    'عزاء',
    'فوتوبوث',
    'كيك',
    'دعوات',
    'مواقف',
    'بوفيه',
    'شواء',
    'ضيافة ملكية',
    'فرقة شعبية',
    ...HOSPITALITY_SEARCH_CHIPS,
  ]),
);

export const CHIP_TO_CATEGORY: Record<string, string> = {
  قهوجي: 'hospitality',
  'قهوة عربية': 'hospitality',
  مباشرين: 'hospitality',
  'تمر وقهوة': 'hospitality',
  'ضيافة ملكية': 'hospitality',
  قهوة: 'hospitality',
  'ضيافة أفراح': 'hospitality',
  'ضيافة رجال': 'hospitality',
  'ضيافة نساء': 'hospitality',
  'ضيافة مؤتمرات': 'hospitality',
  'ضيافة متنقلة': 'hospitality',
  'ضيافة تخرج': 'hospitality',
  'ضيافة رمضان': 'hospitality',
  'ضيافة عزاء': 'condolence',
  'ضيافة ملكة': 'hospitality',
  ضيافة: 'hospitality',
  شاي: 'hospitality',
  معمول: 'hospitality',
  'استقبال الضيوف': 'hospitality',
  'دلال قهوة': 'hospitality',
  فناجين: 'hospitality',
  قاعة: 'halls',
  استراحة: 'halls',
  كراسي: 'rental',
  مفارش: 'rental',
  صبابين: 'servers',
  صبابات: 'servers',
  كوش: 'decoration',
  زفة: 'zaffa',
  'فرقة شعبية': 'zaffa',
  خيمة: 'tents',
  LED: 'av',
  عزاء: 'condolence',
  فوتوبوث: 'photography',
  كيك: 'cakes',
  دعوات: 'invitations',
  مواقف: 'parking',
  بوفيه: 'buffet',
  شواء: 'buffet',
};

export function categoryForSearchQuery(raw: string): string | undefined {
  const query = String(raw || '').trim();
  if (!query) return undefined;
  if (CHIP_TO_CATEGORY[query]) return CHIP_TO_CATEGORY[query];
  for (const [chip, category] of Object.entries(CHIP_TO_CATEGORY)) {
    if (query.includes(chip) || chip.includes(query)) return category;
  }
  return undefined;
}

/** Maps a typed term to catalog synonyms across the full supply graph. */
export const SEARCH_SYNONYMS: Record<string, string[]> = {
  ضيافة: ['hospitality', 'قهوة', 'قهوجي', 'مباشرين', 'استقبال'],
  hospitality: ['ضيافة', 'قهوة', 'قهوجي'],
  coffee: ['ضيافة', 'قهوة', 'قهوجي', 'hospitality'],
  'catering welcome': ['ضيافة', 'استقبال الضيوف', 'hospitality'],
  قهوجي: ['ضيافة', 'قهوة', 'مباشر', 'hospitality'],
  قهوة: ['ضيافة', 'قهوجي', 'دلال', 'فناجين', 'hospitality'],
  'قهوة عربية': ['ضيافة', 'قهوجي', 'دلال قهوة', 'hospitality'],
  مباشرين: ['ضيافة', 'قهوجي', 'مباشر', 'hospitality'],
  مباشر: ['ضيافة', 'قهوجي', 'مباشرين'],
  تمر: ['ضيافة', 'تمر وقهوة', 'قهوة'],
  'تمر وقهوة': ['ضيافة', 'تمر', 'قهوة'],
  بوفيه: ['بوفيه ضيافة', 'بوفيه حار', 'بوفيه بارد', 'catering'],
  'بوفيه ضيافة': ['ضيافة', 'بوفيه', 'معمول', 'معصوب'],
  'بوفيه حار': ['بوفيه', 'عشاء', 'سخانات'],
  'بوفيه بارد': ['بوفيه', 'كانابيه', 'مقبلات'],
  شواء: ['مشويات', 'بوفيه', 'مانقل', 'شواية'],
  مشويات: ['شواء', 'بوفيه'],
  شاي: ['ضيافة', 'قهوة', 'كرك'],
  معمول: ['ضيافة', 'معصوب', 'بوفيه ضيافة'],
  معصوب: ['ضيافة', 'معمول', 'بوفيه ضيافة'],
  دلال: ['ضيافة', 'قهوة', 'فناجين', 'قهوجي'],
  'دلال قهوة': ['ضيافة', 'قهوة', 'فناجين'],
  فناجين: ['ضيافة', 'قهوة', 'دلال'],
  استقبال: ['ضيافة', 'استقبال الضيوف'],
  'استقبال الضيوف': ['ضيافة', 'استقبال'],
  'ضيافة أفراح': ['ضيافة', 'عرس'],
  'ضيافة رجال': ['ضيافة', 'رجالي', 'مجلس'],
  'ضيافة نساء': ['ضيافة', 'نسائي'],
  'ضيافة ملكية': ['ضيافة', 'قهوة', 'بروتوكول'],
  'ضيافة مؤتمرات': ['ضيافة', 'مؤتمر', 'قاعات'],
  'ضيافة متنقلة': ['ضيافة', 'قهوجي', 'coffee'],
  'ضيافة تخرج': ['ضيافة', 'تخرج'],
  'ضيافة رمضان': ['ضيافة', 'رمضان', 'تمر وقهوة'],
  'ضيافة عزاء': ['ضيافة', 'عزاء', 'مجلس عزاء'],
  'ضيافة ملكة': ['ضيافة', 'ملكة'],
  'ضيافة قاعات': ['ضيافة', 'قاعات', 'مؤتمر'],
  قاعة: ['قاعات', 'حجز قاعة', 'صالة', 'استراحة'],
  قاعات: ['قاعة', 'حجز قاعة', 'صالة'],
  'حجز قاعة': ['قاعة', 'قاعات', 'استراحة'],
  صالة: ['قاعة', 'قاعات'],
  استراحة: ['استراحات', 'شاليه', 'قاعة'],
  استراحات: ['استراحة', 'شاليه'],
  شاليه: ['استراحة', 'استراحات'],
  كراسي: ['كرسي', 'تأجير كراسي', 'طاولات', 'نابليون'],
  كرسي: ['كراسي', 'تأجير'],
  طاولات: ['طاولة', 'كراسي', 'مفارش'],
  طاولة: ['طاولات'],
  مفارش: ['مفرش', 'طاولات', 'تأجير'],
  مفرش: ['مفارش'],
  سجاد: ['سجادة', 'كراسي', 'مجلس'],
  تأجير: ['كراسي', 'طاولات', 'مفارش'],
  نابليون: ['كراسي', 'تأجير كراسي'],
  صبابين: ['صباب', 'طاقم ضيافة', 'مباشرين', 'خدمة تقديم'],
  صباب: ['صبابين', 'طاقم ضيافة'],
  صبابات: ['صبابة', 'طاقم ضيافة', 'مضيفات'],
  صبابة: ['صبابات', 'مضيفات'],
  'طاقم ضيافة': ['صبابين', 'صبابات', 'مباشرين'],
  مضيفات: ['صبابات', 'ضيافة نساء'],
  كوش: ['كوشة', 'ديكور', 'ورود', 'ثيم'],
  كوشة: ['كوش', 'ديكور', 'ورود'],
  ورود: ['ورد', 'كوش', 'تنسيق'],
  ثيم: ['ديكور', 'كوش', 'تنسيق'],
  ديكور: ['تنسيق', 'كوش', 'ورود'],
  تنسيق: ['ديكور', 'كوش'],
  زفة: ['زفة عريس', 'فرقة شعبية', 'عرضة', 'طبول'],
  'زفة عريس': ['زفة', 'عرضة'],
  'فرقة شعبية': ['زفة', 'عرضة', 'فنون شعبية'],
  عرضة: ['زفة', 'فرقة شعبية'],
  طبول: ['زفة', 'زفة نسائية'],
  خيمة: ['خيام', 'مظلات', 'خيمة شعر'],
  خيام: ['خيمة', 'مظلات'],
  'خيمة شعر': ['خيمة', 'خيام', 'تراث'],
  مظلات: ['مظلة', 'خيمة', 'تند'],
  مظلة: ['مظلات'],
  LED: ['led', 'شاشة', 'شاشة LED', 'إضاءة'],
  led: ['LED', 'شاشة', 'شاشة LED'],
  شاشة: ['LED', 'led', 'بروجكتر'],
  'شاشة LED': ['LED', 'شاشة'],
  سماعة: ['سماعات', 'صوت', 'مايك'],
  سماعات: ['سماعة', 'صوت', 'منصة'],
  منصة: ['مسرح', 'صوت', 'إضاءة'],
  إضاءة: ['إنارة', 'سبوت', 'LED'],
  عزاء: ['مجلس عزاء', 'عزا', 'تجهيز مجالس', 'ضيافة عزاء'],
  عزا: ['عزاء', 'مجلس عزاء'],
  'مجلس عزاء': ['عزاء', 'تجهيز مجالس'],
  'تجهيز مجالس': ['عزاء', 'مجلس عزاء', 'كراسي'],
  فوتوبوث: ['تصوير', 'كشك تصوير', 'صور فورية'],
  تصوير: ['فوتو', 'فيديو', 'فوتوبوث'],
  فوتو: ['تصوير', 'فيديو'],
  فيديو: ['تصوير', 'توثيق'],
  كيك: ['كيكة', 'كيكات', 'حلويات', 'تورتة'],
  كيكة: ['كيك', 'حلويات'],
  حلويات: ['كيك', 'حلا', 'حلويات المناسبات'],
  'حلويات المناسبات': ['كيك', 'حلا', 'ملكة'],
  دعوات: ['دعوة', 'بطاقة دعوة', 'هدايا تذكارية'],
  دعوة: ['دعوات'],
  توزيعات: ['هدايا تذكارية', 'هدايا'],
  'هدايا تذكارية': ['توزيعات', 'هدايا', 'دعوات'],
  مواقف: ['موقف', 'فاليت', 'حشود', 'تنظيم دخول'],
  فاليت: ['مواقف', 'صف سيارات'],
  حشود: ['مواقف', 'تنظيم دخول', 'أمن مناسبات'],
  'تنظيم دخول': ['حشود', 'مواقف'],
};

const HOSPITALITY_MARKERS = [
  'ضيافة',
  'hospitality',
  'قهوجي',
  'قهوة',
  'coffee',
  'مباشرين',
  'مباشر',
  'تمر',
  'catering welcome',
  'قهوة عربية',
  'دلال',
  'فناجين',
  'استقبال',
  'معمول',
  'معصوب',
  'شاي',
];

const CATEGORY_SEARCH_MARKERS: Partial<Record<ServiceCategory, string[]>> = {
  hospitality: HOSPITALITY_MARKERS,
  rental: ['كراسي', 'كرسي', 'طاولات', 'طاولة', 'مفارش', 'مفرش', 'سجاد', 'تأجير', 'نابليون'],
  servers: ['صبابين', 'صباب', 'صبابات', 'صبابة', 'طاقم ضيافة'],
  av: ['led', 'شاشة', 'سماعة', 'سماعات', 'منصة', 'إضاءة'],
  tents: ['خيمة', 'خيام', 'مظلة', 'مظلات', 'خيمة شعر'],
  zaffa: ['زفة', 'عرضة', 'فرقة شعبية', 'طبول'],
  cakes: ['كيك', 'كيكة', 'حلويات', 'حلويات المناسبات'],
  invitations: ['دعوات', 'دعوة', 'توزيعات', 'هدايا تذكارية'],
  parking: ['مواقف', 'فاليت', 'حشود', 'تنظيم دخول'],
  condolence: ['عزاء', 'عزا', 'مجلس عزاء', 'تجهيز مجالس'],
  halls: ['قاعة', 'قاعات', 'استراحة', 'استراحات', 'حجز قاعة', 'صالة', 'شاليه'],
  buffet: ['بوفيه', 'شواء', 'مشويات', 'بوفيه حار', 'بوفيه بارد'],
  decoration: ['كوش', 'كوشة', 'ورود', 'ثيم', 'ديكور'],
  photography: ['فوتوبوث', 'تصوير', 'فوتو', 'فيديو'],
  entertainment: ['ألعاب', 'ترفيه', 'مسابقات', 'أطفال'],
};

function normalizeSearch(value: string): string {
  return value.toLowerCase().trim();
}

export function expandSearchTerms(query: string): string[] {
  const q = normalizeSearch(query);
  if (!q) return [];
  const terms = new Set<string>([q]);
  for (const [key, mapped] of Object.entries(SEARCH_SYNONYMS)) {
    const k = normalizeSearch(key);
    if (k.length < 2) continue;
    if (q === k || q.includes(k) || (q.length >= 3 && k.includes(q))) {
      terms.add(k);
      mapped.forEach((alias) => terms.add(normalizeSearch(alias)));
    }
  }
  return [...terms];
}

export function isHospitalitySearchQuery(query: string): boolean {
  if (!query.trim()) return false;
  const terms = expandSearchTerms(query);
  return terms.some((term) => HOSPITALITY_MARKERS.includes(term));
}

export function serviceMatchesSearch(item: ServiceItem, query: string): boolean {
  const raw = query.trim();
  if (!raw) return true;
  const terms = expandSearchTerms(raw);
  const haystack = [
    item.title,
    item.shortDesc,
    item.fullDesc,
    item.category,
    item.categoryName,
    item.provider.name,
    item.audience ? AUDIENCE_LABEL[item.audience] : '',
    ...(item.tags || []),
    ...(item.aliases || []),
    ...(item.occasions || []),
    ...(item.features || []),
    ...(item.includes || []),
    ...(item.fulfillment || []).map((lane) => FULFILLMENT_LANE_BY_ID[lane]?.chip || lane),
  ]
    .join(' · ')
    .toLowerCase();

  for (const [category, markers] of Object.entries(CATEGORY_SEARCH_MARKERS)) {
    const hit = terms.some((term) =>
      markers.some((marker) => term === normalizeSearch(marker) || term.includes(normalizeSearch(marker))),
    );
    if (hit && item.category === category) return true;
  }

  return terms.some((term) => term.length >= 2 && haystack.includes(term));
}

function withMarketplaceMetadata(service: ServiceItem): ServiceItem {
  const audience =
    service.audience ||
    AUDIENCE_BY_CATEGORY[service.category] ||
    'family';
  const defaultTags = CATEGORY_DEFAULT_TAGS[service.category] || [];
  const defaultAliases = CATEGORY_DEFAULT_ALIASES[service.category] || [];
  return {
    ...service,
    audience,
    occasions: service.occasions || OCCASIONS_BY_CATEGORY[service.category] || ['مناسبة'],
    tags: Array.from(new Set([...(service.tags || []), ...defaultTags])),
    aliases: Array.from(new Set([...(service.aliases || []), ...defaultAliases])),
    vatIncluded: service.vatIncluded !== false,
    cancellationHours: service.cancellationHours ?? 48,
    delayGuarantee: service.delayGuarantee !== false,
    licensedKitchen: service.category === 'buffet' || service.category === 'cakes'
      ? service.licensedKitchen !== false
      : service.licensedKitchen,
    fulfillment: normalizeFulfillment(
      service.fulfillment,
      defaultFulfillmentForCategory(service.category),
    ),
    provider: {
      ...service.provider,
      avatar: resolveCatalogAvatar(service.provider?.name || service.title, service.provider?.avatar),
    },
  };
}

/** Seed SKUs never carry a Moyasar amount or stock photo. */
export function enrichService(service: ServiceItem): ServiceItem {
  return stripCatalogCommerce(stripStockServiceMedia(withMarketplaceMetadata(service)));
}

/** Vendor listings keep the price and photos the vendor actually uploaded. */
export function enrichVendorService(service: ServiceItem): ServiceItem {
  return stripStockServiceMedia(withMarketplaceMetadata(service));
}

export function enrichServices(list: ServiceItem[]): ServiceItem[] {
  return list.map(enrichService);
}

export function enrichVendorServices(list: ServiceItem[]): ServiceItem[] {
  return list.map(enrichVendorService);
}
