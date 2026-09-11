const STOCK_HOST_RE =
  /unsplash\.com|images\.unsplash|plus\.unsplash|picsum\.photos|loremflickr\.com|placeholder\.com|placehold\.it|placehold\.co|via\.placeholder|dummyimage\.com|placekitten\.com|pravatar\.cc|i\.pravatar|randomuser\.me|uifaces\.co|cloudinary\.com\/demo/i;

export function isStockMediaUrl(url?: string | null): boolean {
  const value = String(url || '').trim();
  if (!value) return false;
  if (STOCK_HOST_RE.test(value)) return true;
  if (/^https?:\/\//i.test(value) && /(placeholder|stock[-_]?photo|dummy[-_]?img)/i.test(value)) {
    return true;
  }
  return false;
}

export function isAllowedListingImage(url?: string | null): boolean {
  const value = String(url || '').trim();
  if (!value) return false;
  if (isStockMediaUrl(value)) return false;
  if (value.startsWith('/uploads/')) return true;
  if (value.startsWith('data:image/')) return true;
  return false;
}

export function keepRealImages(urls: unknown): string[] {
  if (!Array.isArray(urls)) return [];
  return urls.map((item) => String(item || '').trim()).filter(isAllowedListingImage);
}

export function hasCheckoutPrice(price: unknown): boolean {
  const n = Number(price);
  return Number.isFinite(n) && n > 0;
}

/** Marketplace cards need a real vendor photo and a checkout price — no branded placeholders. */
export function listingPhotoUrls(item: {
  image?: string;
  images?: string[];
  galleryImages?: string[];
}): string[] {
  return keepRealImages([item.image, ...(item.images || []), ...(item.galleryImages || [])]);
}

export function isPublicMarketplaceListing(item: {
  price?: unknown;
  image?: string;
  images?: string[];
  galleryImages?: string[];
}): boolean {
  return hasCheckoutPrice(item.price) && listingPhotoUrls(item).length > 0;
}

/** Seed catalog is not a Moyasar amount. Clear prices and photos so checkout waits for a real vendor listing. */
export function stripCatalogCommerce<T extends {
  price?: number;
  image?: string;
  images?: string[];
  galleryImages?: string[];
  provider?: { avatar?: string };
}>(item: T): T {
  return {
    ...item,
    price: 0,
    image: '',
    images: [],
    galleryImages: undefined,
    provider: item.provider
      ? {
          ...item.provider,
          avatar: undefined,
        }
      : item.provider,
  };
}

export function stripStockServiceMedia<T extends {
  image?: string;
  images?: string[];
  galleryImages?: string[];
  provider?: { avatar?: string };
}>(item: T): T {
  const image = isAllowedListingImage(item.image) ? String(item.image) : '';
  const galleryImages = keepRealImages(item.galleryImages);
  const images = keepRealImages(item.images);
  const avatar = item.provider?.avatar;
  return {
    ...item,
    image,
    galleryImages: galleryImages.length ? galleryImages : undefined,
    images: images.length ? images : item.images ? [] : item.images,
    provider: item.provider
      ? {
          ...item.provider,
          avatar: isAllowedListingImage(avatar) ? avatar : undefined,
        }
      : item.provider,
  };
}
