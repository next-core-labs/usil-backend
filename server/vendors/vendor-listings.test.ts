import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FULFILLMENT_AR_LABEL,
  LISTING_MAX_IMAGES,
  listingToServiceItem,
  parseFulfillmentLanes,
  parseListingImages,
  validateVendorListing,
} from './vendor-listings.ts';

describe('vendor listings', () => {
  it('uses the founder Arabic lane labels', () => {
    assert.deepEqual(Object.values(FULFILLMENT_AR_LABEL), [
      'يوصل ساعة',
      'يوصل اليوم',
      'يوصل بكرا',
      'حجز فوري',
    ]);
  });

  it('requires a fulfillment lane per SKU', () => {
    assert.throws(
      () => validateVendorListing({ title: 'قهوة', category: 'hospitality', price: 50 }),
      /مسار يوصل/,
    );
    const clean = validateVendorListing({
      title: 'قهوة',
      category: 'hospitality',
      price: 50,
      fulfillment: ['hour', 'same_day'],
    });
    assert.deepEqual(clean.fulfillment, ['hour', 'same_day']);
  });

  it('maps a listing onto a marketplace ServiceItem with the same lanes', () => {
    const item = listingToServiceItem({
      id: 'lst-1',
      vendorId: 'usr-vendor',
      vendorName: 'قهوة نجد',
      title: 'قهوة حارّة',
      category: 'hospitality',
      categoryName: 'ضيافة وقهوة',
      shortDesc: 'توصيل قهوة',
      price: 90,
      priceUnit: 'للوحدة',
      cities: ['الرياض'],
      fulfillment: ['hour'],
      bookingMode: 'approval',
      createdAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:00.000Z',
    });
    assert.deepEqual(item.fulfillment, ['hour']);
    assert.equal(item.bookingMode, 'approval');
    assert.equal(item.provider.name, 'قهوة نجد');
    assert.equal(parseFulfillmentLanes(['instant'], 'x')[0], 'instant');
  });

  it('requires two uploaded images when the vendor saves a product', () => {
    const base = {
      title: 'قهوة',
      category: 'hospitality',
      price: 50,
      fulfillment: ['hour'],
    };
    assert.throws(
      () => validateVendorListing({ ...base, images: ['/uploads/listing-a.jpg'] }, { requireImages: true }),
      /صورتين/,
    );
    const clean = validateVendorListing(
      { ...base, images: ['/uploads/listing-a.jpg', '/uploads/listing-b.png'] },
      { requireImages: true },
    );
    assert.deepEqual(clean.images, ['/uploads/listing-a.jpg', '/uploads/listing-b.png']);
    assert.equal(clean.image, '/uploads/listing-a.jpg');
  });

  it('keeps legacy single-image listings readable', () => {
    const clean = validateVendorListing({
      title: 'قهوة',
      category: 'hospitality',
      price: 50,
      fulfillment: ['hour'],
      image: '/uploads/legacy.jpg',
    });
    assert.deepEqual(clean.images, ['/uploads/legacy.jpg']);
    const item = listingToServiceItem({
      id: 'lst-2',
      vendorId: 'usr-vendor',
      vendorName: 'قهوة نجد',
      ...clean,
      createdAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:00.000Z',
    });
    assert.equal(item.image, '/uploads/legacy.jpg');
    assert.deepEqual(item.galleryImages, ['/uploads/legacy.jpg']);
  });

  it('drops junk image values, dedupes and caps the gallery', () => {
    const many = Array.from({ length: 12 }, (_, i) => `/uploads/img-${i}.jpg`);
    assert.equal(parseListingImages(many).length, LISTING_MAX_IMAGES);
    assert.deepEqual(parseListingImages(['', 'ملف', '/uploads/a.jpg', '/uploads/a.jpg']), ['/uploads/a.jpg']);
    assert.deepEqual(
      parseListingImages(['https://images.unsplash.com/photo-1', 'https://picsum.photos/200', '/uploads/real.jpg']),
      ['/uploads/real.jpg'],
    );
  });
});
