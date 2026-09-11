import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildVendorHubs, pickDefaultVendorHub } from './vendor-hubs.ts';

describe('vendor hubs', () => {
  it('defaults to the accounts manager own application or workspace', () => {
    const hubs = buildVendorHubs({
      actor: { id: 'usr-nawaf', email: 'nawafalmuhayya@gmail.com' },
      vendors: [
        { id: 'usr-vendor-1', name: 'ضيافة نجد', email: 'najd@usil.sa' },
      ],
      applications: [
        {
          id: 'vap-nawaf',
          email: 'nawafalmuhayya@gmail.com',
          firstName: 'نواف',
          familyName: 'المهيع',
          projectName: 'استوديو نواف',
          status: 'approved',
        },
      ],
      summaries: {
        'usr-vendor-1': { listingCount: 3, bookingCount: 2 },
      },
    });

    const own = pickDefaultVendorHub(hubs, { id: 'usr-nawaf', email: 'nawafalmuhayya@gmail.com' });
    assert.ok(own);
    assert.equal(own?.isOwn, true);
    assert.equal(own?.projectName, 'استوديو نواف');
    assert.equal(own?.vendorId, 'vap-nawaf');
  });

  it('lists pending vendors so a supervisor can still open them', () => {
    const hubs = buildVendorHubs({
      actor: { id: 'usr-admin', email: 'admin@usil.app' },
      vendors: [{ id: 'usr-ok', name: 'معتمد', email: 'ok@usil.sa' }],
      applications: [
        {
          id: 'vap-wait',
          email: 'wait@usil.sa',
          firstName: 'سارة',
          familyName: 'العتيبي',
          projectName: 'كيك سارة',
          status: 'pending',
        },
      ],
      summaries: { 'usr-ok': { listingCount: 1, bookingCount: 0 } },
    });

    assert.equal(hubs.some((row) => row.vendorId === 'vap-wait' && row.status === 'pending'), true);
    assert.equal(pickDefaultVendorHub(hubs, { id: 'usr-admin', email: 'admin@usil.app' }), null);
  });

  it('uses the admin workspace when one already exists', () => {
    const hubs = buildVendorHubs({
      actor: { id: 'usr-nawaf', email: 'nawafalmuhayya@gmail.com' },
      vendors: [],
      applications: [],
      summaries: { 'usr-nawaf': { listingCount: 4, bookingCount: 1 } },
    });
    const own = pickDefaultVendorHub(hubs, { id: 'usr-nawaf', email: 'nawafalmuhayya@gmail.com' });
    assert.equal(own?.vendorId, 'usr-nawaf');
    assert.equal(own?.listingCount, 4);
  });
});
