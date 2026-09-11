import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { registerCityRequestRoutes } from './city-request-routes.ts';
import { validateCityDemandInput } from './city-requests.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-demand-'));
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

function fakeAuth(role: 'admin' | null) {
  return {
    requireRole: (roles: string[]) => (req: Request, res: Response, next: NextFunction) => {
      if (!role) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
      if (!roles.includes(role)) return res.status(403).json({ success: false, error: 'ليست لديك صلاحية هذا الإجراء.' });
      next();
    },
  };
}

const payload = {
  name: 'سارة الدوسري',
  phone: '0501234567',
  city: 'فيفا',
  occasion: 'عرس',
  eventDate: '2026-10-12',
  notes: 'ضيافة نساء فقط',
};

describe('city demand requests', () => {
  it('rejects جميع المدن and accepts a village name', () => {
    const bad = validateCityDemandInput({ ...payload, city: 'جميع المدن' });
    assert.equal(bad.ok, false);
    const good = validateCityDemandInput(payload);
    assert.equal(good.ok, true);
    if (good.ok) assert.equal(good.value.phone, '0501234567');
  });

  it('saves a public request and lists it for admin', async () => {
    const dir = tmpDir();
    const app = express();
    app.use(express.json());
    registerCityRequestRoutes(app, fakeAuth('admin') as any, dir);
    const { url, close } = await listen(app);
    try {
      const created = await fetch(`${url}/api/city-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(created.status, 201);
      const json = await created.json();
      assert.equal(json.success, true);
      assert.equal(json.data.city, 'فيفا');
      assert.equal(json.data.status, 'new');

      const listed = await fetch(`${url}/api/admin/city-requests`);
      const listJson = await listed.json();
      assert.equal(listed.status, 200);
      assert.equal(listJson.data[0].phone, '0501234567');

      const patched = await fetch(`${url}/api/admin/city-requests/${json.data.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'matched' }),
      });
      const patchedJson = await patched.json();
      assert.equal(patched.status, 200);
      assert.equal(patchedJson.data.status, 'matched');
    } finally {
      await close();
    }
  });

  it('blocks guests from the admin list', async () => {
    const app = express();
    app.use(express.json());
    registerCityRequestRoutes(app, fakeAuth(null) as any, tmpDir());
    const { url, close } = await listen(app);
    try {
      const res = await fetch(`${url}/api/admin/city-requests`);
      assert.equal(res.status, 401);
    } finally {
      await close();
    }
  });
});
