import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { registerBookingRoutes } from '../bookings/booking-routes.ts';
import { createBookingStore, type PlatformBooking } from '../bookings/booking-store.ts';
import { registerPaymentRoutes } from './payment-routes.ts';
import { setMailFetchForTests } from '../shared/optional-mail.ts';

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
      listVendorUsers: () => [{ id: 'v-1', email: 'v1@usil.sa' }],
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

  it('raises a free-amount invoice only for an admin', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    try {
      const before = invoicesRaised.length;
      const body = { amount: 25, description: 'تبرع', metadata: { note: 'x' } };
      assert.equal((await call(url, 'POST', '/api/payments/invoice', '', body)).status, 401);
      assert.equal((await call(url, 'POST', '/api/payments/invoice', 'owner', body)).status, 403);
      assert.equal((await call(url, 'POST', '/api/payments/invoice', 'vendor', body)).status, 403);
      assert.equal(invoicesRaised.length, before);
      const res = await call(url, 'POST', '/api/payments/invoice', 'admin', body);
      assert.equal(res.status, 200);
      assert.equal(invoicesRaised[invoicesRaised.length - 1].amount, 2_500);
    } finally {
      await close();
    }
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

describe('webhook for a payment we cannot settle', () => {
  it('answers 200 ignored when Moyasar does not know the payment', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    try {
      const res = await call(url, 'POST', '/api/payments/webhook', '', {
        secret_token: 'whsec-test',
        data: { id: 'pay_ghost000001' },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { received: true, ignored: true });
    } finally {
      await close();
    }
  });

  it('answers 200 ignored when a paid payment matches no booking', async () => {
    const dir = tmpDir();
    providerPayments.pay_orphan00001 = { id: 'pay_orphan00001', status: 'paid', amount: 5_000, currency: 'SAR' };
    const { url, close } = await listen(buildApp(dir));
    try {
      const res = await call(url, 'POST', '/api/payments/webhook', '', {
        secret_token: 'whsec-test',
        data: { id: 'pay_orphan00001' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.ignored, true);
    } finally {
      await close();
    }
  });

  it('stays 5xx when the fault is ours', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    const key = process.env.MOYASAR_SECRET_KEY;
    delete process.env.MOYASAR_SECRET_KEY;
    try {
      const res = await call(url, 'POST', '/api/payments/webhook', '', {
        secret_token: 'whsec-test',
        data: { id: 'pay_ghost000001' },
      });
      assert.equal(res.status, 503);
    } finally {
      process.env.MOYASAR_SECRET_KEY = key;
      await close();
    }
  });
});

describe('GET /api/payments/:id — public lookup', () => {
  it('returns only the status and amount the result page shows', async () => {
    const dir = tmpDir();
    providerPayments.pay_public00001 = {
      id: 'pay_public00001',
      status: 'paid',
      amount: 150_000,
      currency: 'SAR',
      description: 'طلب يوصل BK-500001 — ركن قهوة',
      metadata: { bookingId: 'BK-500001', order_id: 'BK-500001' },
    };
    const { url, close } = await listen(buildApp(dir));
    try {
      const res = await call(url, 'GET', '/api/payments/pay_public00001');
      assert.equal(res.status, 200);
      // The metadata names a booking that is not ours here: no id comes back.
      assert.deepEqual(res.json, { status: 'paid', amount: 1500, bookingId: null });
    } finally {
      await close();
    }
  });

  it('answers 404 with a generic message for an unknown payment', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    try {
      const res = await call(url, 'GET', '/api/payments/pay_ghost000001');
      assert.equal(res.status, 404);
      assert.doesNotMatch(String(res.json.error), /not found/);
    } finally {
      await close();
    }
  });
});

describe('Moyasar not configured', () => {
  it('answers 503 with the same message on every payments route', async () => {
    const dir = tmpDir();
    createBookingStore(dir).add(row());
    const { url, close } = await listen(buildApp(dir));
    const key = process.env.MOYASAR_SECRET_KEY;
    delete process.env.MOYASAR_SECRET_KEY;
    try {
      const responses = [
        await call(url, 'GET', '/api/payments/pay_public00001'),
        await call(url, 'POST', '/api/payments/moyasar/callback', '', { id: 'pay_public00001' }),
        await call(url, 'POST', '/api/payments/invoice', 'owner', { metadata: { bookingId: 'BK-500001' } }),
      ];
      for (const res of responses) assert.equal(res.status, 503, JSON.stringify(res.json));
      assert.equal(new Set(responses.map((res) => res.json.error)).size, 1);
      assert.match(responses[0].json.error, /ميسر غير مفعّل/);
    } finally {
      process.env.MOYASAR_SECRET_KEY = key;
      await close();
    }
  });
});

describe('one payable invoice per order', () => {
  it('returns the existing pay link instead of raising a second invoice', async () => {
    const dir = tmpDir();
    createBookingStore(dir).add(
      row({ paymentUrl: 'https://checkout.moyasar.com/invoices/inv_original01' }),
    );
    const { url, close } = await listen(buildApp(dir));
    try {
      const before = invoicesRaised.length;
      const res = await call(url, 'POST', '/api/payments/invoice', 'owner', { metadata: { bookingId: 'BK-500001' } });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, {
        id: 'inv_original01',
        url: 'https://checkout.moyasar.com/invoices/inv_original01',
        reused: true,
      });
      assert.equal(invoicesRaised.length, before);
    } finally {
      await close();
    }
  });

  it('refuses to invoice an order whose event date has passed', async () => {
    const dir = tmpDir();
    createBookingStore(dir).add(row({ eventDate: '2020-01-01' }));
    const { url, close } = await listen(buildApp(dir));
    try {
      const res = await call(url, 'POST', '/api/payments/invoice', 'owner', { metadata: { bookingId: 'BK-500001' } });
      assert.equal(res.status, 409);
      assert.match(res.json.error, /مضى/);
    } finally {
      await close();
    }
  });
});

describe('second payments and refunds', () => {
  it('records a second payment for a paid order as owed back, once, without overwriting the first', async () => {
    const dir = tmpDir();
    createBookingStore(dir).add(row({ paymentStatus: 'paid', status: 'مؤكد', moyasarPaymentId: 'pay_first000001' }));
    providerPayments.pay_second00001 = {
      id: 'pay_second00001',
      status: 'paid',
      amount: 150_000,
      currency: 'SAR',
      invoice_id: 'inv_other00001',
      metadata: { bookingId: 'BK-500001' },
    };
    const { url, close } = await listen(buildApp(dir));
    try {
      for (let i = 0; i < 2; i++) {
        await call(url, 'POST', '/api/payments/webhook', '', { secret_token: 'whsec-test', data: { id: 'pay_second00001' } });
      }
      const stored = createBookingStore(dir).findById('BK-500001');
      assert.equal(stored?.moyasarPaymentId, 'pay_first000001');
      assert.equal(stored?.duplicatePayments?.length, 1);
      assert.equal(stored?.duplicatePayments?.[0].paymentId, 'pay_second00001');
      assert.equal(stored?.duplicatePayments?.[0].amount, 1500);
      assert.equal(stored?.duplicatePayments?.[0].refundStatus, 'pending');

      // Refunding that second payment closes the duplicate, not the order.
      providerPayments.pay_second00001 = { ...providerPayments.pay_second00001, status: 'refunded', refunded: 150_000 };
      await call(url, 'POST', '/api/payments/webhook', '', {
        secret_token: 'whsec-test',
        type: 'payment_refunded',
        data: { id: 'pay_second00001' },
      });
      const after = createBookingStore(dir).findById('BK-500001');
      assert.equal(after?.duplicatePayments?.[0].refundStatus, 'refunded');
      assert.equal(after?.paymentStatus, 'paid');
    } finally {
      await close();
    }
  });

  it('webhook: a refunded payment closes the order\'s pending refund', async () => {
    const dir = tmpDir();
    createBookingStore(dir).add(
      row({
        paymentStatus: 'paid',
        status: 'ملغي',
        moyasarPaymentId: 'pay_refund00001',
        cancellation: {
          cancelledAt: '2026-10-01T10:00:00.000Z',
          cancelledBy: 'client',
          refundPercent: 100,
          refundHalalas: 150_000,
          refundStatus: 'pending',
          note: '',
        },
      }),
    );
    providerPayments.pay_refund00001 = {
      id: 'pay_refund00001',
      status: 'refunded',
      amount: 150_000,
      refunded: 150_000,
      currency: 'SAR',
      invoice_id: 'inv_original01',
    };
    const { url, close } = await listen(buildApp(dir));
    try {
      const res = await call(url, 'POST', '/api/payments/webhook', '', {
        secret_token: 'whsec-test',
        type: 'payment_refunded',
        data: { id: 'pay_refund00001' },
      });
      assert.equal(res.status, 200);
      const cancellation = createBookingStore(dir).findById('BK-500001')?.cancellation;
      assert.equal(cancellation?.refundStatus, 'refunded');
      assert.ok(cancellation?.refundedAt);
    } finally {
      await close();
    }
  });

  it('emails the vendor when an instant order becomes paid', async () => {
    const dir = tmpDir();
    createBookingStore(dir).add(row());
    providerPayments.pay_notify00001 = {
      id: 'pay_notify00001',
      status: 'paid',
      amount: 150_000,
      currency: 'SAR',
      invoice_id: 'inv_original01',
    };
    const sent: Array<{ to: string[]; subject: string }> = [];
    const savedKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = 're_test';
    setMailFetchForTests(async (_url, init) => {
      sent.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200, text: async () => '{}' };
    });
    const { url, close } = await listen(buildApp(dir));
    try {
      await call(url, 'POST', '/api/payments/webhook', '', { secret_token: 'whsec-test', data: { id: 'pay_notify00001' } });
      // The same payment again (callback after webhook) does not mail twice.
      await call(url, 'POST', '/api/payments/webhook', '', { secret_token: 'whsec-test', data: { id: 'pay_notify00001' } });
      await new Promise((done) => setTimeout(done, 20));
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0].to, ['v1@usil.sa']);
      assert.match(sent[0].subject, /مدفوع/);
    } finally {
      setMailFetchForTests(null);
      if (savedKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = savedKey;
      await close();
    }
  });
});

describe('GET /api/payments/:id — booking id and throttling', () => {
  it('names the booking a payment settled', async () => {
    const dir = tmpDir();
    createBookingStore(dir).add(row({ paymentStatus: 'paid', moyasarPaymentId: 'pay_known000001' }));
    providerPayments.pay_known000001 = { id: 'pay_known000001', status: 'paid', amount: 150_000, currency: 'SAR' };
    const { url, close } = await listen(buildApp(dir));
    try {
      const res = await call(url, 'GET', '/api/payments/pay_known000001');
      assert.deepEqual(res.json, { status: 'paid', amount: 1500, bookingId: 'BK-500001' });
    } finally {
      await close();
    }
  });

  it('rate-limits payment lookups and browser callbacks per IP', async () => {
    const dir = tmpDir();
    providerPayments.pay_spam0000001 = { id: 'pay_spam0000001', status: 'paid', amount: 100, currency: 'SAR' };
    const { url, close } = await listen(buildApp(dir));
    try {
      let lookup = 0;
      for (let i = 0; i < 31; i++) lookup = (await call(url, 'GET', '/api/payments/pay_spam0000001')).status;
      assert.equal(lookup, 429);
      let callback = 0;
      for (let i = 0; i < 31; i++) {
        callback = (await call(url, 'POST', '/api/payments/moyasar/callback', '', { id: 'pay_spam0000001' })).status;
      }
      assert.equal(callback, 429);
    } finally {
      await close();
    }
  });
});
