import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { registerCourierApplicationRoutes, resetCourierApplyLimiter } from './courier-application-routes.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-crr-api-'));
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
    userFromRequest: () =>
      role === 'admin' ? { id: 'usr-admin', name: 'إدارة', email: 'admin@usil.app', phone: '0503333333', role: 'admin' } : null,
    requireRole: (roles: string[]) => (req: Request, res: Response, next: NextFunction) => {
      if (!role) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
      if (!roles.includes(role)) return res.status(403).json({ success: false, error: 'ليست لديك صلاحية هذا الإجراء.' });
      next();
    },
  };
}

const payload = {
  firstName: 'سعد',
  familyName: 'الدوسري',
  nationalId: '1088123456',
  plateLetters: 'برد',
  plateNumbers: '1234',
  carType: 'فان',
  fulfillment: ['hour', 'tomorrow'],
};

describe('courier-application-routes', () => {
  it('accepts a public courier application and hides the full ID', async () => {
    const app = express();
    app.use(express.json());
    registerCourierApplicationRoutes(app, fakeAuth('admin') as any, tmpDir());
    const { url, close } = await listen(app);
    const res = await fetch(`${url}/api/couriers/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.application.status, 'pending');
    assert.equal(json.application.nationalId.includes('1088123456'), false);
    assert.match(json.message, /استلمنا طلبك/);
    await close();
  });

  it('lets admin list and approve', async () => {
    const dir = tmpDir();
    const app = express();
    app.use(express.json());
    registerCourierApplicationRoutes(app, fakeAuth('admin') as any, dir);
    const { url, close } = await listen(app);
    const created = await fetch(`${url}/api/couriers/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const id = (await created.json()).application.id;
    const listed = await fetch(`${url}/api/admin/couriers`);
    assert.equal(listed.status, 200);
    const listJson = await listed.json();
    assert.equal(listJson.data[0].nationalId, payload.nationalId);
    const approved = await fetch(`${url}/api/admin/couriers/${id}/approve`, { method: 'POST' });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).application.status, 'approved');
    await close();
  });

  it('rejects a courier apply without fulfillment lanes', async () => {
    const app = express();
    app.use(express.json());
    registerCourierApplicationRoutes(app, fakeAuth(null) as any, tmpDir());
    const { url, close } = await listen(app);
    const res = await fetch(`${url}/api/couriers/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'سعد',
        familyName: 'الدوسري',
        nationalId: '1099123456',
        plateLetters: 'برد',
        plateNumbers: '1234',
        carType: 'فان',
      }),
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /أقدر أوصل/);
    await close();
  });

  it('rejects guests from the admin list', async () => {
    const app = express();
    app.use(express.json());
    registerCourierApplicationRoutes(app, fakeAuth(null) as any, tmpDir());
    const { url, close } = await listen(app);
    const res = await fetch(`${url}/api/admin/couriers`);
    assert.equal(res.status, 401);
    await close();
  });

  it('rate-limits repeated public applies', async () => {
    resetCourierApplyLimiter();
    const app = express();
    app.use(express.json());
    registerCourierApplicationRoutes(app, fakeAuth(null) as any, tmpDir());
    const { url, close } = await listen(app);
    let lastStatus = 0;
    for (let i = 0; i < 6; i += 1) {
      const res = await fetch(`${url}/api/couriers/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, nationalId: `1${String(i).padStart(9, '0')}` }),
      });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429);
    await close();
  });
});
