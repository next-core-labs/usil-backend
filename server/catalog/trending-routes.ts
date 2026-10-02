import type { Express, Request, Response } from 'express';
import type { ServiceItem } from '../../core/types.ts';
import type { PlatformBooking } from '../bookings/booking-store.ts';
import { clientIp, createSlidingWindowLimiter } from '../shared/booking-guards.ts';
import { createListingViewStore } from './listing-views.ts';
import {
  TRENDING_DEFAULT_LIMIT,
  TRENDING_WINDOW_DAYS,
  rankTrending,
  type TrendingService,
} from './trending.ts';

export type TrendingDeps = {
  /** The public catalog — the same rows `GET /api/catalog/listings` serves. */
  listServices: () => ServiceItem[];
  /** `createdAt` per listing id; the vendor store knows it, the public service does not carry it. */
  listListings: () => Array<{ id: string; createdAt?: string }>;
  /** Platform bookings, newest first. */
  listBookings: () => PlatformBooking[];
  now?: () => Date;
  /** How long one computed shelf is served before it is rebuilt. 0 disables the cache. */
  cacheMs?: number;
};

/** One client may open many products; the same client reopening one product is not a trend. */
const VIEW_BURST_LIMIT = 120;
const VIEW_BURST_WINDOW_MS = 60_000;
const VIEW_DEDUPE_WINDOW_MS = 30 * 60_000;
const DEFAULT_CACHE_MS = 30_000;

const NOT_FOUND = 'المنتج غير موجود';
const RATE_LIMITED = 'محاولات كثيرة. حاول بعد قليل.';

export function registerTrendingRoutes(app: Express, dataDir: string, deps: TrendingDeps) {
  const views = createListingViewStore(dataDir);
  const now = deps.now || (() => new Date());
  const cacheMs = deps.cacheMs === undefined ? DEFAULT_CACHE_MS : Math.max(0, deps.cacheMs);
  const burst = createSlidingWindowLimiter(VIEW_BURST_LIMIT, VIEW_BURST_WINDOW_MS);
  const dedupe = createSlidingWindowLimiter(1, VIEW_DEDUPE_WINDOW_MS);

  const cache = new Map<number, { at: number; rows: TrendingService[] }>();

  function shelf(limit: number): TrendingService[] {
    const at = now().getTime();
    const hit = cache.get(limit);
    if (hit && cacheMs > 0 && at - hit.at < cacheMs) return hit.rows;
    const current = now();
    const createdAt = new Map<string, string>();
    for (const listing of deps.listListings()) {
      if (listing?.id && listing.createdAt) createdAt.set(String(listing.id), String(listing.createdAt));
    }
    const rows = rankTrending({
      services: deps.listServices(),
      bookings: deps.listBookings(),
      views: views.countsSince(TRENDING_WINDOW_DAYS, current),
      createdAt,
      now: current,
      windowDays: TRENDING_WINDOW_DAYS,
      limit,
    });
    cache.set(limit, { at, rows });
    return rows;
  }

  /** الأكثر رواجاً هذا الأسبوع — ranked public listings with the numbers behind the rank. */
  app.get('/api/catalog/trending', (req: Request, res: Response) => {
    const requested = Math.floor(Number(req.query.limit));
    const limit = Number.isFinite(requested) && requested > 0 ? requested : TRENDING_DEFAULT_LIMIT;
    const rows = shelf(limit);
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.json({
      success: true,
      windowDays: TRENDING_WINDOW_DAYS,
      generatedAt: now().toISOString(),
      data: rows,
    });
  });

  /**
   * تسجيل مشاهدة منتج — fired by the storefront when a product page opens.
   * Unknown or unlisted ids are refused so the counter only ever holds public
   * listings; a repeat open from the same caller inside half an hour is
   * acknowledged but not counted.
   */
  app.post('/api/catalog/listings/:id/view', (req: Request, res: Response) => {
    const ip = clientIp(req);
    if (!burst.allow(`view:${ip}`)) {
      return res.status(429).json({ success: false, error: RATE_LIMITED });
    }
    const id = String(req.params.id || '').trim();
    const listed = id && deps.listServices().some((service) => String(service.id) === id);
    if (!listed) return res.status(404).json({ success: false, error: NOT_FOUND });
    const counted = dedupe.allow(`view:${ip}:${id}`);
    if (counted) {
      views.record(id, now());
      cache.clear();
    }
    res.json({ success: true, counted });
  });

  return { views, shelf, invalidate: () => cache.clear() };
}
