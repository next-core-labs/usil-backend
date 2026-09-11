import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isFakeIdentityImage, resolveCatalogAvatar, userInitials } from './brandedAvatar.ts';

describe('brandedAvatar', () => {
  it('builds Arabic initials', () => {
    assert.equal(userInitials('نواف المهيع'), 'نا');
    assert.equal(userInitials('نواف محمد'), 'نم');
    assert.equal(userInitials('يوصل'), 'يو');
  });

  it('detects stock portrait faces and replaces them', () => {
    const portrait = 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=150&q=80';
    assert.equal(isFakeIdentityImage(portrait), true);
    const next = resolveCatalogAvatar('ضيافة الأصالة الفاخرة', portrait);
    assert.equal(next.startsWith('data:image/svg+xml'), true);
    assert.equal(next.includes('0A1A33') || decodeURIComponent(next).includes('#0A1A33'), true);
  });

  it('rejects stock photos even when they are not identity portraits', () => {
    const product = 'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?auto=format&fit=crop&w=900&q=80';
    assert.equal(isFakeIdentityImage(product), false);
    const next = resolveCatalogAvatar('محمصة', product);
    assert.equal(next.startsWith('data:image/svg+xml'), true);
    assert.equal(resolveCatalogAvatar('محمصة', '/uploads/listing-a.jpg'), '/uploads/listing-a.jpg');
  });
});
