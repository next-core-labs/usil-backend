import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { readJsonFile, writeJsonFile } from '../shared/json-file.ts';
import { parseDataUrl, saveUpload, UPLOAD_MAX_BYTES } from '../auth/avatar';
import { isAllowedListingImage, isStockMediaUrl } from '../../core/utils/catalogMedia';
import type { BookingStatus } from '../../core/types';
import { normalizeSaudiMobile } from '../shared/booking-guards';
import {
  createBookingStore,
  vendorHasBooking,
  vendorViewOfBooking,
  type PlatformBooking,
} from '../bookings/booking-store';
import {
  BOOKING_NEW_STATUS,
  BOOKING_PENDING_APPROVAL_STATUS,
  BOOKING_REJECTED_STATUS,
  LISTING_FULFILLMENT_IDS,
  LISTING_MAX_IMAGES,
  listingToServiceItem,
  validateVendorListing,
  type VendorListing,
  type VendorListingInput,
} from './vendor-listings';
import {
  emptyVendorSocials,
  parseVendorSocials,
  publicSocials,
  sanitizeSocials,
  setSocialVerification,
  type SocialNetwork,
  type VendorSocials,
} from './vendor-socials';
import {
  profileFromApplication,
  publicVendorFile,
  workspaceProfileFromOwn,
  type VendorOwnProfile,
  type VendorProfileSource,
  type VendorPublicFile,
  type VendorWorkspaceProfile,
} from './vendor-profile';

export type VendorBookingRecord = {
  id: string;
  bookingNumber: string;
  serviceId: string;
  serviceTitle: string;
  customerName: string;
  customerPhone: string;
  date: string;
  startTime: string;
  endTime: string;
  city: string;
  venueName: string;
  guestCount: number;
  totalAmount: number;
  depositAmount: number;
  remainingAmount: number;
  source: string;
  status: string;
  notes?: string;
  createdAt: string;
};

export type BlockedDateRecord = {
  id: string;
  date: string;
  reason: string;
  type: 'full_day' | 'maintenance' | 'holiday' | 'custom';
};

export type InventoryRecord = {
  id: string;
  [key: string]: unknown;
};

export type ContractRecord = {
  id: string;
  [key: string]: unknown;
};

export type VendorWorkspace = {
  bookings: VendorBookingRecord[];
  blockedDates: BlockedDateRecord[];
  inventoryItems: InventoryRecord[];
  contracts: ContractRecord[];
  listings: VendorListing[];
  socials?: VendorSocials;
  profile?: VendorWorkspaceProfile;
  updatedAt: string;
};

export type VendorStoreFile = {
  workspaces: Record<string, VendorWorkspace>;
};

/**
 * What `saveWorkspace` actually accepts. `listings` is deliberately looser than
 * `VendorListing[]`: rows arrive straight from the vendor modal or a stored
 * file and are repaired by `normalizeListings`, which supplies `id`,
 * `vendorId`, `createdAt` and `updatedAt` and drops anything unsalvageable.
 */
export type VendorWorkspacePatch = Partial<Omit<VendorWorkspace, 'listings'>> & {
  listings?: unknown;
};

export function emptyWorkspace(): VendorWorkspace {
  return {
    bookings: [],
    blockedDates: [],
    inventoryItems: [],
    contracts: [],
    listings: [],
    socials: emptyVendorSocials(),
    profile: undefined,
    updatedAt: new Date().toISOString(),
  };
}

/** Vendor-created products use `lst-…`. Catalog SKUs keep slug ids like `royal-saudi-coffee`. */
export function isVendorCreatedListingId(id: unknown): boolean {
  return String(id || '').startsWith('lst-');
}

export function isCatalogCloneListing(
  listing: { id?: unknown },
  catalogIds: ReadonlySet<string> = new Set(),
): boolean {
  const id = String(listing?.id || '');
  if (!id) return true;
  if (!isVendorCreatedListingId(id)) return true;
  return catalogIds.has(id);
}

/** A store rejection the routes turn into an HTTP status (400 unless stated). */
export class VendorStoreError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'VendorStoreError';
    this.status = status;
  }
}

/**
 * Canonical vendor booking statuses. The English ids are core's `BookingStatus`
 * (VendorHub writes them), the Arabic ones are what the vendor dashboard and the
 * customer booking flow write. Anything else is rejected.
 */
const CORE_BOOKING_STATUSES = [
  'confirmed',
  'in_progress',
  'completed',
  'cancelled',
  'pending_deposit',
] as const satisfies readonly BookingStatus[];
// Fails to compile if core grows a status this list does not carry.
const CORE_BOOKING_STATUSES_EXHAUSTIVE: Exclude<BookingStatus, (typeof CORE_BOOKING_STATUSES)[number]> extends never
  ? true
  : never = true;
void CORE_BOOKING_STATUSES_EXHAUSTIVE;

export const VENDOR_BOOKING_STATUSES = [
  ...CORE_BOOKING_STATUSES,
  'مؤكد',
  'قيد التنفيذ',
  'مكتمل',
  'ملغي',
  BOOKING_NEW_STATUS,
  BOOKING_PENDING_APPROVAL_STATUS,
  BOOKING_REJECTED_STATUS,
] as const;

/** Only these count toward revenue: pending, rejected, cancelled and unpaid-deposit rows do not. */
export const REVENUE_BOOKING_STATUSES: readonly string[] = [
  'confirmed',
  'in_progress',
  'completed',
  'مؤكد',
  'قيد التنفيذ',
  'مكتمل',
];

export const DEFAULT_VENDOR_BOOKING_STATUS = 'confirmed';

export function isVendorBookingStatus(value: unknown): boolean {
  return (VENDOR_BOOKING_STATUSES as readonly string[]).includes(String(value ?? ''));
}

export function isRevenueBookingStatus(value: unknown): boolean {
  return REVENUE_BOOKING_STATUSES.includes(String(value ?? ''));
}

/** A real calendar day in `YYYY-MM-DD`, not just the right shape. */
export function isIsoDate(value: unknown): value is string {
  const text = String(value ?? '');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isClockTime(value: unknown): value is string {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value ?? ''));
}

/** Today in Riyadh as `YYYY-MM-DD` — bookings are for Saudi events. */
export function todayInRiyadh(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function shortId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function nonNegativeNumber(value: unknown, fallback: number, message: string): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new VendorStoreError(message);
  return n;
}

/**
 * Old clients wrote rows with client-chosen ids, so a workspace can hold two
 * rows with one id. Byte-identical copies collapse to one; different rows keep
 * the first id and the rest get a stable `-2`, `-3` suffix so PATCH/DELETE hit
 * exactly the row the vendor sees.
 */
export function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const out: T[] = [];
  const byId = new Map<string, T[]>();
  const taken = new Set(rows.map((row) => String(row?.id || '')));
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id || '');
    const same = byId.get(id);
    if (!same) {
      byId.set(id, [row]);
      out.push(row);
      continue;
    }
    const json = JSON.stringify(row);
    if (same.some((prior) => JSON.stringify(prior) === json)) continue;
    let n = same.length + 1;
    while (taken.has(`${id}-${n}`)) n += 1;
    const renamed = { ...row, id: `${id}-${n}` };
    taken.add(renamed.id);
    same.push(row);
    out.push(renamed);
  }
  return out;
}

/** Trusted rows (seed, tests, stored file) — repaired leniently, always stamped with the owner. */
function normalizeListings(raw: unknown, vendorId: string): VendorListing[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      try {
        const clean = validateVendorListing(row as VendorListingInput);
        const existing = row as Partial<VendorListing>;
        return {
          id: String(existing.id || shortId('lst')),
          vendorId,
          createdAt: String(existing.createdAt || new Date().toISOString()),
          updatedAt: String(existing.updatedAt || new Date().toISOString()),
          ...clean,
        } satisfies VendorListing;
      } catch {
        return null;
      }
    })
    .filter((row): row is VendorListing => Boolean(row));
}

/** Fields a vendor may edit on a listing — used to tell an untouched row from an edit. */
const LISTING_EDIT_FIELDS = [
  'title',
  'category',
  'shortDesc',
  'price',
  'priceUnit',
  'cities',
  'images',
  'fulfillment',
  'bookingMode',
  'vendorName',
] as const;

const PROFILE_TEXT_LIMIT = 120;

export type VendorStoreOptions = {
  /**
   * Platform orders (read-only) for the revenue summary. Defaults to the
   * bookings file in the same data dir, which is what the booking store writes.
   */
  listPlatformBookings?: () => PlatformBooking[];
};

export function createVendorStore(dataDir: string, options: VendorStoreOptions = {}) {
  const file = path.join(dataDir, 'vendor-workspaces.json');
  const listPlatformBookings = options.listPlatformBookings || (() => createBookingStore(dataDir).list());
  const uploadsRoot = path.resolve(dataDir, 'uploads');
  const IMAGE_INVALID_AR = 'صورة المنتج غير صالحة — ارفع الصورة من جهازك';

  function readFile(): VendorStoreFile {
    return readJsonFile<VendorStoreFile>(file, { workspaces: {} });
  }

  function writeFile(data: VendorStoreFile) {
    writeJsonFile(file, data);
  }

  function hasWorkspace(vendorId: string): boolean {
    return Boolean(readFile().workspaces[vendorId]);
  }

  /**
   * Listings carry a copy of the vendor name from when they were saved. The
   * workspace project name wins at read time, so a rename shows on every
   * listing at once (and the next write stores it).
   */
  function withOwner(listings: unknown, vendorId: string, profile?: VendorWorkspaceProfile): VendorListing[] {
    if (!Array.isArray(listings)) return [];
    const current = String(profile?.projectName || '').trim();
    return (listings as VendorListing[]).map((item) => ({
      ...item,
      vendorId,
      ...(current ? { vendorName: current } : {}),
    }));
  }

  function getWorkspace(vendorId: string): VendorWorkspace {
    const data = readFile();
    const stored = data.workspaces[vendorId] || emptyWorkspace();
    return {
      ...emptyWorkspace(),
      ...stored,
      bookings: Array.isArray(stored.bookings) ? dedupeById(stored.bookings) : [],
      blockedDates: Array.isArray(stored.blockedDates) ? dedupeById(stored.blockedDates) : [],
      inventoryItems: Array.isArray(stored.inventoryItems) ? stored.inventoryItems : [],
      contracts: Array.isArray(stored.contracts) ? stored.contracts : [],
      // The workspace key is the owner — a stored row can never point at another vendor.
      listings: withOwner(stored.listings, vendorId, stored.profile),
      socials: stored.socials && Array.isArray(stored.socials.links) ? sanitizeSocials(stored.socials) : emptyVendorSocials(),
      profile: stored.profile && stored.profile.projectName ? stored.profile : undefined,
    };
  }

  /** Writes already-validated fields as they are — no lenient re-normalizing that could drop rows. */
  function patchWorkspace(vendorId: string, patch: Partial<VendorWorkspace>): VendorWorkspace {
    const data = readFile();
    const next: VendorWorkspace = {
      ...getWorkspace(vendorId),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    data.workspaces[vendorId] = next;
    writeFile(data);
    return next;
  }

  /* ── Listing images ───────────────────────────────────────────── */

  /** `/uploads/<flat file name>` that exists under data/uploads — no traversal, no sub-folders. */
  function isExistingUpload(url: string): boolean {
    if (!url.startsWith('/uploads/')) return false;
    let name: string;
    try {
      name = decodeURIComponent(url.slice('/uploads/'.length));
    } catch {
      return false;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) return false;
    const full = path.resolve(uploadsRoot, name);
    if (path.dirname(full) !== uploadsRoot) return false;
    try {
      return fs.statSync(full).isFile();
    } catch {
      return false;
    }
  }

  function rawImageList(images: unknown, legacyImage?: unknown): string[] {
    const raw = Array.isArray(images) ? images : [];
    const list = raw.map((item) => String(item ?? '').trim());
    const legacy = String(legacyImage ?? '').trim();
    if (legacy) list.push(legacy);
    return list.filter(Boolean);
  }

  /**
   * Every vendor-supplied photo must be an upload that exists on disk or an
   * inline `data:image/…` photo (core's `isAllowedListingImage`), which is
   * stored only after the rest of the listing validates.
   */
  function checkListingImages(images: unknown, legacyImage?: unknown): Array<{ kind: 'upload' | 'data'; value: string }> {
    const out: Array<{ kind: 'upload' | 'data'; value: string }> = [];
    for (const value of rawImageList(images, legacyImage)) {
      if (isStockMediaUrl(value) || !isAllowedListingImage(value)) throw new VendorStoreError(IMAGE_INVALID_AR);
      if (value.startsWith('data:image/')) {
        if (!parseDataUrl(value, UPLOAD_MAX_BYTES)) throw new VendorStoreError(IMAGE_INVALID_AR);
        out.push({ kind: 'data', value });
        continue;
      }
      if (!isExistingUpload(value)) throw new VendorStoreError(IMAGE_INVALID_AR);
      if (!out.some((row) => row.value === value)) out.push({ kind: 'upload', value });
    }
    return out.slice(0, LISTING_MAX_IMAGES);
  }

  function vendorDisplayName(vendorId: string, requested?: unknown, fallback?: string): string {
    const projectName = getWorkspace(vendorId).profile?.projectName;
    return String(projectName || requested || fallback || '').trim();
  }

  /** The one validation path for a vendor-authored listing (POST, PATCH and PUT /workspace). */
  function validateListingDraft(vendorId: string, input: VendorListingInput, fallbackName?: string) {
    const checked = checkListingImages(input.images, input.image);
    const draft = {
      ...input,
      image: undefined,
      vendorName: vendorDisplayName(vendorId, input.vendorName, fallbackName),
    };
    // Validate with stand-ins first so a bad title never leaves an orphan file behind.
    validateVendorListing(
      { ...draft, images: checked.map((row, i) => (row.kind === 'upload' ? row.value : `/uploads/pending-${i}`)) },
      { requireImages: true },
    );
    const images = checked.map((row) => {
      if (row.kind === 'upload') return row.value;
      const saved = saveUpload(dataDir, 'listing', row.value, UPLOAD_MAX_BYTES);
      if (!saved) throw new VendorStoreError(IMAGE_INVALID_AR);
      return saved;
    });
    return validateVendorListing({ ...draft, images }, { requireImages: true });
  }

  function listingOwners(): Map<string, string> {
    const owners = new Map<string, string>();
    for (const [vendorId, ws] of Object.entries(readFile().workspaces)) {
      for (const item of Array.isArray(ws.listings) ? ws.listings : []) {
        const id = String(item?.id || '');
        if (id && !owners.has(id)) owners.set(id, vendorId);
      }
    }
    return owners;
  }

  function listingEdited(existing: VendorListing, input: Record<string, unknown>): boolean {
    for (const key of LISTING_EDIT_FIELDS) {
      if (input[key] === undefined) continue;
      if (JSON.stringify(input[key]) !== JSON.stringify(existing[key])) return true;
    }
    return input.image !== undefined && String(input.image || '') !== String(existing.image || '');
  }

  /* ── Workspace lifecycle ──────────────────────────────────────── */

  /** Persist a blank workspace for a newly approved vendor. Never copies the global catalog. */
  function ensureEmptyWorkspace(vendorId: string): VendorWorkspace {
    if (hasWorkspace(vendorId)) return getWorkspace(vendorId);
    return saveWorkspace(vendorId, emptyWorkspace());
  }

  /** New vendor: their registration fields only. Zero catalog clones, zero dummy photos. */
  function seedWorkspaceFromApplication(vendorId: string, source: VendorProfileSource): VendorWorkspace {
    const own = profileFromApplication(source, vendorId);
    const current = hasWorkspace(vendorId) ? getWorkspace(vendorId) : emptyWorkspace();
    return patchWorkspace(vendorId, {
      profile: workspaceProfileFromOwn(own),
      socials: sanitizeSocials(source.socials || current.socials),
    });
  }

  function wipeAllWorkspaces(): number {
    const data = readFile();
    const count = Object.keys(data.workspaces || {}).length;
    if (!count) return 0;
    writeFile({ workspaces: {} });
    return count;
  }

  /** When approval creates a new user id, keep the applicant's uploaded listings. */
  function moveWorkspace(fromId: string, toId: string): VendorWorkspace | null {
    if (!fromId || !toId || fromId === toId) return hasWorkspace(toId) ? getWorkspace(toId) : null;
    const data = readFile();
    const source = data.workspaces[fromId];
    if (!source) return hasWorkspace(toId) ? getWorkspace(toId) : null;
    const target = data.workspaces[toId];
    const merged: VendorWorkspace = {
      ...emptyWorkspace(),
      ...source,
      ...(target || {}),
      listings: [
        ...(Array.isArray(source.listings) ? source.listings : []),
        ...(Array.isArray(target?.listings) ? target.listings : []),
      ].map((item) => ({ ...item, vendorId: toId })),
      bookings: [
        ...(Array.isArray(source.bookings) ? source.bookings : []),
        ...(Array.isArray(target?.bookings) ? target.bookings : []),
      ],
      profile: target?.profile || source.profile,
      socials: target?.socials || source.socials,
      updatedAt: new Date().toISOString(),
    };
    data.workspaces[toId] = merged;
    delete data.workspaces[fromId];
    writeFile(data);
    return getWorkspace(toId);
  }

  /**
   * The vendor's own profile. The workspace profile (what the vendor edited)
   * wins field by field over the application; socials come from the workspace
   * and fall back to the application only when the workspace has none.
   */
  function ownProfile(vendorId: string, source?: VendorProfileSource | null): VendorOwnProfile | null {
    const ws = hasWorkspace(vendorId) ? getWorkspace(vendorId) : emptyWorkspace();
    const socials = ws.socials?.links.length ? ws.socials : sanitizeSocials(source?.socials || ws.socials);
    if (source) {
      const base = profileFromApplication(source, vendorId, { listingCount: ws.listings.length });
      if (!ws.profile) return { ...base, socials };
      const edited = Object.fromEntries(
        Object.entries(ws.profile).filter(([, value]) =>
          Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && String(value).trim() !== '',
        ),
      ) as Partial<VendorWorkspaceProfile>;
      return { ...base, ...edited, vendorId, status: base.status, socials, listingCount: ws.listings.length };
    }
    if (!ws.profile) return null;
    return {
      vendorId,
      status: 'approved',
      ...ws.profile,
      socials,
      listingCount: ws.listings.length,
    };
  }

  function getPublicFile(vendorId: string, source?: VendorProfileSource | null): VendorPublicFile | null {
    const own = ownProfile(vendorId, source);
    if (!own || own.status !== 'approved') return null;
    return publicVendorFile(own);
  }

  /** Public socials for `/api/vendors/:id/socials`: workspace first, application as fallback. */
  function getPublicSocials(vendorId: string, source?: VendorProfileSource | null) {
    const ws = getSocials(vendorId);
    return publicSocials(ws.links.length ? ws : source?.socials);
  }

  /**
   * Remove listings that were cloned 1:1 from the global catalog (same id as a SERVICES SKU).
   * Leaves `lst-…` products the vendor actually created.
   */
  function stripCatalogClonedListings(catalogIds: Iterable<string> = []): number {
    const ids = new Set(Array.from(catalogIds, (id) => String(id)).filter(Boolean));
    const data = readFile();
    let removed = 0;
    for (const [vendorId, ws] of Object.entries(data.workspaces)) {
      const listings = Array.isArray(ws.listings) ? ws.listings : [];
      const kept = listings.filter((item) => {
        if (isCatalogCloneListing(item, ids)) {
          removed += 1;
          return false;
        }
        return true;
      });
      if (kept.length !== listings.length) {
        data.workspaces[vendorId] = { ...ws, listings: kept, updatedAt: new Date().toISOString() };
      }
    }
    if (removed) writeFile(data);
    return removed;
  }

  /**
   * Trusted write for server code, seeds and tests. Vendor HTTP input goes
   * through `saveVendorWorkspace`, never here.
   */
  function saveWorkspace(vendorId: string, patch: VendorWorkspacePatch): VendorWorkspace {
    const data = readFile();
    const current = getWorkspace(vendorId);
    const next: VendorWorkspace = {
      bookings: Array.isArray(patch.bookings) ? patch.bookings : current.bookings,
      blockedDates: Array.isArray(patch.blockedDates) ? patch.blockedDates : current.blockedDates,
      inventoryItems: Array.isArray(patch.inventoryItems) ? patch.inventoryItems : current.inventoryItems,
      contracts: Array.isArray(patch.contracts) ? patch.contracts : current.contracts || [],
      listings: Array.isArray(patch.listings)
        ? normalizeListings(patch.listings, vendorId)
        : current.listings || [],
      socials: patch.socials !== undefined ? sanitizeSocials(patch.socials) : current.socials || emptyVendorSocials(),
      profile: patch.profile !== undefined ? patch.profile : current.profile,
      updatedAt: new Date().toISOString(),
    };
    data.workspaces[vendorId] = next;
    writeFile(data);
    return next;
  }

  function sanitizeProfilePatch(raw: unknown, current?: VendorWorkspaceProfile): VendorWorkspaceProfile | undefined {
    if (raw === null) return current;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new VendorStoreError('بيانات ملف المورّد غير صالحة');
    const input = raw as Record<string, unknown>;
    const pick = (key: keyof VendorWorkspaceProfile, fallback = '') =>
      input[key] === undefined ? fallback : cleanText(input[key], PROFILE_TEXT_LIMIT);
    const projectName = pick('projectName', current?.projectName);
    if (!projectName) throw new VendorStoreError('اكتب اسم المشروع');
    const email = pick('email', current?.email).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new VendorStoreError('البريد الإلكتروني غير صالح');
    let logoUrl = current?.logoUrl;
    if (input.logoUrl !== undefined) {
      const logo = cleanText(input.logoUrl, 500);
      if (!logo) logoUrl = undefined;
      else if (isStockMediaUrl(logo) || !isExistingUpload(logo)) {
        throw new VendorStoreError('شعار المشروع لازم يكون صورة مرفوعة من جهازك');
      } else logoUrl = logo;
    }
    const fulfillment =
      input.fulfillment === undefined
        ? current?.fulfillment || []
        : Array.from(
            new Set(
              (Array.isArray(input.fulfillment) ? input.fulfillment : [])
                .map(String)
                .filter((lane) => (LISTING_FULFILLMENT_IDS as readonly string[]).includes(lane)),
            ),
          );
    return {
      projectName,
      personName: pick('personName', current?.personName),
      projectType: pick('projectType', current?.projectType),
      logoUrl,
      email,
      phone: pick('phone', current?.phone),
      fulfillment,
      // Set from the application review — never from the vendor.
      commercialRegister: current?.commercialRegister,
    };
  }

  /**
   * PUT /api/vendor/workspace. Listings are forced onto this vendor and every
   * added or edited row passes the same checks as POST /api/vendor/listings.
   * Bookings and blocked dates are owned by their own routes and ignored here,
   * so the booking and date rules cannot be bypassed by a bulk save.
   */
  function saveVendorWorkspace(vendorId: string, body: unknown, fallbackName?: string): VendorWorkspace {
    const patch = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const current = getWorkspace(vendorId);
    const next: Partial<VendorWorkspace> = {};
    if (Array.isArray(patch.inventoryItems)) next.inventoryItems = patch.inventoryItems as InventoryRecord[];
    if (Array.isArray(patch.contracts)) next.contracts = patch.contracts as ContractRecord[];
    if (patch.socials !== undefined) {
      next.socials = parseVendorSocials(patch.socials, { previous: current.socials, requireAtLeastOne: false });
    }
    if (patch.profile !== undefined) next.profile = sanitizeProfilePatch(patch.profile, current.profile);

    if (Array.isArray(patch.listings)) {
      const owners = listingOwners();
      const ownById = new Map(current.listings.map((item) => [item.id, item]));
      const seen = new Set<string>();
      const listings: VendorListing[] = [];
      for (const row of patch.listings) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new VendorStoreError('بيانات المنتج غير صالحة');
        const input = row as Record<string, unknown>;
        const requestedId = cleanText(input.id, 120);
        if (requestedId) {
          const owner = owners.get(requestedId);
          if (owner && owner !== vendorId) throw new VendorStoreError('هذا المنتج يخص مورّداً آخر', 403);
          if (seen.has(requestedId)) throw new VendorStoreError('المنتج مكرر في الطلب');
        }
        const existing = requestedId ? ownById.get(requestedId) : undefined;
        if (existing && !listingEdited(existing, input)) {
          listings.push(existing);
          seen.add(existing.id);
          continue;
        }
        const clean = validateListingDraft(vendorId, input as VendorListingInput, existing?.vendorName || fallbackName);
        const now = new Date().toISOString();
        const id = existing
          ? existing.id
          : requestedId && /^lst-[A-Za-z0-9_-]{1,80}$/.test(requestedId) && !owners.has(requestedId)
            ? requestedId
            : shortId('lst');
        listings.push({
          ...clean,
          id,
          vendorId,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        });
        seen.add(id);
      }
      next.listings = listings;
    }
    return patchWorkspace(vendorId, next);
  }

  /* ── Bookings ─────────────────────────────────────────────────── */

  function assertBookableDate(ws: VendorWorkspace, date: string, today: string) {
    if (!isIsoDate(date)) throw new VendorStoreError('اكتب تاريخ الحجز بصيغة YYYY-MM-DD');
    if (date < today) throw new VendorStoreError('ما تقدر تسجّل حجز بتاريخ مضى');
    if (ws.blockedDates.some((row) => row.date === date)) {
      throw new VendorStoreError('هذا التاريخ مغلق في تقويمك — افتحه أولاً');
    }
  }

  function clockOrDefault(value: unknown, fallback: string): string {
    if (value === undefined || value === null || value === '') return fallback;
    if (!isClockTime(value)) throw new VendorStoreError('اكتب الوقت بصيغة HH:MM');
    return String(value);
  }

  function addBooking(vendorId: string, input: unknown, now = new Date()): VendorBookingRecord {
    const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const customerName = cleanText(body.customerName, 120);
    const rawPhone = cleanText(body.customerPhone, 40);
    if (!customerName || !rawPhone) {
      throw new VendorStoreError('اسم العميل ورقم الجوال مطلوبان');
    }
    // Same Saudi mobile rule as checkout, so the vendor can actually call the client back.
    const customerPhone = normalizeSaudiMobile(rawPhone);
    if (!customerPhone) throw new VendorStoreError('رقم جوال العميل غير صالح — اكتبه بصيغة 05xxxxxxxx');
    const ws = getWorkspace(vendorId);

    let serviceId = 'srv-custom';
    let serviceTitle = cleanText(body.serviceTitle, 160) || 'خدمة توريد';
    const requestedService = cleanText(body.serviceId, 120);
    if (requestedService && requestedService !== 'srv-custom') {
      const listing = ws.listings.find((item) => item.id === requestedService);
      if (!listing) throw new VendorStoreError('المنتج المختار مو من منتجاتك');
      serviceId = listing.id;
      serviceTitle = listing.title;
    }

    const today = todayInRiyadh(now);
    const date = body.date === undefined || body.date === null || body.date === '' ? today : String(body.date);
    assertBookableDate(ws, date, today);

    const status =
      body.status === undefined || body.status === null || body.status === ''
        ? DEFAULT_VENDOR_BOOKING_STATUS
        : String(body.status);
    if (!isVendorBookingStatus(status)) throw new VendorStoreError('حالة الحجز غير معروفة');

    const totalAmount = nonNegativeNumber(body.totalAmount, 0, 'المبلغ الإجمالي غير صالح');
    const depositAmount = nonNegativeNumber(body.depositAmount, 0, 'مبلغ العربون غير صالح');
    if (depositAmount > totalAmount) throw new VendorStoreError('العربون أكبر من المبلغ الإجمالي');

    const taken = new Set(ws.bookings.map((row) => row.bookingNumber));
    let bookingNumber = '';
    do {
      bookingNumber = `BK-${Math.floor(100000 + Math.random() * 900000)}`;
    } while (taken.has(bookingNumber));

    const booking: VendorBookingRecord = {
      id: shortId('bk'),
      bookingNumber,
      serviceId,
      serviceTitle,
      customerName,
      customerPhone,
      date,
      startTime: clockOrDefault(body.startTime, '18:00'),
      endTime: clockOrDefault(body.endTime, '23:30'),
      city: cleanText(body.city, 80) || 'الرياض',
      venueName: cleanText(body.venueName, 160) || 'مقر المناسبة',
      guestCount: Math.round(nonNegativeNumber(body.guestCount, 50, 'عدد الضيوف غير صالح')),
      totalAmount,
      depositAmount,
      remainingAmount: totalAmount - depositAmount,
      source: cleanText(body.source, 40) || 'platform',
      status,
      notes: cleanText(body.notes, 1000) || undefined,
      createdAt: now.toISOString(),
    };
    patchWorkspace(vendorId, { bookings: [booking, ...ws.bookings] });
    return booking;
  }

  /** Fields a vendor may change after the fact. Amounts, customer contact and ids are fixed. */
  const BOOKING_PATCH_FIELDS = ['status', 'notes', 'date', 'startTime', 'endTime'] as const;

  function updateBooking(vendorId: string, id: string, patch: unknown, now = new Date()): VendorBookingRecord | null {
    const body = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
    const ws = getWorkspace(vendorId);
    const index = ws.bookings.findIndex((row) => row.id === id);
    if (index < 0) return null;
    const item = ws.bookings[index];
    const next: VendorBookingRecord = { ...item };
    for (const key of BOOKING_PATCH_FIELDS) {
      const value = body[key];
      if (value === undefined) continue;
      if (key === 'status') {
        if (!isVendorBookingStatus(value)) throw new VendorStoreError('حالة الحجز غير معروفة');
        next.status = String(value);
      } else if (key === 'notes') {
        next.notes = cleanText(value, 1000) || undefined;
      } else if (key === 'date') {
        const date = String(value);
        if (date !== item.date) assertBookableDate(ws, date, todayInRiyadh(now));
        next.date = date;
      } else {
        if (!isClockTime(value)) throw new VendorStoreError('اكتب الوقت بصيغة HH:MM');
        next[key] = String(value);
      }
    }
    const bookings = ws.bookings.slice();
    bookings[index] = next;
    patchWorkspace(vendorId, { bookings });
    return next;
  }

  function removeBooking(vendorId: string, id: string): boolean {
    const ws = getWorkspace(vendorId);
    const next = ws.bookings.filter((b) => b.id !== id);
    if (next.length === ws.bookings.length) return false;
    patchWorkspace(vendorId, { bookings: next });
    return true;
  }

  /* ── Blocked dates ────────────────────────────────────────────── */

  const BLOCKED_DATE_TYPES: readonly BlockedDateRecord['type'][] = ['full_day', 'maintenance', 'holiday', 'custom'];

  /** Blocking a date twice returns the existing row (`created: false`). */
  function blockDate(vendorId: string, input: unknown): { blockedDate: BlockedDateRecord; created: boolean } {
    const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if (body.date === undefined || body.date === null || body.date === '') throw new VendorStoreError('التاريخ مطلوب');
    if (!isIsoDate(body.date)) throw new VendorStoreError('اكتب التاريخ بصيغة YYYY-MM-DD');
    const type = body.type === undefined || body.type === '' ? 'custom' : String(body.type);
    if (!(BLOCKED_DATE_TYPES as readonly string[]).includes(type)) throw new VendorStoreError('نوع الإغلاق غير معروف');
    const ws = getWorkspace(vendorId);
    const existing = ws.blockedDates.find((row) => row.date === body.date);
    if (existing) return { blockedDate: existing, created: false };
    const row: BlockedDateRecord = {
      id: shortId('blk'),
      date: body.date,
      reason: cleanText(body.reason, 200) || 'إغلاق',
      type: type as BlockedDateRecord['type'],
    };
    patchWorkspace(vendorId, { blockedDates: [row, ...ws.blockedDates] });
    return { blockedDate: row, created: true };
  }

  function addBlockedDate(vendorId: string, input: unknown): BlockedDateRecord {
    return blockDate(vendorId, input).blockedDate;
  }

  function removeBlockedDate(vendorId: string, id: string): boolean {
    const ws = getWorkspace(vendorId);
    const next = ws.blockedDates.filter((b) => b.id !== id);
    if (next.length === ws.blockedDates.length) return false;
    patchWorkspace(vendorId, { blockedDates: next });
    return true;
  }

  /* ── Listings ─────────────────────────────────────────────────── */

  function addListing(vendorId: string, input: VendorListingInput, vendorName?: string): VendorListing {
    const clean = validateListingDraft(vendorId, input || {}, vendorName);
    const now = new Date().toISOString();
    const listing: VendorListing = {
      id: shortId('lst'),
      vendorId,
      createdAt: now,
      updatedAt: now,
      ...clean,
    };
    const ws = getWorkspace(vendorId);
    patchWorkspace(vendorId, { listings: [listing, ...ws.listings] });
    return listing;
  }

  function updateListing(
    vendorId: string,
    id: string,
    input: VendorListingInput,
    vendorName?: string,
    options: { admin?: boolean } = {},
  ): VendorListing | null {
    const ws = getWorkspace(vendorId);
    const current = ws.listings.find((item) => item.id === id);
    if (!current) return null;
    const body = input || {};
    const imagesGiven = body.images !== undefined || body.image !== undefined;
    const merged: VendorListingInput = {
      title: body.title ?? current.title,
      category: body.category ?? current.category,
      shortDesc: body.shortDesc ?? current.shortDesc,
      price: body.price ?? current.price,
      priceUnit: body.priceUnit ?? current.priceUnit,
      cities: body.cities ?? current.cities,
      images: imagesGiven ? body.images : current.images ?? (current.image ? [current.image] : []),
      image: imagesGiven ? body.image : undefined,
      fulfillment: body.fulfillment ?? current.fulfillment,
      bookingMode: body.bookingMode ?? current.bookingMode,
      vendorName: body.vendorName || vendorName || current.vendorName,
    };
    // An admin fixing lanes or price must not be locked out by a listing's old
    // photos; photos the admin does send get the full check.
    const clean =
      options.admin && !imagesGiven
        ? validateVendorListing({ ...merged, vendorName: current.vendorName })
        : validateListingDraft(vendorId, merged, current.vendorName);
    const listing: VendorListing = {
      ...current,
      ...clean,
      id: current.id,
      vendorId,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    patchWorkspace(vendorId, {
      listings: ws.listings.map((item) => (item.id === id ? listing : item)),
    });
    return listing;
  }

  function removeListing(vendorId: string, id: string): boolean {
    const ws = getWorkspace(vendorId);
    const next = ws.listings.filter((item) => item.id !== id);
    if (next.length === ws.listings.length) return false;
    patchWorkspace(vendorId, { listings: next });
    return true;
  }

  function listAllListings(): VendorListing[] {
    const data = readFile();
    return Object.entries(data.workspaces).flatMap(([vendorId, ws]) => withOwner(ws.listings, vendorId, ws.profile));
  }

  function updateListingAdmin(id: string, input: VendorListingInput): VendorListing | null {
    const owner = listingOwners().get(String(id || ''));
    if (!owner) return null;
    return updateListing(owner, id, input, undefined, { admin: true });
  }

  /* ── Socials ──────────────────────────────────────────────────── */

  function getSocials(vendorId: string): VendorSocials {
    return getWorkspace(vendorId).socials || emptyVendorSocials();
  }

  /**
   * Vendor input: always re-parsed from the handles/URLs. Any `status`,
   * `verifiedBy` or `verifiedAt` the vendor sends is ignored; verification
   * survives only on an unchanged URL.
   */
  function saveSocials(vendorId: string, raw: unknown): VendorSocials {
    const socials = parseVendorSocials(raw, { previous: getSocials(vendorId), requireAtLeastOne: false });
    patchWorkspace(vendorId, { socials });
    return socials;
  }

  /** Server-side sync of socials an admin already reviewed (application verify). */
  function replaceSocials(vendorId: string, socials: VendorSocials | null | undefined): VendorSocials {
    const clean = sanitizeSocials(socials);
    patchWorkspace(vendorId, { socials: clean });
    return clean;
  }

  /**
   * An admin reviewed one network on the application. Only that network's
   * verification carries over: the vendor's other links stay as they are now.
   * A link the vendor has since changed is left alone — the review was of the
   * old URL, not the current one.
   */
  function mergeReviewedSocial(vendorId: string, network: SocialNetwork, reviewed: VendorSocials | null | undefined): VendorSocials {
    const current = getSocials(vendorId);
    const incoming = sanitizeSocials(reviewed).links.find((link) => link.network === network);
    if (!incoming) return current;
    const own = current.links.find((link) => link.network === network);
    if (own && own.url !== incoming.url) return current;
    const merged: VendorSocials = own
      ? {
          ...current,
          links: current.links.map((link) =>
            link.network === network
              ? {
                  ...link,
                  status: incoming.status,
                  verifiedAt: incoming.verifiedAt,
                  verifiedBy: incoming.verifiedBy,
                  updatedAt: incoming.updatedAt || link.updatedAt,
                }
              : link,
          ),
        }
      : { ...current, links: [...current.links, incoming] };
    const clean = sanitizeSocials(merged);
    patchWorkspace(vendorId, { socials: clean });
    return clean;
  }

  function verifySocial(vendorId: string, network: SocialNetwork, verified: boolean, actorName: string): VendorSocials {
    const socials = setSocialVerification(getSocials(vendorId), network, verified, actorName);
    patchWorkspace(vendorId, { socials });
    return socials;
  }

  function listSocials(): Array<{ vendorId: string; socials: VendorSocials }> {
    const data = readFile();
    return Object.entries(data.workspaces)
      .map(([vendorId, ws]) => ({
        vendorId,
        socials: ws.socials && Array.isArray(ws.socials.links) ? sanitizeSocials(ws.socials) : emptyVendorSocials(),
      }))
      .filter((row) => row.socials.links.length > 0);
  }

  function listingToPublicService(listing: VendorListing) {
    const item = listingToServiceItem(listing);
    const socials = publicSocials(getSocials(listing.vendorId));
    return {
      ...item,
      provider: {
        ...item.provider,
        socials,
      },
    };
  }

  function readPlatformBookings(): PlatformBooking[] {
    try {
      const rows = listPlatformBookings();
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  /**
   * Manual bookings plus the platform orders that belong to this vendor. A
   * mixed-vendor order counts only this vendor's own lines (the same trimmed
   * view the vendor sees), and both kinds follow the same revenue statuses.
   */
  function summary(vendorId: string, platformBookings: PlatformBooking[] = readPlatformBookings()) {
    const ws = getWorkspace(vendorId);
    const ownListingIds = new Set(ws.listings.map((item) => String(item.id)));
    const orders = platformBookings
      .filter((row) => row && vendorHasBooking(vendorId, ownListingIds, row))
      .map((row) => vendorViewOfBooking(vendorId, ownListingIds, row));
    const manualRevenue = ws.bookings
      .filter((b) => isRevenueBookingStatus(b.status))
      .reduce((sum, b) => sum + Number(b.totalAmount || 0), 0);
    const platformRevenue = orders
      .filter((row) => isRevenueBookingStatus(row.status))
      .reduce((sum, row) => {
        const amount = Number(row.totalAmount);
        return Number.isFinite(amount) && amount > 0 ? sum + amount : sum;
      }, 0);
    return {
      bookingCount: ws.bookings.length + orders.length,
      manualBookingCount: ws.bookings.length,
      platformBookingCount: orders.length,
      blockedDateCount: ws.blockedDates.length,
      inventoryCount: ws.inventoryItems.length,
      listingCount: ws.listings.length,
      revenue: manualRevenue + platformRevenue,
      platformRevenue,
      updatedAt: ws.updatedAt,
    };
  }

  function listSummaries(): Record<string, ReturnType<typeof summary>> {
    const data = readFile();
    const platformBookings = readPlatformBookings();
    const out: Record<string, ReturnType<typeof summary>> = {};
    for (const vendorId of Object.keys(data.workspaces)) {
      out[vendorId] = summary(vendorId, platformBookings);
    }
    return out;
  }

  /* ── Leftovers of rejected applications ───────────────────────── */

  /**
   * Drops a whole workspace. Only for a rejected application's leftovers —
   * the caller checks the owner is not a vendor account.
   */
  function removeWorkspace(vendorId: string): boolean {
    if (!vendorId) return false;
    const data = readFile();
    if (!data.workspaces[vendorId]) return false;
    delete data.workspaces[vendorId];
    writeFile(data);
    return true;
  }

  return {
    file,
    getWorkspace,
    hasWorkspace,
    ensureEmptyWorkspace,
    seedWorkspaceFromApplication,
    wipeAllWorkspaces,
    moveWorkspace,
    ownProfile,
    getPublicFile,
    getPublicSocials,
    stripCatalogClonedListings,
    saveWorkspace,
    saveVendorWorkspace,
    addBooking,
    updateBooking,
    removeBooking,
    blockDate,
    addBlockedDate,
    removeBlockedDate,
    addListing,
    updateListing,
    removeListing,
    listAllListings,
    updateListingAdmin,
    listingToServiceItem,
    listingToPublicService,
    getSocials,
    saveSocials,
    replaceSocials,
    mergeReviewedSocial,
    verifySocial,
    listSocials,
    summary: (vendorId: string) => summary(vendorId),
    listSummaries,
    removeWorkspace,
  };
}
