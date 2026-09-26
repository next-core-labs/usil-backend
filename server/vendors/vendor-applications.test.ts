import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createVendorApplicationStore,
  isValidNationalId,
  isValidSaudiIban,
  validateVendorApplication,
  parseVendorFulfillment,
  PROJECT_TYPES,
  SAUDI_BANKS,
  type VendorApplicationInput,
} from './vendor-applications.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-vap-'));
}

const valid: VendorApplicationInput = {
  firstName: 'نواف',
  fatherName: 'محمد',
  familyName: 'المهيع',
  projectName: 'إرث الضيافة',
  nationalId: '1088123456',
  email: 'nawaf.vendor@example.com',
  phone: '0504444444',
  projectType: 'ضيافة قهوة وشاي',
  bankName: 'مصرف الراجحي',
  iban: 'SA0380000000608010167519',
  accountHolderName: 'نواف محمد المهيع',
  password: 'Secret12',
  fulfillment: ['hour', 'same_day'],
  instagram: '@irth.diyafa',
  confirmedOwn: true,
};

describe('vendor-applications', () => {
  it('validates national id and Saudi IBAN', () => {
    assert.equal(isValidNationalId('1088123456'), true);
    assert.equal(isValidNationalId('3088123456'), false);
    assert.equal(isValidSaudiIban('SA0380000000608010167519'), true);
    assert.equal(isValidSaudiIban('SA123'), false);
    assert.ok(PROJECT_TYPES.includes('أخرى'));
    assert.ok(PROJECT_TYPES.includes('حفلات زواج وملكة'));
    assert.ok(PROJECT_TYPES.includes('تنظيم معارض وبوثات'));
    assert.ok(SAUDI_BANKS.includes('مصرف الراجحي'));
  });

  it('requires a custom project type when أخرى is selected', () => {
    assert.throws(
      () => validateVendorApplication({ ...valid, projectType: 'أخرى', projectTypeOther: '' }),
      /الخانة الفارغة/,
    );
    assert.equal(
      validateVendorApplication({ ...valid, projectType: 'أخرى', projectTypeOther: 'عطور للمناسبات' }),
      'عطور للمناسبات',
    );
  });

  it('requires at least one fulfillment lane', () => {
    assert.throws(() => parseVendorFulfillment([]), /أقدر أخدم في/);
    assert.deepEqual(parseVendorFulfillment(['hour', 'instant', 'hour']), ['hour', 'instant']);
  });

  it('requires at least one social account on a new application', () => {
    const store = createVendorApplicationStore(tmpDir());
    const { instagram: _ig, confirmedOwn: _own, ...noSocial } = valid;
    assert.throws(() => store.submit(noSocial, 'hash:demo'), /حساب تواصل واحد/);
  });

  it('stores a pending application and blocks a second pending request', () => {
    const store = createVendorApplicationStore(tmpDir());
    const created = store.submit(valid, 'hash:demo');
    assert.equal(created.status, 'pending');
    assert.deepEqual(created.fulfillment, ['hour', 'same_day']);
    assert.equal(created.socials?.links[0]?.network, 'instagram');
    assert.equal(created.socials?.links[0]?.status, 'linked');
    assert.equal(store.statusForEmail(valid.email), 'pending');
    assert.throws(() => store.submit(valid, 'hash:demo'), /بانتظار موافقة/);
  });

  it('requires a password of at least 8 characters', () => {
    assert.throws(() => validateVendorApplication({ ...valid, password: 'Secret1' }), /8 خانات/);
    assert.doesNotThrow(() => validateVendorApplication({ ...valid, password: 'Secret12' }));
  });

  it('approves and rejects applications', () => {
    const dir = tmpDir();
    const store = createVendorApplicationStore(dir);
    const created = store.submit(valid, 'hash:demo');
    const approved = store.decide(created.id, 'approved', 'إدارة يوصل');
    assert.equal(approved?.status, 'approved');
    assert.equal(store.statusForEmail(valid.email), 'approved');

    const second = store.submit({ ...valid, email: 'other@example.com', phone: '0501111222' }, 'hash:demo');
    const rejected = store.decide(second.id, 'rejected', 'إدارة يوصل', 'بيانات ناقصة');
    assert.equal(rejected?.status, 'rejected');
    assert.equal(store.findById(second.id)?.rejectReason, 'بيانات ناقصة');
    assert.ok(fs.existsSync(path.join(dir, 'vendor-applications.json')));
  });
});
