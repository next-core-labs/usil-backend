export type PlaceKind = 'region' | 'governorate' | 'city' | 'village';

export type SaudiPlace = {
  name: string;
  region: string;
  kind: PlaceKind;
  governorate?: string;
  aliases?: string[];
};

export const ALL_CITIES_LABEL = 'جميع المدن';

type RegionPack = {
  region: string;
  governorates: string[];
  towns: string[];
};

const PACKS: RegionPack[] = [
  {
    region: 'الرياض',
    governorates: [
      'الرياض', 'الدرعية', 'الخرج', 'الدوادمي', 'المجمعة', 'القويعية', 'وادي الدواسر', 'الأفلاج',
      'الزلفي', 'شقراء', 'حوطة بني تميم', 'عفيف', 'السليل', 'ضرما', 'المزاحمية', 'رماح', 'ثادق',
      'حريملاء', 'الحريق', 'الغاط', 'مرات', 'الرين',
    ],
    towns: [
      'الدلم', 'السيح', 'اليمامة', 'نعجان', 'السلمية', 'الرويضة', 'ساجر', 'نفي', 'العيينة', 'سدوس',
      'الجبيلة', 'بنبان', 'الحائر', 'ليلى', 'الخماسين', 'الصلبي', 'الحصاة', 'تمير', 'الأرطاوية',
      'حرمة', 'رغبة', 'البير', 'ملهم', 'حوطة سدير', 'الجنوبية', 'العطار', 'نعام', 'الحلوة', 'القدية',
      'البرة', 'المشاعلة', 'الغطغط', 'القصب', 'القصور',
    ],
  },
  {
    region: 'مكة المكرمة',
    governorates: [
      'مكة المكرمة', 'جدة', 'الطائف', 'القنفذة', 'الليث', 'رابغ', 'خليص', 'الكامل', 'الخرمة',
      'رنية', 'تربة', 'الجموم', 'المويه', 'ميسان', 'أضم', 'العرضيات',
    ],
    towns: [
      'ثول', 'ذهبان', 'أبحر', 'الشفا', 'الهدا', 'مستورة', 'صعبر', 'بحرة', 'عسفان', 'القوز',
      'حلي', 'البرك', 'القوزية', 'الشرائع', 'الزيمة', 'الشعيبة', 'المظيلف', 'الشواق', 'ذهبان الصناعية',
      'النوارية', 'الجموم البلد', 'خشم العان',
    ],
  },
  {
    region: 'المدينة المنورة',
    governorates: [
      'المدينة المنورة', 'ينبع', 'العلا', 'مهد الذهب', 'الحناكية', 'بدر', 'خيبر', 'العيص', 'وادي الفرع',
    ],
    towns: [
      'ينبع البحر', 'ينبع النخل', 'ينبع الصناعية', 'الرايس', 'المويح', 'الصلصلة', 'المهد',
      'العيينة النبوية', 'الحجر', 'مغيراء', 'المربع', 'الصلصلة النبوية',
    ],
  },
  {
    region: 'القصيم',
    governorates: [
      'بريدة', 'عنيزة', 'الرس', 'المذنب', 'البكيرية', 'البدائع', 'الأسياح', 'النبهانية',
      'عيون الجواء', 'رياض الخبراء', 'الشماسية', 'عقلة الصقور', 'ضرية',
    ],
    towns: ['الخبراء', 'البطين', 'قبة', 'الهدار', 'التنومة القصيم', 'الرس البلد', 'الهدية', 'دخنة'],
  },
  {
    region: 'الشرقية',
    governorates: [
      'الدمام', 'الخبر', 'الظهران', 'القطيف', 'الجبيل', 'الأحساء', 'حفر الباطن', 'رأس تنورة',
      'بقيق', 'النعيرية', 'الخفجي', 'قرية العليا', 'العديد',
    ],
    towns: [
      'الهفوف', 'المبرز', 'العيون', 'العمران', 'الجفر', 'صفوى', 'سيهات', 'عنك', 'تاروت',
      'عين دار', 'العثمانية', 'القيصومة', 'الرقعي', 'السفانية', 'القديح', 'دارين', 'سنابس',
      'الجش', 'الجبيل الصناعية', 'الراكة', 'العزيزية', 'الخبر الشمالية',
    ],
  },
  {
    region: 'عسير',
    governorates: [
      'أبها', 'خميس مشيط', 'بيشة', 'أحد رفيدة', 'ظهران الجنوب', 'النماص', 'بلقرن', 'محايل عسير',
      'رجال ألمع', 'المجاردة', 'بارق', 'تثليث', 'سراة عبيدة', 'الحرجة', 'طريب', 'تنومة',
    ],
    towns: ['السودة', 'البرك', 'الحريضة', 'القحمة', 'تهامة عسير', 'الواديين'],
  },
  {
    region: 'تبوك',
    governorates: ['تبوك', 'الوجه', 'ضباء', 'تيماء', 'أملج', 'حقل', 'حالة عمار', 'البدع'],
    towns: ['شرما', 'الشريع', 'الخريبة', 'مقنا', 'نيوم', 'حالة عمار البلد', 'الوجه البلد'],
  },
  {
    region: 'حائل',
    governorates: ['حائل', 'بقعاء', 'الغزالة', 'الشنان', 'السليمي', 'الحائط', 'موقق', 'الشملي'],
    towns: ['جبه', 'تربه حائل', 'الاجفر', 'سميراء', 'الحائط البلد', 'قفار'],
  },
  {
    region: 'الحدود الشمالية',
    governorates: ['عرعر', 'رفحاء', 'طريف', 'العويقيلة'],
    towns: ['لينة', 'شعبة نصاب', 'أم خنصر', 'جديدة عرعر'],
  },
  {
    region: 'جازان',
    governorates: [
      'جازان', 'صبيا', 'أبو عريش', 'صامطة', 'أحد المسارحة', 'بيش', 'الدرب', 'العارضة', 'الريث',
      'فرسان', 'الدائر', 'العيدابي', 'فيفا', 'هروب', 'الطوال', 'الحرث',
    ],
    towns: ['الموسم', 'الخشل', 'القياس', 'العالية', 'الشقيق', 'صامطة البلد', 'أبو عريش البلد'],
  },
  {
    region: 'نجران',
    governorates: ['نجران', 'شرورة', 'حبونا', 'بدر الجنوب', 'يدمة', 'ثار', 'خباش', 'الخرخير'],
    towns: ['القابل', 'رجلا', 'بئر عسكر', 'الخرعاء'],
  },
  {
    region: 'الباحة',
    governorates: ['الباحة', 'بلجرشي', 'المندق', 'المخواة', 'العقيق', 'قلوة', 'القرى', 'بني حسن'],
    towns: ['غامد الزناد', 'الحجرة', 'بني كبير', 'بني حسن البلد', 'المخواة البلد'],
  },
  {
    region: 'الجوف',
    governorates: ['سكاكا', 'القريات', 'دومة الجندل', 'طبرجل'],
    towns: ['صوير', 'صوير القديمة', 'النبك أبو قصر', 'أبو عجرم'],
  },
];

const LEGACY_ALIASES: Record<string, string[]> = {
  الدمام: ['الدمام والخبر'],
  الخبر: ['الدمام والخبر'],
  الظهران: ['الدمام والخبر'],
  أبها: ['أبها وخميس مشيط'],
  'خميس مشيط': ['أبها وخميس مشيط'],
  بريدة: ['القصيم'],
};

function uniquePush(list: SaudiPlace[], place: SaudiPlace, seen: Set<string>) {
  if (seen.has(place.name)) return;
  seen.add(place.name);
  list.push(place);
}

function buildPlaces(): SaudiPlace[] {
  const seen = new Set<string>();
  const places: SaudiPlace[] = [];
  for (const pack of PACKS) {
    uniquePush(places, { name: pack.region, region: pack.region, kind: 'region' }, seen);
    for (const name of pack.governorates) {
      uniquePush(
        places,
        {
          name,
          region: pack.region,
          kind: name === pack.region ? 'city' : 'governorate',
          aliases: LEGACY_ALIASES[name],
        },
        seen,
      );
    }
    for (const name of pack.towns) {
      uniquePush(places, { name, region: pack.region, kind: 'village' }, seen);
    }
  }
  uniquePush(places, { name: 'الدمام والخبر', region: 'الشرقية', kind: 'city', aliases: ['الدمام', 'الخبر', 'الظهران'] }, seen);
  uniquePush(places, { name: 'أبها وخميس مشيط', region: 'عسير', kind: 'city', aliases: ['أبها', 'خميس مشيط'] }, seen);
  return places;
}

export const SAUDI_PLACES: SaudiPlace[] = buildPlaces();
export const SAUDI_REGIONS = PACKS.map((pack) => pack.region);

/** أشهر أسواق المناسبات — تظهر أولاً في بوابة اختيار المنطقة. */
export const FEATURED_MARKET_PLACES: Array<{ name: string; blurb: string }> = [
  { name: 'الرياض', blurb: 'العاصمة' },
  { name: 'جدة', blurb: 'البحر الأحمر' },
  { name: 'الدمام', blurb: 'الشرقية' },
  { name: 'مكة المكرمة', blurb: 'الحرم' },
  { name: 'المدينة المنورة', blurb: 'الحرم النبوي' },
];

const EXTRA_ALIASES: Record<string, string[]> = {
  'مكة المكرمة': ['مكة'],
  'المدينة المنورة': ['المدينة'],
  جازان: ['جيزان'],
  الأحساء: ['الحسا'],
};

for (const place of SAUDI_PLACES) {
  const extra = EXTRA_ALIASES[place.name];
  if (extra?.length) place.aliases = [...new Set([...(place.aliases || []), ...extra])];
}

const byName = new Map<string, SaudiPlace>();
for (const place of SAUDI_PLACES) {
  byName.set(place.name, place);
}
for (const place of SAUDI_PLACES) {
  for (const alias of place.aliases || []) {
    if (!byName.has(alias)) byName.set(alias, place);
  }
}

export const PLACE_NAMES: string[] = SAUDI_PLACES.map((place) => place.name);

/** قائمة البحث في الواجهة: جميع المدن ثم كل مكان في المملكة. */
export const CITIES: string[] = [ALL_CITIES_LABEL, ...PLACE_NAMES];

export function findPlace(name: string): SaudiPlace | undefined {
  return byName.get(String(name || '').trim());
}

export function isSaudiPlaceName(name: string): boolean {
  const value = String(name || '').trim();
  if (!value || value === ALL_CITIES_LABEL) return false;
  return byName.has(value);
}

export function searchPlaces(query: string, limit = 40): SaudiPlace[] {
  const q = String(query || '').trim();
  if (!q) return SAUDI_PLACES.slice(0, limit);
  return SAUDI_PLACES.filter((place) => {
    if (place.name.includes(q) || place.region.includes(q)) return true;
    return (place.aliases || []).some((alias) => alias.includes(q));
  }).slice(0, limit);
}

function relatedNames(place: SaudiPlace): Set<string> {
  const names = new Set<string>([place.name, place.region, ...(place.aliases || [])]);
  if (place.governorate) names.add(place.governorate);
  return names;
}

/** هل تغطية المورّد تشمل المكان المختار (منطقة / محافظة / قرية). */
export function cityFilterMatches(listingCities: string[], selected: string): boolean {
  const want = String(selected || '').trim();
  if (!want || want === ALL_CITIES_LABEL) return true;
  const selectedPlace = findPlace(want);
  return (listingCities || []).some((city) => {
    const have = String(city || '').trim();
    if (!have) return false;
    if (have === want) return true;
    if (have.includes(want) || want.includes(have)) return true;
    const listingPlace = findPlace(have);
    if (!selectedPlace || !listingPlace) return false;
    if (listingPlace.name === selectedPlace.name) return true;
    if (listingPlace.kind === 'region' && selectedPlace.region === listingPlace.region) return true;
    if (selectedPlace.kind === 'region' && listingPlace.region === selectedPlace.region) return true;
    const a = relatedNames(listingPlace);
    const b = relatedNames(selectedPlace);
    for (const name of a) if (b.has(name)) return true;
    return false;
  });
}

export function placeKindLabel(kind: PlaceKind): string {
  if (kind === 'region') return 'منطقة';
  if (kind === 'governorate') return 'محافظة';
  if (kind === 'city') return 'مدينة';
  return 'قرية / مركز';
}

export function regionCoverageStats(region: string): { governorates: number; villages: number } {
  const pack = PACKS.find((item) => item.region === region);
  if (!pack) return { governorates: 0, villages: 0 };
  return { governorates: pack.governorates.length, villages: pack.towns.length };
}

export function formatRegionCoverage(region: string): string {
  const stats = regionCoverageStats(region);
  return `تغطي ${stats.governorates} محافظة و ${stats.villages} قرية ومركز`;
}

export function coveringRegion(selection: string[], name: string): string | undefined {
  const place = findPlace(name);
  if (!place) return undefined;
  for (const city of selection || []) {
    const have = findPlace(city);
    if (have?.kind === 'region' && have.region === place.region) return have.name;
  }
  return undefined;
}

/** هل اختيار المورّد يغطي هذا المكان عبر منطقة كاملة أو نفس الاسم. */
export function selectionCoversPlace(selection: string[], name: string): boolean {
  const want = String(name || '').trim();
  if (!want) return false;
  if ((selection || []).includes(want)) return true;
  if (coveringRegion(selection, want)) return true;
  const place = findPlace(want);
  return (selection || []).some((city) => {
    const listingPlace = findPlace(city);
    if (!listingPlace || !place) return false;
    const a = relatedNames(listingPlace);
    const b = relatedNames(place);
    for (const item of a) if (b.has(item)) return true;
    return false;
  });
}

export function formatSelectionCoverage(selection: string[]): string {
  const names = (selection || []).map((item) => String(item || '').trim()).filter(Boolean);
  if (!names.length) return 'ما اخترت تغطية بعد';
  return names
    .map((name) => {
      const place = findPlace(name);
      if (place?.kind === 'region') return `${name} · المنطقة كاملة`;
      return place ? `${name} · ${placeKindLabel(place.kind)}` : name;
    })
    .join('، ');
}

/** إضافة منطقة تطوي محافظاتها وقراها. مكان داخل منطقة مختارة لا يُضاف مرتين. */
export function toggleCoverage(selection: string[], name: string): string[] {
  const want = String(name || '').trim();
  if (!want || want === ALL_CITIES_LABEL) return [...(selection || [])];
  const current = Array.from(new Set((selection || []).map((item) => String(item || '').trim()).filter(Boolean)));
  if (current.includes(want)) return current.filter((item) => item !== want);

  const place = findPlace(want);
  if (place?.kind === 'region') {
    const next = current.filter((item) => {
      const other = findPlace(item);
      if (!other) return true;
      return other.region !== place.region;
    });
    return [...next, place.name];
  }
  if (selectionCoversPlace(current, want)) return current;
  return [...current, want];
}
