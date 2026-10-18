import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createAuth, hashPassword } from '../auth/auth.ts';
import { registerVendorRoutes } from './vendor-routes.ts';
import { registerVendorApplicationRoutes } from './vendor-application-routes.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const ADMIN = { email: 'owner@nclabs.dev', password: 'OwnerPass123' };
const SIGNUP = {
  name: 'سالم أحمد العتيبي',
  projectName: 'بيت القهوة',
  projectType: 'ضيافة قهوة وشاي',
  email: 'coffee-house@nclabs.dev',
  phone: '0559876543',
  password: 'VendorPass123',
};
const DETAILS = {
  nationalId: '1012345678',
  bankName: 'مصرف الراجحي',
  iban: 'SA03 8000 0000 6080 1016 7519',
  accountHolderName: 'سالم أحمد العتيبي',
  fulfillment: ['same_day'],
};

async function mount() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-quick-'));
  fs.writeFileSync(
    path.join(dir, 'users.json'),
    JSON.stringify([
      {
        id: 'usr-owner-1',
        name: 'نورة المالكي',
        email: ADMIN.email,
        phone: '0551234567',
        role: 'admin',
        avatarUrl: '',
        emailVerified: true,
        passwordHash: hashPassword(ADMIN.password),
      },
    ]),
  );

  const auth = createAuth(dir);
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.post('/api/auth/login', (req, res) => auth.loginHandler(req, res));
  app.post('/api/auth/register', (req, res) => auth.registerHandler(req, res));
  registerVendorRoutes(app, auth, dir);
  registerVendorApplicationRoutes(app, auth, dir);
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return { dir, url, close: () => new Promise<void>((done) => server.close(() => done())) };
}

function sessionCookie(res: Response): string {
  const header = res.headers.get('set-cookie') || '';
  const match = header.match(/(usil_sid|midyaf_sid)=([^;]+)/);
  return match && match[2] ? `${match[1]}=${match[2]}` : '';
}

function call(url: string, method: string, route: string, cookie = '', body?: unknown) {
  return fetch(`${url}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function login(url: string, identifier: string, password: string) {
  const res = await call(url, 'POST', '/api/auth/login', '', { identifier, password });
  assert.equal(res.status, 200);
  return sessionCookie(res);
}

const LISTING = {
  title: 'قهوة سعودية جاهزة',
  category: 'hospitality',
  shortDesc: 'دلة وفناجين',
  price: 250,
  priceUnit: 'للمناسبة',
  cities: ['الرياض'],
  images: [`data:image/png;base64,${PNG.toString('base64')}`, `data:image/png;base64,${PNG.toString('base64')}`],
  fulfillment: ['same_day'],
  bookingMode: 'approval',
};

async function signUp(url: string) {
  const res = await call(url, 'POST', '/api/vendor-signup', '', SIGNUP);
  const json = await res.json();
  assert.equal(res.status, 201, json.error);
  return { json, cookie: sessionCookie(res) };
}

async function completeFile(url: string, cookie: string) {
  assert.equal((await call(url, 'PUT', '/api/vendor/application', cookie, DETAILS)).status, 200);
  assert.equal(
    (await call(url, 'PUT', '/api/vendor/socials', cookie, { instagram: '@coffeehouse', confirmedOwn: true })).status,
    200,
  );
  const listing = await call(url, 'POST', '/api/vendor/listings', cookie, LISTING);
  assert.equal(listing.status, 201, (await listing.json()).error);
}

async function applicationId(url: string, adminCookie: string) {
  const list = await (await call(url, 'GET', '/api/admin/vendor-applications', adminCookie)).json();
  return list.data.find((row: { email: string }) => row.email === SIGNUP.email);
}

describe('vendor quick sign-up — dashboard first, approval after', () => {
  it('signs the applicant in as a pending client and splits the name', async () => {
    const { url, close } = await mount();
    try {
      const { json, cookie } = await signUp(url);
      assert.ok(cookie, 'session cookie set');
      assert.equal(json.user.role, 'client');
      assert.equal(json.application.status, 'pending');
      assert.equal(json.application.signup, 'quick');
      assert.equal(json.application.firstName, 'سالم');
      assert.equal(json.application.fatherName, 'أحمد');
      assert.equal(json.application.familyName, 'العتيبي');
      assert.equal(json.application.passwordHash, undefined);
      assert.deepEqual(
        json.missing.map((item: { key: string }) => item.key),
        ['nationalId', 'bank', 'fulfillment', 'socials', 'listings'],
      );
    } finally {
      await close();
    }
  });

  it('accepts a sign-up without a phone number', async () => {
    const { url, close } = await mount();
    try {
      const { phone: _phone, ...noPhone } = SIGNUP;
      const res = await call(url, 'POST', '/api/vendor-signup', '', noPhone);
      const json = await res.json();
      assert.equal(res.status, 201, json.error);
      assert.equal(json.application.phone, '');
      assert.equal(json.user.phone, '');
      // A second phone-less applicant is not mistaken for the first one's account.
      const other = await call(url, 'POST', '/api/vendor-signup', '', { ...noPhone, email: 'second-store@nclabs.dev', phone: '' });
      assert.equal(other.status, 201, (await other.json()).error);
      assert.ok(await login(url, SIGNUP.email, SIGNUP.password));
    } finally {
      await close();
    }
  });

  it('refuses a bad sign-up, an existing account, and a second pending one', async () => {
    const { url, close } = await mount();
    try {
      const bad = await call(url, 'POST', '/api/vendor-signup', '', { ...SIGNUP, phone: '12345' });
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).error, /جوالاً سعودياً/);
      const short = await call(url, 'POST', '/api/vendor-signup', '', { ...SIGNUP, password: 'short' });
      assert.equal(short.status, 400);

      const taken = await call(url, 'POST', '/api/vendor-signup', '', { ...SIGNUP, email: ADMIN.email, phone: '0551234567' });
      assert.equal(taken.status, 409);

      await signUp(url);
      const again = await call(url, 'POST', '/api/vendor-signup', '', { ...SIGNUP, phone: '0559876500' });
      assert.equal(again.status, 400);
      assert.match((await again.json()).error, /بانتظار موافقة/);
    } finally {
      await close();
    }
  });

  it('lets a pending applicant add products and socials, kept off the public catalog', async () => {
    const { url, close } = await mount();
    try {
      const { cookie } = await signUp(url);
      await completeFile(url, cookie);
      const own = await (await call(url, 'GET', '/api/vendor/listings', cookie)).json();
      assert.equal(own.data.length, 1);
      const catalog = await (await call(url, 'GET', '/api/catalog/listings')).json();
      assert.equal(catalog.data.length, 0, 'nothing public before approval');

      const file = await (await call(url, 'GET', '/api/me/vendor-file', cookie)).json();
      assert.deepEqual(file.missing, []);
      assert.equal(file.application.iban, 'SA0380000000608010167519');
      assert.equal(file.application.socials.links[0].network, 'instagram', 'socials mirrored on the application');
    } finally {
      await close();
    }
  });

  it('validates details and only for the account own pending application', async () => {
    const { url, close } = await mount();
    try {
      const { cookie } = await signUp(url);
      const badIban = await call(url, 'PUT', '/api/vendor/application', cookie, { iban: 'SA12' });
      assert.equal(badIban.status, 400);
      const badId = await call(url, 'PUT', '/api/vendor/application', cookie, { nationalId: '3012345678' });
      assert.equal(badId.status, 400);
      const badBank = await call(url, 'PUT', '/api/vendor/application', cookie, { bankName: 'بنك وهمي' });
      assert.equal(badBank.status, 400);
      const noStore = await call(url, 'PUT', '/api/vendor/application', cookie, { projectName: '  ' });
      assert.equal(noStore.status, 400);

      const anon = await call(url, 'PUT', '/api/vendor/application', '', DETAILS);
      assert.equal(anon.status, 401);

      // A plain customer with no application gets neither the dashboard nor the details route.
      await call(url, 'POST', '/api/auth/register', '', {
        name: 'عميل',
        email: 'shopper@nclabs.dev',
        phone: '0552223334',
        password: 'ClientPass123',
      });
      const shopper = await login(url, 'shopper@nclabs.dev', 'ClientPass123');
      assert.equal((await call(url, 'GET', '/api/vendor/listings', shopper)).status, 403);
      assert.equal((await call(url, 'PUT', '/api/vendor/application', shopper, DETAILS)).status, 404);
    } finally {
      await close();
    }
  });

  it('blocks approval until the file is complete, then publishes the products', async () => {
    const { url, close } = await mount();
    try {
      const { cookie } = await signUp(url);
      const admin = await login(url, ADMIN.email, ADMIN.password);
      const row = await applicationId(url, admin);
      assert.equal(row.listingCount, 0);
      assert.ok(row.missing.length > 0);

      const early = await call(url, 'POST', `/api/admin/vendor-applications/${row.id}/approve`, admin, {});
      assert.equal(early.status, 400);
      const earlyJson = await early.json();
      assert.match(earlyJson.error, /ملف المورّد ناقص/);
      assert.ok(earlyJson.missing.length > 0);

      await completeFile(url, cookie);
      const before = await (await call(url, 'GET', '/api/admin/listings', admin)).json();
      assert.equal(before.data[0].vendorPending, true, 'owner sees the product as not yet public');
      const ok = await call(url, 'POST', `/api/admin/vendor-applications/${row.id}/approve`, admin, {});
      const okJson = await ok.json();
      assert.equal(ok.status, 200, okJson.error);
      assert.equal(okJson.user.role, 'vendor');

      const catalog = await (await call(url, 'GET', '/api/catalog/listings')).json();
      assert.equal(catalog.data.length, 1, 'the pending product goes live on approval');
      const after = await (await call(url, 'GET', '/api/admin/listings', admin)).json();
      assert.equal(after.data[0].vendorPending, false);
      // Same account, same session — the dashboard keeps working as a vendor.
      assert.equal((await call(url, 'GET', '/api/vendor/listings', cookie)).status, 200);
      // The password chosen at sign-up still signs in.
      assert.ok(await login(url, SIGNUP.email, SIGNUP.password));
      // Approved files are no longer editable through the pending route.
      assert.equal((await call(url, 'PUT', '/api/vendor/application', cookie, DETAILS)).status, 404);
    } finally {
      await close();
    }
  });

  it('rejection removes the pending products and closes the dashboard', async () => {
    const { url, close } = await mount();
    try {
      const { cookie } = await signUp(url);
      await completeFile(url, cookie);
      const admin = await login(url, ADMIN.email, ADMIN.password);
      const row = await applicationId(url, admin);
      const res = await call(url, 'POST', `/api/admin/vendor-applications/${row.id}/reject`, admin, { reason: 'السجل غير واضح' });
      assert.equal(res.status, 200);

      assert.equal((await call(url, 'GET', '/api/vendor/listings', cookie)).status, 403);
      const adminListings = await (await call(url, 'GET', '/api/admin/listings', admin)).json();
      assert.equal(adminListings.data.length, 0);
      const file = await (await call(url, 'GET', '/api/me/vendor-file', cookie)).json();
      assert.equal(file.application.status, 'rejected');
      assert.equal(file.application.rejectReason, 'السجل غير واضح');

      // The same account can sign up again and starts clean.
      const again = await call(url, 'POST', '/api/vendor-signup', cookie, SIGNUP);
      assert.equal(again.status, 201);
      const fresh = await (await call(url, 'GET', '/api/vendor/listings', cookie)).json();
      assert.equal(fresh.data.length, 0);
    } finally {
      await close();
    }
  });
});

describe('vendor sign-up rate limit', () => {
  it('does not count forms sent back for a mistake', async () => {
    const { url, close } = await mount();
    try {
      for (let i = 0; i < 12; i++) {
        const bad = await call(url, 'POST', '/api/vendor-signup', '', { ...SIGNUP, phone: '123' });
        assert.equal(bad.status, 400);
      }
      await signUp(url);
    } finally {
      await close();
    }
  });
});
