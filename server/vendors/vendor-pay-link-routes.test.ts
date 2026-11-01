import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { registerBookingRoutes } from '../bookings/booking-routes.ts';
import { registerPaymentRoutes } from '../payments/payment-routes.ts';
import { registerPayoutRoutes } from '../payouts/payout-routes.ts';
import { createVendorStore } from './vendor-store.ts';
import { registerVendorPayLinkRoutes } from './vendor-pay-link-routes.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-pay-links-'));
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

const VENDOR = { id: 'v-1', role: 'vendor' };

const auth = {
  userFromRequest: () => VENDOR,
  requireRole: () => (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: typeof VENDOR }).user = VENDOR;
    next();
  },
  listVendorUsers: () => [{ id: 'v-1', name: 'مورّد', email: 'v1@usil.sa' }],
};

function buildApp(dir: string) {
  const app = express();
  app.use(express.json());
  const vendors = createVendorStore(dir);
  const bookings = registerBookingRoutes(app, auth as any, dir, { listListings: () => [], blockedDatesFor: () => [] });
  const payLinks = registerVendorPayLinkRoutes(app, auth, dir, { vendors, port: 0 });
  registerPaymentRoutes(app, { bookings, port: 0, payLinks });
  registerPayoutRoutes(app, auth, dir, { bookings, vendors, payLinks });
  return { app, vendors };
}

async function call(url: string, method: string, pathname: string, body?: unknown) {
  const res = await fetch(`${url}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
}

// ─── Moyasar stub ───
const realFetch = globalThis.fetch;
const invoicesRaised: Array<{ id: string; amount: number; metadata: Record<string, string> }> = [];
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
      const id = `inv_link${String(invoicesRaised.length + 1).padStart(6, '0')}`;
      invoicesRaised.push({ id, amount: body.amount, metadata: body.metadata });
      return json({ id, status: 'initiated', amount: body.amount, url: `https://checkout.moyasar.com/invoices/${id}` });
    }
    const payment = /^https:\/\/api\.moyasar\.com\/v1\/payments\/(.+)$/.exec(target);
    if (payment) {
      const found = providerPayments[decodeURIComponent(payment[1])];
      return found ? json(found) : json({ message: 'not found' }, 404);
    }
    if (target.startsWith('https://api.moyasar.com/v1/invoices/')) return json({ status: 'canceled' });
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

function seedOffice(vendors: ReturnType<typeof createVendorStore>) {
  vendors.patchOffice('v-1', {
    invoices: [
      { id: 'inv-1', invoiceNumber: 'INV-2026-001', clientName: 'أبو فهد', clientPhone: '0551234567', total: 1150, depositPaid: 150, remainingBalance: 1000, status: 'partial' },
      { id: 'inv-store', invoiceNumber: 'INV-2026-002', bookingId: 'BK-1', total: 500, depositPaid: 0, remainingBalance: 500, status: 'unpaid' },
    ],
    quotations: [
      { id: 'q-1', quoteNumber: 'Q-2026-001', clientName: 'شركة الندى', clientPhone: '0559999999', grandTotal: 1150, depositRequired: 345, status: 'sent' },
      { id: 'q-0', quoteNumber: 'Q-2026-002', clientName: 'سارة', grandTotal: 500, depositRequired: 0, status: 'draft' },
    ],
  });
}

async function payWebhook(url: string, id: string, invoiceId: string, amount: number, status = 'paid') {
  providerPayments[id] = { id, status, amount, currency: 'SAR', invoice_id: invoiceId, refunded: status === 'refunded' ? amount : 0 };
  return call(url, 'POST', '/api/payments/webhook', { secret_token: 'whsec-test', data: { id }, type: status === 'refunded' ? 'payment_refunded' : 'payment_paid' });
}

describe('vendor pay links', () => {
  it('charges what the stored document owes, settles on Moyasar\'s word, and pays the vendor less 15%', async () => {
    const dir = tmpDir();
    const { app, vendors } = buildApp(dir);
    seedOffice(vendors);
    const { url, close } = await listen(app);
    try {
      // The request's amount is ignored: the invoice still owes 1000.
      const first = await call(url, 'POST', '/api/vendor/pay-links', { kind: 'invoice', docId: 'inv-1', amount: 1 });
      assert.equal(first.status, 201);
      assert.equal(first.json.data.amount, 1000);
      assert.match(first.json.data.url, /^https:\/\/checkout\.moyasar\.com\//);
      const raised = invoicesRaised.at(-1)!;
      assert.equal(raised.amount, 100_000);
      assert.equal(raised.metadata.source, 'usil-vendor-link');
      assert.equal(raised.metadata.bookingId, undefined);

      // Sending again resends the same link instead of a second payable invoice.
      const again = await call(url, 'POST', '/api/vendor/pay-links', { kind: 'invoice', docId: 'inv-1' });
      assert.equal(again.json.reused, true);
      assert.equal(again.json.data.url, first.json.data.url);

      assert.equal((await call(url, 'POST', '/api/vendor/pay-links', { kind: 'invoice', docId: 'inv-store' })).status, 409);
      assert.equal((await call(url, 'POST', '/api/vendor/pay-links', { kind: 'quotation', docId: 'q-0' })).status, 409);
      assert.equal((await call(url, 'POST', '/api/vendor/pay-links', { kind: 'invoice', docId: 'nope' })).status, 404);
      assert.equal((await call(url, 'POST', '/api/vendor/pay-links', { kind: 'other', docId: 'inv-1' })).status, 400);

      const quote = await call(url, 'POST', '/api/vendor/pay-links', { kind: 'quotation', docId: 'q-1' });
      assert.equal(quote.json.data.amount, 345);

      // A short payment settles nothing.
      await payWebhook(url, 'pay_short000001', first.json.data.moyasarInvoiceId, 50);
      assert.equal(vendors.getOffice('v-1').invoices?.find((row: any) => row.id === 'inv-1')?.['status' as never], 'partial');

      await payWebhook(url, 'pay_full0000001', first.json.data.moyasarInvoiceId, 100_000);
      const invoice = vendors.getOffice('v-1').invoices?.find((row: any) => row.id === 'inv-1') as Record<string, unknown>;
      assert.equal(invoice.status, 'paid');
      assert.equal(invoice.depositPaid, 1150);
      assert.equal(invoice.remainingBalance, 0);
      // Settling twice changes nothing.
      await payWebhook(url, 'pay_full0000001', first.json.data.moyasarInvoiceId, 100_000);
      assert.equal((vendors.getOffice('v-1').invoices?.find((row: any) => row.id === 'inv-1') as any).depositPaid, 1150);

      await payWebhook(url, 'pay_quote000001', quote.json.data.moyasarInvoiceId, 34_500);
      const quotation = vendors.getOffice('v-1').quotations?.find((row: any) => row.id === 'q-1') as Record<string, unknown>;
      assert.equal(quotation.status, 'accepted');
      assert.equal(quotation.depositPaidOnline, 345);

      // A paid invoice cannot get a new link.
      assert.equal((await call(url, 'POST', '/api/vendor/pay-links', { kind: 'invoice', docId: 'inv-1' })).status, 409);

      const earnings = (await call(url, 'GET', '/api/vendor/earnings')).json.data;
      assert.equal(earnings.available, 1143.25); // (1000 + 345) × 0.85
      assert.deepEqual(
        earnings.orders.map((row: any) => [row.id, row.source, row.net]).sort(),
        [['INV-2026-001', 'link', 850], ['Q-2026-001', 'link', 293.25]],
      );

      const links = (await call(url, 'GET', '/api/vendor/pay-links')).json.data;
      assert.deepEqual(links.map((row: any) => row.status).sort(), ['paid', 'paid']);

      // A refund through Moyasar takes the payment back out of the balance.
      await payWebhook(url, 'pay_quote000001', quote.json.data.moyasarInvoiceId, 34_500, 'refunded');
      assert.equal((await call(url, 'GET', '/api/vendor/earnings')).json.data.available, 850);
    } finally {
      await close();
    }
  });

  it('replaces the open link when the invoice amount changes', async () => {
    const dir = tmpDir();
    const { app, vendors } = buildApp(dir);
    seedOffice(vendors);
    const { url, close } = await listen(app);
    try {
      const first = await call(url, 'POST', '/api/vendor/pay-links', { kind: 'invoice', docId: 'inv-1' });
      const office = vendors.getOffice('v-1');
      vendors.patchOffice('v-1', {
        invoices: (office.invoices || []).map((row: any) => (row.id === 'inv-1' ? { ...row, total: 1300, remainingBalance: 1150 } : row)),
      });
      const second = await call(url, 'POST', '/api/vendor/pay-links', { kind: 'invoice', docId: 'inv-1' });
      assert.equal(second.status, 201);
      assert.equal(second.json.data.amount, 1150);
      assert.notEqual(second.json.data.url, first.json.data.url);
      const statuses = (await call(url, 'GET', '/api/vendor/pay-links')).json.data.map((row: any) => [row.amount, row.status]);
      assert.deepEqual(statuses.sort(), [[1000, 'replaced'], [1150, 'open']]);
    } finally {
      await close();
    }
  });
});
