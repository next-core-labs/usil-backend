import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createBookingStore, type PlatformBooking } from './booking-store.ts';

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

  it('scopes a client to their own orders by email or phone', () => {
    const store = createBookingStore(tmpDir());
    store.add(booking({ id: 'BK-mine-email', email: 'me@usil.sa', phone: '0500000000' }));
    store.add(booking({ id: 'BK-mine-phone', email: '', phone: '0512345678' }));
    store.add(booking({ id: 'BK-theirs', email: 'other@usil.sa', phone: '0599999999' }));

    const mine = store.listForClient({ email: 'me@usil.sa', phone: '0512345678' });
    assert.deepEqual(mine.map((row) => row.id).sort(), ['BK-mine-email', 'BK-mine-phone']);
  });

  it('never matches a booking on an empty identifier', () => {
    const store = createBookingStore(tmpDir());
    // Guest checkout can store an empty email; that must not become a wildcard.
    store.add(booking({ id: 'BK-no-email', email: '', phone: '0511111111' }));
    assert.deepEqual(store.listForClient({ email: '', phone: '' }), []);
    assert.deepEqual(store.listForClient({}), []);
  });

  it('updates a status and reports a missing row', () => {
    const store = createBookingStore(tmpDir());
    store.add(booking({ id: 'BK-7' }));
    assert.equal(store.updateStatus('BK-7', 'confirmed')?.status, 'confirmed');
    assert.equal(statusOf(store, 'BK-7'), 'confirmed');
    assert.equal(store.updateStatus('BK-absent', 'confirmed'), null);
  });

  it('removes a booking', () => {
    const store = createBookingStore(tmpDir());
    store.add(booking({ id: 'BK-a' }));
    store.add(booking({ id: 'BK-b' }));
    store.remove('BK-a');
    assert.deepEqual(store.list().map((row) => row.id), ['BK-b']);
  });

  describe('Moyasar settlement', () => {
    it('settles by booking id and stamps the paid settlement label', () => {
      const store = createBookingStore(tmpDir());
      store.add(booking({ id: 'BK-pay-1' }));

      const settled = store.markPaidFromMoyasar({
        bookingId: 'BK-pay-1',
        paymentId: 'pay_123',
        status: 'paid',
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
      const settled = store.markPaidFromMoyasar({ invoiceId: 'inv_777', status: 'paid' });
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
  });
});
