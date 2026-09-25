import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { registerBookingRoutes } from '../bookings/booking-routes.ts';
import { createBookingStore, type PlatformBooking } from '../bookings/booking-store.ts';
import { registerPaymentRoutes } from './payment-routes.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-payments-api-'));
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

const ACTORS: Record<string, { id: string; role: string; email?: string; emailVerified?: boolean }> = {
  admin: { id: 'usr-admin', role: 'admin' },
  owner: { id: 'u-owner', role: 'client', email: 'owner@usil.sa', emailVerified: true },
  other: { id: 'u-other', role: 'client', email: 'other@usil.sa', emailVerified: true },
  vendor: { id: 'v-1', role: 'vendor' },
};

function row(overrides: Partial<PlatformBooking> = {}): PlatformBooking {
  return {
    id: 'BK-500001',
    userId: 'u-owner',
    name: 'نواف',
    phone: '0512345678',
    email: 'owner@usil.sa',
    serviceId: 'lst-coffee',
    serviceName: 'ركن قهوة',
    notes: '',
    city: 'الرياض',
    eventDate: '2026-12-01',
    paymentMethod: 'moyasar',
    settlement: 'ميسر',
    items: [{ id: 'lst-coffee', quantity: 3, price: 500, vendorId: 'v-1' }],
    vendorIds: ['v-1'],
    totalAmount: 1500,
    bookingMode: 'instant',
    status: 'جديد',
    paymentStatus: 'unpaid',
    createdAt: '2026-09-20 10:00',
    moyasarInvoiceId: 'inv_original01',
    ...overrides,
  };
}

function buildApp(dir: string) {
  const app = express();
  app.use(express.json());
  const userFromRequest = (req: express.Request) => ACTORS[String(req.headers['x-test-actor'] || '')] || null;
  const bookings = registerBookingRoutes(
    app,
    {
      userFromRequest,
      requireRole: () => (_req: express.Request, _res: express.Response, next: () => void) => next(),
      listVendorUsers: () => [{ id: 'v-1' }],
    },
    dir,
    { listListings: () => [], blockedDatesFor: () => [] },
  );
  registerPaymentRoutes(app, { bookings, port: 0 });
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

// ─── Moyasar stub ───
const realFetch = globalThis.fetch;
const invoicesRaised: Array<{ amount: number; metadata: Record<string, string>; description: string }> = [];
/** What GET /v1/payments/:id answers — the only source settlement may trust. */
const providerPayments: Record<string, Record<string, unknown>> = {};
const saved: Record<string, string | undefined> = {};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

before(() => {
  for (const key of ['MOYASAR_SECRET_KEY', 'MOYASAR_WEBHOOK_SECRET']) saved[key] = process.env[key];
  process.env.MOYASAR_SECRET_KEY = 'sk_test_abcdefghijklmnopqrstuvwxyz1234';
  process.env.MOYASAR_WEBHOOK_SECRET = 'whsec-test';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target === 'https://api.moyasar.com/v1/invoices' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body || '{}'));
      invoicesRaised.push({ amount: body.amount, metadata: body.metadata, description: body.description });
      const id = `inv_new${String(invoicesRaised.length).padStart(6, '0')}`;
      return json({ id, status: 'initiated', amount: body.amount, url: `https://checkout.moyasar.com/invoices/${id}` });
    }
    const payment = /^https:\/\/api\.moyasar\.com\/v1\/payments\/(.+)$/.exec(target);
    if (payment) {
      const found = providerPayments[decodeURIComponent(payment[1])];
      return found ? json(found) : json({ message: 'not found' }, 404);
    }
    if (target.startsWith('https://api.moyasar.com/v1/invoices/')) return json({ message: 'not found' }, 404);
    return realFetch(input as string, init);
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  for (const key of Object.keys(providerPayments)) delete providerPayments[key];
});

describe('POST /api/payments/invoice with a booking id', () => {
  it('raises the invoice for the owner at the stored amount and attaches it', async () => {
    const dir = tmpDir();
    createBookingStore(dir).add(row());
    const { url, close } = await listen(buildApp(dir));
    const res = await call(url, 'POST', '/api/payments/invoice', 'owner', {
      amount: 1,
      description: 'خصم',
      metadata: { bookingId: 'BK-500001', order_id: 'BK-500001' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const raised = invoicesRaised[invoicesRaised.length - 1];
    assert.equal(raised.amount, 150_000);
    assert.equal(raised.metadata.bookingId, 'BK-500001');
    assert.match(raised.description, /BK-500001/);
    const stored = createBookingStore(dir).findById('BK-500001');
    assert.equal(stored?.moyasarInvoiceId, res.json.id);
    assert.equal(stored?.paymentStatus, 'unpaid');
    await close();
  });

  it('refuses guests, other clients, vendors and unknown bookings', async () => {
    const dir = tmpDir();
    createBookingStore(dir).add(row());
    const { url, close } = await listen(buildApp(dir));
    const before = invoicesRaised.length;
    const body = { amount: 1, description: 'x', metadata: { bookingId: 'BK-500001' } };
    assert.equal((await call(url, 'POST', '/api/payments/invoice', '', body)).status, 401);
    assert.equal((await call(url, 'POST', '/api/payments/invoice', 'other', body)).status, 404);
    assert.equal((await call(url, 'POST', '/api/payments/invoice', 'vendor', body)).status, 404);
    assert.equal(
      (await call(url, 'POST', '/api/payments/invoice', 'admin', { ...body, metadata: { order_id: 'BK-ghost' } })).status,
      404,
    );
    assert.equal(invoicesRaised.length, before);
    assert.equal(createBookingStore(dir).findById('BK-500001')?.moyasarInvoiceId, 'inv_original01');
    await close();
  });

  it('refuses a paid or cancelled booking, and lets an admin invoice an open one', async () => {
    const dir = tmpDir();
    const store = createBookingStore(dir);
    store.add(row({ id: 'BK-paid', paymentStatus: 'paid' }));
    store.add(row({ id: 'BK-cancelled', status: 'ملغي' }));
    store.add(row({ id: 'BK-open', totalAmount: 99.5 }));
    const { url, close } = await listen(buildApp(dir));
    const req = (id: string, actor: string) =>
      call(url, 'POST', '/api/payments/invoice', actor, { amount: 5, description: 'x', metadata: { bookingId: id } });
    assert.equal((await req('BK-paid', 'owner')).status, 409);
    assert.equal((await req('BK-cancelled', 'owner')).status, 409);
    assert.equal((await req('BK-open', 'admin')).status, 200);
    assert.equal(invoicesRaised[invoicesRaised.length - 1].amount, 9_950);
    await close();
  });

  it('still raises a plain invoice that names no booking', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    const res = await call(url, 'POST', '/api/payments/invoice', '', { amount: 25, description: 'تبرع', metadata: { note: 'x' } });
    assert.equal(res.status, 200);
    assert.equal(invoicesRaised[invoicesRaised.length - 1].amount, 2_500);
    await close();
  });
});

describe('settlement trusts only Moyasar\'s own amount', () => {
  it('webhook: a cheap payment carrying a booking id does not settle it', async () => {
    const dir = tmpDir();
    createBookingStore(dir).add(row());
    providerPayments.pay_cheap000001 = {
      id: 'pay_cheap000001',
      status: 'paid',
      amount: 100,
      currency: 'SAR',
      invoice_id: 'inv_attacker01',
      metadata: { bookingId: 'BK-500001' },
    };
    const { url, close } = await listen(buildApp(dir));
    const res = await call(url, 'POST', '/api/payments/webhook', '', {
      secret_token: 'whsec-test',
      data: { id: 'pay_cheap000001', amount: 150_000, status: 'paid' },
    });
    assert.equal(res.status, 200);
    assert.equal(createBookingStore(dir).findById('BK-500001')?.paymentStatus, 'unpaid');
    await close();
  });

  it('webhook: the full payment for the booking invoice settles it', async () => {
    const dir = tmpDir();
    createBookingStore(dir).add(row());
    providerPayments.pay_full0000001 = {
      id: 'pay_full0000001',
      status: 'paid',
      amount: 150_000,
      currency: 'SAR',
      invoice_id: 'inv_original01',
      metadata: { bookingId: 'BK-500001' },
    };
    const { url, close } = await listen(buildApp(dir));
    await call(url, 'POST', '/api/payments/webhook', '', { secret_token: 'whsec-test', data: { id: 'pay_full0000001' } });
    const stored = createBookingStore(dir).findById('BK-500001');
    assert.equal(stored?.paymentStatus, 'paid');
    assert.equal(stored?.moyasarPaymentId, 'pay_full0000001');
    await close();
  });

  it('webhook: an unauthenticated event changes nothing', async () => {
    const dir = tmpDir();
    createBookingStore(dir).add(row());
    const { url, close } = await listen(buildApp(dir));
    const res = await call(url, 'POST', '/api/payments/webhook', '', { secret_token: 'nope', data: { id: 'pay_x' } });
    assert.equal(res.status, 401);
    await close();
  });

  it('browser callback: an underpaid payment leaves the booking unpaid', async () => {
    const dir = tmpDir();
    createBookingStore(dir).add(row());
    providerPayments.pay_under000001 = {
      id: 'pay_under000001',
      status: 'paid',
      amount: 1_000,
      currency: 'SAR',
      metadata: { order_id: 'BK-500001' },
    };
    const { url, close } = await listen(buildApp(dir));
    const res = await call(url, 'POST', '/api/payments/moyasar/callback', '', { id: 'pay_under000001' });
    assert.equal(res.status, 200);
    assert.equal(createBookingStore(dir).findById('BK-500001')?.paymentStatus, 'unpaid');
    await close();
  });
});
