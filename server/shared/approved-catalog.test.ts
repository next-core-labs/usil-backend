import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createVendorStore } from '../vendors/vendor-store.ts';
import {
  isPublicVendorAccount,
  listApprovedCatalogServices,
  serviceSeoFrom,
  vendorUsersFromDataDir,
} from './approved-catalog.ts';
import { seedApprovedAndRejected } from './approved-catalog.fixtures.ts';

describe('approved-catalog', () => {
  it('lists only listings of approved vendor accounts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-approved-'));
    seedApprovedAndRejected(dir);
    const store = createVendorStore(dir);
    const services = listApprovedCatalogServices(store, vendorUsersFromDataDir(dir));
    assert.deepEqual(services.map((item) => item.id), ['lst-approved']);
    // Without any approved vendor, nothing is public.
    assert.deepEqual(listApprovedCatalogServices(store, () => []), []);
  });

  it('builds share metadata from a listing and returns null for none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-approved-'));
    seedApprovedAndRejected(dir);
    const store = createVendorStore(dir);
    const [service] = listApprovedCatalogServices(store, vendorUsersFromDataDir(dir));
    const seo = serviceSeoFrom(service);
    assert.equal(seo?.title, 'قهوة المورد المعتمد');
    assert.match(seo?.description || '', /وصف/);
    assert.equal(seo?.image, '/uploads/listing-lst-approved.jpg');
    assert.equal(serviceSeoFrom(undefined), null);
  });

  it('applies one public-vendor rule: the vendor role', () => {
    assert.equal(isPublicVendorAccount({ id: 'a', email: 'made@usil.sa', role: 'vendor' }), true);
    assert.equal(isPublicVendorAccount({ id: 'd', email: 'x@usil.sa', role: 'client' }), false);
    assert.equal(isPublicVendorAccount({ id: '', role: 'vendor' }), false);
    assert.equal(isPublicVendorAccount(null), false);
  });

  it('keeps a vendor public when a later application of theirs was rejected', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-approved-'));
    seedApprovedAndRejected(dir);
    fs.writeFileSync(
      path.join(dir, 'vendor-applications.json'),
      JSON.stringify([{ id: 'vap-ok', email: 'ok@vendor.sa', status: 'rejected' }]),
    );
    const store = createVendorStore(dir);
    const services = listApprovedCatalogServices(store, vendorUsersFromDataDir(dir));
    assert.deepEqual(services.map((item) => item.id), ['lst-approved']);
  });
});
