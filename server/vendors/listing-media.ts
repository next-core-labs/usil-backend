import crypto from 'crypto';
import { parseDataUrl, saveUpload, UPLOAD_MAX_BYTES } from '../auth/avatar';
import { LISTING_MAX_IMAGES } from './vendor-listings';
import { isStockMediaUrl } from '../../core/utils/catalogMedia';

function rawImageList(images: unknown, legacyImage?: unknown): string[] {
  const raw = Array.isArray(images) ? images : [];
  const list = raw.map((item) => String(item || '').trim());
  const legacy = String(legacyImage || '').trim();
  if (legacy) list.push(legacy);
  return list;
}

/** Content key of an inline photo, so one photo picked twice counts once; null when it isn't a usable image. */
export function dataUrlDigest(value: string): string | null {
  const parsed = parseDataUrl(value, UPLOAD_MAX_BYTES);
  return parsed ? crypto.createHash('sha256').update(parsed.buffer).digest('hex') : null;
}

/** Persist vendor photos to /uploads/listing-… — never keep Unsplash or other stock URLs. */
export function persistListingImages(dataDir: string, images: unknown, legacyImage?: unknown): string[] {
  const out: string[] = [];
  const digests = new Set<string>();
  for (const value of rawImageList(images, legacyImage)) {
    if (!value || isStockMediaUrl(value)) continue;
    if (value.startsWith('/uploads/')) {
      out.push(value);
      continue;
    }
    if (value.startsWith('data:image/')) {
      const digest = dataUrlDigest(value);
      if (!digest || digests.has(digest)) continue;
      digests.add(digest);
      const saved = saveUpload(dataDir, 'listing', value, UPLOAD_MAX_BYTES);
      if (saved) out.push(saved);
    }
  }
  return Array.from(new Set(out)).slice(0, LISTING_MAX_IMAGES);
}
