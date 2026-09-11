import path from 'path';
import { readJsonFile, writeJsonFile } from '../shared/json-file.ts';
import {
  listingToServiceItem,
  validateVendorListing,
  type VendorListing,
  type VendorListingInput,
} from './vendor-listings';
import {
  emptyVendorSocials,
  isNormalizedSocials,
  parseVendorSocials,
  publicSocials,
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

function normalizeListings(raw: unknown, vendorId: string): VendorListing[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      try {
        const clean = validateVendorListing(row as VendorListingInput);
        const existing = row as Partial<VendorListing>;
        return {
          id: String(existing.id || `lst-${Date.now()}`),
          vendorId: String(existing.vendorId || vendorId),
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

export function createVendorStore(dataDir: string) {
  const file = path.join(dataDir, 'vendor-workspaces.json');

  function readFile(): VendorStoreFile {
    return readJsonFile<VendorStoreFile>(file, { workspaces: {} });
  }

  function writeFile(data: VendorStoreFile) {
    writeJsonFile(file, data);
  }

  function hasWorkspace(vendorId: string): boolean {
    return Boolean(readFile().workspaces[vendorId]);
  }

  function getWorkspace(vendorId: string): VendorWorkspace {
    const data = readFile();
    const stored = data.workspaces[vendorId] || emptyWorkspace();
    return {
      ...emptyWorkspace(),
      ...stored,
      bookings: Array.isArray(stored.bookings) ? stored.bookings : [],
      blockedDates: Array.isArray(stored.blockedDates) ? stored.blockedDates : [],
      inventoryItems: Array.isArray(stored.inventoryItems) ? stored.inventoryItems : [],
      contracts: Array.isArray(stored.contracts) ? stored.contracts : [],
      listings: Array.isArray(stored.listings) ? stored.listings : [],
      socials: stored.socials && Array.isArray(stored.socials.links) ? stored.socials : emptyVendorSocials(),
      profile: stored.profile && stored.profile.projectName ? stored.profile : undefined,
    };
  }

  /** Persist a blank workspace for a newly approved vendor. Never copies the global catalog. */
  function ensureEmptyWorkspace(vendorId: string): VendorWorkspace {
    if (hasWorkspace(vendorId)) return getWorkspace(vendorId);
    return saveWorkspace(vendorId, emptyWorkspace());
  }

  /** New vendor: their registration fields only. Zero catalog clones, zero dummy photos. */
  function seedWorkspaceFromApplication(vendorId: string, source: VendorProfileSource): VendorWorkspace {
    const own = profileFromApplication(source, vendorId);
    const current = hasWorkspace(vendorId) ? getWorkspace(vendorId) : emptyWorkspace();
    return saveWorkspace(vendorId, {
      ...current,
      listings: Array.isArray(current.listings) ? current.listings : [],
      bookings: Array.isArray(current.bookings) ? current.bookings : [],
      profile: workspaceProfileFromOwn(own),
      socials: source.socials || current.socials || emptyVendorSocials(),
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

  function ownProfile(vendorId: string, source?: VendorProfileSource | null): VendorOwnProfile | null {
    const ws = hasWorkspace(vendorId) ? getWorkspace(vendorId) : emptyWorkspace();
    if (source) {
      return profileFromApplication(source, vendorId, { listingCount: ws.listings.length });
    }
    if (!ws.profile) return null;
    return {
      vendorId,
      status: 'approved',
      ...ws.profile,
      socials: ws.socials,
      listingCount: ws.listings.length,
    };
  }

  function getPublicFile(vendorId: string, source?: VendorProfileSource | null): VendorPublicFile | null {
    const own = ownProfile(vendorId, source);
    if (!own || own.status !== 'approved') return null;
    return publicVendorFile(own);
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
      socials:
        patch.socials !== undefined
          ? isNormalizedSocials(patch.socials)
            ? patch.socials
            : parseVendorSocials(patch.socials, { previous: current.socials, requireAtLeastOne: false })
          : current.socials || emptyVendorSocials(),
      profile: patch.profile !== undefined ? patch.profile : current.profile,
      updatedAt: new Date().toISOString(),
    };
    data.workspaces[vendorId] = next;
    writeFile(data);
    return next;
  }

  function addBooking(vendorId: string, input: Partial<VendorBookingRecord>): VendorBookingRecord {
    if (!input.customerName || !input.customerPhone) {
      throw new Error('اسم العميل ورقم الجوال مطلوبان');
    }
    const booking: VendorBookingRecord = {
      id: input.id || `bk-${Date.now()}`,
      bookingNumber: input.bookingNumber || `BK-${Math.floor(1000 + Math.random() * 9000)}`,
      serviceId: input.serviceId || 'srv-custom',
      serviceTitle: input.serviceTitle || 'خدمة توريد',
      customerName: String(input.customerName),
      customerPhone: String(input.customerPhone),
      date: input.date || new Date().toISOString().slice(0, 10),
      startTime: input.startTime || '18:00',
      endTime: input.endTime || '23:30',
      city: input.city || 'الرياض',
      venueName: input.venueName || 'مقر المناسبة',
      guestCount: Number(input.guestCount || 50),
      totalAmount: Number(input.totalAmount || 0),
      depositAmount: Number(input.depositAmount || 0),
      remainingAmount: Number(input.remainingAmount || 0),
      source: input.source || 'platform',
      status: input.status || 'confirmed',
      notes: input.notes,
      createdAt: input.createdAt || new Date().toISOString(),
    };
    const ws = getWorkspace(vendorId);
    saveWorkspace(vendorId, { bookings: [booking, ...ws.bookings] });
    return booking;
  }

  function updateBooking(vendorId: string, id: string, patch: Partial<VendorBookingRecord>): VendorBookingRecord | null {
    const ws = getWorkspace(vendorId);
    const item = ws.bookings.find((b) => b.id === id);
    if (!item) return null;
    Object.assign(item, patch, { id: item.id });
    saveWorkspace(vendorId, { bookings: ws.bookings });
    return item;
  }

  function removeBooking(vendorId: string, id: string): boolean {
    const ws = getWorkspace(vendorId);
    const next = ws.bookings.filter((b) => b.id !== id);
    if (next.length === ws.bookings.length) return false;
    saveWorkspace(vendorId, { bookings: next });
    return true;
  }

  function addBlockedDate(vendorId: string, input: Partial<BlockedDateRecord>): BlockedDateRecord {
    if (!input.date) throw new Error('التاريخ مطلوب');
    const row: BlockedDateRecord = {
      id: input.id || `blk-${Date.now()}`,
      date: String(input.date),
      reason: input.reason || 'إغلاق',
      type: input.type || 'custom',
    };
    const ws = getWorkspace(vendorId);
    saveWorkspace(vendorId, { blockedDates: [row, ...ws.blockedDates] });
    return row;
  }

  function removeBlockedDate(vendorId: string, id: string): boolean {
    const ws = getWorkspace(vendorId);
    const next = ws.blockedDates.filter((b) => b.id !== id);
    if (next.length === ws.blockedDates.length) return false;
    saveWorkspace(vendorId, { blockedDates: next });
    return true;
  }

  function addListing(vendorId: string, input: VendorListingInput, vendorName?: string): VendorListing {
    const clean = validateVendorListing(
      { ...input, vendorName: input.vendorName || vendorName },
      { requireImages: true },
    );
    const now = new Date().toISOString();
    const listing: VendorListing = {
      id: `lst-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      vendorId,
      createdAt: now,
      updatedAt: now,
      ...clean,
    };
    const ws = getWorkspace(vendorId);
    saveWorkspace(vendorId, { listings: [listing, ...ws.listings] });
    return listing;
  }

  function updateListing(
    vendorId: string,
    id: string,
    input: VendorListingInput,
    vendorName?: string,
  ): VendorListing | null {
    const ws = getWorkspace(vendorId);
    const current = ws.listings.find((item) => item.id === id);
    if (!current) return null;
    const clean = validateVendorListing({
      title: input.title ?? current.title,
      category: input.category ?? current.category,
      shortDesc: input.shortDesc ?? current.shortDesc,
      price: input.price ?? current.price,
      priceUnit: input.priceUnit ?? current.priceUnit,
      cities: input.cities ?? current.cities,
      images: input.images ?? current.images ?? (current.image ? [current.image] : []),
      fulfillment: input.fulfillment ?? current.fulfillment,
      bookingMode: input.bookingMode ?? current.bookingMode,
      vendorName: input.vendorName || vendorName || current.vendorName,
    }, { requireImages: true });
    const listing: VendorListing = {
      ...current,
      ...clean,
      id: current.id,
      vendorId: current.vendorId,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    saveWorkspace(vendorId, {
      listings: ws.listings.map((item) => (item.id === id ? listing : item)),
    });
    return listing;
  }

  function removeListing(vendorId: string, id: string): boolean {
    const ws = getWorkspace(vendorId);
    const next = ws.listings.filter((item) => item.id !== id);
    if (next.length === ws.listings.length) return false;
    saveWorkspace(vendorId, { listings: next });
    return true;
  }

  function listAllListings(): VendorListing[] {
    const data = readFile();
    return Object.entries(data.workspaces).flatMap(([vendorId, ws]) =>
      (Array.isArray(ws.listings) ? ws.listings : []).map((item) => ({
        ...item,
        vendorId: item.vendorId || vendorId,
      })),
    );
  }

  function updateListingAdmin(id: string, input: VendorListingInput): VendorListing | null {
    const data = readFile();
    for (const vendorId of Object.keys(data.workspaces)) {
      const updated = updateListing(vendorId, id, input);
      if (updated) return updated;
    }
    return null;
  }

  function getSocials(vendorId: string): VendorSocials {
    return getWorkspace(vendorId).socials || emptyVendorSocials();
  }

  function saveSocials(vendorId: string, raw: unknown): VendorSocials {
    const current = getSocials(vendorId);
    const socials = isNormalizedSocials(raw)
      ? raw
      : parseVendorSocials(raw, { previous: current, requireAtLeastOne: false });
    saveWorkspace(vendorId, { socials });
    return socials;
  }

  function verifySocial(vendorId: string, network: SocialNetwork, verified: boolean, actorName: string): VendorSocials {
    const socials = setSocialVerification(getSocials(vendorId), network, verified, actorName);
    saveWorkspace(vendorId, { socials });
    return socials;
  }

  function listSocials(): Array<{ vendorId: string; socials: VendorSocials }> {
    const data = readFile();
    return Object.entries(data.workspaces)
      .map(([vendorId, ws]) => ({
        vendorId,
        socials: ws.socials && Array.isArray(ws.socials.links) ? ws.socials : emptyVendorSocials(),
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

  function summary(vendorId: string) {
    const ws = getWorkspace(vendorId);
    const revenue = ws.bookings.reduce((sum, b) => sum + Number(b.totalAmount || 0), 0);
    return {
      bookingCount: ws.bookings.length,
      blockedDateCount: ws.blockedDates.length,
      inventoryCount: ws.inventoryItems.length,
      listingCount: ws.listings.length,
      revenue,
      updatedAt: ws.updatedAt,
    };
  }

  function listSummaries(): Record<string, ReturnType<typeof summary>> {
    const data = readFile();
    const out: Record<string, ReturnType<typeof summary>> = {};
    for (const vendorId of Object.keys(data.workspaces)) {
      out[vendorId] = summary(vendorId);
    }
    return out;
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
    stripCatalogClonedListings,
    saveWorkspace,
    addBooking,
    updateBooking,
    removeBooking,
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
    verifySocial,
    listSocials,
    summary,
    listSummaries,
  };
}
