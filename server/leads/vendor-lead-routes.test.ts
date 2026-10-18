import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { registerVendorLeadRoutes } from './vendor-lead-routes.ts';
import { LEAD_IMPORT_MAX_ROWS } from './vendor-leads.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-leads-'));
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

function buildApp(dir: string, role: 'admin' | 'vendor' | null) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  registerVendorLeadRoutes(
    app,
    {
      requireRole: (roles: string[]) => (_req: Request, res: Response, next: NextFunction) => {
        if (!role) return res.status(401).json({ success: false });
        if (!roles.includes(role)) return res.status(403).json({ success: false });
        next();
      },
      listVendorUsers: () => [{ id: 'v-1', phone: '0551112223' }],
    },
    dir,
  );
  return app;
}

async function call(url: string, method: string, route: string, body?: unknown) {
  const res = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe('owner vendor leads (أرقام المورّدين)', () => {
  it('imports a sheet: normalises numbers, skips duplicates and reports bad rows', async () => {
    const { url, close } = await listen(buildApp(tmpDir(), 'admin'));
    try {
      const res = await call(url, 'POST', '/api/admin/vendor-leads/import', {
        rows: [
          { name: 'قهوة الديرة', phone: '0501234567', city: 'الرياض', activity: 'قهوة' },
          { name: 'خيام الشمال', phone: '966 55 111 2223' },
          { name: 'نفس الرقم', phone: '+966501234567' },
          { name: 'رقم ناقص', phone: '05012' },
          { name: 'بدون رقم', phone: '' },
        ],
      });
      assert.equal(res.status, 200);
      assert.deepEqual(
        { added: res.json.data.added, duplicates: res.json.data.duplicates, total: res.json.data.total },
        { added: 2, duplicates: 1, total: 5 },
      );
      assert.deepEqual(res.json.data.invalid.map((r: { row: number }) => r.row), [4, 5]);

      const list = await call(url, 'GET', '/api/admin/vendor-leads');
      assert.equal(list.json.data.length, 2);
      const tent = list.json.data.find((r: { name: string }) => r.name === 'خيام الشمال');
      assert.equal(tent.phone, '0551112223');
      assert.equal(tent.status, 'new');
      // That number already sells on Usil.
      assert.equal(tent.alreadyVendor, true);

      // A second import of the same sheet adds nothing.
      const again = await call(url, 'POST', '/api/admin/vendor-leads/import', { rows: [{ phone: '0501234567' }] });
      assert.equal(again.json.data.added, 0);
      assert.equal(again.json.data.duplicates, 1);
    } finally {
      await close();
    }
  });

  it('updates status and notes, adds by hand, and deletes', async () => {
    const { url, close } = await listen(buildApp(tmpDir(), 'admin'));
    try {
      const added = await call(url, 'POST', '/api/admin/vendor-leads', { name: 'تصوير', phone: '0569998887' });
      assert.equal(added.status, 201);
      assert.equal(added.json.data.source, 'manual');
      assert.equal((await call(url, 'POST', '/api/admin/vendor-leads', { phone: '0569998887' })).status, 409);
      assert.equal((await call(url, 'POST', '/api/admin/vendor-leads', { phone: '123' })).status, 400);

      const id = added.json.data.id;
      const updated = await call(url, 'PATCH', `/api/admin/vendor-leads/${id}`, { status: 'interested', note: 'يبغى يتصل بعد العصر' });
      assert.equal(updated.json.data.status, 'interested');
      assert.equal(updated.json.data.note, 'يبغى يتصل بعد العصر');
      assert.equal((await call(url, 'PATCH', `/api/admin/vendor-leads/${id}`, { status: 'whatever' })).status, 400);
      assert.equal((await call(url, 'DELETE', `/api/admin/vendor-leads/${id}`)).status, 200);
      assert.equal((await call(url, 'DELETE', `/api/admin/vendor-leads/${id}`)).status, 404);
    } finally {
      await close();
    }
  });

  it('refuses empty or oversized imports', async () => {
    const { url, close } = await listen(buildApp(tmpDir(), 'admin'));
    try {
      assert.equal((await call(url, 'POST', '/api/admin/vendor-leads/import', { rows: [] })).status, 400);
      const big = Array.from({ length: LEAD_IMPORT_MAX_ROWS + 1 }, (_, i) => ({ phone: `05${String(10000000 + i)}` }));
      assert.equal((await call(url, 'POST', '/api/admin/vendor-leads/import', { rows: big })).status, 413);
    } finally {
      await close();
    }
  });

  it('is for the administration only', async () => {
    for (const role of [null, 'vendor'] as const) {
      const { url, close } = await listen(buildApp(tmpDir(), role));
      try {
        assert.notEqual((await call(url, 'GET', '/api/admin/vendor-leads')).status, 200, String(role));
        assert.notEqual((await call(url, 'POST', '/api/admin/vendor-leads/import', { rows: [{ phone: '0501234567' }] })).status, 200);
      } finally {
        await close();
      }
    }
  });
});
