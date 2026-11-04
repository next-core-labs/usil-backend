import path from 'path';
import crypto from 'crypto';
import { readJsonFile, writeJsonFile } from '../shared/json-file.ts';
import { CATEGORY_DEFS } from '../../core/data/services.ts';

/**
 * «التصنيفات» — the storefront's product categories, added and removed by the
 * owner without a deploy. Until the owner first changes them the list is the
 * design's fifteen (`core/data/services.ts` CATEGORY_DEFS, minus «الكل»).
 *
 * Removing a category never touches listings: a product keeps its category id
 * and stays on the site under «الكل»; its vendor picks a new category on the
 * next edit.
 */

/** Icons the storefront can draw (usil/src/storefront/screens/HomeScreen.tsx CATEGORY_ICONS). */
export const CATEGORY_ICON_NAMES = [
  'Sparkles',
  'Coffee',
  'Utensils',
  'Palette',
  'Camera',
  'PartyPopper',
  'Building2',
  'Armchair',
  'Users',
  'Speaker',
  'Tent',
  'Music',
  'Cake',
  'Gift',
  'Car',
  'Flower2',
] as const;
export type CategoryIconName = (typeof CATEGORY_ICON_NAMES)[number];

export type SiteCategory = {
  id: string;
  /** Full Arabic name, e.g. «ضيافة وقهوة». */
  name: string;
  /** One-word Arabic label for tight rails, e.g. «ضيافة». */
  short: string;
  /** English name for the English storefront; '' falls back to the Arabic. */
  nameEn: string;
  icon: CategoryIconName;
};

export type SiteCategories = {
  categories: SiteCategory[];
  updatedAt: string;
};

export class CategoryStoreError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const CATEGORY_NAME_MAX = 40;
export const CATEGORY_SHORT_MAX = 16;
export const CATEGORY_LIMIT = 60;
const CATEGORY_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function defaultCategories(): SiteCategory[] {
  return CATEGORY_DEFS.filter((def) => def.id !== 'all').map((def) => ({
    id: def.id,
    name: def.name,
    short: def.short,
    nameEn: '',
    icon: def.icon as CategoryIconName,
  }));
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function parseIcon(value: unknown): CategoryIconName {
  return (CATEGORY_ICON_NAMES as readonly string[]).includes(String(value)) ? (value as CategoryIconName) : 'Sparkles';
}

/** One stored row, repaired; null when it cannot be a category at all. */
function sanitizeStored(input: unknown): SiteCategory | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const id = String(raw.id || '');
  const name = text(raw.name, CATEGORY_NAME_MAX);
  if (!CATEGORY_ID.test(id) || !name) return null;
  return {
    id,
    name,
    short: text(raw.short, CATEGORY_SHORT_MAX) || name.split(' ')[0],
    nameEn: text(raw.nameEn, CATEGORY_NAME_MAX),
    icon: parseIcon(raw.icon),
  };
}

export function createCategoryStore(dataDir: string) {
  const file = path.join(dataDir, 'categories.json');

  function load(): SiteCategories {
    const stored = readJsonFile<{ categories?: unknown; updatedAt?: unknown } | null>(file, null);
    if (!stored || !Array.isArray(stored.categories)) return { categories: defaultCategories(), updatedAt: '' };
    const seen = new Set<string>();
    const categories = stored.categories
      .map(sanitizeStored)
      .filter((row): row is SiteCategory => Boolean(row) && !seen.has(row!.id) && Boolean(seen.add(row!.id)));
    return { categories, updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : '' };
  }

  function write(categories: SiteCategory[]): SiteCategories {
    const next = { categories, updatedAt: new Date().toISOString() };
    writeJsonFile(file, next);
    return next;
  }

  function list(): SiteCategory[] {
    return load().categories;
  }

  function add(input: unknown): { category: SiteCategory; all: SiteCategories } {
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    const name = text(raw.name, CATEGORY_NAME_MAX);
    if (name.length < 2) throw new CategoryStoreError('اكتب اسم التصنيف (حرفان على الأقل).');
    const current = list();
    if (current.length >= CATEGORY_LIMIT) {
      throw new CategoryStoreError(`وصلت الحد الأعلى (${CATEGORY_LIMIT} تصنيفاً). احذف تصنيفاً قبل الإضافة.`);
    }
    if (current.some((row) => row.name === name)) throw new CategoryStoreError('يوجد تصنيف بهذا الاسم.', 409);
    let id = '';
    do id = `cat-${crypto.randomBytes(4).toString('hex')}`;
    while (current.some((row) => row.id === id));
    const category: SiteCategory = {
      id,
      name,
      short: text(raw.short, CATEGORY_SHORT_MAX) || name.split(' ')[0],
      nameEn: text(raw.nameEn, CATEGORY_NAME_MAX),
      icon: parseIcon(raw.icon),
    };
    return { category, all: write([...current, category]) };
  }

  function remove(id: string): SiteCategories {
    const current = list();
    if (!current.some((row) => row.id === id)) throw new CategoryStoreError('التصنيف غير موجود.', 404);
    if (current.length <= 1) throw new CategoryStoreError('لا يمكن حذف آخر تصنيف — يحتاج المورّدون قسماً واحداً على الأقل.');
    return write(current.filter((row) => row.id !== id));
  }

  return { file, load, list, add, remove };
}

export type CategoryStore = ReturnType<typeof createCategoryStore>;
