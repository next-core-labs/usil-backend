import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createVendorStore, dedupeById, emptyWorkspace, isIsoDate, todayInRiyadh } from './vendor-store.ts';

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-vendor-'));
  // Listing photos must exist under data/uploads now.
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  for (const name of ['listing-a.jpg', 'listing-b.jpg', 'listing-c.jpg', 'logo.png']) {
    fs.writeFileSync(path.join(dir, 'uploads', name), 'x');
  }
  return dir;
}

const IMAGES = ['/uploads/listing-a.jpg', '/uploads/listing-b.jpg'];
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function goodListing(extra: Record<string, unknown> = {}) {
  return {
    title: 'قهوة سعودية',
    category: 'hospitality',
    price: 80,
    fulfillment: ['hour'],
    images: IMAGES,
    ...extra,
  };
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

  /* ── QA fixes ────────────────────────────────────────────────── */

  it('never lets a vendor mark their own socials verified', () => {
    const store = createVendorStore(tmpDir());
    const forged = store.saveSocials('usr-vendor', {
      confirmedOwn: true,
      links: [
        {
          network: 'instagram',
          handle: 'usil.cafe',
          url: 'https://www.instagram.com/usil.cafe',
          status: 'verified',
          confirmedOwn: true,
          updatedAt: '2026-01-01',
          verifiedAt: '2026-01-01',
          verifiedBy: 'أنا',
        },
      ],
    });
    assert.equal(forged.links[0].status, 'linked');
    assert.equal(forged.links[0].verifiedBy, undefined);
    assert.equal(forged.links[0].verifiedAt, undefined);

    const viaWorkspace = store.saveVendorWorkspace('usr-other', {
      socials: {
        confirmedOwn: false,
        links: [{ network: 'x', handle: 'usil', url: 'https://x.com/usil', status: 'verified', verifiedBy: 'أنا', verifiedAt: 'x' }],
      },
    });
    assert.equal(viaWorkspace.socials?.links[0].status, 'pending');
    assert.equal(viaWorkspace.socials?.links[0].verifiedBy, undefined);
  });

  it('rejects javascript: and foreign-domain social links from vendors', () => {
    const store = createVendorStore(tmpDir());
    assert.throws(() =>
      store.saveSocials('usr-vendor', {
        links: [{ network: 'instagram', url: 'javascript:alert(1)', status: 'verified' }],
      }),
    );
    assert.throws(() => store.saveSocials('usr-vendor', { instagram: 'javascript://instagram.com/%0aalert(1)' }));
    assert.throws(() => store.saveSocials('usr-vendor', { instagram: 'https://evil.example/usil' }));
    assert.throws(() => store.saveSocials('usr-vendor', { x: 'https://instagram.com/usil' }));
    assert.throws(() => store.saveVendorWorkspace('usr-vendor', { socials: { tiktok: 'javascript:alert(1)' } }));
    assert.deepEqual(store.getSocials('usr-vendor').links, []);
  });

  it('drops admin verification when the vendor changes the URL', () => {
    const store = createVendorStore(tmpDir());
    store.saveSocials('usr-vendor', { instagram: '@usil.cafe', confirmedOwn: true });
    store.verifySocial('usr-vendor', 'instagram', true, 'إدارة يوصل');
    const same = store.saveSocials('usr-vendor', { instagram: '@usil.cafe', confirmedOwn: true });
    assert.equal(same.links[0].status, 'verified');
    const changed = store.saveSocials('usr-vendor', { instagram: '@other.cafe', confirmedOwn: true });
    assert.equal(changed.links[0].status, 'linked');
    assert.equal(changed.links[0].verifiedBy, undefined);
  });

  it('keeps unsafe or unstamped stored socials off the public file', () => {
    const store = createVendorStore(tmpDir());
    store.saveWorkspace('usr-vendor', {
      socials: {
        confirmedOwn: true,
        links: [
          { network: 'instagram', handle: 'a', url: 'javascript:alert(1)', status: 'linked', confirmedOwn: true, updatedAt: '' },
          { network: 'x', handle: 'usil', url: 'https://x.com/usil', status: 'verified', confirmedOwn: true, updatedAt: '' },
        ],
      },
    });
    const links = store.getPublicSocials('usr-vendor');
    assert.equal(links.length, 1);
    assert.equal(links[0].network, 'x');
    assert.equal(links[0].status, 'linked');
  });

  it('forces workspace listings onto the logged-in vendor and validates them like POST', () => {
    const store = createVendorStore(tmpDir());
    const ws = store.saveVendorWorkspace('v1', { listings: [goodListing({ vendorId: 'v2', id: 'lst-mine-1' })] });
    assert.equal(ws.listings.length, 1);
    assert.equal(ws.listings[0].vendorId, 'v1');
    assert.equal(ws.listings[0].id, 'lst-mine-1');
    assert.equal(store.listAllListings()[0].vendorId, 'v1');
    assert.throws(() => store.saveVendorWorkspace('v1', { listings: [goodListing({ images: [IMAGES[0]] })] }), /صورتين/);
    assert.throws(() => store.saveVendorWorkspace('v1', { listings: [goodListing({ fulfillment: [] })] }), /مسار يوصل/);
    assert.equal(store.getWorkspace('v1').listings[0].id, 'lst-mine-1');
  });

  it('refuses a workspace listing id that belongs to another vendor', () => {
    const store = createVendorStore(tmpDir());
    const theirs = store.addListing('v2', goodListing({ title: 'منتج مورد آخر' }));
    assert.throws(
      () => store.saveVendorWorkspace('v1', { listings: [goodListing({ id: theirs.id, title: 'سرقة' })] }),
      (error: Error & { status?: number }) => error.status === 403,
    );
    assert.equal(store.getWorkspace('v2').listings[0].title, 'منتج مورد آخر');
    assert.equal(store.getWorkspace('v1').listings.length, 0);
  });

  it('keeps untouched workspace listings and uses the vendor project name', () => {
    const store = createVendorStore(tmpDir());
    store.seedWorkspaceFromApplication('v1', { projectName: 'ضيافة النخيل', status: 'approved' });
    const listing = store.addListing('v1', goodListing({ vendorName: 'اسم مورد آخر' }));
    assert.equal(listing.vendorName, 'ضيافة النخيل');
    const ws = store.saveVendorWorkspace('v1', { listings: [listing] });
    assert.equal(ws.listings[0].updatedAt, listing.updatedAt);
    const edited = store.saveVendorWorkspace('v1', { listings: [{ ...listing, price: 120, vendorName: 'اسم مورد آخر' }] });
    assert.equal(edited.listings[0].price, 120);
    assert.equal(edited.listings[0].vendorName, 'ضيافة النخيل');
  });

  it('accepts only existing uploads or inline photos as listing images', () => {
    const dir = tmpDir();
    const store = createVendorStore(dir);
    for (const bad of [
      '/uploads/../vendor-workspaces.json',
      '/uploads/%2e%2e%2fvendor-workspaces.json',
      '/uploads/sub/listing-a.jpg',
      '/uploads/missing.jpg',
      'https://images.unsplash.com/photo-1',
      'https://cdn.example.com/a.jpg',
      'javascript:alert(1)',
    ]) {
      assert.throws(() => store.addListing('v1', goodListing({ images: [IMAGES[0], bad] })), /صورة المنتج غير صالحة/, bad);
      assert.throws(
        () => store.saveVendorWorkspace('v1', { listings: [goodListing({ images: [IMAGES[0], bad] })] }),
        /صورة المنتج غير صالحة/,
        bad,
      );
    }
    const listing = store.addListing('v1', goodListing({ images: [IMAGES[0], PNG_DATA_URL] }));
    assert.equal(listing.images?.length, 2);
    const saved = String(listing.images?.[1]);
    assert.ok(saved.startsWith('/uploads/listing-'));
    assert.ok(fs.existsSync(path.join(dir, 'uploads', path.basename(saved))));
    assert.throws(() => store.updateListing('v1', listing.id, { images: ['/uploads/missing.jpg', IMAGES[1]] }), /صورة/);
  });

  it('generates booking ids server-side and only books the vendor own listings', () => {
    const store = createVendorStore(tmpDir());
    const mine = store.addListing('v1', goodListing());
    const theirs = store.addListing('v2', goodListing());
    const base = { customerName: 'نواف', customerPhone: '0504444444', date: '2099-01-10' };
    const created = store.addBooking('v1', { ...base, id: 'bk-forged', serviceId: mine.id, serviceTitle: 'أي شي' });
    assert.notEqual(created.id, 'bk-forged');
    assert.ok(created.id.startsWith('bk-'));
    assert.equal(created.serviceTitle, mine.title);
    assert.throws(() => store.addBooking('v1', { ...base, serviceId: theirs.id }), /منتجاتك/);
    assert.throws(() => store.addBooking('v1', { ...base, serviceId: 'lst-nope' }), /منتجاتك/);
    const custom = store.addBooking('v1', { ...base, serviceTitle: 'حجز هاتفي' });
    assert.equal(custom.serviceId, 'srv-custom');
  });

  it('rejects past, blocked and malformed booking dates and unknown statuses', () => {
    const store = createVendorStore(tmpDir());
    const base = { customerName: 'نواف', customerPhone: '0504444444' };
    store.addBlockedDate('v1', { date: '2099-02-01', type: 'holiday' });
    assert.throws(() => store.addBooking('v1', { ...base, date: '2020-01-01' }), /مضى/);
    assert.throws(() => store.addBooking('v1', { ...base, date: '2099-02-01' }), /مغلق/);
    assert.throws(() => store.addBooking('v1', { ...base, date: '2099-02-30' }), /YYYY-MM-DD/);
    assert.throws(() => store.addBooking('v1', { ...base, date: '2099-01-01', status: 'hacked' }), /حالة/);
    assert.throws(() => store.addBooking('v1', { ...base, date: '2099-01-01', totalAmount: -5 }), /غير صالح/);
    const today = store.addBooking('v1', { ...base, date: todayInRiyadh(), status: 'مؤكد' });
    assert.equal(today.status, 'مؤكد');
  });

  it('lets PATCH change only status, notes, date and times', () => {
    const store = createVendorStore(tmpDir());
    const created = store.addBooking('v1', {
      customerName: 'نواف',
      customerPhone: '0504444444',
      customerEmail: 'a@b.sa',
      date: '2099-01-10',
      totalAmount: 1000,
    } as Record<string, unknown>);
    const updated = store.updateBooking('v1', created.id, {
      id: 'bk-other',
      bookingNumber: 'X-1',
      totalAmount: 1,
      customerPhone: '0500000000',
      customerEmail: 'evil@x.sa',
      status: 'completed',
      notes: 'تم',
      date: '2099-01-11',
      startTime: '17:00',
    });
    assert.equal(updated?.id, created.id);
    assert.equal(updated?.bookingNumber, created.bookingNumber);
    assert.equal(updated?.totalAmount, 1000);
    assert.equal(updated?.customerPhone, '0504444444');
    assert.equal((updated as Record<string, unknown>)?.customerEmail, undefined);
    assert.equal(updated?.status, 'completed');
    assert.equal(updated?.notes, 'تم');
    assert.equal(updated?.date, '2099-01-11');
    assert.equal(updated?.startTime, '17:00');
    assert.throws(() => store.updateBooking('v1', created.id, { status: 'hacked' }), /حالة/);
    assert.throws(() => store.updateBooking('v1', created.id, { date: '2020-01-01' }), /مضى/);
    assert.throws(() => store.updateBooking('v1', created.id, { endTime: '25:00' }), /HH:MM/);
    assert.equal(store.updateBooking('v1', 'bk-missing', { status: 'completed' }), null);
  });

  it('makes duplicate booking ids addressable instead of silently hitting the first', () => {
    const store = createVendorStore(tmpDir());
    const row = (name: string) => ({
      id: 'bk-dup',
      bookingNumber: 'BK-1',
      serviceId: 'srv-custom',
      serviceTitle: 'ضيافة',
      customerName: name,
      customerPhone: '0501111111',
      date: '2099-01-01',
      startTime: '18:00',
      endTime: '23:30',
      city: 'الرياض',
      venueName: 'مقر',
      guestCount: 10,
      totalAmount: 100,
      depositAmount: 0,
      remainingAmount: 100,
      source: 'platform',
      status: 'confirmed',
      createdAt: '2026-01-01',
    });
    store.saveWorkspace('v1', { bookings: [row('أ'), row('ب'), row('أ')] });
    const ids = store.getWorkspace('v1').bookings.map((b) => b.id);
    assert.deepEqual(ids, ['bk-dup', 'bk-dup-2']);
    store.updateBooking('v1', 'bk-dup-2', { status: 'completed' });
    const after = store.getWorkspace('v1').bookings;
    assert.equal(after.find((b) => b.id === 'bk-dup')?.status, 'confirmed');
    assert.equal(after.find((b) => b.id === 'bk-dup-2')?.status, 'completed');
    assert.equal(store.removeBooking('v1', 'bk-dup'), true);
    assert.deepEqual(store.getWorkspace('v1').bookings.map((b) => b.customerName), ['ب']);
    assert.deepEqual(dedupeById([{ id: 'a' }, { id: 'a-2' }, { id: 'a', x: 1 }]).map((r) => r.id), ['a', 'a-2', 'a-3']);
  });

  it('ignores bookings and blocked dates sent through the bulk workspace save', () => {
    const store = createVendorStore(tmpDir());
    store.addBooking('v1', { customerName: 'نواف', customerPhone: '0504444444', totalAmount: 100 });
    const ws = store.saveVendorWorkspace('v1', {
      bookings: [{ id: 'bk-x', customerName: 'مزور', totalAmount: 999999, status: 'confirmed' }],
      blockedDates: [{ id: 'b', date: 'garbage' }],
    });
    assert.equal(ws.bookings.length, 1);
    assert.equal(ws.bookings[0].customerName, 'نواف');
    assert.equal(ws.blockedDates.length, 0);
  });

  it('counts only confirmed, in-progress and completed bookings as revenue', () => {
    const store = createVendorStore(tmpDir());
    const base = { customerName: 'أ', customerPhone: '0501111111', date: '2099-01-01' };
    store.addBooking('v1', { ...base, totalAmount: 1000, status: 'confirmed' });
    store.addBooking('v1', { ...base, totalAmount: 200, status: 'مكتمل' });
    store.addBooking('v1', { ...base, totalAmount: 500, status: 'cancelled' });
    store.addBooking('v1', { ...base, totalAmount: 400, status: 'ملغي' });
    store.addBooking('v1', { ...base, totalAmount: 700, status: 'مرفوض من المورّد' });
    store.addBooking('v1', { ...base, totalAmount: 300, status: 'بانتظار موافقة المورّد' });
    store.addBooking('v1', { ...base, totalAmount: 50, status: 'pending_deposit' });
    const sum = store.summary('v1');
    assert.equal(sum.bookingCount, 7);
    assert.equal(sum.revenue, 1200);
  });

  it('validates blocked dates and treats a repeat as the same row', () => {
    const store = createVendorStore(tmpDir());
    for (const bad of ['garbage', '2026-13-01', '2026-02-30', '2026-9-1', '01-10-2026', 20261001]) {
      assert.throws(() => store.addBlockedDate('v1', { date: bad }), /YYYY-MM-DD/, String(bad));
    }
    assert.throws(() => store.addBlockedDate('v1', { date: '2026-10-01', type: 'nope' }), /نوع/);
    const first = store.blockDate('v1', { date: '2026-10-01', type: 'holiday', id: 'blk-client' });
    assert.equal(first.created, true);
    assert.notEqual(first.blockedDate.id, 'blk-client');
    const again = store.blockDate('v1', { date: '2026-10-01', type: 'custom' });
    assert.equal(again.created, false);
    assert.equal(again.blockedDate.id, first.blockedDate.id);
    assert.equal(store.getWorkspace('v1').blockedDates.length, 1);
    assert.equal(isIsoDate('2028-02-29'), true);
    assert.equal(isIsoDate('2027-02-29'), false);
  });

  it('shows the vendor edited profile and workspace socials on the public file', () => {
    const store = createVendorStore(tmpDir());
    const application = {
      projectName: 'اسم الطلب',
      projectType: 'ضيافة',
      firstName: 'نواف',
      status: 'approved' as const,
      socials: {
        confirmedOwn: true,
        links: [{ network: 'x' as const, handle: 'app', url: 'https://x.com/app', status: 'linked' as const, confirmedOwn: true, updatedAt: '' }],
      },
    };
    store.seedWorkspaceFromApplication('v1', { ...application, socials: undefined });
    assert.equal(store.getPublicFile('v1', application)?.socials[0]?.url, 'https://x.com/app');
    assert.equal(store.getPublicSocials('v1', application)[0]?.url, 'https://x.com/app');

    store.saveVendorWorkspace('v1', { profile: { projectName: 'الاسم الجديد', projectType: 'قهوة', logoUrl: '/uploads/logo.png' } });
    store.saveSocials('v1', { instagram: '@new.brand', confirmedOwn: true });
    const file = store.getPublicFile('v1', application);
    assert.equal(file?.projectName, 'الاسم الجديد');
    assert.equal(file?.projectType, 'قهوة');
    assert.equal(file?.logoUrl, '/uploads/logo.png');
    assert.equal(file?.handle, 'الاسم-الجديد');
    assert.deepEqual(file?.socials.map((link) => link.network), ['instagram']);
    assert.equal(store.getPublicSocials('v1', application)[0].network, 'instagram');
    assert.equal(store.getPublicFile('v1', { ...application, status: 'pending' }), null);
    assert.throws(() => store.saveVendorWorkspace('v1', { profile: { projectName: '' } }), /اسم المشروع/);
    assert.throws(
      () => store.saveVendorWorkspace('v1', { profile: { logoUrl: '/uploads/../vendor-workspaces.json' } }),
      /شعار/,
    );
  });

  it('lets the admin edit a listing whose stored photos fail the new rules, and fix them in one PATCH', () => {
    const store = createVendorStore(tmpDir());
    const normal = store.addListing('v1', goodListing());
    const lanes = store.updateListingAdmin(normal.id, { fulfillment: ['tomorrow'] });
    assert.deepEqual(lanes?.fulfillment, ['tomorrow']);
    assert.deepEqual(lanes?.images, IMAGES);

    store.saveWorkspace('v2', {
      listings: [goodListing({ id: 'lst-broken', images: ['/uploads/gone-1.jpg', '/uploads/gone-2.jpg'] })],
    });
    const edited = store.updateListingAdmin('lst-broken', { price: 99 });
    assert.equal(edited?.price, 99);
    assert.equal(edited?.vendorId, 'v2');
    assert.throws(() => store.updateListing('v2', 'lst-broken', { price: 98 }), /صورة/);
    assert.throws(() => store.updateListingAdmin('lst-broken', { images: ['/uploads/gone-1.jpg', IMAGES[0]] }), /صورة/);
    const fixed = store.updateListingAdmin('lst-broken', { images: IMAGES });
    assert.deepEqual(fixed?.images, IMAGES);
    assert.equal(store.updateListingAdmin('lst-none', { price: 1 }), null);
  });
});

describe('vendor-store QA round 2', () => {
  function writeOrders(dir: string, rows: unknown[]) {
    fs.writeFileSync(path.join(dir, 'bookings.json'), JSON.stringify(rows), 'utf-8');
  }

  const order = (extra: Record<string, unknown>) => ({
    id: `bk-${Math.random().toString(16).slice(2)}`,
    name: 'عميل',
    phone: '0501234567',
    email: 'c@usil.sa',
    serviceName: 'طلب',
    notes: '',
    city: 'الرياض',
    eventDate: '2099-01-01',
    paymentMethod: 'moyasar',
    settlement: '',
    items: [],
    totalAmount: 0,
    bookingMode: 'instant',
    status: 'مؤكد',
    paymentStatus: 'paid',
    createdAt: '2026-09-01 10:00',
    ...extra,
  });

  it('counts the vendor platform orders in the summary, only their own share and revenue statuses', () => {
    const dir = tmpDir();
    const store = createVendorStore(dir);
    store.saveWorkspace('v1', { listings: [goodListing({ id: 'lst-v1' })] });
    store.addBooking('v1', { customerName: 'يدوي', customerPhone: '0501111111', totalAmount: 100 });
    writeOrders(dir, [
      // The QA case: a paid, confirmed 1200 SAR order for this vendor alone.
      order({ vendorIds: ['v1'], items: [{ id: 'lst-v1', title: 'قهوة', quantity: 1, price: 1200, vendorId: 'v1' }], totalAmount: 1200 }),
      // Mixed cart: only v1's lines (2 × 300) are theirs.
      order({
        vendorIds: ['v1', 'v2'],
        items: [
          { id: 'lst-v1', title: 'قهوة', quantity: 2, price: 300, vendorId: 'v1' },
          { id: 'lst-v2', title: 'ورد', quantity: 1, price: 500, vendorId: 'v2' },
        ],
        totalAmount: 1100,
      }),
      // Rows from before vendor stamping match on the listing id.
      order({ serviceId: 'lst-v1', status: 'مكتمل', totalAmount: 250 }),
      order({ vendorIds: ['v1'], status: 'ملغي', totalAmount: 900 }),
      order({ vendorIds: ['v1'], status: 'مرفوض', totalAmount: 700 }),
      order({ vendorIds: ['v2'], totalAmount: 5000 }),
    ]);
    const sum = store.summary('v1');
    assert.equal(sum.revenue, 100 + 1200 + 600 + 250);
    assert.equal(sum.platformRevenue, 1200 + 600 + 250);
    assert.equal(sum.bookingCount, 1 + 5);
    assert.equal(sum.platformBookingCount, 5);
    assert.equal(store.listSummaries().v1.revenue, 2150);
  });

  it('takes the platform orders from an injected lookup when one is given', () => {
    const store = createVendorStore(tmpDir(), {
      listPlatformBookings: () => [order({ vendorIds: ['v1'], totalAmount: 1200 })] as never,
    });
    assert.equal(store.summary('v1').revenue, 1200);
    assert.equal(store.summary('v2').revenue, 0);
  });

  it('refuses a manual booking with an invalid customer phone and stores a valid one normalized', () => {
    const store = createVendorStore(tmpDir());
    assert.throws(() => store.addBooking('v1', { customerName: 'نواف', customerPhone: 'abc' }), /جوال العميل غير صالح/);
    assert.throws(() => store.addBooking('v1', { customerName: 'نواف', customerPhone: '12345' }), /جوال العميل غير صالح/);
    assert.throws(() => store.addBooking('v1', { customerName: 'نواف', customerPhone: '' }), /مطلوبان/);
    const ok = store.addBooking('v1', { customerName: 'نواف', customerPhone: '+966 50 123 4567' });
    assert.equal(ok.customerPhone, '0501234567');
  });

  it('shows the new project name on existing listings after a rename', () => {
    const store = createVendorStore(tmpDir());
    store.saveVendorWorkspace('v1', { profile: { projectName: 'الاسم القديم' } });
    const listing = store.addListing('v1', goodListing());
    assert.equal(listing.vendorName, 'الاسم القديم');
    store.saveVendorWorkspace('v1', { profile: { projectName: 'الاسم الجديد' } });
    assert.equal(store.getWorkspace('v1').listings[0].vendorName, 'الاسم الجديد');
    const [row] = store.listAllListings();
    assert.equal(row.vendorName, 'الاسم الجديد');
    assert.equal(store.listingToPublicService(row).provider.name, 'الاسم الجديد');
  });

  it('merges one reviewed network into the live socials without replacing the others', () => {
    const store = createVendorStore(tmpDir());
    store.saveSocials('v2', { instagram: '@new.insta', tiktok: '@same.tok', whatsapp: '0551112222', confirmedOwn: true });
    const application = {
      confirmedOwn: true,
      links: [
        { network: 'instagram', handle: 'old.insta', url: 'https://www.instagram.com/old.insta', status: 'verified', confirmedOwn: true, updatedAt: 't', verifiedAt: 't', verifiedBy: 'إدارة' },
        { network: 'tiktok', handle: 'same.tok', url: 'https://www.tiktok.com/@same.tok', status: 'verified', confirmedOwn: true, updatedAt: 't', verifiedAt: 't', verifiedBy: 'إدارة' },
        { network: 'x', handle: 'app.x', url: 'https://x.com/app.x', status: 'linked', confirmedOwn: true, updatedAt: 't' },
      ],
    } as const;
    const saved = store.mergeReviewedSocial('v2', 'tiktok', application as never);
    const byNetwork = new Map(saved.links.map((link) => [link.network, link]));
    assert.deepEqual([...byNetwork.keys()].sort(), ['instagram', 'tiktok', 'whatsapp']);
    assert.equal(byNetwork.get('tiktok')?.status, 'verified');
    assert.equal(byNetwork.get('instagram')?.url, 'https://www.instagram.com/new.insta');
    assert.equal(byNetwork.get('instagram')?.status, 'linked');
    assert.equal(byNetwork.get('whatsapp')?.handle, '0551112222');
    // The vendor has since changed instagram: the review of the old URL does not apply.
    const unchanged = store.mergeReviewedSocial('v2', 'instagram', application as never);
    assert.equal(unchanged.links.find((link) => link.network === 'instagram')?.status, 'linked');
    // A network the vendor never linked is copied across from the application.
    const added = store.mergeReviewedSocial('v2', 'x', application as never);
    assert.equal(added.links.find((link) => link.network === 'x')?.url, 'https://x.com/app.x');
    assert.equal(added.links.length, 4);
  });

  it('removes a whole workspace on request and reports a missing one', () => {
    const store = createVendorStore(tmpDir());
    store.addListing('usr-applicant', goodListing());
    assert.equal(store.removeWorkspace('usr-applicant'), true);
    assert.equal(store.hasWorkspace('usr-applicant'), false);
    assert.equal(store.removeWorkspace('usr-applicant'), false);
  });
});
