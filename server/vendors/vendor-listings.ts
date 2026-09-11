import type { FulfillmentLane, ServiceCategory, ServiceItem } from '../../core/types';
import { PLACE_NAMES, isSaudiPlaceName } from '../../core/data/saudiPlaces';

export const LISTING_FULFILLMENT_IDS = ['hour', 'same_day', 'tomorrow', 'instant'] as const;
export type ListingFulfillmentLane = (typeof LISTING_FULFILLMENT_IDS)[number];

export const FULFILLMENT_AR_LABEL: Record<ListingFulfillmentLane, string> = {
  hour: 'يوصل ساعة',
  same_day: 'يوصل اليوم',
  tomorrow: 'يوصل بكرا',
  instant: 'حجز فوري',
};

export const LISTING_CATEGORIES: { id: Exclude<ServiceCategory, 'all'>; name: string }[] = [
  { id: 'hospitality', name: 'ضيافة وقهوة' },
  { id: 'buffet', name: 'بوفيه ومأكولات' },
  { id: 'decoration', name: 'تنسيق وديكور' },
  { id: 'photography', name: 'تصوير وتوثيق' },
  { id: 'entertainment', name: 'ألعاب وترفيه' },
  { id: 'halls', name: 'قاعات واستراحات' },
  { id: 'rental', name: 'كراسي وطاولات وتأجير' },
  { id: 'servers', name: 'صبابين وصبابات' },
  { id: 'av', name: 'صوت وإضاءة وشاشات' },
  { id: 'tents', name: 'خيام ومظلات' },
  { id: 'zaffa', name: 'زفة وفرق شعبية' },
  { id: 'cakes', name: 'كيك وحلويات المناسبات' },
  { id: 'invitations', name: 'دعوات وهدايا تذكارية' },
  { id: 'parking', name: 'تنظيم مواقف وحشود' },
  { id: 'condolence', name: 'عزاء وتجهيز مجالس' },
];

export const LISTING_PRICE_UNITS = ['للمناسبة', 'للساعة', 'للشخص', 'لليوم', 'للوحدة'] as const;
export type ListingPriceUnit = (typeof LISTING_PRICE_UNITS)[number];

export const LISTING_CITIES = PLACE_NAMES;

const FALLBACK_IMAGE = '';

/**
 * طريقة تأكيد الحجز — مستقلة تماماً عن مسار يوصل «حجز فوري» (ذاك مسار تنفيذ/سرعة).
 * هنا نتكلم عن: هل يتأكد حجز العميل مباشرة أو ينتظر موافقة المورّد؟
 */
export const LISTING_BOOKING_MODES = ['instant', 'approval'] as const;
export type ListingBookingMode = (typeof LISTING_BOOKING_MODES)[number];
export const DEFAULT_BOOKING_MODE: ListingBookingMode = 'approval';

export const BOOKING_MODE_AR_LABEL: Record<ListingBookingMode, string> = {
  instant: 'حجز فوري',
  approval: 'بموافقة المورّد',
};

export const BOOKING_MODE_AR_HINT: Record<ListingBookingMode, string> = {
  instant: 'العميل يحجز ويتأكد مباشرة',
  approval: 'الطلب ينتظر موافقة المورّد',
};

export const BOOKING_MODE_CTA_AR: Record<ListingBookingMode, string> = {
  instant: 'احجز الآن',
  approval: 'اطلب الحجز',
};

/** حالة الحجز حين يكون المنتج «بموافقة المورّد». */
export const BOOKING_PENDING_APPROVAL_STATUS = 'بانتظار موافقة المورّد';
export const BOOKING_NEW_STATUS = 'جديد';
export const BOOKING_REJECTED_STATUS = 'مرفوض من المورّد';
export const BOOKING_MODE_REQUIRED_AR = 'اختر طريقة تأكيد الحجز: حجز فوري أو بموافقة المورّد';

export const LISTING_MIN_IMAGES = 2;
export const LISTING_MAX_IMAGES = 8;
export const LISTING_IMAGES_REQUIRED_AR = 'أضف صورتين على الأقل لكل منتج';

export type VendorListing = {
  id: string;
  vendorId: string;
  vendorName: string;
  title: string;
  category: Exclude<ServiceCategory, 'all'>;
  categoryName: string;
  shortDesc: string;
  price: number;
  priceUnit: ListingPriceUnit;
  cities: string[];
  images?: string[];
  /** Legacy single-image field, mirrored from images[0] so old cards keep working. */
  image?: string;
  fulfillment: ListingFulfillmentLane[];
  bookingMode: ListingBookingMode;
  createdAt: string;
  updatedAt: string;
};

export type VendorListingInput = {
  title?: unknown;
  category?: unknown;
  shortDesc?: unknown;
  price?: unknown;
  priceUnit?: unknown;
  cities?: unknown;
  images?: unknown;
  image?: unknown;
  fulfillment?: unknown;
  bookingMode?: unknown;
  vendorName?: unknown;
};

export type ValidateListingOptions = {
  /** POST/PATCH from the vendor modal require two images; stored rows are read leniently. */
  requireImages?: boolean;
};

export type CourierProductLine = {
  name: string;
  fulfillment: ListingFulfillmentLane[];
};

export function parseFulfillmentLanes(raw: unknown, requiredMessage: string): ListingFulfillmentLane[] {
  const list = Array.isArray(raw) ? raw : [];
  const lanes = list.filter((item): item is ListingFulfillmentLane =>
    (LISTING_FULFILLMENT_IDS as readonly string[]).includes(String(item)),
  );
  if (!lanes.length) {
    throw new Error(requiredMessage);
  }
  return Array.from(new Set(lanes));
}

export function parseOptionalFulfillmentLanes(raw: unknown): ListingFulfillmentLane[] {
  const list = Array.isArray(raw) ? raw : [];
  return Array.from(
    new Set(
      list.filter((item): item is ListingFulfillmentLane =>
        (LISTING_FULFILLMENT_IDS as readonly string[]).includes(String(item)),
      ),
    ),
  );
}

export function parseCourierProducts(raw: unknown): CourierProductLine[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      const name = String((row as { name?: unknown })?.name || '').trim();
      const fulfillment = parseOptionalFulfillmentLanes((row as { fulfillment?: unknown })?.fulfillment);
      return { name, fulfillment };
    })
    .filter((row) => row.name || row.fulfillment.length)
    .map((row) => ({
      name: row.name,
      fulfillment: row.fulfillment,
    }));
}

export function parseListingImages(images: unknown, legacyImage?: unknown): string[] {
  const raw = Array.isArray(images) ? images : [];
  const list = raw.map((item) => String(item || '').trim());
  const legacy = String(legacyImage || '').trim();
  if (legacy) list.push(legacy);
  const clean = list.filter((url) => url.startsWith('/uploads/') && !/unsplash|picsum|placeholder/i.test(url));
  return Array.from(new Set(clean)).slice(0, LISTING_MAX_IMAGES);
}

export function parseBookingMode(raw: unknown, fallback: ListingBookingMode = DEFAULT_BOOKING_MODE): ListingBookingMode {
  const value = String(raw ?? '').trim();
  return (LISTING_BOOKING_MODES as readonly string[]).includes(value) ? (value as ListingBookingMode) : fallback;
}

/** الحقل مطلوب في المودال: القيمة الغائبة تأخذ الافتراضي، والقيمة الغلط تُرفض. */
export function requireBookingMode(raw: unknown): ListingBookingMode {
  if (raw === undefined || raw === null) return DEFAULT_BOOKING_MODE;
  const value = String(raw).trim();
  if (!(LISTING_BOOKING_MODES as readonly string[]).includes(value)) {
    throw new Error(BOOKING_MODE_REQUIRED_AR);
  }
  return value as ListingBookingMode;
}

export function requiresVendorApproval(mode: unknown): boolean {
  return parseBookingMode(mode) === 'approval';
}

export function validateVendorListing(
  input: VendorListingInput,
  options: ValidateListingOptions = {},
): Omit<VendorListing, 'id' | 'vendorId' | 'createdAt' | 'updatedAt'> {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('اكتب اسم المنتج');

  const category = String(input.category || '').trim() as Exclude<ServiceCategory, 'all'>;
  const cat = LISTING_CATEGORIES.find((item) => item.id === category);
  if (!cat) throw new Error('اختر قسماً للمنتج');

  const shortDesc = String(input.shortDesc || '').trim() || title;
  const price = Number(input.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('أدخل سعراً أكبر من صفر');

  const priceUnit = (LISTING_PRICE_UNITS as readonly string[]).includes(String(input.priceUnit || ''))
    ? (input.priceUnit as ListingPriceUnit)
    : 'للمناسبة';

  const rawCities = Array.isArray(input.cities) ? input.cities.map((city) => String(city)) : [];
  const cities = rawCities.map((city) => String(city).trim()).filter((city) => isSaudiPlaceName(city));
  const resolvedCities = cities.length ? Array.from(new Set(cities)) : ['الرياض'];

  const images = parseListingImages(input.images, input.image);
  if (options.requireImages && images.length < LISTING_MIN_IMAGES) {
    throw new Error(LISTING_IMAGES_REQUIRED_AR);
  }
  const fulfillment = parseFulfillmentLanes(
    input.fulfillment,
    'اختر مساراً واحداً على الأقل في «مسار يوصل»',
  );
  const bookingMode = requireBookingMode(input.bookingMode);
  const vendorName = String(input.vendorName || '').trim() || 'مورّد يوصل';

  return {
    vendorName,
    title,
    category,
    categoryName: cat.name,
    shortDesc,
    price,
    priceUnit,
    cities: resolvedCities,
    images,
    image: images[0] || undefined,
    fulfillment,
    bookingMode,
  };
}

export function minNoticeForFulfillment(lanes: ListingFulfillmentLane[]): string {
  if (lanes.includes('hour')) return 'قبل ساعة داخل المدينة';
  if (lanes.includes('same_day')) return 'نفس اليوم إن طُلب قبل حد القطع';
  if (lanes.includes('tomorrow')) return 'قبل يوم للتجهيز';
  return 'حجز فوري للتاريخ';
}

export function listingToServiceItem(listing: VendorListing): ServiceItem {
  const images = parseListingImages(listing.images, listing.image);
  const bookingMode = parseBookingMode(listing.bookingMode);
  return {
    bookingMode,
    id: listing.id,
    title: listing.title,
    category: listing.category,
    categoryName: listing.categoryName,
    shortDesc: listing.shortDesc,
    fullDesc: listing.shortDesc,
    price: listing.price,
    priceUnit: listing.priceUnit,
    minNotice: minNoticeForFulfillment(listing.fulfillment),
    minQuantity: 1,
    cities: listing.cities,
    image: images[0] || FALLBACK_IMAGE,
    galleryImages: images.length ? images : undefined,
    rating: 0,
    reviewsCount: 0,
    features: listing.fulfillment.map((lane) => FULFILLMENT_AR_LABEL[lane]),
    includes: [],
    provider: {
      id: listing.vendorId,
      name: listing.vendorName,
      verified: false,
      rating: 0,
      completedOrders: 0,
      responseTime: 'خلال ساعات العمل',
      responseRate: '—',
    },
    fulfillment: listing.fulfillment as FulfillmentLane[],
    tags: [],
  };
}
