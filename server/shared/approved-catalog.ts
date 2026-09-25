import path from 'path';
import type { ServiceItem } from '../../core/types';
import { enrichVendorServices } from '../../core/data/saudiMarket';
import { isPublicMarketplaceListing, listingPhotoUrls } from '../../core/utils/catalogMedia';
import type { VendorListing } from '../vendors/vendor-listings';
import { readJsonArray } from './json-file';

/**
 * The public catalog, built the same way as `GET /api/catalog/listings`
 * (server/vendors/vendor-routes.ts): only listings whose vendor currently holds
 * an approved vendor account, turned into public services, enriched, and kept
 * only when they are sellable (a real price and a real photo).
 *
 * The sitemap, the SEO page meta and the AI catalog all read through here, so a
 * rejected or removed vendor's listing cannot surface in one of them while being
 * hidden from the storefront.
 */
export type ApprovedCatalogStore = {
  listAllListings: () => VendorListing[];
  listingToPublicService: (listing: VendorListing) => ServiceItem;
};

export function listApprovedCatalogServices(
  store: ApprovedCatalogStore,
  listVendorUsers: () => Array<{ id: string }>,
): ServiceItem[] {
  const approvedIds = new Set(listVendorUsers().map((user) => user.id));
  const listings = store.listAllListings().filter((listing) => approvedIds.has(listing.vendorId));
  return enrichVendorServices(listings.map((listing) => store.listingToPublicService(listing))).filter(
    isPublicMarketplaceListing,
  );
}

/**
 * Approved vendor accounts read straight from `users.json`, for callers that do
 * not hold the auth API. Mirrors `auth.listVendorUsers()` (role === 'vendor').
 */
export function vendorUsersFromDataDir(dataDir: string): () => Array<{ id: string }> {
  return () =>
    readJsonArray<{ id?: string; role?: string }>(path.join(dataDir, 'users.json'))
      .filter((user) => user.role === 'vendor' && typeof user.id === 'string' && user.id)
      .map((user) => ({ id: String(user.id) }));
}

/** Share metadata for one approved listing, or null when it is not in the public catalog. */
export type ServiceSeo = { title: string; description: string; image: string };

export function serviceSeoFrom(service: ServiceItem | undefined | null): ServiceSeo | null {
  if (!service) return null;
  const title = String(service.title || '').trim();
  if (!title) return null;
  const description = String(service.shortDesc || service.fullDesc || '').replace(/\s+/g, ' ').trim();
  const image = listingPhotoUrls(service)[0] || '';
  return { title, description, image };
}
