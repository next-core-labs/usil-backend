import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformBooking } from './booking-store.ts';
import {
  CHECKOUT_HOLD_MS,
  findSlotConflict,
  isStaleCheckout,
  platformOrderHoldsDate,
  staleCheckoutsOn,
  takenDatesForListing,
} from './slot-holds.ts';

const NOW = Date.parse('2026-10-16T09:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString().replace('T', ' ').slice(0, 16);

function order(overrides: Partial<PlatformBooking> = {}): PlatformBooking {
  return {
    id: 'BK-1',
    name: 'عميل',
    phone: '0512345678',
    email: 'c@usil.sa',
    serviceId: 'lst-a',
    serviceName: 'منتج',
    notes: '',
    city: 'الرياض',
    eventDate: '2026-10-20',
    paymentMethod: 'moyasar',
    settlement: 'ميسر',
    items: [{ id: 'lst-a', title: 'منتج', quantity: 1, price: 100, vendorId: 'v-1' }],
    vendorIds: ['v-1'],
    totalAmount: 100,
    bookingMode: 'instant',
    status: 'جديد',
    paymentStatus: 'unpaid',
    createdAt: minutesAgo(5),
    ...overrides,
  };
}

describe('slot holds — what holds a listing date', () => {
  it('a fresh unpaid checkout holds the date; past its window it does not', () => {
    assert.equal(platformOrderHoldsDate(order(), NOW), true);
    const old = order({ createdAt: minutesAgo(CHECKOUT_HOLD_MS / 60_000 + 1) });
    assert.equal(isStaleCheckout(old, NOW), true);
    assert.equal(platformOrderHoldsDate(old, NOW), false);
  });

  it('paid, waiting-on-vendor, approved, in-progress and completed orders always hold it', () => {
    const old = minutesAgo(60 * 24 * 3);
    assert.equal(platformOrderHoldsDate(order({ createdAt: old, paymentStatus: 'paid' }), NOW), true);
    for (const status of ['بانتظار موافقة المورّد', 'مؤكد', 'قيد التنفيذ', 'مكتمل']) {
      assert.equal(platformOrderHoldsDate(order({ createdAt: old, status }), NOW), true, status);
    }
  });

  it('cancelled and rejected orders free the date, paid or not', () => {
    for (const status of ['ملغي', 'مرفوض من المورّد']) {
      assert.equal(platformOrderHoldsDate(order({ status }), NOW), false, status);
      assert.equal(platformOrderHoldsDate(order({ status, paymentStatus: 'paid' }), NOW), false, status);
    }
  });
});

describe('slot holds — conflicts', () => {
  const orders = [
    order({ id: 'BK-a' }),
    order({ id: 'BK-b', serviceId: 'lst-b', items: [{ id: 'lst-b', title: 'ب', quantity: 1, price: 1, vendorId: 'v-1' }], eventDate: '2026-10-21' }),
  ];

  it('finds the order holding the listing on that date, and only that one', () => {
    assert.equal(findSlotConflict({ listingIds: ['lst-a'], date: '2026-10-20', orders, nowMs: NOW })?.kind, 'order');
    assert.equal(findSlotConflict({ listingIds: ['lst-a'], date: '2026-10-21', orders, nowMs: NOW }), null);
    assert.equal(findSlotConflict({ listingIds: ['lst-c'], date: '2026-10-20', orders, nowMs: NOW }), null);
    // An order never conflicts with itself.
    assert.equal(findSlotConflict({ listingIds: ['lst-a'], date: '2026-10-20', orders, excludeId: 'BK-a', nowMs: NOW }), null);
  });

  it('counts any line of a multi-listing order', () => {
    const multi = order({ id: 'BK-m', items: [{ id: 'lst-x', title: 'x', quantity: 1, price: 1, vendorId: 'v-1' }, { id: 'lst-y', title: 'y', quantity: 1, price: 1, vendorId: 'v-1' }], serviceId: 'lst-x' });
    const hit = findSlotConflict({ listingIds: ['lst-y'], date: '2026-10-20', orders: [multi], nowMs: NOW });
    assert.equal(hit?.kind === 'order' && hit.listingId, 'lst-y');
  });

  it('honours the vendor calendar, except cancelled entries', () => {
    const vendorBookings = [
      { id: 'vb-1', serviceId: 'lst-a', date: '2026-10-22', status: 'confirmed' },
      { id: 'vb-2', serviceId: 'lst-a', date: '2026-10-23', status: 'cancelled' },
    ];
    assert.equal(findSlotConflict({ listingIds: ['lst-a'], date: '2026-10-22', orders: [], vendorBookings, nowMs: NOW })?.kind, 'vendor');
    assert.equal(findSlotConflict({ listingIds: ['lst-a'], date: '2026-10-23', orders: [], vendorBookings, nowMs: NOW }), null);
  });

  it('can ignore orders still waiting on the vendor (approving one of two)', () => {
    const waiting = [order({ id: 'BK-w', status: 'بانتظار موافقة المورّد' })];
    const ignore = (row: PlatformBooking) => row.status === 'بانتظار موافقة المورّد';
    assert.notEqual(findSlotConflict({ listingIds: ['lst-a'], date: '2026-10-20', orders: waiting, nowMs: NOW }), null);
    assert.equal(findSlotConflict({ listingIds: ['lst-a'], date: '2026-10-20', orders: waiting, ignoreOrder: ignore, nowMs: NOW }), null);
  });

  it('lists abandoned checkouts on the date, and the taken dates of a listing', () => {
    const stale = order({ id: 'BK-stale', createdAt: minutesAgo(120) });
    const fresh = order({ id: 'BK-fresh', eventDate: '2026-10-25' });
    assert.deepEqual(staleCheckoutsOn({ listingIds: ['lst-a'], date: '2026-10-20', orders: [stale, fresh], nowMs: NOW }).map((r) => r.id), ['BK-stale']);
    const taken = takenDatesForListing({
      listingId: 'lst-a',
      orders: [stale, fresh, order({ id: 'BK-past', eventDate: '2026-10-01', paymentStatus: 'paid' })],
      vendorBookings: [{ serviceId: 'lst-a', date: '2026-10-28', status: 'confirmed' }],
      fromDate: '2026-10-16',
      nowMs: NOW,
    });
    assert.deepEqual(taken, ['2026-10-25', '2026-10-28']);
  });
});
