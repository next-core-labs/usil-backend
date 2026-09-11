import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { registerMoyasarAdminRoutes } from './moyasar-admin-routes.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-moyasar-admin-'));
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

function fakeAuth(role: 'admin' | 'vendor' | null) {
  return {
    requireRole: (roles: string[]) => (_req: Request, res: Response, next: NextFunction) => {
      if (!role) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
      if (!roles.includes(role)) {
        return res.status(403).json({ success: false, error: 'ليست لديك صلاحية هذا الإجراء.' });
      }
      next();
    },
  };
}

const SECRET = 'sk_test_dddddddddddddddddddddddddddddddd';
const ENV_NAMES = [
  'MOYASAR_SECRET_KEY',
  'MOYASAR_API_KEY',
  'PAYMENT_PROVIDER_SECRET_KEY',
  'MOYASAR_PUBLISHABLE_KEY',
  'MOYASAR_WEBHOOK_SECRET',
  'MOYASAR_WEBHOOK_URL',
];
let savedEnv: Record<string, string | undefined> = {};

describe('moyasar-admin-routes', () => {
  beforeEach(() => {
    savedEnv = {};
    for (const name of ENV_NAMES) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
    process.env.MOYASAR_WEBHOOK_SECRET = 'webhook-secret-for-tests-32chars-aaaa';
    process.env.MOYASAR_WEBHOOK_URL = 'https://hooks.usil.app/api/payments/webhook';
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name] as string;
    }
  });

  it('rejects guests and vendors', async () => {
    const dir = tmpDir();
    const guestApp = express();
    guestApp.use(express.json());
    registerMoyasarAdminRoutes(guestApp, fakeAuth(null) as any, dir, {
      fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
    });
    const vendorApp = express();
    vendorApp.use(express.json());
    registerMoyasarAdminRoutes(vendorApp, fakeAuth('vendor') as any, dir, {
      fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
    });
    const guest = await listen(guestApp);
    const vendor = await listen(vendorApp);
    assert.equal((await fetch(`${guest.url}/api/admin/moyasar`)).status, 401);
    assert.equal((await fetch(`${vendor.url}/api/admin/moyasar`)).status, 403);
    assert.equal(fs.existsSync(path.join(dir, 'moyasar.json')), false);
    await guest.close();
    await vendor.close();
  });

  it('refuses a starred key and does not write the file', async () => {
    const dir = tmpDir();
    const app = express();
    app.use(express.json());
    registerMoyasarAdminRoutes(app, fakeAuth('admin') as any, dir, {
      fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
    });
    const { url, close } = await listen(app);
    const res = await fetch(`${url}/api/admin/moyasar`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secretKey: 'sk_live_************************' }),
    });
    const json = (await res.json()) as { success?: boolean; error?: string };
    assert.equal(res.status, 400);
    assert.equal(json.success, false);
    assert.equal(fs.existsSync(path.join(dir, 'moyasar.json')), false);
    await close();
  });

  it('saves a verified secret, masks it, and registers the webhook', async () => {
    const dir = tmpDir();
    const urls: string[] = [];
    const app = express();
    app.use(express.json());
    registerMoyasarAdminRoutes(app, fakeAuth('admin') as any, dir, {
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const href = String(input);
        urls.push(`${init?.method || 'GET'} ${href}`);
        if ((init?.method || 'GET') === 'POST') {
          return new Response(JSON.stringify({ id: 'wh_1' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ webhooks: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    const { url, close } = await listen(app);
    const res = await fetch(`${url}/api/admin/moyasar`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secretKey: SECRET }),
    });
    const json = (await res.json()) as {
      success?: boolean;
      data?: { configured?: boolean; secretMasked?: string; live?: boolean };
      webhook?: { ok?: boolean; status?: string };
    };
    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.equal(json.data?.configured, true);
    assert.equal(json.data?.live, false);
    assert.equal(String(json.data?.secretMasked || '').includes(SECRET), false);
    assert.equal(json.webhook?.ok, true);
    assert.equal(json.webhook?.status, 'created');
    assert.equal(process.env.MOYASAR_SECRET_KEY, SECRET);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'moyasar.json'), 'utf-8')) as { secretKey: string };
    assert.equal(saved.secretKey, SECRET);
    assert.equal(JSON.stringify(json).includes(SECRET), false);
    assert.equal(urls.some((row) => row.startsWith('POST ')), true);
    await close();
  });
});
