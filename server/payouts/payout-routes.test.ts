import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { registerPayoutRoutes } from './payout-routes.ts';
import { roleAllowed } from '../auth/roles.ts';
import { createBookingStore, type PlatformBooking } from '../bookings/booking-store.ts';
import { setMailFetchForTests } from '../shared/optional-mail.ts';

const ACTORS: Record<string, { id: string; role: string; name: string; email: string }> = {
  admin: { id: 'usr-admin', role: 'admin', name: 'المالك', email: 'owner@usil.sa' },
  manager: { id: 'usr-manager', role: 'accounts_manager', name: 'مدير الحسابات', email: 'm@usil.sa' },
  vendor1: { id: 'v-1', role: 'vendor', name: 'قهوة', email: 'v1@usil.sa' },
  vendor2: { id: 'v-2', role: 'vendor', name: 'خيام', email: 'v2@usil.sa' },
  client: { id: 'u-client', role: 'client', name: 'عميل', email: 'c@usil.sa' },
};

const IBAN = 'SA0380000000608010167519';

function booking(overrides: Partial<PlatformBooking> = {}): PlatformBooking {
  return {
    id: 'BK-1',
    name: 'نواف',
    phone: '0512345678',
    email: 'c@usil.sa',
    serviceId: 'lst-coffee',
    serviceName: 'ركن قهوة',
    notes: '',
    city: 'الرياض',
    eventDate: '2026-10-10',
    paymentMethod: 'moyasar',
    settlement: 'ميسر',
    items: [{ id: 'lst-coffee', title: 'ركن قهوة', quantity: 1, price: 1000, vendorId: 'v-1' }],
    vendorIds: ['v-1'],
    totalAmount: 1000,
    bookingMode: 'instant',
    status: 'مكتمل',
    paymentStatus: 'paid',
    createdAt: '2026-10-01 10:00',
    ...overrides,
  };
}

function buildApp(dir: string) {
  const app = express();
  app.use(express.json());
  const userOf = (req: Request) => ACTORS[String(req.headers['x-test-actor'] || '')] || null;
  const auth = {
    requireRole: (roles: string[]) => (req: Request, res: Response, next: NextFunction) => {
      const user = userOf(req);
      if (!user) return res.status(401).json({ success: false });
      if (!roleAllowed(user.role, roles)) return res.status(403).json({ success: false });
      (req as Request & { user: unknown }).user = user;
      next();
    },
    listVendorUsers: () => [ACTORS.vendor1, ACTORS.vendor2],
  };
  const bookings = createBookingStore(dir);
  registerPayoutRoutes(app, auth, dir, {
    bookings,
    vendors: {
      listAllListings: () => [
        { id: 'lst-coffee', vendorId: 'v-1' },
        { id: 'lst-tent', vendorId: 'v-2' },
      ],
      getWorkspace: (id: string) => ({ profile: id === 'v-1' ? { projectName: 'قهوة الرياض' } : undefined }),
    },
  });
  return { app, bookings };
}

function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
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

async function setup(rows: PlatformBooking[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-payouts-'));
  const { app, bookings } = buildApp(dir);
  for (const row of [...rows].reverse()) bookings.add(row);
  const server = await listen(app);
  return { ...server, dir };
}

const request = (amount: unknown, extra: Record<string, unknown> = {}) => ({
  amount,
  iban: 'SA03 8000 0000 6080 1016 7519',
  accountHolder: 'مؤسسة قهوة الرياض',
  bankName: 'مصرف الراجحي',
  ...extra,
});

const mails: Array<{ to: string[]; subject: string }> = [];
let prevKey: string | undefined;
let prevOwner: string | undefined;

before(() => {
  prevKey = process.env.RESEND_API_KEY;
  prevOwner = process.env.OWNER_EMAIL;
  process.env.RESEND_API_KEY = 're_test';
  process.env.OWNER_EMAIL = 'owner@usil.sa';
  setMailFetchForTests(async (_url, init) => {
    const body = JSON.parse(String(init.body));
    mails.push({ to: body.to, subject: body.subject });
    return { ok: true, status: 200, text: async () => '' };
  });
});

after(() => {
  setMailFetchForTests(null);
  if (prevKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = prevKey;
  if (prevOwner === undefined) delete process.env.OWNER_EMAIL;
  else process.env.OWNER_EMAIL = prevOwner;
});

const settle = () => new Promise((done) => setTimeout(done, 20));

describe('payout routes — vendor side', () => {
  it('reports earnings computed from the vendor own paid orders', async () => {
    const { url, close } = await setup([
      booking(),
      booking({ id: 'BK-2', status: 'مؤكد', totalAmount: 200, items: [{ id: 'lst-coffee', title: 'x', quantity: 2, price: 100, vendorId: 'v-1' }] }),
      booking({ id: 'BK-3', status: 'مكتمل', vendorIds: ['v-2'], serviceId: 'lst-tent', items: [{ id: 'lst-tent', title: 'خيمة', quantity: 1, price: 3000, vendorId: 'v-2' }], totalAmount: 3000 }),
    ]);
    try {
      const out = await call(url, 'GET', '/api/vendor/earnings', 'vendor1');
      assert.equal(out.status, 200);
      assert.equal(out.json.data.currency, 'SAR');
      assert.equal(out.json.data.commissionRate, 0.15);
      assert.equal(out.json.data.available, 850);
      assert.equal(out.json.data.pending, 170);
      assert.equal(out.json.data.paidOut, 0);
      assert.deepEqual(out.json.data.orders.map((row: { id: string }) => row.id), ['BK-1', 'BK-2']);
    } finally {
      await close();
    }
  });

  it('validates amount and IBAN against the server-computed balance', async () => {
    const { url, close } = await setup([booking()]);
    try {
      assert.equal((await call(url, 'POST', '/api/vendor/payouts', 'vendor1', request(0))).status, 400);
      assert.equal((await call(url, 'POST', '/api/vendor/payouts', 'vendor1', request(-5))).status, 400);
      assert.equal((await call(url, 'POST', '/api/vendor/payouts', 'vendor1', request('abc'))).status, 400);
      const tooMuch = await call(url, 'POST', '/api/vendor/payouts', 'vendor1', request(850.01));
      assert.equal(tooMuch.status, 400);
      assert.match(tooMuch.json.error, /الرصيد المتاح/);
      assert.equal((await call(url, 'POST', '/api/vendor/payouts', 'vendor1', request(100, { iban: 'SA123' }))).status, 400);
      assert.equal((await call(url, 'POST', '/api/vendor/payouts', 'vendor1', request(100, { iban: 'GB0380000000608010167519' }))).status, 400);
      assert.equal((await call(url, 'POST', '/api/vendor/payouts', 'vendor1', request(100, { accountHolder: ' ' }))).status, 400);

      mails.length = 0;
      const ok = await call(url, 'POST', '/api/vendor/payouts', 'vendor1', request(850, { note: 'شكراً' }));
      assert.equal(ok.status, 201);
      assert.equal(ok.json.data.status, 'requested');
      assert.equal(ok.json.data.iban, IBAN);
      assert.equal(ok.json.data.vendorName, 'قهوة الرياض');
      assert.equal(ok.json.data.amount, 850);
      await settle();
      assert.ok(mails.some((mail) => mail.to.includes('owner@usil.sa')));

      const earnings = await call(url, 'GET', '/api/vendor/earnings', 'vendor1');
      assert.equal(earnings.json.data.available, 0);
      assert.equal(earnings.json.data.inReview, 850);
    } finally {
      await close();
    }
  });

  it('allows only one open request at a time', async () => {
    const { url, close } = await setup([booking()]);
    try {
      assert.equal((await call(url, 'POST', '/api/vendor/payouts', 'vendor1', request(100))).status, 201);
      const second = await call(url, 'POST', '/api/vendor/payouts', 'vendor1', request(100));
      assert.equal(second.status, 409);
      const list = await call(url, 'GET', '/api/vendor/payouts', 'vendor1');
      assert.equal(list.json.data.length, 1);
    } finally {
      await close();
    }
  });

  it('keeps vendors apart and lets supervisors act through ?vendorId=', async () => {
    const { url, close } = await setup([booking()]);
    try {
      assert.equal((await call(url, 'POST', '/api/vendor/payouts', 'vendor1', request(100))).status, 201);
      // Vendor B never sees vendor A's requests or balance, even by asking for them.
      const other = await call(url, 'GET', '/api/vendor/payouts?vendorId=v-1', 'vendor2');
      assert.equal(other.status, 200);
      assert.equal(other.json.data.length, 0);
      const otherEarnings = await call(url, 'GET', '/api/vendor/earnings?vendorId=v-1', 'vendor2');
      assert.equal(otherEarnings.json.data.available, 0);
      assert.equal(otherEarnings.json.data.orders.length, 0);

      const supervised = await call(url, 'GET', '/api/vendor/payouts?vendorId=v-1', 'manager');
      assert.equal(supervised.json.data.length, 1);
      assert.equal((await call(url, 'GET', '/api/vendor/earnings', 'admin')).status, 400);
      assert.equal((await call(url, 'GET', '/api/vendor/earnings?vendorId=usr-admin', 'admin')).status, 404);
      assert.equal((await call(url, 'GET', '/api/vendor/earnings', 'client')).status, 403);
      assert.equal((await call(url, 'GET', '/api/vendor/earnings')).status, 401);
    } finally {
      await close();
    }
  });
});

describe('payout routes — admin side', () => {
  it('is closed to vendors and clients', async () => {
    const { url, close } = await setup([booking()]);
    try {
      assert.equal((await call(url, 'GET', '/api/admin/payouts', 'vendor1')).status, 403);
      assert.equal((await call(url, 'PATCH', '/api/admin/payouts/x', 'vendor1', { status: 'paid' })).status, 403);
      assert.equal((await call(url, 'GET', '/api/admin/payouts', 'client')).status, 403);
      assert.equal((await call(url, 'GET', '/api/admin/payouts', 'manager')).status, 200);
    } finally {
      await close();
    }
  });

  it('walks requested → approved → paid, with a reference, and emails the vendor', async () => {
    const { url, close } = await setup([booking()]);
    try {
      const created = await call(url, 'POST', '/api/vendor/payouts', 'vendor1', request(500));
      const id = created.json.data.id;

      const list = await call(url, 'GET', '/api/admin/payouts', 'admin');
      assert.equal(list.json.data.length, 1);
      assert.equal(list.json.data[0].vendorName, 'قهوة الرياض');
      assert.equal(list.json.data[0].vendorEmail, 'v1@usil.sa');

      // Paid needs approval first.
      assert.equal((await call(url, 'PATCH', `/api/admin/payouts/${id}`, 'admin', { status: 'paid', reference: 'TRX-1' })).status, 409);
      assert.equal((await call(url, 'PATCH', `/api/admin/payouts/${id}`, 'admin', { status: 'bogus' })).status, 400);
      assert.equal((await call(url, 'PATCH', '/api/admin/payouts/nope', 'admin', { status: 'approved' })).status, 404);

      mails.length = 0;
      const approved = await call(url, 'PATCH', `/api/admin/payouts/${id}`, 'manager', { status: 'approved' });
      assert.equal(approved.status, 200);
      assert.equal(approved.json.data.status, 'approved');
      assert.equal(approved.json.data.decidedBy, 'مدير الحسابات');

      // A vendor may request again once nothing is still `requested` — but only from what is left.
      assert.equal((await call(url, 'POST', '/api/vendor/payouts', 'vendor1', request(350.01))).status, 400);

      assert.equal((await call(url, 'PATCH', `/api/admin/payouts/${id}`, 'admin', { status: 'paid' })).status, 400);
      const paid = await call(url, 'PATCH', `/api/admin/payouts/${id}`, 'admin', { status: 'paid', reference: 'TRX-778' });
      assert.equal(paid.status, 200);
      assert.equal(paid.json.data.reference, 'TRX-778');
      await settle();
      assert.ok(mails.filter((mail) => mail.to.includes('v1@usil.sa')).length >= 2);

      // Final.
      assert.equal((await call(url, 'PATCH', `/api/admin/payouts/${id}`, 'admin', { status: 'rejected' })).status, 409);

      const earnings = await call(url, 'GET', '/api/vendor/earnings', 'vendor1');
      assert.equal(earnings.json.data.paidOut, 500);
      assert.equal(earnings.json.data.available, 350);
    } finally {
      await close();
    }
  });

  it('a rejection returns the amount to the available balance', async () => {
    const { url, close } = await setup([booking()]);
    try {
      const created = await call(url, 'POST', '/api/vendor/payouts', 'vendor1', request(850));
      const rejected = await call(url, 'PATCH', `/api/admin/payouts/${created.json.data.id}`, 'admin', {
        status: 'rejected',
        adminNote: 'الآيبان لا يطابق اسم المؤسسة',
      });
      assert.equal(rejected.status, 200);
      assert.equal(rejected.json.data.adminNote, 'الآيبان لا يطابق اسم المؤسسة');
      const earnings = await call(url, 'GET', '/api/vendor/earnings', 'vendor1');
      assert.equal(earnings.json.data.available, 850);
      assert.equal((await call(url, 'POST', '/api/vendor/payouts', 'vendor1', request(850))).status, 201);
    } finally {
      await close();
    }
  });

  it('refuses to approve a request the completed balance no longer covers', async () => {
    const { url, close, dir } = await setup([booking()]);
    try {
      const created = await call(url, 'POST', '/api/vendor/payouts', 'vendor1', request(850));
      // The order is cancelled by an admin after the request went in.
      const store = createBookingStore(dir);
      store.cancel('BK-1', {
        cancelledAt: '2026-10-05',
        cancelledBy: 'admin',
        refundPercent: 100,
        refundHalalas: 100000,
        refundStatus: 'pending',
        note: '',
      });
      const approve = await call(url, 'PATCH', `/api/admin/payouts/${created.json.data.id}`, 'admin', { status: 'approved' });
      assert.equal(approve.status, 409);
      const reject = await call(url, 'PATCH', `/api/admin/payouts/${created.json.data.id}`, 'admin', { status: 'rejected' });
      assert.equal(reject.status, 200);
    } finally {
      await close();
    }
  });
});
