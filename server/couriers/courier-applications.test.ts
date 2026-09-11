import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createCourierApplicationStore,
  isValidSaudiPlateLetters,
  isValidSaudiPlateNumbers,
  maskNationalId,
  normalizePlateLetters,
  publicCourierApplication,
  validateCourierApplication,
} from './courier-applications.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-crr-'));
}

const valid = {
  firstName: 'سعد',
  familyName: 'الدوسري',
  nationalId: '1088123456',
  plateLetters: 'ب ر د',
  plateNumbers: '1234',
  carType: 'سيدان',
  fulfillment: ['hour', 'same_day'],
};

describe('courier-applications', () => {
  it('accepts Saudi ID/Iqama and official plate letters', () => {
    const clean = validateCourierApplication(valid);
    assert.equal(clean.nationalId, '1088123456');
    assert.equal(clean.plateLetters, 'برد');
    assert.equal(clean.plateNumbers, '1234');
    assert.equal(isValidSaudiPlateLetters('ا ب ح'), true);
    assert.equal(isValidSaudiPlateLetters('xyz'), false);
    assert.equal(isValidSaudiPlateNumbers('12'), true);
    assert.equal(isValidSaudiPlateNumbers('12345'), false);
    assert.equal(normalizePlateLetters('ي'), 'ى');
  });

  it('requires custom text when car type is أخرى', () => {
    assert.throws(
      () => validateCourierApplication({ ...valid, carType: 'أخرى', carTypeOther: '' }),
      /الخانة الفارغة/,
    );
    const clean = validateCourierApplication({ ...valid, carType: 'أخرى', carTypeOther: 'ونيت صغير' });
    assert.equal(clean.carType, 'ونيت صغير');
  });

  it('masks national ID on the public payload', () => {
    const store = createCourierApplicationStore(tmpDir());
    const row = store.submit(valid);
    const pub = publicCourierApplication(row);
    assert.equal(pub.nationalId, maskNationalId(valid.nationalId));
    assert.equal(pub.nationalId.includes('1088123456'), false);
    assert.equal(pub.status, 'pending');
    assert.ok(pub.createdAt);
  });

  it('persists only the allowed fields and blocks a second pending apply', () => {
    const dir = tmpDir();
    const store = createCourierApplicationStore(dir);
    store.submit(valid);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'courier-applications.json'), 'utf-8'))[0];
    assert.deepEqual(
      Object.keys(raw).sort(),
      ['carType', 'createdAt', 'familyName', 'firstName', 'fulfillment', 'id', 'nationalId', 'plateLetters', 'plateNumbers', 'products', 'status'].sort(),
    );
    assert.deepEqual(raw.fulfillment, ['hour', 'same_day']);
    assert.throws(() => store.submit(valid), /بانتظار موافقة/);
  });

  it('requires at least one fulfillment lane', () => {
    assert.throws(
      () => validateCourierApplication({ ...valid, fulfillment: [] }),
      /أقدر أوصل/,
    );
  });

  it('lets admin approve then reject is blocked', () => {
    const store = createCourierApplicationStore(tmpDir());
    const row = store.submit(valid);
    const approved = store.decide(row.id, 'approved', 'إدارة يوصل');
    assert.equal(approved?.status, 'approved');
    assert.throws(() => store.decide(row.id, 'rejected', 'إدارة يوصل'), /تمت مراجعته/);
  });
});
