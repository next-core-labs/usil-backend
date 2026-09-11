import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canFileExternalBooking,
  canUseVendorHub,
  dashboardFor,
  isAccountRole,
  isVendorSupervisor,
  roleAllowed,
  roleLabelAr,
} from './roles.ts';

describe('roles', () => {
  it('maps accounts_manager to مدير الحسابات and treats admin as supervisor', () => {
    assert.equal(roleLabelAr('accounts_manager'), 'مدير الحسابات');
    assert.equal(roleLabelAr('admin'), 'مدير كل الحسابات');
    assert.equal(isVendorSupervisor('admin'), true);
    assert.equal(isVendorSupervisor('accounts_manager'), true);
    assert.equal(isVendorSupervisor('vendor'), false);
    assert.equal(canUseVendorHub('admin'), true);
    assert.equal(canUseVendorHub('accounts_manager'), true);
    assert.equal(canUseVendorHub('vendor'), true);
    assert.equal(canUseVendorHub('client'), false);
  });

  it('sends staff to the admin home without stripping vendor access', () => {
    assert.equal(dashboardFor('admin'), 'admin');
    assert.equal(dashboardFor('accounts_manager'), 'admin');
    assert.equal(dashboardFor('vendor'), 'vendor');
    assert.equal(isAccountRole('accounts_manager'), true);
    assert.equal(roleAllowed('accounts_manager', ['admin']), true);
    assert.equal(roleAllowed('vendor', ['admin']), false);
  });

  it('keeps external bookings for couriers and platform supervisors', () => {
    assert.equal(isAccountRole('courier'), true);
    assert.equal(roleLabelAr('courier'), 'مندوب توصيل');
    assert.equal(canFileExternalBooking('courier'), true);
    assert.equal(canFileExternalBooking('admin'), true);
    assert.equal(canFileExternalBooking('accounts_manager'), true);
    assert.equal(canFileExternalBooking('client'), false);
    assert.equal(canFileExternalBooking('vendor'), false);
    assert.equal(canUseVendorHub('courier'), false);
  });
});
