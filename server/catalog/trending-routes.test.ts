import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { ServiceItem } from '../../core/types.ts';
import type { PlatformBooking } from '../bookings/booking-store.ts';
import { registerTrendingRoutes } from './trending-routes.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-trending-api-'));
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

const NOW = new Date('2026-10-02T12:00:00Z');

function service(id: string): ServiceItem {
  return { id, title: id, price: 100, cities: ['الرياض'], image: '/uploads/a.jpg', rating: 0, reviewsCount: 0 } as ServiceItem;
}

function paidBooking(id: string): PlatformBooking {
  return {
    id: `BK-${id}`,
    name: 'عميل',
    phone: '0512345678',
    email: '',
    serviceName: '',
    notes: '',
    city: 'الرياض',
    eventDate: '2026-12-01',
    paymentMethod: 'moyasar',
    settlement: '',
    items: [{ id, title: id, quantity: 1, price: 100, vendorId: 'v-1' }],
    totalAmount: 100,
    bookingMode: 'instant',
    status: 'مؤكد',
    paymentStatus: 'paid',
    createdAt: '2026-10-01 09:00',
  };
}

function setup(opts: { bookings?: PlatformBooking[]; cacheMs?: number } = {}) {
  const app = express();
  app.use(express.json());
  const services = [service('a'), service('b'), service('c')];
  const handle = registerTrendingRoutes(app, tmpDir(), {
    listServices: () => services,
    listListings: () => services.map((row, i) => ({ id: row.id, createdAt: new Date(NOW.getTime() - i * 86_400_000).toISOString() })),
    listBookings: () => opts.bookings || [],
    now: () => NOW,
    cacheMs: opts.cacheMs ?? 0,
  });
  return { app, handle };
}

describe('trending routes', () => {
  it('serves the ranked public catalog with the window and the numbers behind each rank', async () => {
    const { app } = setup({ bookings: [paidBooking('c')] });
    const { url, close } = await listen(app);
    try {
      const res = await fetch(`${url}/api/catalog/trending`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=30');
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.windowDays, 7);
      assert.equal(body.generatedAt, NOW.toISOString());
      assert.deepEqual(body.data.map((row: { id: string }) => row.id), ['c', 'a', 'b']);
      assert.equal(body.data[0].trending.rank, 1);
      assert.equal(body.data[0].trending.paidBookings, 1);
      assert.equal(body.data[1].trending.isNew, true);
    } finally {
      await close();
    }
  });

  it('honours ?limit and ignores junk', async () => {
    const { app } = setup();
    const { url, close } = await listen(app);
    try {
      assert.equal((await (await fetch(`${url}/api/catalog/trending?limit=2`)).json()).data.length, 2);
      assert.equal((await (await fetch(`${url}/api/catalog/trending?limit=abc`)).json()).data.length, 3);
    } finally {
      await close();
    }
  });

  it('counts a product view once per caller per half hour and re-ranks', async () => {
    const { app, handle } = setup();
    const { url, close } = await listen(app);
    try {
      const first = await fetch(`${url}/api/catalog/listings/b/view`, { method: 'POST' });
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), { success: true, counted: true });
      const repeat = await fetch(`${url}/api/catalog/listings/b/view`, { method: 'POST' });
      assert.deepEqual(await repeat.json(), { success: true, counted: false });
      assert.equal(handle.views.countsSince(7, NOW).get('b'), 1);

      const body = await (await fetch(`${url}/api/catalog/trending`)).json();
      assert.equal(body.data[0].id, 'b');
      assert.equal(body.data[0].trending.views, 1);
    } finally {
      await close();
    }
  });

  it('refuses views for listings that are not in the public catalog', async () => {
    const { app, handle } = setup();
    const { url, close } = await listen(app);
    try {
      const res = await fetch(`${url}/api/catalog/listings/ghost/view`, { method: 'POST' });
      assert.equal(res.status, 404);
      assert.equal(handle.views.read().days['2026-10-02'], undefined);
    } finally {
      await close();
    }
  });

  it('serves a cached shelf inside the cache window and drops it when a view lands', async () => {
    const bookings: PlatformBooking[] = [];
    const { app } = setup({ bookings, cacheMs: 60_000 });
    const { url, close } = await listen(app);
    try {
      const before = await (await fetch(`${url}/api/catalog/trending`)).json();
      assert.equal(before.data[0].id, 'a');
      bookings.push(paidBooking('c'));
      const cached = await (await fetch(`${url}/api/catalog/trending`)).json();
      assert.equal(cached.data[0].id, 'a');
      await fetch(`${url}/api/catalog/listings/a/view`, { method: 'POST' });
      const fresh = await (await fetch(`${url}/api/catalog/trending`)).json();
      assert.equal(fresh.data[0].id, 'c');
    } finally {
      await close();
    }
  });
});
