import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LISTING_VIEWS_RETENTION_DAYS, createListingViewStore, riyadhDay } from './listing-views.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-views-'));
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-02T12:00:00Z');

describe('listing-views store', () => {
  it('counts opens per listing per Riyadh day', () => {
    const store = createListingViewStore(tmpDir());
    assert.equal(store.record('a', NOW), 1);
    assert.equal(store.record('a', NOW), 2);
    assert.equal(store.record('b', NOW), 1);
    assert.equal(store.record('', NOW), 0);
    assert.deepEqual(store.read().days, { '2026-10-02': { a: 2, b: 1 } });
  });

  it('buckets by the Riyadh calendar, not UTC', () => {
    const store = createListingViewStore(tmpDir());
    const lateUtc = new Date('2026-10-02T22:30:00Z'); // 01:30 on 3 Oct in Riyadh
    assert.equal(riyadhDay(lateUtc), '2026-10-03');
    store.record('a', lateUtc);
    assert.deepEqual(Object.keys(store.read().days), ['2026-10-03']);
  });

  it('sums a window of calendar days, today included', () => {
    const store = createListingViewStore(tmpDir());
    store.record('a', NOW);
    store.record('a', new Date(NOW.getTime() - 6 * DAY));
    store.record('a', new Date(NOW.getTime() - 7 * DAY)); // outside a 7-day window
    store.record('b', new Date(NOW.getTime() - 2 * DAY));
    const counts = store.countsSince(7, NOW);
    assert.equal(counts.get('a'), 2);
    assert.equal(counts.get('b'), 1);
    assert.equal(store.countsSince(1, NOW).get('a'), 1);
  });

  it('prunes history past the retention horizon on write', () => {
    const store = createListingViewStore(tmpDir());
    store.record('a', new Date(NOW.getTime() - (LISTING_VIEWS_RETENTION_DAYS + 5) * DAY));
    assert.equal(Object.keys(store.read().days).length, 1);
    store.record('b', NOW);
    assert.deepEqual(Object.keys(store.read().days), ['2026-10-02']);
  });

  it('survives a corrupt or foreign document', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'listing-views.json'), JSON.stringify({ days: { bad: 1, '2026-10-01': { a: 'x', b: 2 } } }));
    const store = createListingViewStore(dir);
    assert.deepEqual(store.read().days, { '2026-10-01': { b: 2 } });
    fs.writeFileSync(path.join(dir, 'listing-views.json'), '[1,2');
    assert.deepEqual(createListingViewStore(dir).read().days, {});
  });
});
