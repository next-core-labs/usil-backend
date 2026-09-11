import { describe, it } from 'node:test';
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createAuth, hashPassword } from './auth.ts';
import { FOUNDER_ADMIN_EMAIL } from './dummy-accounts.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-forgot-'));
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

function appWithAuth(dir: string) {
  const auth = createAuth(dir);
  const app = express();
  app.use(express.json());
  app.post('/api/auth/register', (req, res) => auth.registerHandler(req, res));
  app.post('/api/auth/login', (req, res) => auth.loginHandler(req, res));
  app.post('/api/auth/forgot-password', (req, res) => auth.forgotPasswordHandler(req, res));
  app.get('/api/auth/me', (req, res) => auth.meHandler(req, res));
  return app;
}

function seedUser(dir: string, user: { id: string; name: string; email: string; phone: string; role: string; password: string }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'users.json'),
    JSON.stringify([
      {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        passwordHash: hashPassword(user.password),
        avatarUrl: '',
      },
    ]),
    'utf-8',
  );
}

async function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

describe('forgot password', () => {
  it('resets when email and phone match, then login works with the new secret', async () => {
    const dir = tmpDir();
    seedUser(dir, {
      id: 'usr-client-1',
      name: 'عميل التجربة',
      email: 'reset.user@usil.sa',
      phone: '0591111222',
      role: 'client',
      password: 'old-secret',
    });
    const { url, close } = await listen(appWithAuth(dir));
    const reset = await fetch(`${url}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'Reset.User@usil.sa',
        phone: '+966591111222',
        newPassword: 'new-secret9',
      }),
    });
    const resetJson = await json(reset);
    assert.equal(reset.status, 200);
    assert.equal(resetJson.success, true);
    assert.equal(resetJson.message, 'تم تغيير الرقم السري. ادخل الآن.');
    assert.equal(resetJson.password, undefined);
    assert.equal(resetJson.newPassword, undefined);
    assert.equal(resetJson.passwordHash, undefined);
    const dumped = JSON.stringify(resetJson);
    assert.equal(dumped.includes('new-secret9'), false);
    assert.equal(dumped.includes('old-secret'), false);

    const oldLogin = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'reset.user@usil.sa',
        phone: '0591111222',
        password: 'old-secret',
      }),
    });
    assert.equal(oldLogin.status, 401);

    const nextLogin = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'reset.user@usil.sa',
        phone: '0591111222',
        password: 'new-secret9',
      }),
    });
    const nextJson = await json(nextLogin);
    assert.equal(nextLogin.status, 200);
    assert.equal(nextJson.success, true);
    await close();
  });

  it('keeps a generic Arabic error when email and phone do not match one user', async () => {
    const dir = tmpDir();
    seedUser(dir, {
      id: 'usr-client-2',
      name: 'عميل آخر',
      email: 'known@usil.sa',
      phone: '0592222333',
      role: 'client',
      password: 'secret12',
    });
    const { url, close } = await listen(appWithAuth(dir));

    const missing = await fetch(`${url}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'nobody@usil.sa',
        phone: '0592222333',
        newPassword: 'new-secret9',
      }),
    });
    const missingJson = await json(missing);
    assert.equal(missing.status, 400);
    assert.match(String(missingJson.error), /حساب غير موجود|الجوال لا يطابق البريد/);

    const mismatch = await fetch(`${url}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'known@usil.sa',
        phone: '0590000111',
        newPassword: 'new-secret9',
      }),
    });
    const mismatchJson = await json(mismatch);
    assert.equal(mismatch.status, 400);
    assert.equal(mismatchJson.error, missingJson.error);
    assert.match(String(mismatchJson.error), /حساب غير موجود|الجوال لا يطابق البريد/);
    await close();
  });

  it('rejects a weak secret and does not rewrite the stored hash', async () => {
    const dir = tmpDir();
    seedUser(dir, {
      id: 'usr-client-3',
      name: 'عميل',
      email: 'weak@usil.sa',
      phone: '0593333444',
      role: 'client',
      password: 'strong-enough',
    });
    const beforeHash = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf-8'))[0].passwordHash;
    const { url, close } = await listen(appWithAuth(dir));
    const res = await fetch(`${url}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'weak@usil.sa',
        phone: '0593333444',
        newPassword: 'short',
      }),
    });
    const body = await json(res);
    assert.equal(res.status, 400);
    assert.match(String(body.error), /الرقم السري ضعيف/);
    const afterHash = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf-8'))[0].passwordHash;
    assert.equal(afterHash, beforeHash);
    await close();
  });

  it('invalidates existing sessions after a reset', async () => {
    const dir = tmpDir();
    seedUser(dir, {
      id: 'usr-client-4',
      name: 'عميل جلسة',
      email: 'session@usil.sa',
      phone: '0594444555',
      role: 'client',
      password: 'before-reset',
    });
    const { url, close } = await listen(appWithAuth(dir));
    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'session@usil.sa',
        phone: '0594444555',
        password: 'before-reset',
      }),
    });
    const cookie = login.headers.get('set-cookie') || '';
    assert.match(cookie, /midyaf_sid=/);
    const meBefore = await fetch(`${url}/api/auth/me`, { headers: { cookie } });
    const meBeforeJson = await json(meBefore);
    assert.equal((meBeforeJson.user as { email?: string } | null)?.email, 'session@usil.sa');

    const reset = await fetch(`${url}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'session@usil.sa',
        phone: '0594444555',
        newPassword: 'after-reset9',
      }),
    });
    assert.equal(reset.status, 200);
    const meAfter = await fetch(`${url}/api/auth/me`, { headers: { cookie } });
    const meAfterJson = await json(meAfter);
    assert.equal(meAfterJson.user, null);
    await close();
  });

  it('lets the founder admin reset through the same form without returning secrets', async () => {
    const dir = tmpDir();
    seedUser(dir, {
      id: 'usr-nawaf-admin',
      name: 'مدير كل الحسابات — يوصل',
      email: FOUNDER_ADMIN_EMAIL,
      phone: '0504444444',
      role: 'admin',
      password: 'founder-old',
    });
    const { url, close } = await listen(appWithAuth(dir));
    const reset = await fetch(`${url}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: FOUNDER_ADMIN_EMAIL,
        phone: '0504444444',
        newPassword: 'founder-new9',
      }),
    });
    const resetJson = await json(reset);
    assert.equal(reset.status, 200);
    assert.equal(resetJson.success, true);
    assert.equal(JSON.stringify(resetJson).includes('founder-new9'), false);
    assert.equal(JSON.stringify(resetJson).includes('founder-old'), false);

    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: FOUNDER_ADMIN_EMAIL,
        phone: '0504444444',
        password: 'founder-new9',
      }),
    });
    const loginJson = await json(login);
    assert.equal(login.status, 200);
    assert.equal((loginJson.user as { role?: string }).role, 'admin');
    await close();
  });

  it('rate-limits an IP to 5 attempts per 15 minutes', async () => {
    const dir = tmpDir();
    seedUser(dir, {
      id: 'usr-client-5',
      name: 'عميل حد',
      email: 'limit@usil.sa',
      phone: '0595555666',
      role: 'client',
      password: 'secret12',
    });
    const { url, close } = await listen(appWithAuth(dir));
    const payload = {
      email: 'nobody@usil.sa',
      phone: '0595555666',
      newPassword: 'new-secret9',
    };
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${url}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 400);
    }
    const blocked = await fetch(`${url}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
      body: JSON.stringify(payload),
    });
    const blockedJson = await json(blocked);
    assert.equal(blocked.status, 429);
    assert.match(String(blockedJson.error), /حدّ المحاولات/);

    const otherIp = await fetch(`${url}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.10' },
      body: JSON.stringify(payload),
    });
    assert.equal(otherIp.status, 400);
    await close();
  });

  it('still resets when SMTP env is set but mail cannot send', async () => {
    const dir = tmpDir();
    seedUser(dir, {
      id: 'usr-client-6',
      name: 'عميل بريد',
      email: 'mail@usil.sa',
      phone: '0596666777',
      role: 'client',
      password: 'before-mail',
    });
    const prevHost = process.env.SMTP_HOST;
    process.env.SMTP_HOST = 'smtp.invalid.example';
    process.env.SMTP_PORT = '2525';
    try {
      const { url, close } = await listen(appWithAuth(dir));
      const reset = await fetch(`${url}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'mail@usil.sa',
          phone: '0596666777',
          newPassword: 'after-mail9',
        }),
      });
      const resetJson = await json(reset);
      assert.equal(reset.status, 200);
      assert.equal(resetJson.success, true);
      await close();
    } finally {
      if (prevHost === undefined) delete process.env.SMTP_HOST;
      else process.env.SMTP_HOST = prevHost;
      delete process.env.SMTP_PORT;
    }
  });
});
