import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { registerBookingRoutes } from './booking-routes.ts';
import { createBookingStore, type PlatformBooking } from './booking-store.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-bookings-api-'));
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

type Actor = { id: string; role: string; email?: string; phone?: string; emailVerified?: boolean };

const ACTORS: Record<string, Actor> = {
  admin: { id: 'usr-admin', role: 'admin' },
  manager: { id: 'usr-manager', role: 'accounts_manager' },
  vendor1: { id: 'v-1', role: 'vendor' },
  vendor2: { id: 'v-2', role: 'vendor' },
  courier: { id: 'usr-courier', role: 'courier' },
  client: { id: 'u-client', role: 'client', email: 'client@usil.sa', emailVerified: true, phone: '0512345678' },
  // Registered with a guest's email and phone, never verified it.
  squatter: { id: 'u-squat', role: 'client', email: 'guest@usil.sa', emailVerified: false, phone: '0555555555' },
};

const LISTINGS = [
  {
    id: 'lst-coffee',
    vendorId: 'v-1',
    vendorName: 'قهوة الرياض',
    title: 'ركن قهوة',
    price: 500,
    priceUnit: 'للمناسبة' as const,
    bookingMode: 'instant' as const,
    images: ['/uploads/a.jpg', '/uploads/b.jpg'],
    fulfillment: ['tomorrow' as const],
    cities: ['الرياض'],
  },
  {
    id: 'lst-sweets',
    vendorId: 'v-1',
    vendorName: 'قهوة الرياض',
    title: 'حلويات',
    price: 120.5,
    priceUnit: 'للوحدة' as const,
    bookingMode: 'approval' as const,
    images: ['/uploads/c.jpg'],
    fulfillment: ['same_day' as const],
    cities: ['الرياض'],
  },
  {
    id: 'lst-tent',
    vendorId: 'v-2',
    vendorName: 'خيام',
    title: 'خيمة',
    price: 3000,
    priceUnit: 'للمناسبة' as const,
    bookingMode: 'instant' as const,
    images: ['/uploads/d.jpg'],
    fulfillment: ['tomorrow' as const],
    cities: ['الرياض'],
  },
  {
    id: 'lst-nophoto',
    vendorId: 'v-1',
    vendorName: 'قهوة الرياض',
    title: 'بدون صورة',
    price: 50,
    bookingMode: 'instant' as const,
    images: [],
    fulfillment: ['tomorrow' as const],
  },
  {
    id: 'lst-pending-vendor',
    vendorId: 'v-pending',
    vendorName: 'مورّد لم يُعتمد',
    title: 'منتج',
    price: 50,
    bookingMode: 'instant' as const,
    images: ['/uploads/e.jpg'],
    fulfillment: ['tomorrow' as const],
  },
];

/** 12:00 in Riyadh on 2026-09-24. */
const NOW = new Date('2026-09-24T09:00:00Z');

function row(overrides: Partial<PlatformBooking> = {}): PlatformBooking {
  return {
    id: 'BK-100001',
    name: 'نواف',
    phone: '0512345678',
    email: 'client@usil.sa',
    serviceId: 'lst-coffee',
    serviceName: 'ركن قهوة',
    notes: '',
    city: 'الرياض',
    eventDate: '2026-10-10',
    paymentMethod: 'moyasar',
    settlement: 'ميسر',
    items: [{ id: 'lst-coffee', title: 'ركن قهوة', quantity: 1, price: 500, vendorId: 'v-1' }],
    vendorIds: ['v-1'],
    totalAmount: 500,
    bookingMode: 'instant',
    status: 'جديد',
    paymentStatus: 'unpaid',
    createdAt: '2026-09-20 10:00',
    ...overrides,
  };
}

function buildApp(dir: string, blocked: Record<string, string[]> = {}) {
  const app = express();
  app.use(express.json());
  const userFromRequest = (req: express.Request) => ACTORS[String(req.headers['x-test-actor'] || '')] || null;
  const auth = {
    userFromRequest,
    requireRole: (roles: string[]) => (req: express.Request, res: express.Response, next: () => void) => {
      const user = userFromRequest(req);
      if (!user) return res.status(401).json({ success: false });
      const ok = roles.includes(user.role) || (user.role === 'accounts_manager' && roles.includes('admin'));
      if (!ok) return res.status(403).json({ success: false });
      next();
    },
    listVendorUsers: () => [{ id: 'v-1' }, { id: 'v-2' }],
  };
  registerBookingRoutes(app, auth, dir, {
    listListings: () => LISTINGS,
    blockedDatesFor: (vendorId) => (blocked[vendorId] || []).map((date) => ({ date })),
    now: () => NOW,
  });
  return app;
}

async function call(url: string, method: string, pathname: string, actor = '', body?: unknown) {
  const res = await fetch(`${url}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(actor ? { 'x-test-actor': actor } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, json };
}

function seed(dir: string, rows: PlatformBooking[]) {
  const store = createBookingStore(dir);
  for (const item of [...rows].reverse()) store.add(item);
}

// ─── Moyasar stub: invoices are "raised" without touching the network ───
const realFetch = globalThis.fetch;
const invoiceRequests: Array<{ amount: number; metadata: Record<string, string> }> = [];
let prevSecret: string | undefined;

before(() => {
  prevSecret = process.env.MOYASAR_SECRET_KEY;
  process.env.MOYASAR_SECRET_KEY = 'sk_test_abcdefghijklmnopqrstuvwxyz1234';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.startsWith('https://api.moyasar.com/v1/invoices')) {
      const body = JSON.parse(String(init?.body || '{}'));
      invoiceRequests.push({ amount: body.amount, metadata: body.metadata });
      const id = `inv_${String(invoiceRequests.length).padStart(10, '0')}`;
      return new Response(
        JSON.stringify({ id, status: 'initiated', amount: body.amount, url: `https://checkout.moyasar.com/invoices/${id}` }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return realFetch(input as string, init);
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  if (prevSecret === undefined) delete process.env.MOYASAR_SECRET_KEY;
  else process.env.MOYASAR_SECRET_KEY = prevSecret;
});

const checkout = {
  name: 'نورة',
  phone: '0551234567',
  city: 'الرياض',
  eventDate: '2026-10-10',
  items: [{ id: 'lst-coffee', quantity: 2 }],
};

describe('GET /api/bookings — who sees which orders', () => {
  const rows = [
    row({ id: 'BK-client', userId: 'u-client' }),
    row({ id: 'BK-guest', email: 'guest@usil.sa', phone: '0555555555' }),
    row({ id: 'BK-tent', serviceId: 'lst-tent', items: [{ id: 'lst-tent' }], vendorIds: ['v-2'], email: 'x@usil.sa' }),
    // Pre-stamping row: ownership comes from the listing id alone.
    row({ id: 'BK-legacy', vendorIds: undefined, email: 'y@usil.sa', phone: '0500000000' }),
  ];

  it('scopes clients, vendors, couriers and supervisors', async () => {
    const dir = tmpDir();
    seed(dir, rows);
    const { url, close } = await listen(buildApp(dir));
    const ids = (json: Record<string, any>) => (json.data as PlatformBooking[]).map((b) => b.id).sort();

    assert.equal((await call(url, 'GET', '/api/bookings')).status, 401);
    assert.deepEqual(ids((await call(url, 'GET', '/api/bookings', 'client')).json), ['BK-client']);
    assert.deepEqual(ids((await call(url, 'GET', '/api/bookings', 'squatter')).json), []);
    assert.deepEqual(ids((await call(url, 'GET', '/api/bookings', 'vendor1')).json), ['BK-client', 'BK-guest', 'BK-legacy']);
    assert.deepEqual(ids((await call(url, 'GET', '/api/bookings', 'vendor2')).json), ['BK-tent']);
    assert.equal((await call(url, 'GET', '/api/bookings', 'courier')).status, 403);
    assert.equal(ids((await call(url, 'GET', '/api/bookings', 'admin')).json).length, 4);
    assert.equal(ids((await call(url, 'GET', '/api/bookings', 'manager')).json).length, 4);
    await close();
  });

  it('applies the same rule to a single-booking read', async () => {
    const dir = tmpDir();
    seed(dir, rows);
    const { url, close } = await listen(buildApp(dir));
    assert.equal((await call(url, 'GET', '/api/bookings/BK-client', 'client')).status, 200);
    assert.equal((await call(url, 'GET', '/api/bookings/BK-guest', 'client')).status, 404);
    assert.equal((await call(url, 'GET', '/api/bookings/BK-guest', 'squatter')).status, 404);
    assert.equal((await call(url, 'GET', '/api/bookings/BK-tent', 'vendor1')).status, 404);
    assert.equal((await call(url, 'GET', '/api/bookings/BK-tent', 'vendor2')).status, 200);
    assert.equal((await call(url, 'GET', '/api/bookings/BK-tent', 'courier')).status, 404);
    assert.equal((await call(url, 'GET', '/api/bookings/BK-tent', 'admin')).status, 200);
    assert.equal((await call(url, 'GET', '/api/bookings/BK-tent')).status, 401);
    await close();
  });
});

describe('GET /api/bookings — mixed-vendor orders', () => {
  it('shows each vendor only their own lines and subtotal', async () => {
    const dir = tmpDir();
    seed(dir, [
      row({
        id: 'BK-mixed',
        items: [
          { id: 'lst-coffee', title: 'ركن قهوة', quantity: 2, price: 500, vendorId: 'v-1' },
          { id: 'lst-tent', title: 'خيمة', quantity: 1, price: 2000, vendorId: 'v-2' },
        ],
        vendorIds: ['v-1', 'v-2'],
        totalAmount: 3000,
        moyasarInvoiceId: 'inv-secret',
      }),
    ]);
    const { url, close } = await listen(buildApp(dir));
    try {
      const listed = await call(url, 'GET', '/api/bookings', 'vendor1');
      assert.equal(listed.status, 200);
      const [view] = listed.json.data;
      assert.deepEqual(view.items.map((item: { id: string }) => item.id), ['lst-coffee']);
      assert.equal(view.totalAmount, 1000);
      assert.deepEqual(view.vendorIds, ['v-1']);
      assert.equal(view.moyasarInvoiceId, undefined);

      const single = await call(url, 'GET', '/api/bookings/BK-mixed', 'vendor1');
      assert.equal(single.json.booking.totalAmount, 1000);

      const admin = await call(url, 'GET', '/api/bookings/BK-mixed', 'admin');
      assert.equal(admin.json.booking.items.length, 2);
      assert.equal(admin.json.booking.totalAmount, 3000);
    } finally {
      await close();
    }
  });
});

describe('PATCH /api/bookings/:id — status changes', () => {
  it('lets a vendor move only their own orders, to a canonical status', async () => {
    const dir = tmpDir();
    seed(dir, [
      row({ id: 'BK-own' }),
      row({ id: 'BK-tent', serviceId: 'lst-tent', items: [{ id: 'lst-tent' }], vendorIds: ['v-2'] }),
      row({ id: 'BK-mixed', items: [{ id: 'lst-coffee' }, { id: 'lst-tent' }], vendorIds: ['v-1', 'v-2'] }),
    ]);
    const { url, close } = await listen(buildApp(dir));

    const ok = await call(url, 'PATCH', '/api/bookings/BK-own', 'vendor1', { status: 'مؤكد' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.booking.status, 'مؤكد');

    assert.equal((await call(url, 'PATCH', '/api/bookings/BK-tent', 'vendor1', { status: 'ملغي' })).status, 404);
    assert.equal((await call(url, 'PATCH', '/api/bookings/BK-mixed', 'vendor1', { status: 'ملغي' })).status, 403);
    assert.equal((await call(url, 'PATCH', '/api/bookings/BK-own', 'client', { status: 'مؤكد' })).status, 403);
    assert.equal((await call(url, 'PATCH', '/api/bookings/BK-own', 'courier', { status: 'مؤكد' })).status, 403);

    const store = createBookingStore(dir);
    assert.equal(store.findById('BK-tent')?.status, 'جديد');
    assert.equal(store.findById('BK-mixed')?.status, 'جديد');
    await close();
  });

  it('rejects an empty, missing or unknown status with 400 and never stores null', async () => {
    const dir = tmpDir();
    seed(dir, [row({ id: 'BK-own' })]);
    const { url, close } = await listen(buildApp(dir));
    for (const body of [{}, { status: '' }, { status: '   ' }, { status: null }, { status: 'paid' }, { status: 7 }]) {
      const res = await call(url, 'PATCH', '/api/bookings/BK-own', 'admin', body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(createBookingStore(dir).findById('BK-own')?.status, 'جديد');
    await close();
  });

  it('keeps full control for admins, including mixed-vendor orders', async () => {
    const dir = tmpDir();
    seed(dir, [row({ id: 'BK-mixed', vendorIds: ['v-1', 'v-2'] })]);
    const { url, close } = await listen(buildApp(dir));
    const res = await call(url, 'PATCH', '/api/bookings/BK-mixed', 'manager', { status: 'قيد التنفيذ' });
    assert.equal(res.status, 200);
    assert.equal((await call(url, 'PATCH', '/api/bookings/BK-nope', 'admin', { status: 'مؤكد' })).status, 404);
    await close();
  });
});

describe('DELETE /api/bookings/:id', () => {
  it('returns 404 for a booking that does not exist', async () => {
    const dir = tmpDir();
    seed(dir, [row({ id: 'BK-1' })]);
    const { url, close } = await listen(buildApp(dir));
    assert.equal((await call(url, 'DELETE', '/api/bookings/BK-missing', 'admin')).status, 404);
    assert.equal((await call(url, 'DELETE', '/api/bookings/BK-1', 'vendor1')).status, 403);
    assert.equal((await call(url, 'DELETE', '/api/bookings/BK-1', 'admin')).status, 200);
    assert.equal((await call(url, 'DELETE', '/api/bookings/BK-1', 'admin')).status, 404);
    await close();
  });
});

describe('POST /api/bookings/:id/cancel — customer cancellation', () => {
  it('cancels an unpaid order with nothing to refund', async () => {
    const dir = tmpDir();
    seed(dir, [row({ id: 'BK-c', userId: 'u-client', eventDate: '2026-09-25' })]);
    const { url, close } = await listen(buildApp(dir));
    const res = await call(url, 'POST', '/api/bookings/BK-c/cancel', 'client');
    assert.equal(res.status, 200);
    assert.equal(res.json.booking.status, 'ملغي');
    assert.equal(res.json.booking.cancellation.refundStatus, 'not_applicable');
    assert.equal(res.json.refund.amountSar, 0);
    await close();
  });

  it('follows the refund tiers for a paid order', async () => {
    const dir = tmpDir();
    seed(dir, [
      row({ id: 'BK-full', userId: 'u-client', paymentStatus: 'paid', eventDate: '2026-10-01', totalAmount: 1000 }),
      row({ id: 'BK-half', userId: 'u-client', paymentStatus: 'paid', eventDate: '2026-09-28', totalAmount: 1000 }),
      row({ id: 'BK-none', userId: 'u-client', paymentStatus: 'paid', eventDate: '2026-09-25', totalAmount: 1000 }),
    ]);
    const { url, close } = await listen(buildApp(dir));

    const full = await call(url, 'POST', '/api/bookings/BK-full/cancel', 'client');
    assert.equal(full.json.refund.percent, 100);
    assert.equal(full.json.booking.cancellation.refundHalalas, 100_000);
    assert.equal(full.json.booking.cancellation.refundStatus, 'pending');

    const half = await call(url, 'POST', '/api/bookings/BK-half/cancel', 'client');
    assert.equal(half.json.refund.percent, 50);
    assert.equal(half.json.refund.amountSar, 500);

    const none = await call(url, 'POST', '/api/bookings/BK-none/cancel', 'client');
    assert.equal(none.status, 200);
    assert.equal(none.json.refund.percent, 0);
    assert.equal(none.json.booking.cancellation.refundStatus, 'none');
    assert.match(none.json.booking.cancellation.note, /لا استرجاع/);
    await close();
  });

  it('refuses when policy forbids it, and for someone else\'s order', async () => {
    const dir = tmpDir();
    seed(dir, [
      row({ id: 'BK-started', userId: 'u-client', status: 'قيد التنفيذ' }),
      row({ id: 'BK-done', userId: 'u-client', status: 'مكتمل' }),
      row({ id: 'BK-cancelled', userId: 'u-client', status: 'ملغي' }),
      row({ id: 'BK-past', userId: 'u-client', eventDate: '2026-09-20' }),
      row({ id: 'BK-guest', email: 'guest@usil.sa', phone: '0555555555' }),
    ]);
    const { url, close } = await listen(buildApp(dir));

    const started = await call(url, 'POST', '/api/bookings/BK-started/cancel', 'client');
    assert.equal(started.status, 409);
    assert.match(started.json.error, /بدء التنفيذ/);
    assert.equal((await call(url, 'POST', '/api/bookings/BK-done/cancel', 'client')).status, 409);
    assert.equal((await call(url, 'POST', '/api/bookings/BK-cancelled/cancel', 'client')).status, 409);
    const past = await call(url, 'POST', '/api/bookings/BK-past/cancel', 'client');
    assert.equal(past.status, 409);
    assert.match(past.json.error, /مضى/);
    assert.equal((await call(url, 'POST', '/api/bookings/BK-guest/cancel', 'squatter')).status, 404);
    assert.equal((await call(url, 'POST', '/api/bookings/BK-guest/cancel', 'client')).status, 404);
    assert.equal((await call(url, 'POST', '/api/bookings/BK-guest/cancel', 'vendor1')).status, 403);
    assert.equal((await call(url, 'POST', '/api/bookings/BK-guest/cancel')).status, 401);
    assert.equal(createBookingStore(dir).findById('BK-guest')?.status, 'جديد');
    await close();
  });
});

describe('POST /api/bookings — server-side pricing and checks', () => {
  it('prices from the listings and invoices the server amount', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    const before = invoiceRequests.length;
    const res = await call(url, 'POST', '/api/bookings', 'client', {
      ...checkout,
      items: [
        { id: 'lst-coffee', quantity: 2, price: 1 },
        { id: 'lst-sweets', quantity: 3, price: 1 },
      ],
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    // 2 × 500 + 3 × 120.5
    assert.equal(res.json.booking.totalAmount, 1361.5);
    assert.equal(res.json.booking.userId, 'u-client');
    assert.deepEqual(res.json.booking.vendorIds, ['v-1']);
    assert.equal(res.json.booking.bookingMode, 'approval');
    assert.equal(res.json.booking.items[0].price, 500);
    assert.equal(invoiceRequests.length, before + 1);
    assert.equal(invoiceRequests[invoiceRequests.length - 1].amount, 136_150);
    await close();
  });

  it('rejects a tampered total and accepts the matching one', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    const tampered = await call(url, 'POST', '/api/bookings', '', { ...checkout, totalAmount: 1 });
    assert.equal(tampered.status, 409);
    assert.equal(tampered.json.totalAmount, 1000);
    const matching = await call(url, 'POST', '/api/bookings', '', { ...checkout, totalAmount: 1000 });
    assert.equal(matching.status, 201);
    assert.equal(matching.json.booking.totalAmount, 1000);
    await close();
  });

  it('rejects past, malformed and blocked dates', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir, { 'v-1': ['2026-10-10'] }));
    assert.equal((await call(url, 'POST', '/api/bookings', '', { ...checkout, eventDate: '2026-09-23' })).status, 400);
    assert.equal((await call(url, 'POST', '/api/bookings', '', { ...checkout, eventDate: '' })).status, 400);
    assert.equal((await call(url, 'POST', '/api/bookings', '', { ...checkout, eventDate: '2026-02-30' })).status, 400);
    const blocked = await call(url, 'POST', '/api/bookings', '', checkout);
    assert.equal(blocked.status, 409);
    assert.match(blocked.json.error, /مغلق/);
    // Today is still bookable.
    assert.equal((await call(url, 'POST', '/api/bookings', '', { ...checkout, eventDate: '2026-09-24' })).status, 201);
    await close();
  });

  it('rejects listings that are unknown, off-catalog or from an unapproved vendor', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    for (const id of ['lst-ghost', 'lst-nophoto', 'lst-pending-vendor']) {
      const res = await call(url, 'POST', '/api/bookings', '', { ...checkout, items: [{ id, quantity: 1 }] });
      assert.equal(res.status, 400, id);
    }
    const noItems = await call(url, 'POST', '/api/bookings', '', { ...checkout, items: [] });
    assert.equal(noItems.status, 400);
    for (const quantity of [0, -1, 1.5, 'x', 5000]) {
      const res = await call(url, 'POST', '/api/bookings', '', { ...checkout, items: [{ id: 'lst-coffee', quantity }] });
      assert.equal(res.status, 400, String(quantity));
    }
    assert.equal(createBookingStore(dir).count(), 0);
    await close();
  });

  it('stops an obvious duplicate checkout', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    const first = await call(url, 'POST', '/api/bookings', 'client', checkout);
    assert.equal(first.status, 201);
    const again = await call(url, 'POST', '/api/bookings', 'client', checkout);
    assert.equal(again.status, 200);
    assert.equal(again.json.duplicate, true);
    assert.equal(again.json.booking.id, first.json.booking.id);

    const guest = await call(url, 'POST', '/api/bookings', '', { ...checkout, phone: '0561111111' });
    assert.equal(guest.status, 201);
    const guestAgain = await call(url, 'POST', '/api/bookings', '', { ...checkout, phone: '0561111111' });
    assert.equal(guestAgain.status, 409);

    // A different date is a different order.
    const other = await call(url, 'POST', '/api/bookings', 'client', { ...checkout, eventDate: '2026-10-11' });
    assert.equal(other.status, 201);
    assert.equal(createBookingStore(dir).count(), 3);
    await close();
  });

  it('keeps a clear error and stores nothing when Moyasar is not configured', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    const saved = process.env.MOYASAR_SECRET_KEY;
    delete process.env.MOYASAR_SECRET_KEY;
    try {
      const res = await call(url, 'POST', '/api/bookings', '', checkout);
      assert.equal(res.status, 503);
      assert.match(res.json.error, /ميسر غير مفعّل/);
      assert.equal(createBookingStore(dir).count(), 0);
    } finally {
      process.env.MOYASAR_SECRET_KEY = saved;
      await close();
    }
  });
});

describe('POST /api/bookings — field shapes', () => {
  it('refuses objects and arrays in text fields and stores nothing', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    try {
      const bad: Array<Record<string, unknown>> = [
        { name: { $gt: '' } },
        { notes: { a: [1] } },
        { city: ['x'] },
        { email: { x: 1 } },
        { serviceName: ['a', 'b'] },
        { eventDate: { y: 2026 } },
        { phone: ['0551234567'] },
        { serviceId: { id: 'lst-coffee' } },
        { totalAmount: { n: 1000 } },
      ];
      for (const patch of bad) {
        const res = await call(url, 'POST', '/api/bookings', '', { ...checkout, ...patch });
        assert.equal(res.status, 400, JSON.stringify(patch));
      }
      const blankName = await call(url, 'POST', '/api/bookings', '', { ...checkout, name: '   ' });
      assert.equal(blankName.status, 400);
      assert.equal(createBookingStore(dir).count(), 0);
    } finally {
      await close();
    }
  });

  it('requires items to be an array of plain objects with string ids', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    try {
      for (const items of ['lst-coffee', { id: 'lst-coffee' }, [['lst-coffee']], [null], [{ id: 7 }], [{ id: { $ne: '' } }], [{ id: '  ' }]]) {
        const res = await call(url, 'POST', '/api/bookings', '', { ...checkout, items });
        assert.equal(res.status, 400, JSON.stringify(items));
      }
      assert.equal(createBookingStore(dir).count(), 0);
    } finally {
      await close();
    }
  });

  it('trims and caps the text it stores', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    try {
      const res = await call(url, 'POST', '/api/bookings', '', {
        ...checkout,
        name: `  ${'ن'.repeat(300)}  `,
        notes: 'م'.repeat(5000),
        city: `  ${'ر'.repeat(200)}`,
      });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      const stored = createBookingStore(dir).findById(res.json.booking.id)!;
      assert.equal(stored.name.length, 100);
      assert.equal(stored.notes.length, 1000);
      assert.equal(stored.city.length, 80);
      assert.equal(typeof stored.email, 'string');
    } finally {
      await close();
    }
  });
});

describe('POST /api/bookings — duplicate check needs the same buyer', () => {
  it('a stranger\'s order with the same phone does not block a signed-in customer', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    try {
      // A guest types the client's phone and an email of their own.
      const squat = await call(url, 'POST', '/api/bookings', '', { ...checkout, phone: '0512345678', email: 'x@evil.sa' });
      assert.equal(squat.status, 201);
      const mine = await call(url, 'POST', '/api/bookings', 'client', { ...checkout, phone: '0512345678' });
      assert.equal(mine.status, 201, JSON.stringify(mine.json));
      assert.notEqual(mine.json.booking.id, squat.json.booking.id);
      // The guest's own repeat is still caught.
      const again = await call(url, 'POST', '/api/bookings', '', { ...checkout, phone: '0512345678', email: 'x@evil.sa' });
      assert.equal(again.status, 409);
    } finally {
      await close();
    }
  });
});

describe('PATCH /api/bookings/:id — transition rules', () => {
  it('keeps final statuses final for vendors and never goes back to new', async () => {
    const dir = tmpDir();
    seed(dir, [
      row({ id: 'BK-cancelled', status: 'ملغي' }),
      row({ id: 'BK-done', status: 'مكتمل' }),
      row({ id: 'BK-rejected', status: 'مرفوض من المورّد' }),
      row({ id: 'BK-confirmed', status: 'مؤكد' }),
    ]);
    const { url, close } = await listen(buildApp(dir));
    try {
      for (const id of ['BK-cancelled', 'BK-done', 'BK-rejected']) {
        const res = await call(url, 'PATCH', `/api/bookings/${id}`, 'vendor1', { status: 'مؤكد' });
        assert.equal(res.status, 409, id);
        assert.match(res.json.error, /لا يمكن تغيير حالته/);
      }
      const back = await call(url, 'PATCH', '/api/bookings/BK-confirmed', 'vendor1', { status: 'جديد' });
      assert.equal(back.status, 409);
      const store = createBookingStore(dir);
      assert.equal(store.findById('BK-cancelled')?.status, 'ملغي');
      assert.equal(store.findById('BK-done')?.status, 'مكتمل');
      assert.equal(store.findById('BK-confirmed')?.status, 'مؤكد');

      // The normal path still works.
      assert.equal((await call(url, 'PATCH', '/api/bookings/BK-confirmed', 'vendor1', { status: 'قيد التنفيذ' })).status, 200);
      assert.equal((await call(url, 'PATCH', '/api/bookings/BK-confirmed', 'vendor1', { status: 'مكتمل' })).status, 200);
    } finally {
      await close();
    }
  });

  it('lets an admin override a final status', async () => {
    const dir = tmpDir();
    seed(dir, [row({ id: 'BK-done', status: 'مكتمل' })]);
    const { url, close } = await listen(buildApp(dir));
    try {
      const res = await call(url, 'PATCH', '/api/bookings/BK-done', 'admin', { status: 'قيد التنفيذ' });
      assert.equal(res.status, 200);
      assert.equal(res.json.booking.status, 'قيد التنفيذ');
    } finally {
      await close();
    }
  });
});

describe('PATCH /api/bookings/:id — ending a paid order', () => {
  it('refuses a vendor cancelling or rejecting a paid order', async () => {
    const dir = tmpDir();
    seed(dir, [row({ id: 'BK-paid', paymentStatus: 'paid', status: 'مؤكد' })]);
    const { url, close } = await listen(buildApp(dir));
    try {
      for (const status of ['ملغي', 'مرفوض من المورّد']) {
        const res = await call(url, 'PATCH', '/api/bookings/BK-paid', 'vendor1', { status });
        assert.equal(res.status, 409, status);
        assert.match(res.json.error, /إدارة يوصل/);
      }
      const stored = createBookingStore(dir).findById('BK-paid');
      assert.equal(stored?.status, 'مؤكد');
      assert.equal(stored?.cancellation, undefined);
    } finally {
      await close();
    }
  });

  it('records a pending full refund when an admin cancels a paid order', async () => {
    const dir = tmpDir();
    seed(dir, [row({ id: 'BK-paid', paymentStatus: 'paid', status: 'مؤكد', totalAmount: 1234.5 })]);
    const { url, close } = await listen(buildApp(dir));
    try {
      const res = await call(url, 'PATCH', '/api/bookings/BK-paid', 'admin', { status: 'ملغي' });
      assert.equal(res.status, 200);
      const cancellation = createBookingStore(dir).findById('BK-paid')?.cancellation;
      assert.equal(cancellation?.cancelledBy, 'admin');
      assert.equal(cancellation?.refundPercent, 100);
      assert.equal(cancellation?.refundHalalas, 123_450);
      assert.equal(cancellation?.refundStatus, 'pending');
      assert.ok(cancellation?.cancelledAt);
    } finally {
      await close();
    }
  });

  it('lets a vendor reject an unpaid order, noting nothing is owed', async () => {
    const dir = tmpDir();
    seed(dir, [row({ id: 'BK-unpaid', status: 'بانتظار موافقة المورّد' })]);
    const { url, close } = await listen(buildApp(dir));
    try {
      const res = await call(url, 'PATCH', '/api/bookings/BK-unpaid', 'vendor1', { status: 'مرفوض من المورّد' });
      assert.equal(res.status, 200);
      assert.equal(res.json.booking.cancellation.cancelledBy, 'vendor');
      assert.equal(res.json.booking.cancellation.refundStatus, 'not_applicable');
    } finally {
      await close();
    }
  });
});
