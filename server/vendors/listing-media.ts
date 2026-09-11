import { saveUpload, UPLOAD_MAX_BYTES } from '../auth/avatar';
import { LISTING_MAX_IMAGES } from './vendor-listings';
import { isStockMediaUrl } from '../../core/utils/catalogMedia';

function rawImageList(images: unknown, legacyImage?: unknown): string[] {
  const raw = Array.isArray(images) ? images : [];
  const list = raw.map((item) => String(item || '').trim());
  const legacy = String(legacyImage || '').trim();
  if (legacy) list.push(legacy);
  return list;
}

/** Persist vendor photos to /uploads/listing-… — never keep Unsplash or other stock URLs. */
export function persistListingImages(dataDir: string, images: unknown, legacyImage?: unknown): string[] {
  const out: string[] = [];
  for (const value of rawImageList(images, legacyImage)) {
    if (!value || isStockMediaUrl(value)) continue;
    if (value.startsWith('/uploads/')) {
      out.push(value);
      continue;
    }
    if (value.startsWith('data:image/')) {
      const saved = saveUpload(dataDir, 'listing', value, UPLOAD_MAX_BYTES);
      if (saved) out.push(saved);
    }
  }
  return Array.from(new Set(out)).slice(0, LISTING_MAX_IMAGES);
}
