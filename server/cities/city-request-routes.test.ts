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
  // Far enough ahead that the "no past dates" rule never trips this fixture.
  eventDate: '2099-10-12',
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

  it('rejects impossible and past event dates, using today in Riyadh', () => {
    // 2026-09-27 21:30 UTC is already 2026-09-28 in Riyadh.
    const now = new Date('2026-09-27T21:30:00Z');
    for (const eventDate of ['2026-99-99', '2026-02-30', '2026-13-01', '27-09-2026', 'غداً']) {
      const bad = validateCityDemandInput({ ...payload, eventDate }, now);
      assert.equal(bad.ok, false, eventDate);
      if (bad.ok === false) assert.match(bad.error, /غير صحيح/);
    }
    const past = validateCityDemandInput({ ...payload, eventDate: '2026-09-27' }, now);
    assert.equal(past.ok, false);
    if (past.ok === false) assert.match(past.error, /مضى/);
    assert.equal(validateCityDemandInput({ ...payload, eventDate: '2026-09-28' }, now).ok, true);
    assert.equal(validateCityDemandInput({ ...payload, eventDate: '2028-02-29' }, now).ok, true);
    // The date stays optional.
    assert.equal(validateCityDemandInput({ ...payload, eventDate: '' }, now).ok, true);
  });

  it('refuses a past event date over HTTP', async () => {
    const app = express();
    app.use(express.json());
    registerCityRequestRoutes(app, fakeAuth(null) as any, tmpDir());
    const { url, close } = await listen(app);
    try {
      const res = await fetch(`${url}/api/city-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, eventDate: '2020-01-01' }),
      });
      assert.equal(res.status, 400);
    } finally {
      await close();
    }
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
