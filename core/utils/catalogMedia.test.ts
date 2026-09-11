import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasCheckoutPrice,
  isAllowedListingImage,
  isPublicMarketplaceListing,
  isStockMediaUrl,
  stripCatalogCommerce,
  stripStockServiceMedia,
} from './catalogMedia.ts';

describe('catalogMedia', () => {
  it('flags stock / demo hosts and keeps vendor uploads', () => {
    assert.equal(
      isStockMediaUrl('https://images.unsplash.com/photo-1519167758481-83f29da8c2b3?auto=format&fit=crop&w=900&q=80'),
      true,
    );
    assert.equal(isStockMediaUrl('https://picsum.photos/800/500'), true);
    assert.equal(isStockMediaUrl('https://via.placeholder.com/800'), true);
    assert.equal(isAllowedListingImage('/uploads/listing-a.jpg'), true);
    assert.equal(isAllowedListingImage('https://images.unsplash.com/photo-1'), false);
    assert.equal(isAllowedListingImage(''), false);
  });

  it('strips catalog stock fields and keeps titles', () => {
    const next = stripStockServiceMedia({
      title: 'ركن الضيافة',
      image: 'https://images.unsplash.com/photo-1578357078586-491adf1aa5ba?w=900',
      galleryImages: [
        'https://images.unsplash.com/photo-1578357078586-491adf1aa5ba?w=900',
        '/uploads/real.jpg',
      ],
      provider: { avatar: 'https://picsum.photos/150' },
    });
    assert.equal(next.title, 'ركن الضيافة');
    assert.equal(next.image, '');
    assert.deepEqual(next.galleryImages, ['/uploads/real.jpg']);
    assert.equal(next.provider?.avatar, undefined);
  });

  it('clears catalog prices and photos so Moyasar is not charged from seed amounts', () => {
    const next = stripCatalogCommerce({
      title: 'ركن الضيافة',
      price: 1850,
      image: '/uploads/listing-a.jpg',
      images: ['/uploads/listing-a.jpg'],
      galleryImages: ['/uploads/listing-a.jpg'],
      provider: { avatar: '/uploads/avatar.jpg' },
    });
    assert.equal(next.title, 'ركن الضيافة');
    assert.equal(next.price, 0);
    assert.equal(next.image, '');
    assert.deepEqual(next.images, []);
    assert.equal(next.galleryImages, undefined);
    assert.equal(next.provider?.avatar, undefined);
    assert.equal(hasCheckoutPrice(0), false);
    assert.equal(hasCheckoutPrice(1), true);
  });

  it('publishes a listing only when it has a real photo and a checkout price', () => {
    assert.equal(
      isPublicMarketplaceListing({
        price: 1850,
        image: '/uploads/listing-a.jpg',
      }),
      true,
    );
    assert.equal(isPublicMarketplaceListing({ price: 0, image: '/uploads/listing-a.jpg' }), false);
    assert.equal(isPublicMarketplaceListing({ price: 1850, image: '' }), false);
    assert.equal(
      isPublicMarketplaceListing({
        price: 1850,
        image: 'https://images.unsplash.com/photo-1',
      }),
      false,
    );
  });
});
