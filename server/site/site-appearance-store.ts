import path from 'path';
import { readJsonFile, writeJsonFile } from '../shared/json-file.ts';

/**
 * «مظهر الواجهة» — what the owner can restyle on the storefront without a
 * deploy. Today: the three floating photo cards in the home hero.
 */

export const HERO_CARD_COUNT = 3;

export type HeroCard = {
  /** `/uploads/…` from `POST /api/uploads`; '' keeps the design photo. */
  image: string;
  /** false shows the card as a solid colour, with no photo at all. */
  showImage: boolean;
  /** Card ground: what shows while the photo loads, or the whole card without one. */
  color: string;
};

export type SiteAppearance = {
  heroCards: HeroCard[];
  updatedAt: string;
};

/** The design's grounds: navy-700, action blue, tint-blue (usil/src/index.css). */
export const DEFAULT_HERO_COLORS = ['#163A78', '#155EEF', '#DBE7FF'] as const;

export function defaultSiteAppearance(): SiteAppearance {
  return {
    heroCards: DEFAULT_HERO_COLORS.map((color) => ({ image: '', showImage: true, color })),
    updatedAt: '',
  };
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
/** Only files the server itself wrote; a pasted outside URL never reaches the home page. */
const UPLOAD_PATH = /^\/uploads\/[a-zA-Z0-9_-]+\.(?:jpg|png|webp)$/;

function sanitizeCard(input: unknown, fallback: HeroCard): HeroCard {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const image = typeof raw.image === 'string' ? raw.image.trim() : fallback.image;
  const color = typeof raw.color === 'string' ? raw.color.trim() : fallback.color;
  return {
    image: image === '' || UPLOAD_PATH.test(image) ? image : fallback.image,
    showImage: typeof raw.showImage === 'boolean' ? raw.showImage : fallback.showImage,
    color: HEX_COLOR.test(color) ? color.toUpperCase() : fallback.color,
  };
}

export function sanitizeSiteAppearance(input: unknown, previous = defaultSiteAppearance()): SiteAppearance {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const cards = Array.isArray(raw.heroCards) ? raw.heroCards : [];
  return {
    heroCards: previous.heroCards.map((fallback, index) => sanitizeCard(cards[index], fallback)),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : previous.updatedAt,
  };
}

export function createSiteAppearanceStore(dataDir: string) {
  const file = path.join(dataDir, 'site-appearance.json');

  function load(): SiteAppearance {
    const stored = readJsonFile<unknown>(file, null);
    return stored === null ? defaultSiteAppearance() : sanitizeSiteAppearance(stored);
  }

  /** Cards missing from `input` keep their saved values; bad fields keep theirs too. */
  function save(input: unknown): SiteAppearance {
    const next = sanitizeSiteAppearance(input, load());
    next.updatedAt = new Date().toISOString();
    writeJsonFile(file, next);
    return next;
  }

  return { file, load, save };
}
