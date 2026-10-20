import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeVendorEarnings, PLATFORM_COMMISSION_RATE, rawBalanceHalalas } from './earnings.ts';
import type { PlatformBooking } from '../bookings/booking-store.ts';

function order(overrides: Partial<PlatformBooking> = {}): PlatformBooking {
  return {
    id: 'BK-1',
    name: 'نواف',
    phone: '0512345678',
    email: 'c@usil.sa',
    serviceId: 'lst-a',
    serviceName: 'ركن قهوة',
    notes: '',
    city: 'الرياض',
    eventDate: '2026-10-10',
    paymentMethod: 'moyasar',
    settlement: 'ميسر',
    items: [{ id: 'lst-a', title: 'ركن قهوة', quantity: 1, price: 1000, vendorId: 'v-1' }],
    vendorIds: ['v-1'],
    totalAmount: 1000,
    bookingMode: 'instant',
    status: 'مكتمل',
    paymentStatus: 'paid',
    createdAt: '2026-10-01 10:00',
    ...overrides,
  };
}

const OWN = new Set(['lst-a']);

describe('computeVendorEarnings', () => {
  it('takes the 15% commission off completed orders', () => {
    const out = computeVendorEarnings({ vendorId: 'v-1', ownListingIds: OWN, bookings: [order()], payouts: [] });
    assert.equal(PLATFORM_COMMISSION_RATE, 0.15);
    assert.equal(out.commissionRate, 0.15);
    assert.equal(out.available, 850);
    assert.equal(out.earned, 850);
    assert.equal(out.pending, 0);
    assert.deepEqual(
      out.orders.map((row) => [row.id, row.gross, row.commission, row.net, row.bucket]),
      [['BK-1', 1000, 150, 850, 'available']],
    );
  });

  it('holds paid but not completed orders in escrow and skips unpaid ones', () => {
    const out = computeVendorEarnings({
      vendorId: 'v-1',
      ownListingIds: OWN,
      bookings: [
        order({ id: 'BK-confirmed', status: 'مؤكد', totalAmount: 200, items: [{ id: 'lst-a', title: 'x', quantity: 2, price: 100, vendorId: 'v-1' }] }),
        order({ id: 'BK-running', status: 'قيد التنفيذ', totalAmount: 100, items: [{ id: 'lst-a', title: 'x', quantity: 1, price: 100, vendorId: 'v-1' }] }),
        order({ id: 'BK-unpaid', status: 'جديد', paymentStatus: 'unpaid' }),
      ],
      payouts: [],
    });
    assert.equal(out.pending, 255);
    assert.equal(out.available, 0);
    assert.deepEqual(out.orders.map((row) => row.id), ['BK-confirmed', 'BK-running']);
  });

  it('counts only the vendor own lines of a mixed cart', () => {
    const mixed = order({
      id: 'BK-mixed',
      vendorIds: ['v-1', 'v-2'],
      totalAmount: 1300,
      items: [
        { id: 'lst-a', title: 'قهوة', quantity: 2, price: 150, vendorId: 'v-1' },
        { id: 'lst-tent', title: 'خيمة', quantity: 1, price: 1000, vendorId: 'v-2' },
      ],
    });
    const v1 = computeVendorEarnings({ vendorId: 'v-1', ownListingIds: OWN, bookings: [mixed], payouts: [] });
    assert.equal(v1.orders[0].gross, 300);
    assert.equal(v1.orders[0].commission, 45);
    assert.equal(v1.available, 255);
    const v2 = computeVendorEarnings({ vendorId: 'v-2', ownListingIds: new Set(['lst-tent']), bookings: [mixed], payouts: [] });
    assert.equal(v2.available, 850);
    const v3 = computeVendorEarnings({ vendorId: 'v-3', ownListingIds: new Set(), bookings: [mixed], payouts: [] });
    assert.equal(v3.orders.length, 0);
  });

  it('excludes cancelled, rejected and refund-owed orders', () => {
    const out = computeVendorEarnings({
      vendorId: 'v-1',
      ownListingIds: OWN,
      bookings: [
        order({ id: 'BK-cancelled', status: 'ملغي' }),
        order({ id: 'BK-rejected', status: 'مرفوض من المورّد' }),
        order({
          id: 'BK-dup',
          status: 'مكتمل',
          duplicatePayments: [{ paymentId: 'p2', amount: 1000, at: '2026-10-01', refundStatus: 'pending' }],
        }),
        order({ id: 'BK-ok', totalAmount: 100, items: [{ id: 'lst-a', title: 'x', quantity: 1, price: 100, vendorId: 'v-1' }] }),
      ],
      payouts: [],
    });
    assert.equal(out.available, 85);
    assert.equal(out.pending, 0);
    assert.deepEqual(
      out.orders.filter((row) => row.bucket === 'excluded').map((row) => row.id),
      ['BK-cancelled', 'BK-rejected', 'BK-dup'],
    );
    assert.equal(out.orders.find((row) => row.id === 'BK-dup')?.refundPending, true);
  });

  it('subtracts requested, approved and paid payouts — not rejected ones', () => {
    const out = computeVendorEarnings({
      vendorId: 'v-1',
      ownListingIds: OWN,
      bookings: [order()],
      payouts: [
        { status: 'paid', amount: 300 },
        { status: 'approved', amount: 100 },
        { status: 'requested', amount: 50.5 },
        { status: 'rejected', amount: 400 },
      ],
    });
    assert.equal(out.paidOut, 300);
    assert.equal(out.inReview, 150.5);
    assert.equal(out.available, 399.5);
    assert.equal(rawBalanceHalalas(out), 39950);
  });

  it('never reports a negative available balance', () => {
    const out = computeVendorEarnings({
      vendorId: 'v-1',
      ownListingIds: OWN,
      bookings: [order({ status: 'ملغي' })],
      payouts: [{ status: 'paid', amount: 850 }],
    });
    assert.equal(out.available, 0);
    assert.ok(rawBalanceHalalas(out) < 0);
  });

  it('rounds commission to halalas without float drift', () => {
    const out = computeVendorEarnings({
      vendorId: 'v-1',
      ownListingIds: OWN,
      bookings: [order({ totalAmount: 120.5, items: [{ id: 'lst-a', title: 'x', quantity: 1, price: 120.5, vendorId: 'v-1' }] })],
      payouts: [],
    });
    assert.equal(out.orders[0].commission, 18.08);
    assert.equal(out.orders[0].net, 102.42);
  });
});
