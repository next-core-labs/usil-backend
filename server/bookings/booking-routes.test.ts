import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { registerBookingRoutes, uniqueBookingId } from './booking-routes.ts';
import { setMailFetchForTests } from '../shared/optional-mail.ts';
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
    id: 'lst-chairs',
    vendorId: 'v-2',
    vendorName: 'خيام',
    title: 'كراسي',
    price: 10,
    priceUnit: 'للوحدة' as const,
    bookingMode: 'instant' as const,
    images: ['/uploads/f.jpg'],
    fulfillment: ['tomorrow' as const],
    cities: ['الرياض'],
    minQuantity: 20,
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

function buildApp(
  dir: string,
  blocked: Record<string, string[]> = {},
  vendorCalendar: Record<string, Array<{ id?: string; serviceId?: string; date?: string; status?: string }>> = {},
) {
  const app = express();
  app.use(express.json());
  const userFromRequest = (req: express.Request) => ACTORS[String(req.headers['x-test-actor'] || '')] || null;
  const auth = {
    userFromRequest,
    requireRole: (roles: string[], options?: { exact?: boolean }) => (req: express.Request, res: express.Response, next: () => void) => {
      const user = userFromRequest(req);
      if (!user) return res.status(401).json({ success: false });
      const ok =
        roles.includes(user.role) || (!options?.exact && user.role === 'accounts_manager' && roles.includes('admin'));
      if (!ok) return res.status(403).json({ success: false });
      next();
    },
    listVendorUsers: () => [
      { id: 'v-1', email: 'v1@usil.sa' },
      { id: 'v-2', email: 'v2@usil.sa' },
    ],
    findUserByEmail: (email: string) =>
      ['client@usil.sa', 'owner@usil.sa'].includes(email.trim().toLowerCase()) ? { id: 'registered' } : null,
  };
  registerBookingRoutes(app, auth, dir, {
    listListings: () => LISTINGS,
    blockedDatesFor: (vendorId) => (blocked[vendorId] || []).map((date) => ({ date })),
    vendorBookingsFor: (vendorId) => vendorCalendar[vendorId] || [],
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
const cancelledInvoices: string[] = [];
let prevSecret: string | undefined;

before(() => {
  prevSecret = process.env.MOYASAR_SECRET_KEY;
  process.env.MOYASAR_SECRET_KEY = 'sk_test_abcdefghijklmnopqrstuvwxyz1234';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    const cancel = /^https:\/\/api\.moyasar\.com\/v1\/invoices\/([^/]+)\/cancel$/.exec(target);
    if (cancel && init?.method === 'PUT') {
      cancelledInvoices.push(decodeURIComponent(cancel[1]));
      return new Response(JSON.stringify({ id: cancel[1], status: 'canceled' }), { status: 200 });
    }
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
      row({ id: 'BK-own', bookingMode: 'approval', status: 'بانتظار موافقة المورّد' }),
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
        { id: 'lst-tent', quantity: 1, price: 1 },
      ],
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    // 2 × 500 + 1 × 3000
    assert.equal(res.json.booking.totalAmount, 4000);
    assert.equal(res.json.booking.userId, 'u-client');
    assert.deepEqual(res.json.booking.vendorIds.sort(), ['v-1', 'v-2']);
    assert.equal(res.json.booking.bookingMode, 'instant');
    assert.equal(res.json.booking.items[0].price, 500);
    assert.equal(invoiceRequests.length, before + 1);
    assert.equal(invoiceRequests[invoiceRequests.length - 1].amount, 400_000);
    await close();
  });

  it('holds an approval cart for the vendor without charging, and needs an account', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    try {
      const cart = { ...checkout, items: [{ id: 'lst-coffee', quantity: 2 }, { id: 'lst-sweets', quantity: 3 }] };
      const guest = await call(url, 'POST', '/api/bookings', '', cart);
      assert.equal(guest.status, 401);
      assert.equal(guest.json.needsLogin, true);

      const before = invoiceRequests.length;
      const res = await call(url, 'POST', '/api/bookings', 'client', cart);
      assert.equal(res.status, 201, JSON.stringify(res.json));
      // 2 × 500 + 3 × 120.5, priced on the server
      assert.equal(res.json.booking.totalAmount, 1361.5);
      assert.equal(res.json.booking.bookingMode, 'approval');
      assert.equal(res.json.booking.status, 'بانتظار موافقة المورّد');
      assert.equal(res.json.awaitingApproval, true);
      assert.equal(res.json.booking.paymentUrl, undefined);
      assert.equal(invoiceRequests.length, before);

      // The vendor's approval raises the invoice for the stored amount.
      const id = res.json.booking.id;
      const approved = await call(url, 'PATCH', `/api/bookings/${id}`, 'vendor1', { status: 'مؤكد' });
      assert.equal(approved.status, 200);
      assert.equal(approved.json.booking.status, 'مؤكد');
      assert.equal(invoiceRequests.length, before + 1);
      assert.equal(invoiceRequests[invoiceRequests.length - 1].amount, 136_150);
      assert.match(approved.json.booking.paymentUrl, /^https:\/\/checkout\.moyasar\.com\//);
    } finally {
      await close();
    }
  });

  it('never files a guest order into a registered account', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    try {
      const guest = await call(url, 'POST', '/api/bookings', '', { ...checkout, email: 'Client@usil.sa' });
      assert.equal(guest.status, 409);
      assert.equal(guest.json.needsLogin, true);
      assert.equal(createBookingStore(dir).list().length, 0);

      // A signed-in order always carries the session's own email, whatever is typed.
      const own = await call(url, 'POST', '/api/bookings', 'client', { ...checkout, email: 'owner@usil.sa' });
      assert.equal(own.status, 201);
      assert.equal(own.json.booking.email, 'client@usil.sa');

      // Another day: the client's order already holds 2026-10-10 for this listing.
      const fresh = await call(url, 'POST', '/api/bookings', '', { ...checkout, eventDate: '2026-10-12', email: 'new.guest@usil.sa' });
      assert.equal(fresh.status, 201);
    } finally {
      await close();
    }
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
    // A «قبل يوم للتجهيز» listing can't be booked for today; tomorrow is fine.
    const today = await call(url, 'POST', '/api/bookings', '', { ...checkout, eventDate: '2026-09-24' });
    assert.equal(today.status, 409);
    assert.match(today.json.error, /يوماً للتجهيز/);
    assert.equal((await call(url, 'POST', '/api/bookings', '', { ...checkout, eventDate: '2026-09-25' })).status, 201);
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

    // A guest on a free day (the client holds 2026-10-10); their double tap is caught too.
    const guestOrder = { ...checkout, phone: '0561111111', eventDate: '2026-10-12' };
    const guest = await call(url, 'POST', '/api/bookings', '', guestOrder);
    assert.equal(guest.status, 201);
    const guestAgain = await call(url, 'POST', '/api/bookings', '', guestOrder);
    assert.equal(guestAgain.status, 409);
    assert.equal(guestAgain.json.duplicate, true);

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
        city: '  الرياض  ',
      });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      const stored = createBookingStore(dir).findById(res.json.booking.id)!;
      assert.equal(stored.name.length, 100);
      assert.equal(stored.notes.length, 1000);
      assert.equal(stored.city, 'الرياض');
      assert.equal(typeof stored.email, 'string');
    } finally {
      await close();
    }
  });
});

describe('POST /api/bookings — where the event is', () => {
  it('refuses a made-up city and a city the listing does not serve', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    try {
      const fake = await call(url, 'POST', '/api/bookings', '', { ...checkout, city: 'مدينة وهمية' });
      assert.equal(fake.status, 400);
      const outside = await call(url, 'POST', '/api/bookings', '', { ...checkout, city: 'جدة' });
      assert.equal(outside.status, 409);
      assert.match(outside.json.error, /ما يخدم جدة/);
      assert.equal(createBookingStore(dir).count(), 0);
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
      // Same listing and day: the date is the guest's now. The client is told it's taken,
      // never handed the stranger's order as if it were their own.
      const mine = await call(url, 'POST', '/api/bookings', 'client', { ...checkout, phone: '0512345678' });
      assert.equal(mine.status, 409, JSON.stringify(mine.json));
      assert.equal(mine.json.slotTaken, true);
      assert.equal(mine.json.duplicate, undefined);
      assert.equal(mine.json.booking, undefined);
      // Another day is free for the client.
      const otherDay = await call(url, 'POST', '/api/bookings', 'client', { ...checkout, phone: '0512345678', eventDate: '2026-10-12' });
      assert.equal(otherDay.status, 201, JSON.stringify(otherDay.json));
      assert.notEqual(otherDay.json.booking.id, squat.json.booking.id);
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
      row({ id: 'BK-confirmed', status: 'مؤكد', paymentStatus: 'paid' }),
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

  it('keeps unpaid orders from being started, completed or hand-confirmed by a vendor', async () => {
    const dir = tmpDir();
    seed(dir, [
      row({ id: 'BK-unpaid-new' }),
      row({ id: 'BK-unpaid-ok', status: 'مؤكد' }),
      row({ id: 'BK-admin', status: 'مؤكد' }),
    ]);
    const { url, close } = await listen(buildApp(dir));
    try {
      const confirm = await call(url, 'PATCH', '/api/bookings/BK-unpaid-new', 'vendor1', { status: 'مؤكد' });
      assert.equal(confirm.status, 409);
      assert.match(confirm.json.error, /تلقائياً بعد دفع/);
      for (const status of ['قيد التنفيذ', 'مكتمل']) {
        const res = await call(url, 'PATCH', '/api/bookings/BK-unpaid-ok', 'vendor1', { status });
        assert.equal(res.status, 409, status);
        assert.match(res.json.error, /لم يُدفع/);
      }
      // Declining an unpaid order is still the vendor's call.
      assert.equal((await call(url, 'PATCH', '/api/bookings/BK-unpaid-new', 'vendor1', { status: 'مرفوض من المورّد' })).status, 200);
      // An admin may still push it through (logged as an override).
      assert.equal((await call(url, 'PATCH', '/api/bookings/BK-admin', 'admin', { status: 'مكتمل' })).status, 200);
      assert.equal(createBookingStore(dir).findById('BK-unpaid-ok')?.status, 'مؤكد');
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
      const res = await call(url, 'PATCH', '/api/bookings/BK-unpaid', 'vendor1', {
        status: 'مرفوض من المورّد',
        reason: '  فريق التصوير محجوز   يوم 19 نوفمبر ',
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.booking.cancellation.cancelledBy, 'vendor');
      assert.equal(res.json.booking.cancellation.refundStatus, 'not_applicable');
      assert.equal(res.json.booking.cancellation.reason, 'فريق التصوير محجوز يوم 19 نوفمبر');
      assert.match(res.json.booking.cancellation.note, /رفضه المورّد/);
    } finally {
      await close();
    }
  });
});

/** Mails sent through Resend while `fn` runs (fire-and-forget sends are awaited a tick). */
async function captureMail(fn: () => Promise<void>): Promise<Array<{ to: string[]; subject: string; text: string }>> {
  const sent: Array<{ to: string[]; subject: string; text: string }> = [];
  const savedKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 're_test';
  setMailFetchForTests(async (_url, init) => {
    sent.push(JSON.parse(String(init.body)));
    return { ok: true, status: 200, text: async () => '{}' };
  });
  try {
    await fn();
    await new Promise((done) => setTimeout(done, 20));
  } finally {
    setMailFetchForTests(null);
    if (savedKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = savedKey;
  }
  return sent;
}

async function waitFor(check: () => boolean, ms = 500) {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((done) => setTimeout(done, 5));
}

describe('booking ids', () => {
  it('never hands out an id that is already taken', () => {
    const taken = new Set(['BK-111111', 'BK-222222']);
    const sequence = ['BK-111111', 'BK-222222', 'BK-333333'];
    const id = uniqueBookingId((candidate) => taken.has(candidate), (attempt) => sequence[attempt]);
    assert.equal(id, 'BK-333333');
    assert.match(uniqueBookingId(() => false), /^BK-\d{6}$/);
    assert.throws(() => uniqueBookingId(() => true, () => 'BK-111111'));
  });
});

describe('POST /api/bookings — event time, minimum quantity, duplicates', () => {
  it('stores an optional HH:mm event time and shows it to the client, vendor and admin', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    try {
      for (const eventTime of ['25:00', '7pm', '12:60', 9]) {
        const bad = await call(url, 'POST', '/api/bookings', 'client', { ...checkout, eventTime });
        assert.equal(bad.status, 400, String(eventTime));
      }
      const res = await call(url, 'POST', '/api/bookings', 'client', { ...checkout, eventTime: '19:30', notes: 'المدخل الشرقي' });
      assert.equal(res.status, 201);
      assert.equal(res.json.booking.eventTime, '19:30');
      assert.equal(res.json.booking.notes, 'المدخل الشرقي');
      for (const actor of ['client', 'vendor1', 'admin']) {
        const listed = await call(url, 'GET', '/api/bookings', actor);
        assert.equal(listed.json.data[0].eventTime, '19:30', actor);
      }
      // No time given: no field.
      const plain = await call(url, 'POST', '/api/bookings', 'client', { ...checkout, eventDate: '2026-10-12', eventTime: '' });
      assert.equal(plain.status, 201);
      assert.equal(plain.json.booking.eventTime, undefined);
    } finally {
      await close();
    }
  });

  it('enforces the listing minimum quantity', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    try {
      const low = await call(url, 'POST', '/api/bookings', 'client', { ...checkout, items: [{ id: 'lst-chairs', quantity: 5 }] });
      assert.equal(low.status, 400);
      assert.match(low.json.error, /أقل كمية/);
      assert.match(low.json.error, /20/);
      const ok = await call(url, 'POST', '/api/bookings', 'client', { ...checkout, items: [{ id: 'lst-chairs', quantity: 20 }] });
      assert.equal(ok.status, 201);
      assert.equal(ok.json.booking.totalAmount, 200);
    } finally {
      await close();
    }
  });

  it('answers a duplicate with the first order so the client can resume it', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    try {
      // Approval order, signed in: the same account gets the row back, flagged as awaiting approval.
      const approval = { ...checkout, items: [{ id: 'lst-sweets', quantity: 1 }] };
      const first = await call(url, 'POST', '/api/bookings', 'client', approval);
      assert.equal(first.status, 201);
      const again = await call(url, 'POST', '/api/bookings', 'client', approval);
      assert.equal(again.status, 200);
      assert.equal(again.json.duplicate, true);
      assert.equal(again.json.awaitingApproval, true);
      assert.equal(again.json.booking.id, first.json.booking.id);

      // Guest without an email: 409, with the first order's id, status and pay link.
      const guest = { ...checkout, phone: '0562222222' };
      const paid = await call(url, 'POST', '/api/bookings', '', guest);
      assert.equal(paid.status, 201);
      const guestAgain = await call(url, 'POST', '/api/bookings', '', guest);
      assert.equal(guestAgain.status, 409);
      assert.equal(guestAgain.json.duplicate, true);
      assert.deepEqual(guestAgain.json.booking, {
        id: paid.json.booking.id,
        status: 'جديد',
        paymentUrl: paid.json.booking.paymentUrl,
        awaitingApproval: false,
      });

      // Guest with an email: the stored-row match, same 409 shape.
      const emailGuest = { ...checkout, phone: '0563333333', email: 'walkin@usil.sa', eventDate: '2026-10-13' };
      const firstEmail = await call(url, 'POST', '/api/bookings', '', emailGuest);
      const emailAgain = await call(url, 'POST', '/api/bookings', '', emailGuest);
      assert.equal(emailAgain.status, 409);
      assert.equal(emailAgain.json.booking.id, firstEmail.json.booking.id);
      assert.equal(emailAgain.json.booking.paymentUrl, firstEmail.json.booking.paymentUrl);
    } finally {
      await close();
    }
  });

  it('emails each vendor about an approval order', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    try {
      const sent = await captureMail(async () => {
        const res = await call(url, 'POST', '/api/bookings', 'client', {
          ...checkout,
          items: [{ id: 'lst-sweets', quantity: 1 }, { id: 'lst-tent', quantity: 1 }],
        });
        assert.equal(res.status, 201);
      });
      assert.deepEqual(sent.map((mail) => mail.to[0]).sort(), ['v1@usil.sa', 'v2@usil.sa']);
      const v2 = sent.find((mail) => mail.to[0] === 'v2@usil.sa')!;
      assert.match(v2.subject, /موافقتك/);
      assert.match(v2.text, /خيمة/);
      assert.doesNotMatch(v2.text, /حلويات/);
    } finally {
      await close();
    }
  });
});

describe('GET /api/bookings?vendorId= — supervising one vendor', () => {
  it('gives an admin exactly the vendor-trimmed rows that vendor sees', async () => {
    const dir = tmpDir();
    seed(dir, [
      row({ id: 'BK-own' }),
      row({ id: 'BK-tent', serviceId: 'lst-tent', items: [{ id: 'lst-tent' }], vendorIds: ['v-2'] }),
      row({
        id: 'BK-mixed',
        items: [
          { id: 'lst-coffee', title: 'ركن قهوة', quantity: 1, price: 500, vendorId: 'v-1' },
          { id: 'lst-tent', title: 'خيمة', quantity: 1, price: 3000, vendorId: 'v-2' },
        ],
        vendorIds: ['v-1', 'v-2'],
        totalAmount: 3500,
        moyasarInvoiceId: 'inv-secret',
      }),
    ]);
    const { url, close } = await listen(buildApp(dir));
    try {
      const asAdmin = await call(url, 'GET', '/api/bookings?vendorId=v-2', 'manager');
      const asVendor = await call(url, 'GET', '/api/bookings', 'vendor2');
      assert.deepEqual(asAdmin.json.data, asVendor.json.data);
      const mixed = asAdmin.json.data.find((b: PlatformBooking) => b.id === 'BK-mixed');
      assert.equal(mixed.totalAmount, 3000);
      assert.equal(mixed.moyasarInvoiceId, undefined);
      // A vendor cannot use the filter to read another vendor's orders.
      const sneaky = await call(url, 'GET', '/api/bookings?vendorId=v-2', 'vendor1');
      assert.deepEqual(sneaky.json.data.map((b: PlatformBooking) => b.id).sort(), ['BK-mixed', 'BK-own']);
    } finally {
      await close();
    }
  });
});

describe('PATCH /api/bookings/:id — approval rules', () => {
  it('stops a vendor moving an order into «بانتظار موافقة المورّد»', async () => {
    const dir = tmpDir();
    seed(dir, [row({ id: 'BK-new' })]);
    const { url, close } = await listen(buildApp(dir));
    try {
      const res = await call(url, 'PATCH', '/api/bookings/BK-new', 'vendor1', { status: 'بانتظار موافقة المورّد' });
      assert.equal(res.status, 409);
      assert.equal(createBookingStore(dir).findById('BK-new')?.status, 'جديد');
    } finally {
      await close();
    }
  });

  it('does not let a vendor approve an unpaid instant order parked in pending', async () => {
    const dir = tmpDir();
    seed(dir, [row({ id: 'BK-parked', bookingMode: 'instant', status: 'بانتظار موافقة المورّد' })]);
    const { url, close } = await listen(buildApp(dir));
    try {
      const res = await call(url, 'PATCH', '/api/bookings/BK-parked', 'vendor1', { status: 'مؤكد' });
      assert.equal(res.status, 409);
      assert.match(res.json.error, /تلقائياً بعد دفع/);
    } finally {
      await close();
    }
  });

  it('refuses to confirm an order whose date has passed or is now blocked', async () => {
    const dir = tmpDir();
    seed(dir, [
      row({ id: 'BK-past', bookingMode: 'approval', status: 'بانتظار موافقة المورّد', eventDate: '2026-09-23' }),
      row({ id: 'BK-blocked', bookingMode: 'approval', status: 'بانتظار موافقة المورّد', eventDate: '2026-10-20' }),
      row({ id: 'BK-fine', bookingMode: 'approval', status: 'بانتظار موافقة المورّد', eventDate: '2026-10-21' }),
    ]);
    const { url, close } = await listen(buildApp(dir, { 'v-1': ['2026-10-20'] }));
    try {
      const past = await call(url, 'PATCH', '/api/bookings/BK-past', 'vendor1', { status: 'مؤكد' });
      assert.equal(past.status, 409);
      assert.match(past.json.error, /مضى/);
      const blocked = await call(url, 'PATCH', '/api/bookings/BK-blocked', 'admin', { status: 'مؤكد' });
      assert.equal(blocked.status, 409);
      assert.match(blocked.json.error, /مغلق/);
      assert.equal((await call(url, 'PATCH', '/api/bookings/BK-fine', 'vendor1', { status: 'مؤكد' })).status, 200);
      // Rejecting is still possible.
      assert.equal((await call(url, 'PATCH', '/api/bookings/BK-past', 'vendor1', { status: 'مرفوض من المورّد' })).status, 200);
    } finally {
      await close();
    }
  });

  it('emails the client and cancels the unpaid invoice when an order is rejected or cancelled', async () => {
    const dir = tmpDir();
    seed(dir, [
      row({ id: 'BK-reject', status: 'بانتظار موافقة المورّد', bookingMode: 'approval', moyasarInvoiceId: 'inv_toreject01' }),
      row({ id: 'BK-cancel', moyasarInvoiceId: 'inv_tocancel01', email: 'other@usil.sa' }),
    ]);
    const { url, close } = await listen(buildApp(dir));
    cancelledInvoices.length = 0;
    try {
      const sent = await captureMail(async () => {
        assert.equal((await call(url, 'PATCH', '/api/bookings/BK-reject', 'vendor1', { status: 'مرفوض من المورّد' })).status, 200);
        assert.equal((await call(url, 'PATCH', '/api/bookings/BK-cancel', 'admin', { status: 'ملغي' })).status, 200);
      });
      assert.deepEqual(sent.map((mail) => mail.to[0]).sort(), ['client@usil.sa', 'other@usil.sa']);
      assert.ok(sent.every((mail) => /تعذّر تنفيذ طلبك/.test(mail.text)));
      await waitFor(() => cancelledInvoices.length >= 2);
      assert.deepEqual(cancelledInvoices.sort(), ['inv_tocancel01', 'inv_toreject01']);
    } finally {
      await close();
    }
  });
});

describe('POST /api/bookings/:id/refund-done', () => {
  it('lets a supervisor close a pending refund, and only a pending one', async () => {
    const dir = tmpDir();
    const pending = {
      cancelledAt: '2026-09-23T10:00:00.000Z',
      cancelledBy: 'admin' as const,
      refundPercent: 100 as const,
      refundHalalas: 50_000,
      refundStatus: 'pending' as const,
      note: '',
    };
    seed(dir, [
      row({ id: 'BK-owed', status: 'ملغي', paymentStatus: 'paid', cancellation: pending }),
      row({ id: 'BK-clear', status: 'ملغي', cancellation: { ...pending, refundStatus: 'not_applicable' } }),
    ]);
    const { url, close } = await listen(buildApp(dir));
    try {
      assert.equal((await call(url, 'POST', '/api/bookings/BK-owed/refund-done', 'vendor1')).status, 403);
      assert.equal((await call(url, 'POST', '/api/bookings/BK-owed/refund-done', 'client')).status, 403);
      assert.equal((await call(url, 'POST', '/api/bookings/BK-nope/refund-done', 'admin')).status, 404);
      assert.equal((await call(url, 'POST', '/api/bookings/BK-clear/refund-done', 'admin')).status, 409);
      const done = await call(url, 'POST', '/api/bookings/BK-owed/refund-done', 'manager');
      assert.equal(done.status, 200);
      assert.equal(done.json.success, true);
      assert.equal(done.json.booking.cancellation.refundStatus, 'refunded');
      assert.equal(done.json.booking.cancellation.refundedAt, NOW.toISOString());
      // Already refunded: nothing pending any more.
      assert.equal((await call(url, 'POST', '/api/bookings/BK-owed/refund-done', 'admin')).status, 409);
    } finally {
      await close();
    }
  });
});

describe('POST /api/bookings/:id/refund-done — duplicate payments', () => {
  it('records a duplicate payment refunded by hand as sent', async () => {
    const dir = tmpDir();
    seed(dir, [
      row({
        id: 'BK-twice',
        status: 'مؤكد',
        paymentStatus: 'paid',
        duplicatePayments: [{ paymentId: 'pay_2', amount: 500, at: '2026-09-23T10:00:00.000Z', refundStatus: 'pending' }],
      }),
    ]);
    const { url, close } = await listen(buildApp(dir));
    try {
      const done = await call(url, 'POST', '/api/bookings/BK-twice/refund-done', 'admin');
      assert.equal(done.status, 200);
      assert.equal(done.json.booking.duplicatePayments[0].refundStatus, 'refunded');
      assert.equal(done.json.booking.duplicatePayments[0].refundedAt, NOW.toISOString());
      assert.equal(done.json.booking.cancellation, undefined);
      assert.equal((await call(url, 'POST', '/api/bookings/BK-twice/refund-done', 'admin')).status, 409);
    } finally {
      await close();
    }
  });
});

describe('DELETE /api/bookings/:id — owner admin, no money on the order', () => {
  it('is for «مدير كل الحسابات» only and never removes a paid or refund-owing order', async () => {
    const dir = tmpDir();
    seed(dir, [
      row({ id: 'BK-paid', paymentStatus: 'paid', status: 'مؤكد' }),
      row({
        id: 'BK-dup',
        duplicatePayments: [{ paymentId: 'pay_x', amount: 500, at: '2026-09-23T10:00:00.000Z', refundStatus: 'pending' }],
      }),
      row({ id: 'BK-free' }),
    ]);
    const { url, close } = await listen(buildApp(dir));
    try {
      assert.equal((await call(url, 'DELETE', '/api/bookings/BK-free', 'manager')).status, 403);
      const paid = await call(url, 'DELETE', '/api/bookings/BK-paid', 'admin');
      assert.equal(paid.status, 409);
      assert.match(paid.json.error, /مدفوع/);
      assert.equal((await call(url, 'DELETE', '/api/bookings/BK-dup', 'admin')).status, 409);
      assert.equal((await call(url, 'DELETE', '/api/bookings/BK-free', 'admin')).status, 200);
      assert.deepEqual(createBookingStore(dir).list().map((b) => b.id).sort(), ['BK-dup', 'BK-paid']);
    } finally {
      await close();
    }
  });
});

describe('one event per listing per day — date reservation', () => {
  const D = '2026-10-16';
  const order = { ...checkout, eventDate: D, items: [{ id: 'lst-coffee', quantity: 1 }] };

  it("refuses a second order for a listing's taken date, from anyone", async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    try {
      const first = await call(url, 'POST', '/api/bookings', 'client', order);
      assert.equal(first.status, 201);
      // A stranger, same listing and day.
      const stranger = await call(url, 'POST', '/api/bookings', '', { ...order, phone: '0569999999', email: 'other@usil.sa' });
      assert.equal(stranger.status, 409);
      assert.equal(stranger.json.slotTaken, true);
      assert.equal(stranger.json.booking, undefined);
      // The same customer again with another quantity or time: their own order is pointed out.
      const mineAgain = await call(url, 'POST', '/api/bookings', 'client', { ...order, items: [{ id: 'lst-coffee', quantity: 3 }], eventTime: '20:00' });
      assert.equal(mineAgain.status, 409);
      assert.equal(mineAgain.json.slotTaken, true);
      assert.equal(mineAgain.json.booking.id, first.json.booking.id);
      assert.match(mineAgain.json.error, /طلباتي/);
      assert.equal(createBookingStore(dir).count(), 1);
    } finally {
      await close();
    }
  });

  it('leaves other listings and other days free', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    try {
      assert.equal((await call(url, 'POST', '/api/bookings', 'client', order)).status, 201);
      // Same vendor, another listing, same day.
      const sweets = await call(url, 'POST', '/api/bookings', 'client', { ...order, items: [{ id: 'lst-sweets', quantity: 1 }] });
      assert.equal(sweets.status, 201);
      // Another vendor, same day.
      assert.equal((await call(url, 'POST', '/api/bookings', '', { ...order, phone: '0567777777', items: [{ id: 'lst-tent', quantity: 1 }] })).status, 201);
      // Same listing, next day.
      assert.equal((await call(url, 'POST', '/api/bookings', '', { ...order, phone: '0568888888', eventDate: '2026-10-17' })).status, 201);
    } finally {
      await close();
    }
  });

  it('a cart is refused whole when any of its listings is taken that day', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    try {
      assert.equal((await call(url, 'POST', '/api/bookings', '', { ...order, items: [{ id: 'lst-tent', quantity: 1 }] })).status, 201);
      const cart = await call(url, 'POST', '/api/bookings', 'client', {
        ...order,
        items: [
          { id: 'lst-coffee', quantity: 1 },
          { id: 'lst-tent', quantity: 1 },
        ],
      });
      assert.equal(cart.status, 409);
      assert.equal(cart.json.listingId, 'lst-tent');
      assert.equal(createBookingStore(dir).count(), 1);
    } finally {
      await close();
    }
  });

  it("holds the date for orders approved, paid or in progress — not cancelled, rejected or someone else's waiting request", async () => {
    const holding = [
      { status: 'مؤكد', bookingMode: 'approval' as const },
      { status: 'مؤكد', paymentStatus: 'paid' as const },
      { status: 'قيد التنفيذ', paymentStatus: 'paid' as const },
    ];
    for (const extra of holding) {
      const dir = tmpDir();
      seed(dir, [row({ id: 'BK-held', eventDate: D, createdAt: '2026-09-01 10:00', ...extra })]);
      const { url, close } = await listen(buildApp(dir));
      try {
        const res = await call(url, 'POST', '/api/bookings', 'client', order);
        assert.equal(res.status, 409, JSON.stringify(extra));
      } finally {
        await close();
      }
    }
    const free = [
      { status: 'ملغي', paymentStatus: 'paid' as const },
      { status: 'مرفوض من المورّد', paymentStatus: 'paid' as const },
      { status: 'بانتظار موافقة المورّد', bookingMode: 'approval' as const },
    ];
    for (const { status, ...extra } of free) {
      const dir = tmpDir();
      seed(dir, [row({ id: 'BK-ended', eventDate: D, status, ...extra })]);
      const { url, close } = await listen(buildApp(dir));
      try {
        assert.equal((await call(url, 'POST', '/api/bookings', 'client', order)).status, 201, status);
      } finally {
        await close();
      }
    }
  });

  it('an abandoned checkout stops holding the date, and lapses when someone else books it', async () => {
    const dir = tmpDir();
    // Unpaid instant order placed days ago (NOW is 2026-09-24): past its payment window.
    seed(dir, [row({ id: 'BK-stale', eventDate: D, createdAt: '2026-09-20 10:00', moyasarInvoiceId: 'inv_stale01', paymentUrl: 'https://checkout.moyasar.com/invoices/inv_stale01', email: 'gone@usil.sa', phone: '0560000000', userId: undefined })]);
    const { url, close } = await listen(buildApp(dir));
    try {
      const res = await call(url, 'POST', '/api/bookings', 'client', order);
      assert.equal(res.status, 201);
      const stale = createBookingStore(dir).findById('BK-stale');
      assert.equal(stale?.status, 'ملغي');
      assert.equal(stale?.cancellation?.refundStatus, 'not_applicable');
      await waitFor(() => cancelledInvoices.includes('inv_stale01'));
    } finally {
      await close();
    }
  });

  it("honours bookings the vendor recorded in their own calendar", async () => {
    const dir = tmpDir();
    const calendar = { 'v-1': [{ id: 'vb-1', serviceId: 'lst-coffee', date: D, status: 'confirmed' }, { id: 'vb-2', serviceId: 'lst-coffee', date: '2026-10-18', status: 'cancelled' }] };
    const { url, close } = await listen(buildApp(dir, {}, calendar));
    try {
      const taken = await call(url, 'POST', '/api/bookings', 'client', order);
      assert.equal(taken.status, 409);
      assert.equal(taken.json.slotTaken, true);
      assert.equal((await call(url, 'POST', '/api/bookings', 'client', { ...order, eventDate: '2026-10-18' })).status, 201);
    } finally {
      await close();
    }
  });

  it("lets others request a date while someone else's request is still waiting on the vendor", async () => {
    const dir = tmpDir();
    const waiting = { bookingMode: 'approval' as const, status: 'بانتظار موافقة المورّد', serviceId: 'lst-coffee', items: [{ id: 'lst-coffee', title: 'ركن قهوة', quantity: 1, price: 500, vendorId: 'v-1' }], eventDate: D };
    seed(dir, [row({ id: 'BK-waiting', ...waiting, userId: 'u-someone', email: 'someone@usil.sa', phone: '0561231234' })]);
    const { url, close } = await listen(buildApp(dir));
    try {
      const mine = await call(url, 'POST', '/api/bookings', 'client', order);
      assert.equal(mine.status, 201, JSON.stringify(mine.json));
    } finally {
      await close();
    }
  });

  it('approving needs the date free; of two orders waiting on it, the vendor approves one', async () => {
    const dir = tmpDir();
    const waiting = { bookingMode: 'approval' as const, status: 'بانتظار موافقة المورّد', serviceId: 'lst-sweets', items: [{ id: 'lst-sweets', title: 'حلويات', quantity: 1, price: 120.5, vendorId: 'v-1' }], eventDate: D };
    seed(dir, [
      row({ id: 'BK-w1', ...waiting }),
      row({ id: 'BK-w2', ...waiting, email: 'b@usil.sa', phone: '0561231234' }),
      row({ id: 'BK-w3', ...waiting, eventDate: '2026-10-19' }),
      row({ id: 'BK-paid', serviceId: 'lst-sweets', items: waiting.items, eventDate: '2026-10-19', status: 'مؤكد', paymentStatus: 'paid' }),
    ]);
    const { url, close } = await listen(buildApp(dir));
    try {
      assert.equal((await call(url, 'PATCH', '/api/bookings/BK-w1', 'vendor1', { status: 'مؤكد' })).status, 200);
      // The date is now promised to BK-w1's customer.
      const second = await call(url, 'PATCH', '/api/bookings/BK-w2', 'vendor1', { status: 'مؤكد' });
      assert.equal(second.status, 409);
      assert.equal(second.json.slotTaken, true);
      // Rejecting it is still allowed.
      assert.equal((await call(url, 'PATCH', '/api/bookings/BK-w2', 'vendor1', { status: 'مرفوض من المورّد' })).status, 200);
      // A paid order already has 2026-10-19.
      assert.equal((await call(url, 'PATCH', '/api/bookings/BK-w3', 'vendor1', { status: 'مؤكد' })).status, 409);
    } finally {
      await close();
    }
  });

  it('two buyers racing for the same date: only one order is stored', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    try {
      const results = await Promise.all(
        ['0561000001', '0561000002', '0561000003', '0561000004'].map((phone) =>
          call(url, 'POST', '/api/bookings', '', { ...order, phone, email: `${phone}@usil.sa` }),
        ),
      );
      assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
      assert.equal(createBookingStore(dir).count(), 1);
    } finally {
      await close();
    }
  });
});
