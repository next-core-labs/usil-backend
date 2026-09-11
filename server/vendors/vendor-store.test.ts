import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createVendorStore, emptyWorkspace } from './vendor-store.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-vendor-'));
}

describe('vendor-store', () => {
  it('starts with an empty workspace', () => {
    const store = createVendorStore(tmpDir());
    const ws = store.getWorkspace('usr-vendor');
    assert.deepEqual(ws.bookings, []);
    assert.deepEqual(ws.listings, []);
    assert.deepEqual(ws.blockedDates, []);
    assert.deepEqual(ws.socials?.links, []);
    assert.equal(emptyWorkspace().bookings.length, 0);
    assert.equal(emptyWorkspace().listings.length, 0);
  });

  it('persists a blank workspace for a newly approved vendor without seeding the catalog', () => {
    const store = createVendorStore(tmpDir());
    const created = store.ensureEmptyWorkspace('usr-new');
    assert.deepEqual(created.listings, []);
    assert.deepEqual(created.bookings, []);
    assert.deepEqual(created.blockedDates, []);
    assert.deepEqual(created.socials?.links, []);
    const again = store.ensureEmptyWorkspace('usr-new');
    assert.equal(again.listings.length, 0);
  });

  it('seeds a vendor workspace from the registration form, never a catalog clone', () => {
    const store = createVendorStore(tmpDir());
    const ws = store.seedWorkspaceFromApplication('usr-own', {
      firstName: 'نواف',
      fatherName: 'محمد',
      familyName: 'المهيع',
      projectName: 'ضيافة النخيل',
      projectType: 'ضيافة قهوة وشاي',
      email: 'own@usil.sa',
      phone: '0508888111',
      fulfillment: ['hour'],
      socials: store.getSocials('usr-own'),
      status: 'approved',
    });
    assert.deepEqual(ws.listings, []);
    assert.equal(ws.profile?.projectName, 'ضيافة النخيل');
    assert.equal(ws.profile?.personName, 'نواف محمد المهيع');
    const file = store.getPublicFile('usr-own', {
      projectName: 'ضيافة النخيل',
      firstName: 'نواف',
      fatherName: 'محمد',
      familyName: 'المهيع',
      projectType: 'ضيافة قهوة وشاي',
      status: 'approved',
      email: 'own@usil.sa',
    });
    assert.equal(file?.projectName, 'ضيافة النخيل');
    assert.equal(file?.listingCount, 0);
  });

  it('strips catalog-cloned listings by id and keeps vendor-created products', () => {
    const store = createVendorStore(tmpDir());
    store.saveWorkspace('usr-vendor', {
      // Only the fields this assertion reads — stripping keys off `id` alone.
      listings: [
        {
          id: 'royal-saudi-coffee',
          vendorId: 'usr-vendor',
          vendorName: 'نسخة الكتالوج',
          title: 'ركن الضيافة النجدية الملكية',
          category: 'hospitality',
          shortDesc: 'نسخة',
          price: 1850,
          fulfillment: ['hour'],
        },
        {
          id: 'lst-own-1',
          vendorId: 'usr-vendor',
          vendorName: 'قهوة نجد',
          title: 'قهوة المورد',
          category: 'hospitality',
          shortDesc: 'منتج خاص',
          price: 90,
          fulfillment: ['same_day'],
        },
      ],
    });
    const removed = store.stripCatalogClonedListings([]);
    assert.equal(removed, 1);
    const kept = store.getWorkspace('usr-vendor').listings;
    assert.equal(kept.length, 1);
    assert.equal(kept[0].id, 'lst-own-1');
  });

  it('rejects a booking without customer name and phone', () => {
    const store = createVendorStore(tmpDir());
    assert.throws(() => store.addBooking('usr-vendor', { serviceTitle: 'ضيافة' }), /مطلوبان/);
  });

  it('adds, updates, and removes a booking', () => {
    const store = createVendorStore(tmpDir());
    const created = store.addBooking('usr-vendor', {
      customerName: 'نواف',
      customerPhone: '0504444444',
      totalAmount: 4800,
      city: 'الرياض',
    });
    assert.equal(created.customerName, 'نواف');
    assert.ok(created.id.startsWith('bk-'));
    assert.equal(store.getWorkspace('usr-vendor').bookings.length, 1);

    const updated = store.updateBooking('usr-vendor', created.id, { status: 'completed' });
    assert.equal(updated?.status, 'completed');

    assert.equal(store.removeBooking('usr-vendor', created.id), true);
    assert.equal(store.getWorkspace('usr-vendor').bookings.length, 0);
    assert.equal(store.removeBooking('usr-vendor', created.id), false);
  });

  it('blocks dates and reports a summary', () => {
    const store = createVendorStore(tmpDir());
    store.addBooking('usr-vendor', { customerName: 'أ', customerPhone: '0501111111', totalAmount: 1000 });
    store.addBlockedDate('usr-vendor', { date: '2026-09-01', reason: 'صيانة', type: 'maintenance' });
    const sum = store.summary('usr-vendor');
    assert.equal(sum.bookingCount, 1);
    assert.equal(sum.blockedDateCount, 1);
    assert.equal(sum.revenue, 1000);
  });

  it('keeps vendor workspaces isolated', () => {
    const store = createVendorStore(tmpDir());
    store.addBooking('v1', { customerName: 'أ', customerPhone: '0501111111' });
    store.addBooking('v2', { customerName: 'ب', customerPhone: '0502222222' });
    assert.equal(store.getWorkspace('v1').bookings.length, 1);
    assert.equal(store.getWorkspace('v2').bookings[0].customerName, 'ب');
  });

  it('saves contracts inside the vendor workspace', () => {
    const store = createVendorStore(tmpDir());
    store.saveWorkspace('usr-vendor', {
      contracts: [{ id: 'cnt-01', contractNumber: 'CNT-1', clientName: 'نواف' }],
    });
    assert.equal(store.getWorkspace('usr-vendor').contracts[0].contractNumber, 'CNT-1');
  });

  it('requires a fulfillment lane on each vendor product', () => {
    const store = createVendorStore(tmpDir());
    assert.throws(
      () => store.addListing('usr-vendor', { title: 'قهوة', category: 'hospitality', price: 80 }),
      /صورتين/,
    );
    assert.throws(
      () =>
        store.addListing('usr-vendor', {
          title: 'قهوة',
          category: 'hospitality',
          price: 80,
          images: ['/uploads/listing-a.jpg', '/uploads/listing-b.jpg'],
        }),
      /مسار يوصل/,
    );
    const listing = store.addListing('usr-vendor', {
      title: 'قهوة سعودية',
      category: 'hospitality',
      price: 80,
      fulfillment: ['hour', 'same_day'],
      images: ['/uploads/listing-a.jpg', '/uploads/listing-b.jpg'],
    });
    assert.deepEqual(listing.fulfillment, ['hour', 'same_day']);
    assert.equal(store.getWorkspace('usr-vendor').listings.length, 1);
    const updated = store.updateListing('usr-vendor', listing.id, {
      fulfillment: ['tomorrow'],
    });
    assert.deepEqual(updated?.fulfillment, ['tomorrow']);
  });

  it('saves vendor socials and keeps them when other workspace fields change', () => {
    const store = createVendorStore(tmpDir());
    const socials = store.saveSocials('usr-vendor', {
      instagram: '@usil.cafe',
      confirmedOwn: true,
    });
    assert.equal(socials.links[0].status, 'linked');
    store.addBooking('usr-vendor', { customerName: 'نواف', customerPhone: '0504444444' });
    assert.equal(store.getSocials('usr-vendor').links[0].url, 'https://www.instagram.com/usil.cafe');
    const verified = store.verifySocial('usr-vendor', 'instagram', true, 'إدارة يوصل');
    assert.equal(verified.links[0].status, 'verified');
  });

  it('persists to disk across store instances', () => {
    const dir = tmpDir();
    const first = createVendorStore(dir);
    first.addBooking('usr-vendor', { customerName: 'خالد', customerPhone: '0555555555' });
    const second = createVendorStore(dir);
    assert.equal(second.getWorkspace('usr-vendor').bookings[0].customerName, 'خالد');
  });
});
