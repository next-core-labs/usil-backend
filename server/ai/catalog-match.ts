import { SERVICES } from '../../core/data/services';
import { OCCASION_PACKAGES } from '../../core/data/saudiMarket';

export type CatalogCard = {
  id: string;
  title: string;
  category: string;
  categoryName?: string;
  price: number;
  cities: string[];
  audience?: string;
  occasions?: string[];
  tags?: string[];
  shortDesc?: string;
  providerName?: string;
};

export type MatchInput = {
  brief?: string;
  occasion?: string;
  city?: string;
  budget?: number;
  guests?: number;
};

export type MatchedBundle = {
  id: string;
  title: string;
  badge: string;
  description: string;
  serviceIds: string[];
  originalTotal: number;
  discountedTotal: number;
  savings: number;
  discountPercent: number;
};

const OCCASION_KEYWORDS: Record<string, string[]> = {
  wedding: ['عرس', 'زواج', 'زفاف', 'عريس', 'عروس'],
  graduation: ['تخرج', 'دفعة', 'حفل تخرج'],
  malakah: ['ملكة', 'خطوبة', 'عقد قران'],
  corporate: ['مؤتمر', 'شركات', 'إطلاق', 'افتتاح', 'معرض', 'اجتماع'],
  ramadan: ['رمضان', 'إفطار', 'سحور', 'استقبال رمضاني'],
  condolence: ['عزاء', 'مجلس عزاء', 'وفاة'],
  family: ['عائلي', 'عزيمة', 'مجلس', 'استقبال'],
};

const OCCASION_CATEGORIES: Record<string, string[]> = {
  wedding: ['hospitality', 'buffet', 'decoration', 'photography', 'zaffa'],
  عرس: ['hospitality', 'buffet', 'decoration', 'photography', 'zaffa'],
  graduation: ['decoration', 'photography', 'cakes', 'hospitality'],
  تخرج: ['decoration', 'photography', 'cakes', 'hospitality'],
  malakah: ['hospitality', 'cakes', 'decoration', 'photography'],
  ملكة: ['hospitality', 'cakes', 'decoration', 'photography'],
  corporate: ['halls', 'hospitality', 'av', 'photography'],
  'مؤتمر / إطلاق': ['halls', 'hospitality', 'av', 'photography'],
  ramadan: ['hospitality', 'buffet', 'servers'],
  'استقبال رمضاني': ['hospitality', 'buffet', 'servers'],
  condolence: ['condolence', 'hospitality', 'rental'],
  عزاء: ['condolence', 'hospitality', 'rental'],
};

export function liveCatalog(): CatalogCard[] {
  return SERVICES.map((item) => ({
    id: item.id,
    title: item.title,
    category: item.category,
    categoryName: item.categoryName,
    price: item.price,
    cities: item.cities || [],
    audience: item.audience,
    occasions: item.occasions,
    tags: item.tags,
    shortDesc: item.shortDesc,
    providerName: item.provider?.name,
  }));
}

export function compactCatalogForPrompt(cards: CatalogCard[] = liveCatalog()): string {
  return cards
    .map(
      (item) =>
        `${item.id} | ${item.title} | ${item.category} | ${item.price} | ${(item.cities || []).join(',')}`,
    )
    .join('\n');
}

function normalize(value: string): string {
  return (value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function occasionHints(occasion?: string, brief?: string): string[] {
  const blob = normalize(`${occasion || ''} ${brief || ''}`);
  const hints = new Set<string>();
  if (occasion) hints.add(occasion);
  for (const pack of OCCASION_PACKAGES) {
    if (blob.includes(normalize(pack.title)) || blob.includes(pack.id)) {
      hints.add(pack.title);
      hints.add(pack.category);
    }
  }
  for (const [id, words] of Object.entries(OCCASION_KEYWORDS)) {
    if (words.some((word) => blob.includes(normalize(word))) || blob.includes(id)) {
      words.forEach((word) => hints.add(word));
    }
  }
  blob
    .split(/[^\u0600-\u06FFa-z0-9]+/i)
    .filter((token) => token.length >= 3)
    .forEach((token) => hints.add(token));
  return [...hints];
}

function cityOk(item: CatalogCard, city?: string): boolean {
  if (!city || city === 'جميع المدن') return true;
  return (item.cities || []).some((c) => c === city || c.includes(city) || city.includes(c));
}

function preferredCategories(input: MatchInput): string[] {
  const blob = normalize(`${input.occasion || ''} ${input.brief || ''}`);
  const cats = new Set<string>();
  for (const [key, list] of Object.entries(OCCASION_CATEGORIES)) {
    if (blob.includes(normalize(key))) list.forEach((c) => cats.add(c));
  }
  for (const pack of OCCASION_PACKAGES) {
    if (blob.includes(normalize(pack.title)) || blob.includes(pack.id)) cats.add(pack.category);
  }
  return [...cats];
}

function scoreService(item: CatalogCard, input: MatchInput, hints: string[], preferred: string[]): number {
  let score = 8;
  const hay = normalize(
    [item.title, item.category, item.categoryName, item.shortDesc, ...(item.occasions || []), ...(item.tags || [])].join(
      ' ',
    ),
  );
  for (const hint of hints) {
    const h = normalize(hint);
    if (!h) continue;
    if (hay.includes(h)) score += h.length > 4 ? 14 : 8;
  }
  if (preferred.includes(item.category)) score += 18;
  if (input.budget && item.price <= input.budget) score += 4;
  if (input.budget && item.price > input.budget) score -= 6;
  if (item.audience === 'corporate' && /شرك|مؤتمر|إطلاق/.test(normalize(input.occasion || input.brief || ''))) {
    score += 10;
  }
  return score;
}

function bundleTotals(ids: string[], cards: CatalogCard[]): Pick<MatchedBundle, 'originalTotal' | 'discountedTotal' | 'savings' | 'discountPercent'> {
  const originalTotal = ids.reduce((sum, id) => sum + (cards.find((item) => item.id === id)?.price || 0), 0);
  const discountPercent = ids.length >= 3 ? 10 : ids.length === 2 ? 7 : 0;
  const discountedTotal = Math.round(originalTotal * (1 - discountPercent / 100));
  return {
    originalTotal,
    discountedTotal,
    savings: originalTotal - discountedTotal,
    discountPercent,
  };
}

function pickDistinct(sorted: CatalogCard[], count: number, budget: number, used: Set<string>): string[] {
  const chosen: string[] = [];
  const cats = new Set<string>();
  for (const item of sorted) {
    if (used.has(item.id) || cats.has(item.category)) continue;
    const next = chosen.concat(item.id);
    const total = next.reduce((sum, id) => sum + (sorted.find((s) => s.id === id)?.price || item.price), 0);
    if (budget > 0 && total > budget * 1.15 && chosen.length >= 2) continue;
    chosen.push(item.id);
    cats.add(item.category);
    used.add(item.id);
    if (chosen.length >= count) break;
  }
  if (chosen.length < 2) {
    for (const item of sorted) {
      if (used.has(item.id)) continue;
      chosen.push(item.id);
      used.add(item.id);
      if (chosen.length >= 2) break;
    }
  }
  return chosen;
}

export function matchBundlesFromCatalog(
  input: MatchInput,
  cards: CatalogCard[] = liveCatalog(),
): MatchedBundle[] {
  const city = input.city && input.city !== 'جميع المدن' ? input.city : undefined;
  const hints = occasionHints(input.occasion, input.brief);
  const preferred = preferredCategories(input);
  const inCity = cards.filter((item) => cityOk(item, city));
  const pool = (inCity.length ? inCity : cards)
    .map((item) => ({ item, score: scoreService(item, input, hints, preferred) }))
    .sort((a, b) => b.score - a.score || a.item.price - b.item.price)
    .map((row) => row.item);

  if (!pool.length) return [];

  const budget = Number(input.budget) > 0 ? Number(input.budget) : 8000;
  const used = new Set<string>();
  const top = pool.slice(0, 20);
  const cheapRelevant = [...top].sort((a, b) => a.price - b.price);
  const richRelevant = [...top].sort((a, b) => b.price - a.price);

  const economyIds = pickDistinct(cheapRelevant, 2, Math.max(1800, Math.min(budget * 0.55, 5500)), used);
  const balancedIds = pickDistinct(pool, 3, budget, used);
  const premiumIds = pickDistinct(richRelevant.length ? richRelevant : pool, 3, Math.max(budget, 9000), used);

  const occasionLabel = input.occasion || hints[0] || 'المناسبة';
  const cityLabel = city || 'مدن يوصل';

  const specs: Array<{ id: string; title: string; badge: string; description: string; ids: string[] }> = [
    {
      id: 'save',
      title: `باقة التوفير — ${occasionLabel}`,
      badge: 'الأقل تكلفة من الكتالوج',
      description: `خدمتان أساسيتان في ${cityLabel} ضمن الميزانية، من مورّدين حقيقيين في كتالوج يوصل.`,
      ids: economyIds,
    },
    {
      id: 'balanced',
      title: `باقة متوازنة — ${occasionLabel}`,
      badge: 'الأنسب للميزانية',
      description: `ثلاث خدمات متكاملة (ضيافة أو تجهيز وتوثيق) مطابقة لمدينتك ووصفك.`,
      ids: balancedIds,
    },
    {
      id: 'complete',
      title: `باقة متكاملة — ${occasionLabel}`,
      badge: 'أوسع تغطية',
      description: `تغطية أوسع من الكتالوج الحي (${cards.length} خدمة) مع خصم تجميع يوصل — دفع إلكتروني عبر ميسر.`,
      ids: premiumIds,
    },
  ];

  return specs
    .filter((spec) => spec.ids.length >= 2)
    .map((spec) => ({
      id: `bundle-${spec.id}`,
      title: spec.title,
      badge: spec.badge,
      description: spec.description,
      serviceIds: spec.ids,
      ...bundleTotals(spec.ids, cards),
    }))
    .slice(0, 3);
}

export function hydrateBundleIds(
  proposed: Array<{ title?: string; badge?: string; description?: string; serviceIds?: string[] }>,
  cards: CatalogCard[] = liveCatalog(),
): MatchedBundle[] {
  const byId = new Map(cards.map((item) => [item.id, item]));
  const bundles: MatchedBundle[] = [];
  for (const [index, row] of proposed.entries()) {
    const ids = (row.serviceIds || []).filter((id) => byId.has(id)).slice(0, 4);
    if (ids.length < 2) continue;
    bundles.push({
      id: `bundle-ai-${index + 1}`,
      title: row.title || `باقة مقترحة ${index + 1}`,
      badge: row.badge || 'مطابقة Gemini من الكتالوج',
      description: row.description || 'اقتراح من كتالوج يوصل الحي.',
      serviceIds: ids,
      ...bundleTotals(ids, cards),
    });
    if (bundles.length >= 3) break;
  }
  return bundles;
}

export function catalogSize(cards: CatalogCard[] = liveCatalog()): number {
  return cards.length;
}
