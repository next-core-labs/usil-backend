import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { registerVendorRoutes } from './vendor-routes.ts';
import { roleAllowed } from '../auth/roles.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-vendor-api-'));
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

function fakeAuth(
  role: 'vendor' | 'admin' | 'accounts_manager' | 'client' | null,
  id = 'usr-vendor',
  extra: { email?: string; vendors?: Array<{ id: string; name: string; email: string; role: string }> } = {},
) {
  return {
    userFromRequest: () => (role ? { id, role, email: extra.email || `${id}@usil.sa`, name: 'مشرف' } : null),
    requireRole: (roles: string[]) => (req: Request, res: Response, next: NextFunction) => {
      if (!role) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
      if (!roleAllowed(role, roles)) return res.status(403).json({ success: false, error: 'ليست لديك صلاحية هذا الإجراء.' });
      (req as Request & { user: { id: string; role: string; email?: string } }).user = {
        id,
        role,
        email: extra.email || `${id}@usil.sa`,
      };
      next();
    },
    listVendorUsers: () => extra.vendors || (role === 'vendor' ? [{ id, name: 'مشرف', email: extra.email || `${id}@usil.sa`, role: 'vendor' }] : []),
  };
}

describe('vendor-routes', () => {
  it('rejects guests', async () => {
    const app = express();
    app.use(express.json());
    registerVendorRoutes(app, fakeAuth(null) as any, tmpDir());
    const { url, close } = await listen(app);
    const res = await fetch(`${url}/api/vendor/workspace`);
    assert.equal(res.status, 401);
    await close();
  });

  it('rejects clients', async () => {
    const app = express();
    app.use(express.json());
    registerVendorRoutes(app, fakeAuth('client', 'usr-client') as any, tmpDir());
    const { url, close } = await listen(app);
    const res = await fetch(`${url}/api/vendor/summary`);
    assert.equal(res.status, 403);
    await close();
  });

  it('lets a vendor create a booking and read the workspace', async () => {
    const app = express();
    app.use(express.json());
    registerVendorRoutes(app, fakeAuth('vendor') as any, tmpDir());
    const { url, close } = await listen(app);

    const created = await fetch(`${url}/api/vendor/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerName: 'سارة', customerPhone: '0501234567', totalAmount: 2200 }),
    });
    assert.equal(created.status, 201);
    const createdJson = await created.json();
    assert.equal(createdJson.booking.customerName, 'سارة');

    const ws = await fetch(`${url}/api/vendor/workspace`);
    const wsJson = await ws.json();
    assert.equal(wsJson.success, true);
    assert.equal(wsJson.data.bookings.length, 1);

    const sum = await fetch(`${url}/api/vendor/summary`);
    const sumJson = await sum.json();
    assert.equal(sumJson.data.revenue, 2200);

    await close();
  });

  it('returns 400 when booking payload is incomplete', async () => {
    const app = express();
    app.use(express.json());
    registerVendorRoutes(app, fakeAuth('vendor') as any, tmpDir());
    const { url, close } = await listen(app);
    const res = await fetch(`${url}/api/vendor/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceTitle: 'بوفيه' }),
    });
    assert.equal(res.status, 400);
    await close();
  });

  it('patches and deletes a booking', async () => {
    const app = express();
    app.use(express.json());
    registerVendorRoutes(app, fakeAuth('vendor') as any, tmpDir());
    const { url, close } = await listen(app);

    const created = await fetch(`${url}/api/vendor/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerName: 'هند', customerPhone: '0550000000' }),
    });
    const createdJson = await created.json();
    const id = createdJson.booking.id;

    const patched = await fetch(`${url}/api/vendor/bookings/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
    assert.equal(patched.status, 200);
    assert.equal((await patched.json()).booking.status, 'completed');

    const removed = await fetch(`${url}/api/vendor/bookings/${id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    const missing = await fetch(`${url}/api/vendor/bookings/${id}`, { method: 'DELETE' });
    assert.equal(missing.status, 404);
    await close();
  });

  it('blocks and unblocks dates', async () => {
    const app = express();
    app.use(express.json());
    registerVendorRoutes(app, fakeAuth('vendor') as any, tmpDir());
    const { url, close } = await listen(app);

    const bad = await fetch(`${url}/api/vendor/blocked-dates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'بدون تاريخ' }),
    });
    assert.equal(bad.status, 400);

    const created = await fetch(`${url}/api/vendor/blocked-dates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-10-01', reason: 'إجازة', type: 'holiday' }),
    });
    assert.equal(created.status, 201);
    const id = (await created.json()).blockedDate.id;
    const removed = await fetch(`${url}/api/vendor/blocked-dates/${id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    await close();
  });

  it('lets an admin write into another vendor workspace', async () => {
    const app = express();
    app.use(express.json());
    registerVendorRoutes(app, fakeAuth('admin', 'usr-admin') as any, tmpDir());
    const { url, close } = await listen(app);

    const created = await fetch(`${url}/api/vendor/bookings?vendorId=usr-other`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerName: 'فهد', customerPhone: '0533333333' }),
    });
    assert.equal(created.status, 201);

    const own = await fetch(`${url}/api/vendor/workspace`);
    const ownJson = await own.json();
    assert.equal(ownJson.data.bookings.length, 0);

    const other = await fetch(`${url}/api/vendor/workspace?vendorId=usr-other`);
    const otherJson = await other.json();
    assert.equal(otherJson.data.bookings[0].customerName, 'فهد');
    await close();
  });

  it('lets a vendor register a product with fulfillment and shows it on the public catalog', async () => {
    const app = express();
    app.use(express.json());
    registerVendorRoutes(app, fakeAuth('vendor') as any, tmpDir());
    const { url, close } = await listen(app);

    const missing = await fetch(`${url}/api/vendor/listings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'قهوة', category: 'hospitality', price: 70 }),
    });
    assert.equal(missing.status, 400);

    const created = await fetch(`${url}/api/vendor/listings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'قهوة الساعة',
        category: 'hospitality',
        price: 70,
        fulfillment: ['hour', 'same_day'],
        images: ['/uploads/listing-a.jpg', '/uploads/listing-b.jpg'],
      }),
    });
    assert.equal(created.status, 201);
    const createdJson = await created.json();
    assert.deepEqual(createdJson.listing.fulfillment, ['hour', 'same_day']);
    assert.equal(createdJson.listing.images.length, 2);
    assert.equal(createdJson.listing.bookingMode, 'approval');

    const catalog = await fetch(`${url}/api/catalog/listings`);
    const catalogJson = await catalog.json();
    assert.equal(catalog.status, 200);
    assert.equal(catalogJson.data[0].title, 'قهوة الساعة');
    assert.equal(catalogJson.data[0].price, 70);
    assert.equal(catalogJson.data[0].image, '/uploads/listing-a.jpg');
    assert.ok(catalogJson.data[0].fulfillment.includes('hour'));
    await close();
  });

  it('hides listings that still have no vendor photo or checkout price', async () => {
    const dir = tmpDir();
    const app = express();
    app.use(express.json());
    registerVendorRoutes(app, fakeAuth('vendor') as any, dir);
    const { url, close } = await listen(app);
    await fetch(`${url}/api/vendor/listings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'قهوة جاهزة',
        category: 'hospitality',
        price: 90,
        fulfillment: ['hour'],
        images: ['/uploads/listing-a.jpg', '/uploads/listing-b.jpg'],
      }),
    });
    const file = path.join(dir, 'vendor-workspaces.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const vendorId = Object.keys(raw.workspaces)[0];
    raw.workspaces[vendorId].listings.push({
      id: 'lst-incomplete',
      vendorId,
      vendorName: 'مورد',
      title: 'منتج بلا سعر',
      category: 'hospitality',
      categoryName: 'ضيافة وقهوة',
      shortDesc: 'ناقص',
      price: 0,
      priceUnit: 'للمناسبة',
      cities: ['الرياض'],
      images: [],
      fulfillment: ['hour'],
      bookingMode: 'approval',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    fs.writeFileSync(file, JSON.stringify(raw));
    const catalog = await fetch(`${url}/api/catalog/listings`);
    const catalogJson = await catalog.json();
    assert.equal(catalogJson.data.length, 1);
    assert.equal(catalogJson.data[0].title, 'قهوة جاهزة');
    assert.equal(catalogJson.data[0].price, 90);
    await close();
  });

  it('lets a vendor link socials and shows them on the public catalog with an admin verify badge', async () => {
    const dir = tmpDir();
    const savedSocials: unknown[] = [];
    const vendorApp = express();
    vendorApp.use(express.json());
    registerVendorRoutes(
      vendorApp,
      {
        ...fakeAuth('vendor'),
        saveUserSocials: (_id: string, socials: unknown) => {
          savedSocials.push(socials);
          return { id: 'usr-vendor', name: 'مورد', email: 'v@usil.app', phone: '0501111111', role: 'vendor' as const };
        },
        findUserByEmail: () => null,
      } as any,
      dir,
    );
    const vendor = await listen(vendorApp);
    try {
      const saved = await fetch(`${vendor.url}/api/vendor/socials`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instagram: '@usil.cafe', confirmedOwn: true }),
      });
      assert.equal(saved.status, 200);
      assert.equal((await saved.json()).data.links[0].status, 'linked');
      assert.equal(savedSocials.length, 1);

      await fetch(`${vendor.url}/api/vendor/listings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'قهوة مع إنستغرام',
          category: 'hospitality',
          price: 70,
          fulfillment: ['hour'],
          images: ['/uploads/listing-a.jpg', '/uploads/listing-b.jpg'],
        }),
      });
      const catalog = await fetch(`${vendor.url}/api/catalog/listings`);
      const catalogJson = await catalog.json();
      assert.equal(catalogJson.data[0].provider.socials[0].network, 'instagram');
      assert.equal(catalogJson.data[0].provider.socials[0].status, 'linked');
    } finally {
      await vendor.close();
    }

    const adminApp = express();
    adminApp.use(express.json());
    registerVendorRoutes(adminApp, fakeAuth('admin', 'usr-admin') as any, dir);
    const admin = await listen(adminApp);
    try {
      const verified = await fetch(`${admin.url}/api/admin/vendor-socials/usr-vendor/instagram/verify`, { method: 'POST' });
      assert.equal(verified.status, 200);
      assert.equal((await verified.json()).data.links[0].status, 'verified');
      const list = await fetch(`${admin.url}/api/admin/vendor-socials`);
      const listJson = await list.json();
      assert.ok(listJson.data.some((row: { vendorId: string }) => row.vendorId === 'usr-vendor'));
    } finally {
      await admin.close();
    }
  });

  it('lets an accounts manager write into another vendor workspace', async () => {
    const app = express();
    app.use(express.json());
    registerVendorRoutes(app, fakeAuth('accounts_manager', 'usr-accounts') as any, tmpDir());
    const { url, close } = await listen(app);

    const created = await fetch(`${url}/api/vendor/bookings?vendorId=usr-other`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerName: 'لينا', customerPhone: '0544444444' }),
    });
    assert.equal(created.status, 201);

    const other = await fetch(`${url}/api/vendor/workspace?vendorId=usr-other`);
    const otherJson = await other.json();
    assert.equal(otherJson.data.bookings[0].customerName, 'لينا');
    await close();
  });

  it('lists vendor hubs for admin including pending applications', async () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, 'vendor-applications.json'),
      JSON.stringify([
        {
          id: 'vap-wait',
          firstName: 'سارة',
          familyName: 'العتيبي',
          projectName: 'كيك سارة',
          email: 'wait@usil.sa',
          status: 'pending',
        },
      ]),
      'utf-8',
    );
    const app = express();
    app.use(express.json());
    registerVendorRoutes(
      app,
      fakeAuth('admin', 'usr-nawaf', {
        email: 'nawafalmuhayya@gmail.com',
        vendors: [{ id: 'usr-ok', name: 'معتمد', email: 'ok@usil.sa', role: 'vendor' }],
      }) as any,
      dir,
    );
    const { url, close } = await listen(app);
    const res = await fetch(`${url}/api/admin/vendor-hubs`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.data.some((row: { vendorId: string; status: string }) => row.vendorId === 'vap-wait' && row.status === 'pending'));
    assert.ok(json.data.some((row: { vendorId: string }) => row.vendorId === 'usr-ok'));
    await close();
  });

  it('keeps the public catalog empty until a vendor publishes their own listing', async () => {
    const app = express();
    app.use(express.json());
    registerVendorRoutes(app, fakeAuth('vendor') as any, tmpDir());
    const { url, close } = await listen(app);
    const catalog = await fetch(`${url}/api/catalog/listings`);
    const json = await catalog.json();
    assert.equal(catalog.status, 200);
    assert.deepEqual(json.data, []);
    const missing = await fetch(`${url}/api/vendors/usr-nobody`);
    assert.equal(missing.status, 404);
    await close();
  });
});
