import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  isDummyCourierApplication,
  isDummyEmail,
  isDummyUser,
  isDummyVendorApplication,
  isProtectedAccount,
  purgeDummyRecords,
  purgeLiveDummyData,
  wipeAllVendorsAndDummyMedia,
} from './dummy-accounts.ts';

describe('dummy-accounts', () => {
  it('never flags the founder admin', () => {
    assert.equal(
      isDummyUser({
        id: 'usr-nawaf-admin',
        name: 'مدير كل الحسابات — يوصل',
        email: 'nawafalmuhayya@gmail.com',
      }),
      false,
    );
    assert.equal(isProtectedAccount({ email: 'nawafalmuhayya@gmail.com' }), true);
    assert.equal(
      isDummyUser({
        id: 'usr-1788051147088',
        name: 'نواف محمد المهيع',
        email: 'newvendor@usil.app',
      }),
      false,
    );
  });

  it('flags seeded demo users and throwaway launch accounts', () => {
    assert.equal(isDummyUser({ id: 'usr-client', name: 'عميل مِضياف', email: 'client@usil.app' }), true);
    assert.equal(isDummyUser({ id: 'usr-vendor', name: 'مورد الضيافة', email: 'vendor@usil.app' }), true);
    assert.equal(isDummyUser({ id: 'usr-admin', name: 'إدارة الموقع', email: 'admin@usil.app' }), true);
    assert.equal(isDummyEmail('faisal@mithyaf.sa'), true);
    assert.equal(isDummyEmail('someone@example.com'), true);
    assert.equal(isDummyUser({ name: 'نواف الإطلاق', email: 'launch.1@usil.app' }), true);
    assert.equal(isDummyEmail('qa.live.1788433107@usil-qa.invalid'), true);
    assert.equal(isDummyEmail('usil.ksa@gmail.com'), true);
    assert.equal(isDummyUser({ name: 'يوصل - Usil', email: 'usil.ksa@gmail.com' }), true);
    assert.equal(isDummyUser({ name: 'نورة عبدالعزيز اليوسف', email: 'nalyousef7@gmail.com' }), false);
    assert.equal(isDummyUser({ name: 'نواف خالد ال', email: 'n.almuhayya@gmail.com' }), false);
  });

  it('never guesses from the local part of an email', () => {
    for (const email of [
      'photo.studio@gmail.com',
      'test.family@outlook.com',
      'demo-events@hotmail.com',
      'qa_ahmed@yahoo.com',
      'verify.me@icloud.com',
      'launch.1788390040060@usil.app',
    ]) {
      assert.equal(isDummyEmail(email), false, email);
      assert.equal(isDummyUser({ id: 'usr-real', name: 'عميل حقيقي', email }), false, email);
    }
  });

  it('keeps real users, bookings and support messages on a restart purge', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-purge-real-'));
    fs.writeFileSync(
      path.join(dir, 'users.json'),
      JSON.stringify([
        { id: 'usr-photo', email: 'photo.studio@gmail.com', name: 'استوديو تصوير', role: 'client' },
        { id: 'usr-test', email: 'test.family@outlook.com', name: 'عائلة', role: 'client' },
        { id: 'usr-client', email: 'client@usil.app', name: 'عميل مِضياف', role: 'client' },
        { id: 'usr-qa', email: 'qa.live.1@usil-qa.invalid', name: 'QA', role: 'client' },
      ]),
    );
    fs.writeFileSync(
      path.join(dir, 'bookings.json'),
      JSON.stringify([
        { id: 'bk-1', email: 'photo.studio@gmail.com', name: 'استوديو تصوير' },
        { id: 'bk-2', email: 'guest-without-email', name: 'ضيف' },
        { id: 'bk-3', email: 'a@example.com', name: 'x' },
      ]),
    );
    fs.writeFileSync(
      path.join(dir, 'support-messages.json'),
      JSON.stringify([{ id: 'sm-1', email: 'demo.events@gmail.com', name: 'فعاليات' }]),
    );
    const result = purgeLiveDummyData(dir);
    assert.deepEqual(result.removedUsers.sort(), ['client@usil.app', 'qa.live.1@usil-qa.invalid']);
    const users = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf-8'));
    assert.deepEqual(users.map((row: { id: string }) => row.id), ['usr-photo', 'usr-test']);
    const bookings = JSON.parse(fs.readFileSync(path.join(dir, 'bookings.json'), 'utf-8'));
    assert.deepEqual(bookings.map((row: { id: string }) => row.id), ['bk-1', 'bk-2']);
    const support = JSON.parse(fs.readFileSync(path.join(dir, 'support-messages.json'), 'utf-8'));
    assert.equal(support.length, 1);
  });

  it('flags planted courier seeds without blocking later real namesakes', () => {
    assert.equal(
      isDummyCourierApplication({ firstName: 'سعد', familyName: 'الدوسري', nationalId: '2088123499' }),
      true,
    );
    assert.equal(
      isDummyCourierApplication({ firstName: 'فهد', familyName: 'العتيبي', nationalId: '1098765432' }),
      true,
    );
    assert.equal(
      isDummyCourierApplication({ firstName: 'سعد', familyName: 'الدوسري', nationalId: '1012345678' }),
      false,
    );
    assert.equal(
      isDummyCourierApplication({ firstName: 'نواف', familyName: 'المحيّا', nationalId: '1000000000' }),
      false,
    );
  });

  it('flags garbage vendor applications and keeps Nawaf pending apps', () => {
    assert.equal(
      isDummyVendorApplication({
        firstName: 'JN',
        familyName: 'F/F',
        projectName: "F''FS",
        email: "f[pld'[@lkidsj\\",
      }),
      true,
    );
    assert.equal(
      isDummyVendorApplication({
        firstName: 'نواف',
        familyName: 'المهيع',
        projectName: 'ضيافة النخيل',
        email: 'newvendor@usil.app',
      }),
      false,
    );
    assert.equal(
      isDummyVendorApplication({
        firstName: 'نواف',
        familyName: 'ال',
        projectName: 'اببل',
        email: 'n.almuhayya@gmail.com',
      }),
      false,
    );
  });

  it('purges dummy rows while keeping protected ones', () => {
    const { kept, removed } = purgeDummyRecords(
      [
        { id: 'usr-client', email: 'client@usil.app', name: 'عميل مِضياف' },
        { id: 'usr-nawaf-admin', email: 'nawafalmuhayya@gmail.com', name: 'مدير كل الحسابات — يوصل' },
      ],
      isDummyUser,
    );
    assert.equal(removed.length, 1);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].email, 'nawafalmuhayya@gmail.com');
  });

  it('clears stored vendor listing prices and photos once for Moyasar', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-commerce-'));
    fs.writeFileSync(path.join(dir, 'users.json'), '[]');
    fs.writeFileSync(
      path.join(dir, 'vendor-workspaces.json'),
      JSON.stringify({
        workspaces: {
          'usr-nawaf-admin': {
            listings: [
              {
                id: 'l1',
                title: 'قهوة',
                price: 185,
                image: '/uploads/a.jpg',
                images: ['/uploads/a.jpg'],
              },
            ],
          },
        },
      }),
    );
    purgeLiveDummyData(dir);
    const first = JSON.parse(fs.readFileSync(path.join(dir, 'vendor-workspaces.json'), 'utf-8'));
    assert.equal(first.workspaces['usr-nawaf-admin'].listings[0].price, 0);
    assert.deepEqual(first.workspaces['usr-nawaf-admin'].listings[0].images, []);

    first.workspaces['usr-nawaf-admin'].listings[0].price = 99;
    fs.writeFileSync(path.join(dir, 'vendor-workspaces.json'), JSON.stringify(first));
    purgeLiveDummyData(dir);
    const second = JSON.parse(fs.readFileSync(path.join(dir, 'vendor-workspaces.json'), 'utf-8'));
    assert.equal(second.workspaces['usr-nawaf-admin'].listings[0].price, 99);
  });

  it('wipes every vendor account, application, workspace, and dummy photo once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-wipe-vendors-'));
    fs.mkdirSync(path.join(dir, 'uploads'));
    fs.writeFileSync(
      path.join(dir, 'users.json'),
      JSON.stringify([
        {
          id: 'usr-nawaf-admin',
          email: 'nawafalmuhayya@gmail.com',
          name: 'مدير كل الحسابات — يوصل',
          role: 'admin',
          avatarUrl: '/uploads/avatar-usr-nawaf-admin.svg',
        },
        {
          id: 'usr-vendor-x',
          email: 'newvendor@usil.app',
          name: 'نواف محمد المهيع',
          role: 'vendor',
          avatarUrl: '/uploads/avatar-usr-vendor-x.svg',
        },
      ]),
    );
    fs.writeFileSync(
      path.join(dir, 'vendor-applications.json'),
      JSON.stringify([{ id: 'vap-1', email: 'newvendor@usil.app', projectName: 'ضيافة النخيل' }]),
    );
    fs.writeFileSync(
      path.join(dir, 'vendor-workspaces.json'),
      JSON.stringify({
        workspaces: {
          'usr-vendor-x': { listings: [{ id: 'royal-saudi-coffee', image: 'https://images.unsplash.com/x' }] },
        },
      }),
    );
    fs.writeFileSync(path.join(dir, 'uploads', 'avatar-usr-nawaf-admin.svg'), '<svg />');
    fs.writeFileSync(path.join(dir, 'uploads', 'avatar-usr-vendor-x.svg'), '<svg />');
    fs.writeFileSync(path.join(dir, 'uploads', 'listing-dummy.jpg'), 'x');

    const first = wipeAllVendorsAndDummyMedia(dir, { once: true });
    assert.equal(first.skipped, false);
    assert.ok(first.removedVendors.includes('newvendor@usil.app'));
    const users = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf-8'));
    assert.equal(users.length, 1);
    assert.equal(users[0].email, 'nawafalmuhayya@gmail.com');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'vendor-applications.json'), 'utf-8')), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'vendor-workspaces.json'), 'utf-8')).workspaces, {});
    assert.equal(fs.existsSync(path.join(dir, 'uploads', 'listing-dummy.jpg')), false);
    assert.equal(fs.existsSync(path.join(dir, 'uploads', 'avatar-usr-vendor-x.svg')), false);
    assert.equal(fs.existsSync(path.join(dir, 'uploads', 'avatar-usr-nawaf-admin.svg')), true);

    fs.writeFileSync(
      path.join(dir, 'users.json'),
      JSON.stringify([
        users[0],
        { id: 'usr-real', email: 'real@usil.sa', name: 'مورد جديد', role: 'vendor' },
      ]),
    );
    const second = wipeAllVendorsAndDummyMedia(dir, { once: true });
    assert.equal(second.skipped, true);
    const kept = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf-8'));
    assert.equal(kept.some((row: { email: string }) => row.email === 'real@usil.sa'), true);
  });
});
