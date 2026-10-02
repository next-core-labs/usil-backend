import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ServiceItem } from '../../core/types.ts';
import type { PlatformBooking } from '../bookings/booking-store.ts';
import {
  OPEN_BOOKING_POINTS,
  PAID_BOOKING_POINTS,
  TRENDING_MAX_LIMIT,
  VIEW_POINTS,
  parseBookingTime,
  rankTrending,
} from './trending.ts';

const NOW = new Date('2026-10-02T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function service(id: string): ServiceItem {
  return {
    id,
    title: `منتج ${id}`,
    category: 'hospitality',
    categoryName: 'ضيافة',
    shortDesc: '',
    fullDesc: '',
    price: 100,
    priceUnit: 'للمناسبة',
    minNotice: '',
    cities: ['الرياض'],
    image: '/uploads/a.jpg',
    rating: 0,
    reviewsCount: 0,
    features: [],
    includes: [],
    provider: { id: 'v-1', name: 'مورّد', verified: false, rating: 0, completedOrders: 0, responseTime: '', responseRate: '' },
  } as ServiceItem;
}

function booking(
  items: string[],
  opts: { daysAgo?: number; paid?: boolean; status?: string; createdAt?: string } = {},
): PlatformBooking {
  const at = new Date(NOW.getTime() - (opts.daysAgo ?? 1) * DAY);
  return {
    id: `BK-${Math.random().toString(36).slice(2, 8)}`,
    name: 'عميل',
    phone: '0512345678',
    email: '',
    serviceId: items[0],
    serviceName: '',
    notes: '',
    city: 'الرياض',
    eventDate: '2026-12-01',
    paymentMethod: 'moyasar',
    settlement: '',
    items: items.map((id) => ({ id, title: id, quantity: 50, price: 100, vendorId: 'v-1' })),
    vendorIds: ['v-1'],
    totalAmount: 100,
    bookingMode: 'instant',
    status: opts.status || 'جديد',
    paymentStatus: opts.paid ? 'paid' : 'unpaid',
    createdAt: opts.createdAt ?? at.toISOString().replace('T', ' ').substring(0, 16),
  };
}

function rank(input: Partial<Parameters<typeof rankTrending>[0]>) {
  return rankTrending({
    services: [],
    bookings: [],
    views: new Map(),
    createdAt: new Map(),
    now: NOW,
    ...input,
  });
}

describe('parseBookingTime', () => {
  it('reads the store stamp (UTC without a zone) and full ISO strings alike', () => {
    assert.equal(parseBookingTime('2026-10-02 09:30'), Date.parse('2026-10-02T09:30:00Z'));
    assert.equal(parseBookingTime('2026-10-02T09:30:00.000Z'), Date.parse('2026-10-02T09:30:00Z'));
    assert.equal(parseBookingTime('2026-10-02T12:30:00+03:00'), Date.parse('2026-10-02T09:30:00Z'));
    assert.equal(parseBookingTime(''), null);
    assert.equal(parseBookingTime('not a date'), null);
  });
});

describe('rankTrending', () => {
  it('scores paid bookings above open ones above views, and ignores quantity', () => {
    const rows = rank({
      services: [service('a'), service('b'), service('c'), service('d')],
      bookings: [
        booking(['b'], { paid: true }), // 5
        booking(['c']), // 2
        booking(['c']), // +2 = 4
      ],
      views: new Map([
        ['a', 10], // 2.5
        ['d', 1], // 0.25
      ]),
    });
    assert.deepEqual(
      rows.map((row) => [row.id, row.trending.score]),
      [
        ['b', PAID_BOOKING_POINTS],
        ['c', 2 * OPEN_BOOKING_POINTS],
        ['a', 10 * VIEW_POINTS],
        ['d', VIEW_POINTS],
      ],
    );
    assert.deepEqual(rows.map((row) => row.trending.rank), [1, 2, 3, 4]);
    assert.equal(rows[0].trending.paidBookings, 1);
    assert.equal(rows[1].trending.bookings, 2);
    assert.equal(rows[2].trending.views, 10);
  });

  it('counts a listing once per order even when the cart holds it on several lines', () => {
    const rows = rank({
      services: [service('a')],
      bookings: [{ ...booking(['a', 'a']), items: [{ id: 'a' }, { id: 'a' }] }],
    });
    assert.equal(rows[0].trending.bookings, 1);
  });

  it('ignores cancelled and vendor-rejected orders and anything outside the window', () => {
    const rows = rank({
      services: [service('a'), service('b'), service('c')],
      bookings: [
        booking(['a'], { paid: true, status: 'ملغي' }),
        booking(['b'], { paid: true, status: 'مرفوض من المورّد' }),
        booking(['c'], { paid: true, daysAgo: 8 }),
        booking(['c'], { paid: true, daysAgo: -1 }), // clock skew: in the future
        booking(['c'], { paid: true, createdAt: 'garbage' }),
      ],
    });
    assert.ok(rows.every((row) => row.trending.score === 0));
  });

  it('counts the whole window: a booking six and a half days old is in, eight days is out', () => {
    const rows = rank({
      services: [service('a'), service('b')],
      bookings: [booking(['a'], { paid: true, daysAgo: 6.5 }), booking(['b'], { paid: true, daysAgo: 8 })],
    });
    assert.equal(rows[0].id, 'a');
    assert.equal(rows[0].trending.bookings, 1);
    assert.equal(rows[1].trending.bookings, 0);
  });

  it('falls back to the newest listings when nothing has moved, and flags them as new', () => {
    const rows = rank({
      services: [service('old'), service('fresh'), service('mid')],
      createdAt: new Map([
        ['old', new Date(NOW.getTime() - 40 * DAY).toISOString()],
        ['fresh', new Date(NOW.getTime() - 1 * DAY).toISOString()],
        ['mid', new Date(NOW.getTime() - 5 * DAY).toISOString()],
      ]),
    });
    assert.deepEqual(rows.map((row) => row.id), ['fresh', 'mid', 'old']);
    assert.deepEqual(rows.map((row) => row.trending.isNew), [true, true, false]);
  });

  it('only ranks listings in the public catalog, and drops bookings for anything else', () => {
    const rows = rank({
      services: [service('a')],
      bookings: [booking(['hidden'], { paid: true }), booking(['a'])],
    });
    assert.deepEqual(rows.map((row) => row.id), ['a']);
    assert.equal(rows[0].trending.bookings, 1);
  });

  it('applies the limit and caps it', () => {
    const services = Array.from({ length: 40 }, (_, i) => service(`s${String(i).padStart(2, '0')}`));
    assert.equal(rank({ services, limit: 3 }).length, 3);
    assert.equal(rank({ services, limit: 999 }).length, TRENDING_MAX_LIMIT);
    assert.equal(rank({ services, limit: 0 }).length, 8);
    assert.equal(rank({ services: services.slice(0, 2) }).length, 2);
  });

  it('keeps the service payload intact beside the trending block', () => {
    const [row] = rank({ services: [service('a')] });
    assert.equal(row.title, 'منتج a');
    assert.equal(row.price, 100);
    assert.equal(row.trending.windowDays, 7);
  });
});
