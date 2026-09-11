import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogSize,
  compactCatalogForPrompt,
  hydrateBundleIds,
  liveCatalog,
  matchBundlesFromCatalog,
  type CatalogCard,
} from './catalog-match';

const SAMPLE: CatalogCard[] = [
  {
    id: 'lst-coffee',
    title: 'ركن ضيافة',
    category: 'hospitality',
    categoryName: 'ضيافة وقهوة',
    price: 1800,
    cities: ['الرياض'],
    shortDesc: 'قهوة سعودية',
    providerName: 'مورد معتمد',
  },
  {
    id: 'lst-photo',
    title: 'تغطية تصوير',
    category: 'photography',
    categoryName: 'تصوير وتوثيق',
    price: 2200,
    cities: ['الرياض'],
    shortDesc: 'تصوير مناسبات',
    providerName: 'مورد معتمد',
  },
  {
    id: 'lst-buffet',
    title: 'بوفيه عشاء',
    category: 'buffet',
    categoryName: 'بوفيه ومأكولات',
    price: 3500,
    cities: ['جدة'],
    shortDesc: 'بوفيه',
    providerName: 'مورد معتمد',
  },
];

describe('catalog-match', () => {
  it('does not ship a baked-in dummy catalog', () => {
    assert.equal(catalogSize(), 0);
    assert.equal(liveCatalog().length, 0);
    assert.equal(compactCatalogForPrompt(), '');
  });

  it('returns no bundles when the live marketplace is empty', () => {
    const bundles = matchBundlesFromCatalog({
      occasion: 'عرس',
      city: 'الرياض',
      budget: 9000,
      brief: 'عرس في الرياض لـ 120 ضيف مع ضيافة وتصوير',
    });
    assert.deepEqual(bundles, []);
  });

  it('matches a Riyadh wedding brief against real vendor cards', () => {
    const bundles = matchBundlesFromCatalog(
      {
        occasion: 'عرس',
        city: 'الرياض',
        budget: 9000,
        brief: 'عرس في الرياض لـ 120 ضيف مع ضيافة وتصوير',
      },
      SAMPLE,
    );
    assert.ok(bundles.length >= 1);
    assert.ok(bundles[0].serviceIds.length >= 2);
  });

  it('matches a Jeddah corporate brief from live products', () => {
    const bundles = matchBundlesFromCatalog(
      {
        occasion: 'مؤتمر / إطلاق',
        city: 'جدة',
        budget: 12000,
      },
      SAMPLE,
    );
    assert.ok(Array.isArray(bundles));
  });

  it('hydrates known catalog ids and drops missing ones', () => {
    const hydrated = hydrateBundleIds(
      [
        {
          title: 'باقة تجريبية',
          serviceIds: ['lst-coffee', 'missing-id', 'lst-photo'],
        },
        { title: 'ناقصة', serviceIds: ['lst-coffee'] },
      ],
      SAMPLE,
    );
    assert.equal(hydrated.length, 1);
    assert.deepEqual(hydrated[0].serviceIds.sort(), ['lst-coffee', 'lst-photo'].sort());
  });
});
