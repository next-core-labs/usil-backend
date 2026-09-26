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

/** Admin on /api/admin routes, and the given applicant (or a guest) on the public apply route. */
function adminWithApplicant(applicant: Record<string, unknown> | null = null) {
  const base = fakeAuth('admin');
  return {
    ...base,
    userFromRequest: (req: Request) => (req.path.startsWith('/api/admin') ? base.userFromRequest() : applicant),
  };
}

function writeUsers(dir: string, users: Array<Record<string, unknown>>) {
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(users));
}

function readUsers(dir: string): Array<{ id: string; role: string }> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf-8'));
}

async function applyAndApprove(dir: string, auth: unknown, body: Record<string, unknown>) {
  resetCourierApplyLimiter();
  const app = express();
  app.use(express.json());
  registerCourierApplicationRoutes(app, auth as any, dir);
  const { url, close } = await listen(app);
  try {
    const created = await fetch(`${url}/api/couriers/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const createdJson = await created.json();
    assert.equal(created.status, 201, JSON.stringify(createdJson));
    const approved = await fetch(`${url}/api/admin/couriers/${createdJson.application.id}/approve`, { method: 'POST' });
    return { created: createdJson, status: approved.status, json: await approved.json() };
  } finally {
    await close();
  }
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

  it('never links a guest application to an account by its typed email or phone', async () => {
    const dir = tmpDir();
    writeUsers(dir, [
      { id: 'usr-1', email: 'saad@gmail.com', phone: '0551112222', role: 'client', name: 'سعد' },
    ]);
    const byEmail = await applyAndApprove(dir, adminWithApplicant(), { ...payload, email: 'Saad@Gmail.com' });
    assert.equal(byEmail.status, 200);
    assert.equal(byEmail.json.application.status, 'approved');
    assert.equal(byEmail.json.account.status, 'not_linked');
    assert.equal(byEmail.json.accountLinked, false);
    assert.match(byEmail.json.message, /يلزم إنشاء حساب/);

    const byPhone = await applyAndApprove(dir, adminWithApplicant(), {
      ...payload,
      nationalId: '1077123456',
      phone: '+966 55 111 2222',
    });
    assert.equal(byPhone.json.account.status, 'not_linked');
    assert.equal(readUsers(dir)[0].role, 'client');
  });

  it('promotes the signed-in applicant account on approval', async () => {
    const dir = tmpDir();
    writeUsers(dir, [
      { id: 'usr-9', email: 'me@gmail.com', phone: '0559990000', role: 'client', name: 'أنا' },
      { id: 'usr-2', email: 'other@gmail.com', phone: '0553334444', role: 'client', name: 'آخر' },
    ]);
    const applicant = { id: 'usr-9', email: 'me@gmail.com', phone: '0559990000', role: 'client', name: 'أنا' };
    // A typed email naming someone else is ignored for a signed-in applicant too.
    const result = await applyAndApprove(dir, adminWithApplicant(applicant), { ...payload, email: 'other@gmail.com' });
    assert.equal(result.created.application.email, 'me@gmail.com');
    assert.equal(result.json.account.status, 'promoted');
    assert.equal(result.json.account.userId, 'usr-9');
    assert.equal(result.json.accountLinked, true);
    const users = readUsers(dir);
    assert.equal(users.find((row) => row.id === 'usr-9')?.role, 'courier');
    assert.equal(users.find((row) => row.id === 'usr-2')?.role, 'client');
  });

  for (const role of ['admin', 'accounts_manager', 'vendor']) {
    it(`never changes a ${role} account and reports it`, async () => {
      const dir = tmpDir();
      const staff = { id: 'usr-x', email: 'staff@gmail.com', phone: '0551112222', role, name: 'موظف' };
      writeUsers(dir, [staff]);
      const result = await applyAndApprove(dir, adminWithApplicant(staff), payload);
      assert.equal(result.status, 200);
      assert.equal(result.json.application.status, 'approved');
      assert.equal(result.json.account.status, 'protected_role');
      assert.equal(result.json.account.role, role);
      assert.equal(result.json.accountLinked, false);
      assert.match(result.json.message, /لم نغيّر دوره/);
      assert.equal(readUsers(dir)[0].role, role);
    });
  }

  it('keeps the approval and says an account is needed when the applicant account is gone', async () => {
    const dir = tmpDir();
    writeUsers(dir, []);
    const ghost = { id: 'usr-gone', email: 'gone@gmail.com', phone: '0551112222', role: 'client', name: 'س' };
    const result = await applyAndApprove(dir, adminWithApplicant(ghost), payload);
    assert.equal(result.status, 200);
    assert.equal(result.json.application.status, 'approved');
    assert.equal(result.json.account.status, 'not_found');
    assert.match(result.json.message, /يلزم إنشاء حساب/);
  });

  it('rejects an invalid applicant email or phone', async () => {
    resetCourierApplyLimiter();
    const app = express();
    app.use(express.json());
    registerCourierApplicationRoutes(app, adminWithApplicant() as any, tmpDir());
    const { url, close } = await listen(app);
    for (const extra of [{ email: 'not-an-email' }, { phone: '12345' }]) {
      const res = await fetch(`${url}/api/couriers/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, ...extra }),
      });
      assert.equal(res.status, 400);
    }
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
