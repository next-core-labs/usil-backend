import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { registerExternalBookingRoutes } from './external-booking-routes.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-exb-api-'));
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

const COURIERS = [
  { id: 'usr-courier', name: 'سعد الدوسري', source: 'account' as const },
  { id: 'crr-1', name: 'فهد القحطاني', source: 'application' as const },
];

function actors() {
  return {
    admin: { id: 'usr-admin', name: 'إدارة يوصل', role: 'admin' },
    courier: { id: 'usr-courier', name: 'سعد الدوسري', role: 'courier' },
    client: { id: 'usr-client', name: 'عميل', role: 'client' },
  };
}

/** كل طلب يحمل ترويسة x-test-actor بدل كوكي الجلسة. */
function buildApp(dir: string) {
  const app = express();
  app.use(express.json());
  const auth = {
    userFromRequest: (req: express.Request) => {
      const key = String(req.headers['x-test-actor'] || '');
      return (actors() as Record<string, { id: string; name: string; role: string }>)[key] || null;
    },
  };
  registerExternalBookingRoutes(app, auth, dir, { listCourierOptions: () => COURIERS });
  return app;
}

const payload = {
  customerName: 'نورة',
  phone: '0551234567',
  city: 'جدة',
  serviceType: 'ضيافة زواج',
  eventDate: '2026-11-02',
  amount: 2500,
  collection: 'transfer',
};

async function post(url: string, actor: string, body: unknown) {
  return fetch(`${url}/api/external-bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-actor': actor },
    body: JSON.stringify(body),
  });
}

describe('external-booking-routes', () => {
  it('lets a courier file a booking that is attributed to himself', async () => {
    const { url, close } = await listen(buildApp(tmpDir()));
    const res = await post(url, 'courier', { ...payload, courierId: 'crr-1' });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.booking.courierId, 'usr-courier');
    assert.equal(json.message, 'تم تسجيل الحجز الخارجي');
    await close();
  });

  it('lets admin file on behalf of an approved courier and blocks unknown couriers', async () => {
    const { url, close } = await listen(buildApp(tmpDir()));
    const ok = await post(url, 'admin', { ...payload, courierId: 'crr-1' });
    assert.equal(ok.status, 201);
    assert.equal((await ok.json()).booking.courierName, 'فهد القحطاني');
    const bad = await post(url, 'admin', { ...payload, courierId: 'crr-ghost' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /مندوباً معتمداً/);
    await close();
  });

  it('shows the courier only his own rows and the admin all of them', async () => {
    const { url, close } = await listen(buildApp(tmpDir()));
    await post(url, 'courier', payload);
    await post(url, 'admin', { ...payload, courierId: 'crr-1' });
    const mine = await fetch(`${url}/api/external-bookings`, { headers: { 'x-test-actor': 'courier' } });
    assert.equal((await mine.json()).data.length, 1);
    const all = await fetch(`${url}/api/external-bookings`, { headers: { 'x-test-actor': 'admin' } });
    assert.equal((await all.json()).data.length, 2);
    await close();
  });

  it('refuses guests and clients', async () => {
    const { url, close } = await listen(buildApp(tmpDir()));
    const guest = await fetch(`${url}/api/external-bookings`);
    assert.equal(guest.status, 401);
    const client = await fetch(`${url}/api/external-bookings`, { headers: { 'x-test-actor': 'client' } });
    assert.equal(client.status, 403);
    await close();
  });

  it('keeps a courier away from another courier row and keeps delete for admin', async () => {
    const { url, close } = await listen(buildApp(tmpDir()));
    const other = await post(url, 'admin', { ...payload, courierId: 'crr-1' });
    const id = (await other.json()).booking.id;
    const forbidden = await fetch(`${url}/api/external-bookings/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-test-actor': 'courier' },
      body: JSON.stringify({ status: 'مؤكد' }),
    });
    assert.equal(forbidden.status, 403);
    const patched = await fetch(`${url}/api/external-bookings/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-test-actor': 'admin' },
      body: JSON.stringify({ status: 'منفّذ' }),
    });
    assert.equal((await patched.json()).booking.status, 'منفّذ');
    const courierDelete = await fetch(`${url}/api/external-bookings/${id}`, {
      method: 'DELETE',
      headers: { 'x-test-actor': 'courier' },
    });
    assert.equal(courierDelete.status, 403);
    const adminDelete = await fetch(`${url}/api/external-bookings/${id}`, {
      method: 'DELETE',
      headers: { 'x-test-actor': 'admin' },
    });
    assert.equal(adminDelete.status, 200);
    await close();
  });

  it('rejects an unknown status with 400 and leaves the booking unchanged', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    const created = await post(url, 'admin', { ...payload, courierId: 'crr-1', status: 'مؤكد' });
    const id = (await created.json()).booking.id;
    const before = fs.readFileSync(path.join(dir, 'external-bookings.json'), 'utf-8');
    for (const status of ['done', 'ملغى تماماً', '', null, 42]) {
      const res = await fetch(`${url}/api/external-bookings/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-test-actor': 'admin' },
        body: JSON.stringify({ status, notes: 'تعديل' }),
      });
      assert.equal(res.status, 400, `status ${JSON.stringify(status)}`);
      assert.match((await res.json()).error, /حالة الحجز غير صحيحة/);
    }
    assert.equal(fs.readFileSync(path.join(dir, 'external-bookings.json'), 'utf-8'), before);
    const badCreate = await post(url, 'admin', { ...payload, courierId: 'crr-1', status: 'pending' });
    assert.equal(badCreate.status, 400);
    await close();
  });

  it('rejects an invalid Saudi mobile', async () => {
    const { url, close } = await listen(buildApp(tmpDir()));
    const res = await post(url, 'courier', { ...payload, phone: '0121234567' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /05xxxxxxxx/);
    await close();
  });
});
