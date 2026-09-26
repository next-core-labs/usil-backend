import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  PLATFORM_BOOKING_STATUSES,
  createBookingStore,
  isPlatformBookingStatus,
  vendorOwnsWholeBooking,
  type PlatformBooking,
} from './booking-store.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-bookings-'));
}

function booking(overrides: Partial<PlatformBooking> = {}): PlatformBooking {
  return {
    id: 'BK-100001',
    name: 'نواف',
    phone: '0512345678',
    email: 'client@usil.sa',
    serviceName: 'ركن ضيافة',
    notes: '',
    city: 'الرياض',
    eventDate: '2026-10-01',
    paymentMethod: 'moyasar',
    settlement: 'ميسر',
    items: [],
    totalAmount: 1500,
    bookingMode: 'instant',
    status: 'new',
    paymentStatus: 'unpaid',
    createdAt: '2026-09-11 10:00',
    ...overrides,
  };
}

function statusOf(store: ReturnType<typeof createBookingStore>, id: string) {
  return store.list().find((row) => row.id === id)?.status;
}

describe('booking store', () => {
  it('starts empty and persists across store instances', () => {
    const dir = tmpDir();
    const store = createBookingStore(dir);
    assert.deepEqual(store.list(), []);
    assert.equal(store.count(), 0);

    store.add(booking());
    assert.equal(createBookingStore(dir).count(), 1);
  });

  it('keeps newest first', () => {
    const store = createBookingStore(tmpDir());
    store.add(booking({ id: 'BK-1' }));
    store.add(booking({ id: 'BK-2' }));
    assert.deepEqual(store.list().map((row) => row.id), ['BK-2', 'BK-1']);
  });

  it('scopes a client to orders placed from their account or their verified email', () => {
    const store = createBookingStore(tmpDir());
    store.add(booking({ id: 'BK-mine-session', userId: 'u-me', email: '', phone: '0500000000' }));
    store.add(booking({ id: 'BK-mine-email', email: 'Me@usil.sa', phone: '0500000001' }));
    store.add(booking({ id: 'BK-theirs', email: 'other@usil.sa', phone: '0599999999' }));

    const mine = store.listForClient({ id: 'u-me', email: 'me@usil.sa', emailVerified: true });
    assert.deepEqual(mine.map((row) => row.id).sort(), ['BK-mine-email', 'BK-mine-session']);
  });

  it('does not match by email until that email is verified', () => {
    const store = createBookingStore(tmpDir());
    store.add(booking({ id: 'BK-guest', email: 'guest@usil.sa' }));
    assert.deepEqual(store.listForClient({ id: 'u-new', email: 'guest@usil.sa', emailVerified: false }), []);
    assert.deepEqual(store.listForClient({ id: 'u-new', email: 'guest@usil.sa' }), []);
    assert.equal(store.listForClient({ id: 'u-new', email: 'guest@usil.sa', emailVerified: true }).length, 1);
  });

  it('never matches by phone', () => {
    const store = createBookingStore(tmpDir());
    store.add(booking({ id: 'BK-guest-phone', email: '', phone: '0512345678' }));
    const identity = { id: 'u-x', email: 'x@usil.sa', emailVerified: true, phone: '0512345678' };
    assert.deepEqual(store.listForClient(identity), []);
  });

  it('never matches a booking on an empty identifier', () => {
    const store = createBookingStore(tmpDir());
    // Guest checkout can store an empty email; that must not become a wildcard.
    store.add(booking({ id: 'BK-no-email', email: '', phone: '0511111111' }));
    assert.deepEqual(store.listForClient({ id: '', email: '', emailVerified: true }), []);
    assert.deepEqual(store.listForClient({}), []);
  });

  it('scopes a vendor to orders stamped with their id or holding their listings', () => {
    const store = createBookingStore(tmpDir());
    store.add(booking({ id: 'BK-stamped', vendorIds: ['v-1'] }));
    store.add(booking({ id: 'BK-legacy', serviceId: 'lst-own', items: [{ id: 'lst-own' }] }));
    store.add(booking({ id: 'BK-other', vendorIds: ['v-2'], serviceId: 'lst-other' }));
    const rows = store.listForVendor('v-1', ['lst-own']);
    assert.deepEqual(rows.map((row) => row.id).sort(), ['BK-legacy', 'BK-stamped']);
    assert.equal(store.listForVendor('', ['lst-own']).length, 0);
  });

  it('knows when every line on an order is one vendor\'s', () => {
    const own = new Set(['lst-a']);
    assert.equal(vendorOwnsWholeBooking('v-1', own, booking({ vendorIds: ['v-1'] })), true);
    assert.equal(vendorOwnsWholeBooking('v-1', own, booking({ vendorIds: ['v-1', 'v-2'] })), false);
    assert.equal(vendorOwnsWholeBooking('v-1', own, booking({ serviceId: 'lst-a', items: [{ id: 'lst-b' }] })), false);
    assert.equal(vendorOwnsWholeBooking('v-1', own, booking({ serviceId: 'lst-a', items: [{ id: 'lst-a' }] })), true);
  });

  it('updates a status and reports a missing row', () => {
    const store = createBookingStore(tmpDir());
    store.add(booking({ id: 'BK-7' }));
    assert.equal(store.updateStatus('BK-7', 'مؤكد')?.status, 'مؤكد');
    assert.equal(statusOf(store, 'BK-7'), 'مؤكد');
    assert.equal(store.updateStatus('BK-absent', 'مؤكد'), null);
  });

  it('refuses a status outside the canonical list', () => {
    const store = createBookingStore(tmpDir());
    store.add(booking({ id: 'BK-8', status: 'جديد' }));
    assert.equal(store.updateStatus('BK-8', 'hacked'), null);
    assert.equal(store.updateStatus('BK-8', ''), null);
    assert.equal(statusOf(store, 'BK-8'), 'جديد');
    assert.equal(isPlatformBookingStatus('ملغي'), true);
    assert.equal(isPlatformBookingStatus(null), false);
    assert.ok(PLATFORM_BOOKING_STATUSES.includes('بانتظار موافقة المورّد'));
  });

  it('removes a booking and reports a missing one', () => {
    const store = createBookingStore(tmpDir());
    store.add(booking({ id: 'BK-a' }));
    store.add(booking({ id: 'BK-b' }));
    assert.equal(store.remove('BK-a'), true);
    assert.deepEqual(store.list().map((row) => row.id), ['BK-b']);
    assert.equal(store.remove('BK-a'), false);
  });

  it('finds a recent identical unpaid checkout, and only that', () => {
    const store = createBookingStore(tmpDir());
    const now = Date.parse('2026-09-11T10:05:00Z');
    store.add(booking({ id: 'BK-dup', userId: 'u-1', serviceId: 'lst-a', items: [{ id: 'lst-a' }], createdAt: '2026-09-11 10:00' }));
    const query = { userId: 'u-1', listingIds: ['lst-a'], eventDate: '2026-10-01', windowMs: 10 * 60_000, now };
    assert.equal(store.findRecentDuplicate(query)?.id, 'BK-dup');
    assert.equal(store.findRecentDuplicate({ ...query, eventDate: '2026-10-02' }), null);
    assert.equal(store.findRecentDuplicate({ ...query, listingIds: ['lst-a', 'lst-b'] }), null);
    assert.equal(store.findRecentDuplicate({ ...query, userId: 'u-2' }), null);
    assert.equal(store.findRecentDuplicate({ ...query, now: now + 20 * 60_000 }), null);
  });

  it('records a cancellation with its refund decision', () => {
    const store = createBookingStore(tmpDir());
    store.add(booking({ id: 'BK-c' }));
    const updated = store.cancel('BK-c', {
      cancelledAt: '2026-09-11T10:00:00.000Z',
      cancelledBy: 'client',
      refundPercent: 0,
      refundHalalas: 0,
      refundStatus: 'not_applicable',
      note: 'x',
    });
    assert.equal(updated?.status, 'ملغي');
    assert.equal(store.findById('BK-c')?.cancellation?.refundStatus, 'not_applicable');
  });

  describe('Moyasar settlement', () => {
    it('settles by booking id and stamps the paid settlement label', () => {
      const store = createBookingStore(tmpDir());
      store.add(booking({ id: 'BK-pay-1' }));

      const settled = store.markPaidFromMoyasar({
        bookingId: 'BK-pay-1',
        paymentId: 'pay_123',
        status: 'paid',
        amountHalalas: 150_000,
        currency: 'SAR',
      });
      assert.equal(settled?.paymentStatus, 'paid');
      assert.equal(settled?.moyasarPaymentId, 'pay_123');
      assert.match(String(settled?.settlement), /ميسر/);
      // persisted, not just mutated in memory
      assert.equal(store.list()[0].paymentStatus, 'paid');
    });

    it('settles by invoice id when only the invoice is known', () => {
      const store = createBookingStore(tmpDir());
      store.add(booking({ id: 'BK-pay-2', moyasarInvoiceId: 'inv_777' }));
      const settled = store.markPaidFromMoyasar({ invoiceId: 'inv_777', status: 'paid', amountHalalas: 150_000 });
      assert.equal(settled?.id, 'BK-pay-2');
      assert.equal(settled?.paymentStatus, 'paid');
    });

    it('leaves a booking unpaid when the provider status is not paid', () => {
      const store = createBookingStore(tmpDir());
      store.add(booking({ id: 'BK-pay-3' }));
      const settled = store.markPaidFromMoyasar({ bookingId: 'BK-pay-3', status: 'failed' });
      assert.equal(settled?.paymentStatus, 'unpaid');
    });

    it('returns null for an invoice that belongs to no booking', () => {
      const store = createBookingStore(tmpDir());
      store.add(booking({ id: 'BK-pay-4' }));
      assert.equal(store.markPaidFromMoyasar({ invoiceId: 'inv_unknown', status: 'paid' }), null);
    });

    it('ignores blank identifiers instead of matching the first row', () => {
      const store = createBookingStore(tmpDir());
      store.add(booking({ id: 'BK-pay-5' }));
      assert.equal(store.markPaidFromMoyasar({ bookingId: '  ', invoiceId: '', status: 'paid' }), null);
      assert.equal(store.list()[0].paymentStatus, 'unpaid');
    });

    it('stays unpaid when Moyasar reports less than the booking total', () => {
      const store = createBookingStore(tmpDir());
      store.add(booking({ id: 'BK-pay-6', totalAmount: 1500 }));
      // A 1 SAR invoice carrying this booking id in its metadata.
      const settled = store.markPaidFromMoyasar({ bookingId: 'BK-pay-6', status: 'paid', amountHalalas: 100 });
      assert.equal(settled?.paymentStatus, 'unpaid');
      assert.equal(store.markPaidFromMoyasar({ bookingId: 'BK-pay-6', status: 'paid' })?.paymentStatus, 'unpaid');
      assert.equal(
        store.markPaidFromMoyasar({ bookingId: 'BK-pay-6', status: 'paid', amountHalalas: 150_000, currency: 'USD' })
          ?.paymentStatus,
        'unpaid',
      );
    });

    it('prefers the stored invoice over a metadata booking id', () => {
      const store = createBookingStore(tmpDir());
      store.add(booking({ id: 'BK-pay-7', moyasarInvoiceId: 'inv_real' }));
      store.add(booking({ id: 'BK-pay-8', moyasarInvoiceId: 'inv_other' }));
      const settled = store.markPaidFromMoyasar({
        invoiceId: 'inv_real',
        bookingId: 'BK-pay-8',
        status: 'paid',
        amountHalalas: 150_000,
      });
      assert.equal(settled?.id, 'BK-pay-7');
      assert.equal(store.findById('BK-pay-8')?.paymentStatus, 'unpaid');
    });

    it('owes a full refund when payment lands after an unpaid cancellation', () => {
      const store = createBookingStore(tmpDir());
      store.add(booking({ id: 'BK-pay-9', moyasarInvoiceId: 'inv_9' }));
      store.cancel('BK-pay-9', {
        cancelledAt: '2026-09-11T10:00:00.000Z',
        cancelledBy: 'client',
        refundPercent: 0,
        refundHalalas: 0,
        refundStatus: 'not_applicable',
        note: '',
      });
      const settled = store.markPaidFromMoyasar({ invoiceId: 'inv_9', status: 'paid', amountHalalas: 150_000 });
      assert.equal(settled?.paymentStatus, 'paid');
      assert.equal(settled?.cancellation?.refundStatus, 'pending');
      assert.equal(settled?.cancellation?.refundHalalas, 150_000);
    });
  });
});
