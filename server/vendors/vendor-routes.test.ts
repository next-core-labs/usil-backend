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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-vendor-api-'));
  // Listing photos must exist under data/uploads.
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  for (const name of ['listing-a.jpg', 'listing-b.jpg']) fs.writeFileSync(path.join(dir, 'uploads', name), 'x');
  return dir;
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

describe('vendor-routes QA fixes', () => {
  const IMAGES = ['/uploads/listing-a.jpg', '/uploads/listing-b.jpg'];
  const listing = (extra: Record<string, unknown> = {}) => ({
    title: 'قهوة',
    category: 'hospitality',
    price: 70,
    fulfillment: ['hour'],
    images: IMAGES,
    ...extra,
  });

  async function serve(auth: unknown, dir: string) {
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    registerVendorRoutes(app, auth as any, dir);
    const server = await listen(app);
    const send = (method: string, route: string, body?: unknown) =>
      fetch(`${server.url}${route}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    return { ...server, send };
  }

  it('rejects forged social verification and javascript links on PUT /api/vendor/socials', async () => {
    const { send, close } = await serve(fakeAuth('vendor'), tmpDir());
    try {
      const forged = await send('PUT', '/api/vendor/socials', {
        confirmedOwn: true,
        links: [{ network: 'instagram', url: 'https://instagram.com/usil', status: 'verified', verifiedBy: 'أنا', verifiedAt: 'x' }],
      });
      assert.equal(forged.status, 200);
      const link = (await forged.json()).data.links[0];
      assert.equal(link.status, 'linked');
      assert.equal(link.verifiedBy, undefined);

      const bad = await send('PUT', '/api/vendor/socials', { links: [{ network: 'x', url: 'javascript:alert(1)' }] });
      assert.equal(bad.status, 400);
      const badWs = await send('PUT', '/api/vendor/workspace', { socials: { youtube: 'javascript:alert(1)' } });
      assert.equal(badWs.status, 400);
    } finally {
      await close();
    }
  });

  it('forces workspace listings onto the vendor and refuses another vendor listing id', async () => {
    const dir = tmpDir();
    const other = await serve(fakeAuth('vendor', 'usr-other'), dir);
    let theirId = '';
    try {
      const created = await other.send('POST', '/api/vendor/listings', listing({ title: 'منتج الآخر' }));
      assert.equal(created.status, 201);
      theirId = (await created.json()).listing.id;
    } finally {
      await other.close();
    }

    const { send, close } = await serve(fakeAuth('vendor'), dir);
    try {
      const stolen = await send('PUT', '/api/vendor/workspace', { listings: [listing({ id: theirId, vendorId: 'usr-other' })] });
      assert.equal(stolen.status, 403);
      const spoofed = await send('PUT', '/api/vendor/workspace', { listings: [listing({ vendorId: 'usr-other' })] });
      assert.equal(spoofed.status, 200);
      const saved = (await spoofed.json()).data.listings;
      assert.equal(saved[0].vendorId, 'usr-vendor');
      const oneImage = await send('PUT', '/api/vendor/workspace', { listings: [listing({ images: [IMAGES[0]] })] });
      assert.equal(oneImage.status, 400);
      const traversal = await send('POST', '/api/vendor/listings', listing({ images: [IMAGES[0], '/uploads/../vendor-workspaces.json'] }));
      assert.equal(traversal.status, 400);
      const remote = await send('PUT', '/api/vendor/workspace', { listings: [listing({ images: [IMAGES[0], 'https://cdn.example.com/a.jpg'] })] });
      assert.equal(remote.status, 400);
    } finally {
      await close();
    }
  });

  it('validates vendor bookings, blocked dates and revenue', async () => {
    const { send, close } = await serve(fakeAuth('vendor'), tmpDir());
    try {
      const base = { customerName: 'سارة', customerPhone: '0501234567', date: '2099-05-01' };
      const past = await send('POST', '/api/vendor/bookings', { ...base, date: '2020-01-01' });
      assert.equal(past.status, 400);
      const badStatus = await send('POST', '/api/vendor/bookings', { ...base, status: 'free-money' });
      assert.equal(badStatus.status, 400);
      const foreign = await send('POST', '/api/vendor/bookings', { ...base, serviceId: 'lst-someone-else' });
      assert.equal(foreign.status, 400);

      const created = await send('POST', '/api/vendor/bookings', { ...base, id: 'bk-mine', totalAmount: 1000 });
      assert.equal(created.status, 201);
      const booking = (await created.json()).booking;
      assert.notEqual(booking.id, 'bk-mine');

      const patched = await send('PATCH', `/api/vendor/bookings/${booking.id}`, { status: 'ملغي', totalAmount: 5, customerPhone: '0500000000' });
      assert.equal(patched.status, 200);
      const patchedJson = (await patched.json()).booking;
      assert.equal(patchedJson.totalAmount, 1000);
      assert.equal(patchedJson.customerPhone, '0501234567');
      const badPatch = await send('PATCH', `/api/vendor/bookings/${booking.id}`, { status: 'nope' });
      assert.equal(badPatch.status, 400);

      await send('POST', '/api/vendor/bookings', { ...base, totalAmount: 400, status: 'مؤكد' });
      const summary = await (await send('GET', '/api/vendor/summary')).json();
      assert.equal(summary.data.revenue, 400);

      const garbage = await send('POST', '/api/vendor/blocked-dates', { date: 'not-a-date' });
      assert.equal(garbage.status, 400);
      const first = await send('POST', '/api/vendor/blocked-dates', { date: '2099-06-01', type: 'holiday' });
      assert.equal(first.status, 201);
      const again = await send('POST', '/api/vendor/blocked-dates', { date: '2099-06-01', type: 'holiday' });
      assert.equal(again.status, 200);
      assert.equal((await again.json()).blockedDate.id, (await first.json()).blockedDate.id);
      const onBlocked = await send('POST', '/api/vendor/bookings', { ...base, date: '2099-06-01' });
      assert.equal(onBlocked.status, 400);
    } finally {
      await close();
    }
  });

  it('shows the edited workspace profile and socials on the public vendor page', async () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, 'vendor-applications.json'),
      JSON.stringify([
        {
          id: 'vap-ok',
          firstName: 'نواف',
          familyName: 'المهيع',
          projectName: 'اسم الطلب',
          email: 'usr-vendor@usil.sa',
          status: 'approved',
          socials: {
            confirmedOwn: true,
            links: [{ network: 'x', handle: 'app', url: 'https://x.com/app', status: 'linked', confirmedOwn: true, updatedAt: '' }],
          },
        },
      ]),
      'utf-8',
    );
    const { send, close } = await serve(fakeAuth('vendor'), dir);
    try {
      const before = await (await send('GET', '/api/vendors/usr-vendor/socials')).json();
      assert.equal(before.data[0].url, 'https://x.com/app');

      const saved = await send('PUT', '/api/vendor/workspace', { profile: { projectName: 'الاسم الجديد', projectType: 'قهوة' } });
      assert.equal(saved.status, 200);
      await send('PUT', '/api/vendor/socials', { instagram: '@new.brand', confirmedOwn: true });

      const page = await send('GET', '/api/vendors/usr-vendor');
      assert.equal(page.status, 200);
      const pageJson = (await page.json()).data;
      assert.equal(pageJson.projectName, 'الاسم الجديد');
      assert.equal(pageJson.projectType, 'قهوة');
      assert.deepEqual(pageJson.socials.map((link: { network: string }) => link.network), ['instagram']);
      const socials = await (await send('GET', '/api/vendors/usr-vendor/socials')).json();
      assert.equal(socials.data[0].url, 'https://www.instagram.com/new.brand');
    } finally {
      await close();
    }
  });

  it('hides socials of an account that is not an approved vendor', async () => {
    const dir = tmpDir();
    const vendor = await serve(fakeAuth('vendor', 'usr-rej'), dir);
    try {
      await vendor.send('PUT', '/api/vendor/socials', { instagram: '@rejected.brand', confirmedOwn: true });
      const listed = await (await vendor.send('GET', '/api/vendors/usr-rej/socials')).json();
      assert.equal(listed.data.length, 1);
    } finally {
      await vendor.close();
    }
    // Same stored socials, but the account is no longer in the vendor list.
    const guest = await serve(fakeAuth(null, 'usr-rej', { vendors: [] }), dir);
    try {
      const page = await guest.send('GET', '/api/vendors/usr-rej');
      assert.equal(page.status, 404);
      const socials = await (await guest.send('GET', '/api/vendors/usr-rej/socials')).json();
      assert.deepEqual(socials.data, []);
    } finally {
      await guest.close();
    }
  });

  it('keeps the admin listing PATCH working, including a listing with broken photos', async () => {
    const dir = tmpDir();
    const vendor = await serve(fakeAuth('vendor'), dir);
    let id = '';
    try {
      id = (await (await vendor.send('POST', '/api/vendor/listings', listing())).json()).listing.id;
    } finally {
      await vendor.close();
    }
    fs.rmSync(path.join(dir, 'uploads', 'listing-a.jpg'));
    fs.writeFileSync(path.join(dir, 'uploads', 'listing-c.jpg'), 'x');

    const admin = await serve(fakeAuth('admin', 'usr-admin'), dir);
    try {
      const lanes = await admin.send('PATCH', `/api/admin/listings/${id}`, { fulfillment: ['tomorrow'] });
      assert.equal(lanes.status, 200);
      assert.deepEqual((await lanes.json()).listing.fulfillment, ['tomorrow']);
      const stillBroken = await admin.send('PATCH', `/api/admin/listings/${id}`, { images: ['/uploads/listing-a.jpg', IMAGES[1]] });
      assert.equal(stillBroken.status, 400);
      const fixed = await admin.send('PATCH', `/api/admin/listings/${id}`, {
        images: ['/uploads/listing-c.jpg', IMAGES[1]],
        price: 90,
      });
      assert.equal(fixed.status, 200);
      const fixedJson = (await fixed.json()).listing;
      assert.deepEqual(fixedJson.images, ['/uploads/listing-c.jpg', IMAGES[1]]);
      assert.equal(fixedJson.price, 90);
      assert.equal(fixedJson.vendorId, 'usr-vendor');
    } finally {
      await admin.close();
    }
  });
});
