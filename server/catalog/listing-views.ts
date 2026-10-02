import path from 'path';
import { readJsonFile, writeJsonFile } from '../shared/json-file.ts';

/**
 * مشاهدات المنتجات — a per-day counter of product-page opens, the second
 * signal behind «ترند هالأسبوع» (the first is paid bookings).
 *
 * Shape: `{ version: 1, days: { "2026-10-02": { "<listingId>": 3 } } }`.
 * Keying by day first keeps the window query and the pruning trivial, and the
 * document stays small: a listing adds one integer per day it was viewed.
 */
export type ListingViewsDocument = {
  version: 1;
  days: Record<string, Record<string, number>>;
};

/** Days of history kept on every write; the trending window is far shorter. */
export const LISTING_VIEWS_RETENTION_DAYS = 60;

const RIYADH_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Calendar day on the Riyadh clock as `YYYY-MM-DD` — the same day the storefront shows. */
export function riyadhDay(now: Date): string {
  return new Date(now.getTime() + RIYADH_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` of `daysBack` days before `now` (Riyadh clock). */
export function riyadhDayBefore(now: Date, daysBack: number): string {
  return riyadhDay(new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000));
}

function emptyDocument(): ListingViewsDocument {
  return { version: 1, days: {} };
}

function normalize(raw: unknown): ListingViewsDocument {
  if (!raw || typeof raw !== 'object') return emptyDocument();
  const days = (raw as { days?: unknown }).days;
  if (!days || typeof days !== 'object' || Array.isArray(days)) return emptyDocument();
  const clean: ListingViewsDocument['days'] = {};
  for (const [day, counts] of Object.entries(days as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !counts || typeof counts !== 'object') continue;
    const row: Record<string, number> = {};
    for (const [id, count] of Object.entries(counts as Record<string, unknown>)) {
      const n = Math.floor(Number(count));
      if (id && Number.isFinite(n) && n > 0) row[id] = n;
    }
    if (Object.keys(row).length) clean[day] = row;
  }
  return { version: 1, days: clean };
}

export function createListingViewStore(dataDir: string) {
  const file = path.join(dataDir, 'listing-views.json');

  function read(): ListingViewsDocument {
    return normalize(readJsonFile<unknown>(file, null));
  }

  function save(doc: ListingViewsDocument, now: Date) {
    const cutoff = riyadhDayBefore(now, LISTING_VIEWS_RETENTION_DAYS);
    for (const day of Object.keys(doc.days)) {
      if (day < cutoff) delete doc.days[day];
    }
    writeJsonFile(file, doc);
  }

  /** Count one product-page open. Returns the listing's total for that day. */
  function record(listingId: string, now = new Date()): number {
    const id = String(listingId || '').trim();
    if (!id) return 0;
    const doc = read();
    const day = riyadhDay(now);
    const row = doc.days[day] || (doc.days[day] = {});
    row[id] = (row[id] || 0) + 1;
    save(doc, now);
    return row[id];
  }

  /**
   * Views per listing over the last `windowDays` calendar days, today
   * included — so `windowDays = 7` is today plus the six days before it.
   */
  function countsSince(windowDays: number, now = new Date()): Map<string, number> {
    const since = riyadhDayBefore(now, Math.max(0, windowDays - 1));
    const totals = new Map<string, number>();
    for (const [day, counts] of Object.entries(read().days)) {
      if (day < since) continue;
      for (const [id, n] of Object.entries(counts)) totals.set(id, (totals.get(id) || 0) + n);
    }
    return totals;
  }

  return { record, countsSince, read };
}

export type ListingViewStore = ReturnType<typeof createListingViewStore>;
