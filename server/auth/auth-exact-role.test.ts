import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createAuth, hashPassword, roleGuardAllows } from './auth.ts';
import { registerAuthRoutes } from './auth-routes.ts';
import { registerIntegrationsRoutes } from '../ai/integrations-routes.ts';
import { registerMoyasarAdminRoutes } from '../payments/moyasar-admin-routes.ts';
import { registerSeoRoutes } from '../seo/seo-routes.ts';
import { registerBookingRoutes } from '../bookings/booking-routes.ts';
import { createBookingStore } from '../bookings/booking-store.ts';

const PASSWORD = 'secret123';
const ADMIN = { id: 'usr-admin-2', email: 'admin2@usil.sa', phone: '0500000002', role: 'admin' };
const MANAGER = { id: 'usr-manager', email: 'manager@usil.sa', phone: '0500000003', role: 'accounts_manager' };

function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

async function call(url: string, method: string, body?: unknown, cookie = '') {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { res, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe('roleGuardAllows', () => {
  it('lets accounts_manager through admin guards unless the guard is exact', () => {
    assert.equal(roleGuardAllows('accounts_manager', ['admin']), true);
    assert.equal(roleGuardAllows('accounts_manager', ['admin'], { exact: true }), false);
    assert.equal(roleGuardAllows('admin', ['admin'], { exact: true }), true);
    assert.equal(roleGuardAllows(null, ['admin'], { exact: true }), false);
    assert.equal(roleGuardAllows('vendor', ['vendor', 'admin'], { exact: true }), true);
  });
});

describe('owner-only settings — real sessions', () => {
  it('keeps payment keys, SEO writes, AI keys and booking deletion from accounts_manager', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-exact-role-'));
    fs.writeFileSync(
      path.join(dir, 'users.json'),
      JSON.stringify(
        [ADMIN, MANAGER].map((user) => ({
          name: user.id,
          avatarUrl: '',
          emailVerified: true,
          passwordHash: hashPassword(PASSWORD),
          ...user,
        })),
      ),
    );
    createBookingStore(dir).add({
      id: 'BK-100001',
      name: 'نواف',
      phone: '0512345678',
      email: 'client@usil.sa',
      serviceName: 'ركن قهوة',
      notes: '',
      city: 'الرياض',
      eventDate: '2026-12-10',
      paymentMethod: 'moyasar',
      settlement: 'ميسر',
      items: [],
      totalAmount: 500,
      bookingMode: 'instant',
      status: 'جديد',
      paymentStatus: 'unpaid',
      createdAt: '2026-10-01 10:00',
    });

    const auth = createAuth(dir);
    const app = express();
    app.use(express.json());
    registerAuthRoutes(app, auth, dir);
    registerIntegrationsRoutes(app, auth, dir);
    registerMoyasarAdminRoutes(app, auth, dir, {
      fetchImpl: (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch,
    });
    registerSeoRoutes(app, auth, dir, { readIndexHtml: () => '<html></html>' });
    registerBookingRoutes(app, auth, dir, { listListings: () => [], blockedDatesFor: () => [] });
    const { url, close } = await listen(app);

    const login = async (user: typeof ADMIN) => {
      const { res } = await call(`${url}/api/auth/login`, 'POST', { email: user.email, phone: user.phone, password: PASSWORD });
      assert.equal(res.status, 200, `login ${user.email}`);
      return (res.headers.get('set-cookie') || '').split(';')[0];
    };

    try {
      const manager = await login(MANAGER);
      const admin = await login(ADMIN);

      // accounts_manager: refused on every owner-only route.
      const refused: Array<[string, string, unknown?]> = [
        ['PUT', '/api/admin/moyasar', { secretKey: 'sk_test_x' }],
        ['PUT', '/api/admin/seo', { siteTitle: 'x' }],
        ['GET', '/api/admin/integrations'],
        ['PUT', '/api/admin/integrations', {}],
        ['POST', '/api/admin/integrations/test', { provider: 'gemini' }],
        ['DELETE', '/api/bookings/BK-100001'],
      ];
      for (const [method, route, body] of refused) {
        const { res } = await call(`${url}${route}`, method, body, manager);
        assert.equal(res.status, 403, `${method} ${route}`);
      }
      // …but still reads what supervisors read.
      assert.equal((await call(`${url}/api/admin/moyasar`, 'GET', undefined, manager)).res.status, 200);
      assert.equal((await call(`${url}/api/admin/seo`, 'GET', undefined, manager)).res.status, 200);
      assert.equal((await call(`${url}/api/bookings`, 'GET', undefined, manager)).res.status, 200);

      // The owner admin passes the guard on each.
      assert.equal((await call(`${url}/api/admin/integrations`, 'GET', undefined, admin)).res.status, 200);
      assert.notEqual((await call(`${url}/api/admin/moyasar`, 'PUT', { secretKey: 'sk_test_x' }, admin)).res.status, 403);
      assert.equal((await call(`${url}/api/bookings/BK-100001`, 'DELETE', undefined, admin)).res.status, 200);
    } finally {
      await close();
    }
  });
});
