import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createExternalBookingStore,
  normalizeCollection,
  validateExternalBooking,
} from './external-bookings.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-exb-'));
}

const base = {
  courierId: 'usr-courier',
  courierName: 'سعد الدوسري',
  customerName: 'نورة',
  phone: '0551234567',
  city: 'الرياض',
  serviceType: 'قهوة وضيافة',
  eventDate: '2026-10-12',
  amount: 1200,
  collection: 'cash',
};

describe('external-bookings', () => {
  it('validates a full external booking and keeps the Saudi mobile normalized', () => {
    const clean = validateExternalBooking({ ...base, phone: '+966551234567', taxIncluded: true, guests: '40' });
    assert.equal(clean.phone, '0551234567');
    assert.equal(clean.guests, 40);
    assert.equal(clean.taxIncluded, true);
    assert.equal(clean.status, 'جديد');
    assert.equal(clean.collection, 'cash');
  });

  it('rejects a bad mobile, a missing date and a missing collection method', () => {
    assert.throws(() => validateExternalBooking({ ...base, phone: '0121234567' }), /05xxxxxxxx/);
    assert.throws(() => validateExternalBooking({ ...base, eventDate: '12-10-2026' }), /تاريخ المناسبة/);
    assert.throws(() => validateExternalBooking({ ...base, collection: 'bitcoin' }), /طريقة التحصيل/);
    assert.throws(() => validateExternalBooking({ ...base, customerName: '  ' }), /اسم العميل/);
  });

  it('accepts the Arabic collection labels', () => {
    assert.equal(normalizeCollection('كاش'), 'cash');
    assert.equal(normalizeCollection('تحويل'), 'transfer');
    assert.equal(normalizeCollection('تحصيل مع المورّد'), 'vendor_collect');
    assert.equal(normalizeCollection('شيك'), null);
  });

  it('stores rows and scopes the list to the courier who filed them', () => {
    const store = createExternalBookingStore(tmpDir());
    store.create(base, 'usr-courier');
    store.create({ ...base, courierId: 'crr-2', courierName: 'فهد' }, 'usr-admin');
    assert.equal(store.list().length, 2);
    assert.equal(store.listFor({ id: 'usr-courier', role: 'courier' }).length, 1);
    assert.equal(store.listFor({ id: 'usr-admin', role: 'admin' }).length, 2);
  });

  it('updates the status without letting the courier be reassigned', () => {
    const store = createExternalBookingStore(tmpDir());
    const created = store.create(base, 'usr-courier');
    const updated = store.update(created.id, { status: 'مؤكد', courierId: 'crr-hijack' });
    assert.equal(updated?.status, 'مؤكد');
    assert.equal(updated?.courierId, 'usr-courier');
    assert.ok(updated?.updatedAt);
    assert.equal(store.remove(created.id), true);
    assert.equal(store.remove(created.id), false);
  });
});
