import fs from 'fs';
import path from 'path';
import { isAllowedListingImage, isStockMediaUrl } from '../../core/utils/catalogMedia';
import { readJsonFile, writeJsonFile } from '../shared/json-file';

export const FOUNDER_ADMIN_EMAIL = 'nawafalmuhayya@gmail.com';

const PROTECTED_EMAIL_RE = /almuhayya|n\.almuhayya/i;
const PROTECTED_NAME_RE = /المهيع|المحي/;

const DUMMY_USER_IDS = new Set(['usr-client', 'usr-vendor', 'usr-admin']);
const DUMMY_EMAILS = new Set([
  'client@usil.app',
  'vendor@usil.app',
  'admin@usil.app',
  'faisal@mithyaf.sa',
  'vendor@asalah.sa',
  'demo@usil.app',
  'test@usil.app',
  'midyaf@usil.app',
  'usil.ksa@gmail.com',
  'founder@usil.app',
  'qa.booking@usil-qa.invalid',
  'khalid.njd@usil.sa',
  'najd@usil.sa',
]);
const DUMMY_USER_NAMES = new Set([
  'عميل مِضياف',
  'عميل مضياف',
  'مورد الضيافة',
  'إدارة الموقع',
  'حساب تجريبي',
  'فيصل السبيعي',
  'سارة المصور',
  'نواف الإطلاق',
  'ضيافة الأصالة الفاخرة',
  'مختبر يوصل',
  'مختبر حجز يوصل',
  'يوصل - Usil',
  'تأكيد مباشر',
  'تأكيد جلسة',
]);

const DUMMY_COURIER_SEEDS = [
  { firstName: 'سعد', familyName: 'الدوسري', nationalId: '2088123499' },
  { firstName: 'فهد', familyName: 'العتيبي', nationalId: '1098765432' },
];

export function normalizeAccountEmail(raw: string): string {
  return String(raw || '').trim().toLowerCase();
}

export function isProtectedAccount(input: { email?: string; name?: string }): boolean {
  const email = normalizeAccountEmail(input.email || '');
  if (email === FOUNDER_ADMIN_EMAIL) return true;
  if (email && PROTECTED_EMAIL_RE.test(email)) return true;
  const name = String(input.name || '');
  if (PROTECTED_NAME_RE.test(name) && !isDummyEmail(email) && !DUMMY_USER_NAMES.has(name.trim())) {
    return true;
  }
  return false;
}

/**
 * True only for addresses we know are ours to delete: the explicit seed list and
 * the reserved test domains. This feeds the purge that runs on every restart, so
 * it must never guess from the local part — `photo.studio@gmail.com` or
 * `test.family@outlook.com` are real people.
 */
export function isDummyEmail(email: string): boolean {
  const normalized = normalizeAccountEmail(email);
  if (!normalized) return false;
  if (DUMMY_EMAILS.has(normalized)) return true;
  if (/@(example\.com|mithyaf\.sa|usil-qa\.invalid)$/i.test(normalized)) return true;
  return false;
}

/** Not an address at all (no `@`, or bracket/backslash junk from form fuzzing). */
function isGarbageEmail(email: string): boolean {
  const normalized = normalizeAccountEmail(email);
  if (!normalized) return false;
  return !normalized.includes('@') || /[\[\]\\]/.test(normalized);
}

export function isDummyUser(user: { id?: string; email?: string; name?: string }): boolean {
  if (isProtectedAccount(user)) return false;
  if (user.id && DUMMY_USER_IDS.has(user.id)) return true;
  if (isDummyEmail(user.email || '')) return true;
  if (DUMMY_USER_NAMES.has(String(user.name || '').trim())) return true;
  return false;
}

export function isDummyCourierApplication(row: {
  firstName?: string;
  familyName?: string;
  nationalId?: string;
}): boolean {
  const firstName = String(row.firstName || '').trim();
  const familyName = String(row.familyName || '').trim();
  const nationalId = String(row.nationalId || '').replace(/\s+/g, '');
  return DUMMY_COURIER_SEEDS.some(
    (seed) =>
      seed.firstName === firstName &&
      seed.familyName === familyName &&
      seed.nationalId === nationalId,
  );
}

export function isDummyVendorApplication(row: {
  email?: string;
  firstName?: string;
  familyName?: string;
  projectName?: string;
}): boolean {
  const email = normalizeAccountEmail(row.email || '');
  const name = `${row.firstName || ''} ${row.familyName || ''} ${row.projectName || ''}`.trim();
  if (isProtectedAccount({ email, name })) return false;
  if (isDummyEmail(email) || isGarbageEmail(email)) return true;
  const firstName = String(row.firstName || '').trim();
  if (firstName.length <= 2 && /[A-Z]/.test(firstName) && !/[\u0600-\u06FF]/.test(firstName)) return true;
  return false;
}

export function purgeDummyRecords<T>(rows: T[], isDummy: (row: T) => boolean): { kept: T[]; removed: T[] } {
  const kept: T[] = [];
  const removed: T[] = [];
  for (const row of rows) {
    if (isDummy(row)) removed.push(row);
    else kept.push(row);
  }
  return { kept, removed };
}

function readJson<T>(file: string, fallback: T): T {
  return readJsonFile(file, fallback);
}

function writeJson(file: string, value: unknown) {
  writeJsonFile(file, value);
}

function stripWorkspaceStockImages(dataDir: string, keptUserIds: Set<string>): { removedWorkspaces: number; strippedListings: number } {
  const file = path.join(dataDir, 'vendor-workspaces.json');
  if (!fs.existsSync(file)) return { removedWorkspaces: 0, strippedListings: 0 };
  const raw = readJson<{ workspaces?: Record<string, { listings?: Array<{ image?: string; images?: string[] }> }> }>(file, {});
  const nested = raw.workspaces && typeof raw.workspaces === 'object';
  const workspaces = nested ? raw.workspaces : raw;
  if (!workspaces || typeof workspaces !== 'object') return { removedWorkspaces: 0, strippedListings: 0 };

  let removedWorkspaces = 0;
  let strippedListings = 0;
  const next: Record<string, unknown> = {};
  for (const [vendorId, workspace] of Object.entries(workspaces as Record<string, unknown>)) {
    if (vendorId === 'workspaces') continue;
    if (vendorId === 'usr-vendor' || vendorId === 'usr-client' || vendorId === 'usr-admin' || (vendorId.startsWith('usr-') && !keptUserIds.has(vendorId))) {
      removedWorkspaces += 1;
      continue;
    }
    if (!workspace || typeof workspace !== 'object') {
      next[vendorId] = workspace;
      continue;
    }
    const row = { ...(workspace as { listings?: Array<{ image?: string; images?: string[] }> }) };
    if (Array.isArray(row.listings)) {
      row.listings = row.listings.map((listing) => {
        const images = (listing.images || []).filter(isAllowedListingImage);
        const image = isAllowedListingImage(listing.image) ? listing.image : images[0] || '';
        if ((listing.images || []).length !== images.length || listing.image !== image) strippedListings += 1;
        return { ...listing, images, image: image || undefined };
      });
    }
    next[vendorId] = row;
  }

  if (!removedWorkspaces && !strippedListings) return { removedWorkspaces, strippedListings };
  if (nested) writeJson(file, { ...raw, workspaces: next });
  else writeJson(file, next);
  return { removedWorkspaces, strippedListings };
}

/** One-shot: drop stored vendor photos and prices so Moyasar is not charged from leftover amounts. */
function clearVendorListingCommerce(dataDir: string): number {
  const marker = path.join(dataDir, 'vendor-commerce-cleared.json');
  if (fs.existsSync(marker)) return 0;
  const file = path.join(dataDir, 'vendor-workspaces.json');
  let cleared = 0;
  if (fs.existsSync(file)) {
    const raw = readJson<{ workspaces?: Record<string, { listings?: Array<Record<string, unknown>> }> }>(file, {});
    const nested = raw.workspaces && typeof raw.workspaces === 'object';
    const workspaces = nested ? raw.workspaces : (raw as unknown as Record<string, unknown>);
    if (workspaces && typeof workspaces === 'object') {
      const next: Record<string, unknown> = {};
      for (const [vendorId, workspace] of Object.entries(workspaces as Record<string, unknown>)) {
        if (!workspace || typeof workspace !== 'object') {
          next[vendorId] = workspace;
          continue;
        }
        const row = { ...(workspace as { listings?: Array<Record<string, unknown>> }) };
        if (Array.isArray(row.listings)) {
          row.listings = row.listings.map((listing) => {
            const hadPrice = Number(listing.price) > 0;
            const hadImage = Boolean(listing.image) || (Array.isArray(listing.images) && listing.images.length > 0);
            if (hadPrice || hadImage) cleared += 1;
            return { ...listing, price: 0, image: '', images: [] };
          });
        }
        next[vendorId] = row;
      }
      if (nested) writeJson(file, { ...raw, workspaces: next });
      else writeJson(file, next);
    }
  }
  writeJson(marker, { clearedAt: new Date().toISOString(), listingsTouched: cleared });
  return cleared;
}

function purgeOrphanUploads(dataDir: string, keptUsers: Array<{ id?: string; avatarUrl?: string }>): number {
  const uploads = path.join(dataDir, 'uploads');
  if (!fs.existsSync(uploads)) return 0;
  const keep = new Set<string>(['avatar-usr-nawaf-admin.svg', 'avatar-supervisor.svg']);
  for (const user of keptUsers) {
    const avatar = String(user.avatarUrl || '');
    if (avatar.startsWith('/uploads/')) keep.add(path.basename(avatar));
  }
  let removed = 0;
  for (const name of fs.readdirSync(uploads)) {
    if (keep.has(name)) continue;
    if (name.startsWith('listing-')) continue;
    const file = path.join(uploads, name);
    try {
      if (!fs.statSync(file).isFile()) continue;
      if (name.startsWith('avatar-') || isStockMediaUrl(name)) {
        fs.unlinkSync(file);
        removed += 1;
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}

const VENDORS_WIPED_MARKER = 'vendors-wiped-v4.json';

function deleteUploadIfSafe(uploadsDir: string, name: string): boolean {
  const file = path.join(uploadsDir, name);
  try {
    if (!file.startsWith(uploadsDir)) return false;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** One-shot: drop every vendor account, application, workspace, and dummy photo. Keeps the founder admin. */
export function wipeAllVendorsAndDummyMedia(
  dataDir: string,
  options?: { once?: boolean },
): {
  skipped: boolean;
  removedVendors: string[];
  removedApps: number;
  wipedWorkspaces: number;
  removedUploads: number;
} {
  const marker = path.join(dataDir, VENDORS_WIPED_MARKER);
  if (options?.once && fs.existsSync(marker)) {
    return { skipped: true, removedVendors: [], removedApps: 0, wipedWorkspaces: 0, removedUploads: 0 };
  }

  const usersFile = path.join(dataDir, 'users.json');
  const sessionsFile = path.join(dataDir, 'sessions.json');
  const users = readJson<Array<{ id: string; email?: string; name?: string; role?: string; avatarUrl?: string }>>(
    usersFile,
    [],
  );
  const keptUsers = users.filter((user) => {
    const email = normalizeAccountEmail(user.email || '');
    if (email === FOUNDER_ADMIN_EMAIL) return true;
    if (user.role === 'vendor') return false;
    return true;
  });
  const removedVendors = users.filter((user) => !keptUsers.some((kept) => kept.id === user.id));
  const removedIds = new Set(removedVendors.map((user) => user.id));

  if (removedVendors.length) {
    writeJson(usersFile, keptUsers);
    const sessions = readJson<Record<string, string>>(sessionsFile, {});
    for (const [token, userId] of Object.entries(sessions)) {
      if (removedIds.has(userId)) delete sessions[token];
    }
    writeJson(sessionsFile, sessions);
  }

  const vendorFile = path.join(dataDir, 'vendor-applications.json');
  const apps = readJson<unknown[]>(vendorFile, []);
  const removedApps = Array.isArray(apps) ? apps.length : 0;
  writeJson(vendorFile, []);

  const workspaceFile = path.join(dataDir, 'vendor-workspaces.json');
  let wipedWorkspaces = 0;
  if (fs.existsSync(workspaceFile)) {
    const raw = readJson<{ workspaces?: Record<string, unknown> }>(workspaceFile, {});
    const nested = raw.workspaces && typeof raw.workspaces === 'object';
    const workspaces = nested ? raw.workspaces : (raw as unknown as Record<string, unknown>);
    wipedWorkspaces = workspaces && typeof workspaces === 'object' ? Object.keys(workspaces).length : 0;
    writeJson(workspaceFile, { workspaces: {} });
  }

  const keepUploads = new Set<string>(['avatar-usr-nawaf-admin.svg', 'avatar-supervisor.svg']);
  for (const user of keptUsers) {
    const avatar = String(user.avatarUrl || '');
    if (avatar.startsWith('/uploads/')) keepUploads.add(path.basename(avatar));
  }

  const uploads = path.join(dataDir, 'uploads');
  let removedUploads = 0;
  if (fs.existsSync(uploads)) {
    for (const name of fs.readdirSync(uploads)) {
      if (keepUploads.has(name)) continue;
      if (
        name.startsWith('listing-') ||
        name.startsWith('vendor-logo-') ||
        name.startsWith('avatar-') ||
        isStockMediaUrl(name)
      ) {
        if (deleteUploadIfSafe(uploads, name)) removedUploads += 1;
      }
    }
  }

  writeJson(marker, {
    wipedAt: new Date().toISOString(),
    removedVendors: removedVendors.map((user) => user.email || user.id),
    removedApps,
    wipedWorkspaces,
    removedUploads,
  });

  return {
    skipped: false,
    removedVendors: removedVendors.map((user) => user.email || user.id),
    removedApps,
    wipedWorkspaces,
    removedUploads,
  };
}

export function purgeLiveDummyData(dataDir: string): {
  removedUsers: string[];
  removedCouriers: number;
  removedVendorApps: number;
} {
  const usersFile = path.join(dataDir, 'users.json');
  const sessionsFile = path.join(dataDir, 'sessions.json');
  const users = readJson<Array<{ id: string; email?: string; name?: string; avatarUrl?: string }>>(usersFile, []);
  const { kept: keptUsers, removed: removedUsers } = purgeDummyRecords(users, isDummyUser);
  const removedIds = new Set(removedUsers.map((user) => user.id));

  if (removedUsers.length) {
    writeJson(usersFile, keptUsers);
    const sessions = readJson<Record<string, string>>(sessionsFile, {});
    for (const [token, userId] of Object.entries(sessions)) {
      if (removedIds.has(userId)) delete sessions[token];
    }
    writeJson(sessionsFile, sessions);

    const uploads = path.join(dataDir, 'uploads');
    for (const user of removedUsers) {
      const avatar = String((user as { avatarUrl?: string }).avatarUrl || '');
      if (avatar.startsWith('/uploads/')) {
        const file = path.join(uploads, path.basename(avatar));
        try {
          if (fs.existsSync(file) && file.startsWith(uploads)) fs.unlinkSync(file);
        } catch {
          /* ignore */
        }
      }
    }
  }

  const courierFile = path.join(dataDir, 'courier-applications.json');
  const couriers = readJson<Array<{ firstName?: string; familyName?: string; nationalId?: string }>>(
    courierFile,
    [],
  );
  const courierPurge = purgeDummyRecords(couriers, isDummyCourierApplication);
  if (courierPurge.removed.length) writeJson(courierFile, courierPurge.kept);

  const vendorFile = path.join(dataDir, 'vendor-applications.json');
  const vendors = readJson<Array<{ email?: string; firstName?: string; familyName?: string; projectName?: string }>>(
    vendorFile,
    [],
  );
  const vendorPurge = purgeDummyRecords(vendors, isDummyVendorApplication);
  if (vendorPurge.removed.length) writeJson(vendorFile, vendorPurge.kept);

  const bookingsFile = path.join(dataDir, 'bookings.json');
  const bookings = readJson<Array<{ email?: string; name?: string; phone?: string }>>(bookingsFile, []);
  const bookingPurge = purgeDummyRecords(
    bookings,
    (row) => isDummyEmail(row.email || '') || DUMMY_USER_NAMES.has(String(row.name || '').trim()),
  );
  if (bookingPurge.removed.length) writeJson(bookingsFile, bookingPurge.kept);

  const supportFile = path.join(dataDir, 'support-messages.json');
  const support = readJson<Array<{ email?: string; name?: string }>>(supportFile, []);
  const supportPurge = purgeDummyRecords(
    support,
    (row) => isDummyEmail(row.email || '') || DUMMY_USER_NAMES.has(String(row.name || '').trim()),
  );
  if (supportPurge.removed.length) writeJson(supportFile, supportPurge.kept);

  const demandFile = path.join(dataDir, 'city-requests.json');
  const demand = readJson<Array<{ name?: string; phone?: string }>>(demandFile, []);
  const demandPurge = purgeDummyRecords(
    demand,
    (row) => DUMMY_USER_NAMES.has(String(row.name || '').trim()) || String(row.phone || '').startsWith('050000'),
  );
  if (demandPurge.removed.length) writeJson(demandFile, demandPurge.kept);

  const keptIds = new Set(keptUsers.map((user) => user.id));
  keptIds.add('usr-nawaf-admin');
  stripWorkspaceStockImages(dataDir, keptIds);
  clearVendorListingCommerce(dataDir);
  purgeOrphanUploads(dataDir, keptUsers);

  return {
    removedUsers: removedUsers.map((user) => user.email || user.id),
    removedCouriers: courierPurge.removed.length,
    removedVendorApps: vendorPurge.removed.length,
  };
}
