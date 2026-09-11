import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { profileFromApplication, publicVendorFile, vendorHandle } from './vendor-profile.ts';

describe('vendor-profile', () => {
  it('builds the public file from what the vendor typed at registration', () => {
    const own = profileFromApplication(
      {
        firstName: 'سارة',
        fatherName: 'عبدالله',
        familyName: 'القحطاني',
        projectName: 'قهوة سارة',
        projectType: 'ضيافة قهوة وشاي',
        email: 'sara@usil.sa',
        phone: '0551111222',
        fulfillment: ['hour', 'same_day'],
        status: 'pending',
      },
      'usr-sara',
    );
    assert.equal(own.projectName, 'قهوة سارة');
    assert.equal(own.personName, 'سارة عبدالله القحطاني');
    assert.equal(own.status, 'pending');
    const file = publicVendorFile(own);
    assert.equal(file.projectName, 'قهوة سارة');
    assert.equal(file.handle, 'قهوة-سارة');
    assert.equal('email' in file, false);
    assert.equal(vendorHandle('إرث الضيافة', 'usr-1'), 'إرث-الضيافة');
  });
});
