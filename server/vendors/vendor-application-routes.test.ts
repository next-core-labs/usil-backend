import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { registerVendorApplicationRoutes } from './vendor-application-routes.ts';
import { createAuth, hashPassword } from '../auth/auth.ts';
import { createVendorStore } from './vendor-store.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-vap-api-'));
}

function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function fakeAuth(role: 'admin' | 'vendor' | null) {
  const created: Array<{ id: string; email: string; role: string; name?: string; phone?: string }> = [];
  return {
    created,
    userFromRequest: () => (role === 'admin' ? { id: 'usr-admin', name: 'إدارة', email: 'admin@usil.app', phone: '0503333333', role: 'admin' } : null),
    requireRole: (roles: string[]) => (req: Request, res: Response, next: NextFunction) => {
      if (!role) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
      if (!roles.includes(role)) return res.status(403).json({ success: false, error: 'ليست لديك صلاحية هذا الإجراء.' });
      next();
    },
    addVendorUser: (input: { name: string; email: string; phone: string; passwordHash: string }) => {
      const existing = created.find((row) => row.email === input.email);
      if (existing) {
        existing.role = 'vendor';
        existing.name = input.name;
        return existing;
      }
      const user = { id: 'usr-new', name: input.name, email: input.email, phone: input.phone, role: 'vendor' as const };
      created.push(user);
      return user;
    },
    ensureApplicantUser: (input: { name: string; email: string; phone: string; passwordHash: string }) => {
      const user = { id: 'usr-applicant', name: input.name, email: input.email, phone: input.phone, role: 'client' as const };
      created.push(user);
      return user;
    },
    findUserByEmail: (email: string) => created.find((row) => row.email === email) || null,
    checkApplicantAccount: () => 'new' as const,
    startSession: () => 'sess-test',
  };
}

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const payload = {
  firstName: 'نواف',
  fatherName: 'محمد',
  familyName: 'المهيع',
  projectName: 'إرث الضيافة',
  nationalId: '1088123456',
  email: 'apply@usil.app',
  phone: '0504444000',
  projectType: 'ضيافة قهوة وشاي',
  bankName: 'مصرف الراجحي',
  iban: 'SA0380000000608010167519',
  accountHolderName: 'نواف محمد المهيع',
  password: 'Secret12',
  fulfillment: ['hour', 'same_day'],
  instagram: '@usil.vendor',
  confirmedOwn: true,
  listing: {
    title: 'قهوة نجدية',
    category: 'hospitality',
    price: 850,
    fulfillment: ['hour', 'same_day'],
    images: [TINY_PNG, TINY_PNG],
  },
};

describe('vendor-application-routes', () => {
  it('accepts a public vendor application', async () => {
    const app = express();
    app.use(express.json());
    const auth = fakeAuth('admin');
    registerVendorApplicationRoutes(app, auth as any, tmpDir());
    const { url, close } = await listen(app);
    const res = await fetch(`${url}/api/vendor-applications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.application.status, 'pending');
    assert.equal(json.application.passwordHash, undefined);
    assert.equal(json.application.socials.links[0].network, 'instagram');
    assert.equal(json.profile.projectName, 'إرث الضيافة');
    assert.equal(json.profile.personName, 'نواف محمد المهيع');
    assert.equal(json.user.email, 'apply@usil.app');
    assert.equal(json.user.role, 'client');
    assert.equal(json.listing.title, 'قهوة نجدية');
    assert.equal(json.listing.price, 850);
    assert.ok(String(json.listing.image).startsWith('/uploads/listing-'));
    await close();
  });

  it('rejects a new application without product photos and a price', async () => {
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    registerVendorApplicationRoutes(app, fakeAuth('admin') as any, tmpDir());
    const { url, close } = await listen(app);
    const { listing: _listing, ...noListing } = payload;
    const res = await fetch(`${url}/api/vendor-applications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(noListing),
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /صورتين/);
    await close();
  });

  it('rejects a new application without any social account', async () => {
    const app = express();
    app.use(express.json());
    registerVendorApplicationRoutes(app, fakeAuth('admin') as any, tmpDir());
    const { url, close } = await listen(app);
    const { instagram: _ig, confirmedOwn: _own, ...noSocial } = payload;
    const res = await fetch(`${url}/api/vendor-applications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(noSocial),
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /حساب تواصل واحد/);
    await close();
  });

  it('lets admin approve and create a vendor login', async () => {
    const app = express();
    app.use(express.json());
    const auth = fakeAuth('admin');
    registerVendorApplicationRoutes(app, auth as any, tmpDir());
    const { url, close } = await listen(app);
    const created = await fetch(`${url}/api/vendor-applications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const id = (await created.json()).application.id;
    const approved = await fetch(`${url}/api/admin/vendor-applications/${id}/approve`, { method: 'POST' });
    assert.equal(approved.status, 200);
    const body = await approved.json();
    assert.equal(auth.created.some((row) => row.email === 'apply@usil.app' && row.role === 'vendor'), true);
    assert.equal(body.profile.projectName, 'إرث الضيافة');
    assert.equal(body.workspace.listings.length, 1);
    assert.equal(body.workspace.listings[0].title, 'قهوة نجدية');
    assert.equal(body.workspace.listings[0].price, 850);
    assert.ok(String(body.workspace.listings[0].image).startsWith('/uploads/listing-'));
    assert.equal(body.workspace.profile.projectName, 'إرث الضيافة');
    await close();
  });

  it('rejects guests from the admin list', async () => {
    const app = express();
    app.use(express.json());
    registerVendorApplicationRoutes(app, fakeAuth(null) as any, tmpDir());
    const { url, close } = await listen(app);
    const res = await fetch(`${url}/api/admin/vendor-applications`);
    assert.equal(res.status, 401);
    await close();
  });

  it('hashes passwords with the same scrypt format as login', () => {
    const hashed = hashPassword('Secret1');
    assert.match(hashed, /^[a-f0-9]+:[a-f0-9]+$/);
  });
});

describe('vendor-application-routes — account takeover and orphan uploads', () => {
  const EXISTING = {
    id: 'usr-existing-1',
    name: 'صاحب الحساب',
    email: 'apply@usil.app',
    phone: '0504444000',
    role: 'client',
    avatarUrl: '',
    emailVerified: true,
  };

  async function mountReal(seedUsers: Array<Record<string, unknown>> = []) {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(seedUsers));
    const auth = createAuth(dir);
    const app = express();
    app.use(express.json({ limit: '4mb' }));
    app.post('/api/auth/login', (req, res) => auth.loginHandler(req, res));
    registerVendorApplicationRoutes(app, auth, dir);
    const server = await listen(app);
    return { dir, ...server };
  }

  function listingUploads(dir: string): string[] {
    const uploads = path.join(dir, 'uploads');
    if (!fs.existsSync(uploads)) return [];
    return fs.readdirSync(uploads).filter((name) => !name.endsWith('.svg'));
  }

  function readUsers(dir: string) {
    return JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf-8')) as Array<Record<string, string>>;
  }

  async function apply(url: string, body: unknown, cookie = '') {
    return fetch(`${url}/api/vendor-applications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  }

  it('refuses (409) an application naming an existing email without logging in, and changes nothing', async () => {
    const originalHash = hashPassword('owner-secret');
    const { dir, url, close } = await mountReal([{ ...EXISTING, passwordHash: originalHash }]);
    try {
      const res = await apply(url, { ...payload, password: 'attacker1' });
      assert.equal(res.status, 409);
      const json = await res.json();
      assert.match(json.error, /سجّل الدخول/);
      assert.equal(res.headers.get('set-cookie'), null);
      const [owner] = readUsers(dir);
      assert.equal(owner.passwordHash, originalHash);
      assert.equal(owner.name, EXISTING.name);
      assert.equal(owner.role, 'client');
      assert.deepEqual(listingUploads(dir), []);
      const applicationsFile = path.join(dir, 'vendor-applications.json');
      const stored = fs.existsSync(applicationsFile) ? JSON.parse(fs.readFileSync(applicationsFile, 'utf-8')) : [];
      assert.equal(stored.length, 0);
    } finally {
      await close();
    }
  });

  it('refuses (409) an application reusing an existing phone under a new email', async () => {
    const { dir, url, close } = await mountReal([{ ...EXISTING, passwordHash: hashPassword('owner-secret') }]);
    const res = await apply(url, { ...payload, email: 'fresh@usil.app' });
    assert.equal(res.status, 409);
    assert.equal(readUsers(dir).length, 1);
    assert.deepEqual(listingUploads(dir), []);
    await close();
  });

  it('accepts the owner once logged in, without touching their password, name or phone', async () => {
    const originalHash = hashPassword('owner-secret');
    const { dir, url, close } = await mountReal([{ ...EXISTING, phone: '0501231234', passwordHash: originalHash }]);
    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EXISTING.email, phone: '0501231234', password: 'owner-secret' }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const res = await apply(url, { ...payload, password: 'different1' }, cookie);
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.user.id, EXISTING.id);
    const [owner] = readUsers(dir);
    assert.equal(owner.passwordHash, originalHash);
    assert.equal(owner.name, EXISTING.name);
    assert.equal(owner.phone, '0501231234');
    await close();
  });

  it('still creates a new account for a brand-new email and phone', async () => {
    const { dir, url, close } = await mountReal([]);
    const res = await apply(url, payload);
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.match(json.user.id, /^usr-\d+-[0-9a-f]{8}$/);
    assert.equal(readUsers(dir).length, 1);
    assert.match(res.headers.get('set-cookie') || '', /midyaf_sid=/);
    await close();
  });

  it('writes no uploads when validation fails', async () => {
    const { dir, url, close } = await mountReal([]);
    const { instagram: _ig, confirmedOwn: _own, ...noSocial } = payload;
    const noSocialRes = await apply(url, { ...noSocial, logoDataUrl: TINY_PNG });
    assert.equal(noSocialRes.status, 400);
    const badIban = await apply(url, { ...payload, iban: 'SA12', logoDataUrl: TINY_PNG });
    assert.equal(badIban.status, 400);
    const noPrice = await apply(url, { ...payload, listing: { ...payload.listing, price: 0 } });
    assert.equal(noPrice.status, 400);
    const fakePhotos = await apply(url, {
      ...payload,
      listing: { ...payload.listing, images: ['data:image/png;base64,PHN2Zz48L3N2Zz4=', TINY_PNG] },
    });
    assert.equal(fakePhotos.status, 400);
    assert.deepEqual(listingUploads(dir), []);
    await close();
  });
});


describe('vendor-application-routes — rejection leftovers and password rule', () => {
  async function mount(auth: unknown) {
    const dir = tmpDir();
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    registerVendorApplicationRoutes(app, auth as any, dir);
    const server = await listen(app);
    const post = (route: string, body: unknown = {}) =>
      fetch(`${server.url}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    return { dir, post, ...server };
  }

  it('removes the listing and workspace a rejected application created, and leaves other vendors alone', async () => {
    const { dir, post, close } = await mount(fakeAuth('admin'));
    try {
      // An unrelated approved vendor with their own product.
      const store = createVendorStore(dir);
      store.saveWorkspace('usr-approved', {
        listings: [
          { title: 'منتج معتمد', category: 'hospitality', price: 90, fulfillment: ['hour'], images: ['/uploads/a.jpg'] },
        ],
      });
      const created = await post('/api/vendor-applications', payload);
      assert.equal(created.status, 201);
      const id = (await created.json()).application.id;
      assert.equal(store.getWorkspace('usr-applicant').listings.length, 1);

      const rejected = await post(`/api/admin/vendor-applications/${id}/reject`, { reason: 'بيانات ناقصة' });
      assert.equal(rejected.status, 200);
      assert.equal(store.hasWorkspace('usr-applicant'), false);
      assert.ok(!store.listAllListings().some((row) => row.vendorId === 'usr-applicant'));
      assert.equal(store.getWorkspace('usr-approved').listings.length, 1);
    } finally {
      await close();
    }
  });

  it('never removes the workspace of a vendor account whose new application is rejected', async () => {
    const auth = {
      ...fakeAuth('admin'),
      ensureApplicantUser: (input: { email: string }) => ({ id: 'usr-live-vendor', email: input.email, role: 'vendor' }),
      findUserByEmail: (email: string) => (email === payload.email ? { id: 'usr-live-vendor', email, role: 'vendor' } : null),
    };
    const { dir, post, close } = await mount(auth);
    try {
      const created = await post('/api/vendor-applications', payload);
      assert.equal(created.status, 201);
      const id = (await created.json()).application.id;
      const rejected = await post(`/api/admin/vendor-applications/${id}/reject`);
      assert.equal(rejected.status, 200);
      assert.equal(createVendorStore(dir).getWorkspace('usr-live-vendor').listings.length, 1);
    } finally {
      await close();
    }
  });

  it('requires an 8-character password on a vendor application', async () => {
    const { post, close } = await mount(fakeAuth('admin'));
    try {
      const short = await post('/api/vendor-applications', { ...payload, password: 'Secret1' });
      assert.equal(short.status, 400);
      assert.match((await short.json()).error, /8 خانات/);
      const ok = await post('/api/vendor-applications', { ...payload, password: 'Secret12' });
      assert.equal(ok.status, 201);
    } finally {
      await close();
    }
  });
});
