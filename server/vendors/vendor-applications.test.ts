import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createVendorApplicationStore,
  isValidNationalId,
  isValidSaudiIban,
  normalizeIban,
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
    assert.equal(isValidSaudiIban('0380000000608010167519'), true);
    assert.equal(isValidSaudiIban('SA03 8000 0000 6080-1016 7519'), true);
    assert.equal(isValidSaudiIban('SA٠٣٨٠٠٠٠٠٠٠٦٠٨٠١٠١٦٧٥١٩'), true);
    assert.equal(normalizeIban('\u200eSA0380000000608010167519'), 'SA0380000000608010167519');
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

/** A real-shaped Saudi IBAN: SA + mod-97 check digits + 2-digit bank code + 18-digit account. */
function saudiIban(bankCode: string, account: string): string {
  const bban = `${bankCode}${account}`;
  const numeric = `${bban}2810` + '00'; // S=28, A=10, then "00" check digits
  let rest = 0;
  for (const ch of numeric) rest = (rest * 10 + Number(ch)) % 97;
  return `SA${String(98 - rest).padStart(2, '0')}${bban}`;
}

const toArabicDigits = (v: string) => v.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);
const toPersianDigits = (v: string) => v.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
const grouped = (v: string) => v.replace(/(.{4})/g, '$1 ').trim();

describe('Saudi IBAN as vendors type it', () => {
  const BANKS: Record<string, string> = {
    '10': 'البنك الأهلي السعودي',
    '80': 'مصرف الراجحي',
    '20': 'بنك الرياض',
    '05': 'مصرف الإنماء',
    '15': 'بنك البلاد',
    '60': 'بنك الجزيرة',
    '30': 'البنك العربي الوطني',
    '45': 'بنك ساب',
    '65': 'البنك السعودي للاستثمار',
    '55': 'البنك السعودي الفرنسي',
    '90': 'بنك الخليج الدولي',
  };

  for (const [code, bank] of Object.entries(BANKS)) {
    it(`accepts every way of typing a ${bank} IBAN`, () => {
      const iban = saudiIban(code, '000000608010167519'.slice(0, 16) + code);
      assert.match(iban, /^SA\d{22}$/);
      const typed = [
        iban,
        iban.slice(2), // the 22 digits without SA
        iban.toLowerCase(),
        grouped(iban), // as the bank app shows it
        iban.replace(/(.{4})/g, '$1-').replace(/-$/, ''),
        `SA${toArabicDigits(iban.slice(2))}`, // Arabic keyboard
        toArabicDigits(iban.slice(2)),
        `SA${toPersianDigits(iban.slice(2))}`,
        `\u200e${iban}\u200f`, // copied with direction marks
        `  ${grouped(iban.slice(2))}  `,
      ];
      for (const value of typed) {
        assert.equal(normalizeIban(value), iban, JSON.stringify(value));
        assert.equal(isValidSaudiIban(value), true, JSON.stringify(value));
      }
    });
  }

  it('rejects what is not a Saudi IBAN', () => {
    const iban = saudiIban('80', '000000608010167519');
    for (const value of [
      '',
      iban.slice(0, -1), // 21 digits
      `${iban}0`, // 23 digits
      iban.slice(3), // 21 bare digits, no SA added
      `AE${iban.slice(2)}`, // another country
      `SA${iban.slice(2, 10)}X${iban.slice(11)}`, // a letter inside
      '05xxxxxxxx',
    ]) {
      assert.equal(isValidSaudiIban(value), false, JSON.stringify(value));
    }
  });
});

