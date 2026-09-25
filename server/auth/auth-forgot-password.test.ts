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
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

function appWithAuth(dir: string) {
  const auth = createAuth(dir);
  const app = express();
  app.use(express.json());
  app.post('/api/auth/login', (req, res) => auth.loginHandler(req, res));
  app.post('/api/auth/forgot-password', (req, res) => auth.forgotPasswordHandler(req, res));
  app.post('/api/auth/reset-password', (req, res) => auth.resetPasswordHandler(req, res));
  app.get('/api/auth/me', (req, res) => auth.meHandler(req, res));
  return app;
}

type Seed = { id: string; name: string; email: string; phone: string; role: string; password: string };

function seedUser(dir: string, user: Seed) {
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

function storedUser(dir: string) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf-8'))[0];
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { res, json: (await res.json()) as Record<string, unknown> };
}

/** Local runs have no SMTP, so step 1 hands the code back (never in production). */
async function requestCode(url: string, email: string): Promise<string> {
  const { res, json } = await post(`${url}/api/auth/forgot-password`, { email });
  assert.equal(res.status, 200);
  assert.match(String(json.resetCode), /^\d{6}$/);
  return String(json.resetCode);
}

const CLIENT: Seed = {
  id: 'usr-client-1',
  name: 'عميل التجربة',
  email: 'reset.user@usil.sa',
  phone: '0591111222',
  role: 'client',
  password: 'old-secret',
};

describe('forgot password — two-step code flow', () => {
  it('no longer resets with just email + phone (the old proof-less flow)', async () => {
    const dir = tmpDir();
    seedUser(dir, CLIENT);
    const before = storedUser(dir).passwordHash;
    const { url, close } = await listen(appWithAuth(dir));
    const { res } = await post(`${url}/api/auth/forgot-password`, {
      email: CLIENT.email,
      phone: CLIENT.phone,
      newPassword: 'attacker-pass9',
    });
    assert.equal(res.status, 200);
    assert.equal(storedUser(dir).passwordHash, before);
    const login = await post(`${url}/api/auth/login`, {
      email: CLIENT.email,
      phone: CLIENT.phone,
      password: 'attacker-pass9',
    });
    assert.equal(login.res.status, 401);
    await close();
  });

  it('answers identically for registered and unknown emails and stores only a hash', async () => {
    const dir = tmpDir();
    seedUser(dir, CLIENT);
    const { url, close } = await listen(appWithAuth(dir));
    const known = await post(`${url}/api/auth/forgot-password`, { email: 'Reset.User@usil.sa' });
    const unknown = await post(`${url}/api/auth/forgot-password`, { email: 'nobody@usil.sa' });
    assert.equal(known.res.status, 200);
    assert.equal(unknown.res.status, 200);
    assert.equal(known.json.success, true);
    assert.equal(unknown.json.success, true);
    assert.equal(unknown.json.resetCode, undefined);
    const stored = storedUser(dir);
    assert.ok(stored.passwordResetCodeHash);
    assert.equal(JSON.stringify(stored).includes(String(known.json.resetCode)), false);
    assert.ok(stored.passwordResetExpiresAt - Date.now() <= 15 * 60 * 1000);
    assert.equal(stored.passwordResetAttempts, 0);
    await close();
  });

  it('never returns the code in production', async () => {
    const dir = tmpDir();
    seedUser(dir, CLIENT);
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { url, close } = await listen(appWithAuth(dir));
      const { res, json } = await post(`${url}/api/auth/forgot-password`, { email: CLIENT.email });
      assert.equal(res.status, 200);
      assert.equal(json.resetCode, undefined);
      assert.ok(storedUser(dir).passwordResetCodeHash);
      await close();
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  it('resets with the right code, clears it, kills sessions and logs in with the new secret', async () => {
    const dir = tmpDir();
    seedUser(dir, CLIENT);
    const { url, close } = await listen(appWithAuth(dir));
    const login = await post(`${url}/api/auth/login`, {
      email: CLIENT.email,
      phone: CLIENT.phone,
      password: 'old-secret',
    });
    const cookie = login.res.headers.get('set-cookie') || '';
    assert.match(cookie, /midyaf_sid=/);

    const code = await requestCode(url, CLIENT.email);
    const reset = await post(`${url}/api/auth/reset-password`, {
      email: 'Reset.User@usil.sa',
      code,
      newPassword: 'new-secret9',
    });
    assert.equal(reset.res.status, 200);
    assert.equal(reset.json.message, 'تم تغيير الرقم السري. ادخل الآن.');
    assert.equal(JSON.stringify(reset.json).includes('new-secret9'), false);
    assert.equal(storedUser(dir).passwordResetCodeHash, undefined);

    const me = await fetch(`${url}/api/auth/me`, { headers: { cookie } });
    assert.equal(((await me.json()) as { user: unknown }).user, null);

    const oldLogin = await post(`${url}/api/auth/login`, { email: CLIENT.email, phone: CLIENT.phone, password: 'old-secret' });
    assert.equal(oldLogin.res.status, 401);
    const newLogin = await post(`${url}/api/auth/login`, { email: CLIENT.email, phone: CLIENT.phone, password: 'new-secret9' });
    assert.equal(newLogin.res.status, 200);

    const reuse = await post(`${url}/api/auth/reset-password`, { email: CLIENT.email, code, newPassword: 'again-secret9' });
    assert.equal(reuse.res.status, 400);
    await close();
  });

  it('rejects a wrong code and burns the code after 5 wrong attempts', async () => {
    const dir = tmpDir();
    seedUser(dir, CLIENT);
    const before = storedUser(dir).passwordHash;
    const { url, close } = await listen(appWithAuth(dir));
    const code = await requestCode(url, CLIENT.email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const { res, json } = await post(`${url}/api/auth/reset-password`, {
        email: CLIENT.email,
        code: wrong,
        newPassword: 'new-secret9',
      });
      assert.equal(res.status, 400);
      assert.match(String(json.error), /رمز الاستعادة غير صحيح/);
    }
    const late = await post(`${url}/api/auth/reset-password`, { email: CLIENT.email, code, newPassword: 'new-secret9' });
    assert.equal(late.res.status, 400);
    assert.equal(storedUser(dir).passwordHash, before);
    await close();
  });

  it('rejects an expired code', async () => {
    const dir = tmpDir();
    seedUser(dir, CLIENT);
    const { url, close } = await listen(appWithAuth(dir));
    const code = await requestCode(url, CLIENT.email);
    const users = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf-8'));
    users[0].passwordResetExpiresAt = Date.now() - 1000;
    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(users));
    const { res } = await post(`${url}/api/auth/reset-password`, { email: CLIENT.email, code, newPassword: 'new-secret9' });
    assert.equal(res.status, 400);
    assert.equal(storedUser(dir).passwordResetCodeHash, undefined);
    await close();
  });

  it('rejects a weak secret without spending an attempt or rewriting the hash', async () => {
    const dir = tmpDir();
    seedUser(dir, CLIENT);
    const before = storedUser(dir).passwordHash;
    const { url, close } = await listen(appWithAuth(dir));
    const code = await requestCode(url, CLIENT.email);
    const { res, json } = await post(`${url}/api/auth/reset-password`, { email: CLIENT.email, code, newPassword: 'short' });
    assert.equal(res.status, 400);
    assert.match(String(json.error), /الرقم السري ضعيف/);
    assert.equal(storedUser(dir).passwordHash, before);
    assert.equal(storedUser(dir).passwordResetAttempts, 0);
    await close();
  });

  it('lets the founder admin reset through the same flow', async () => {
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
    const code = await requestCode(url, FOUNDER_ADMIN_EMAIL);
    const reset = await post(`${url}/api/auth/reset-password`, { email: FOUNDER_ADMIN_EMAIL, code, newPassword: 'founder-new9' });
    assert.equal(reset.res.status, 200);
    const login = await post(`${url}/api/auth/login`, {
      email: FOUNDER_ADMIN_EMAIL,
      phone: '0504444444',
      password: 'founder-new9',
    });
    assert.equal(login.res.status, 200);
    assert.equal((login.json.user as { role?: string }).role, 'admin');
    await close();
  });

  it('rate-limits code requests per IP', async () => {
    const dir = tmpDir();
    seedUser(dir, CLIENT);
    const { url, close } = await listen(appWithAuth(dir));
    for (let i = 0; i < 5; i++) {
      const { res } = await post(`${url}/api/auth/forgot-password`, { email: `nobody${i}@usil.sa` });
      assert.equal(res.status, 200);
    }
    const blocked = await post(`${url}/api/auth/forgot-password`, { email: 'nobody-else@usil.sa' });
    assert.equal(blocked.res.status, 429);
    assert.match(String(blocked.json.error), /حدّ المحاولات/);
    // A spoofed X-Forwarded-For no longer buys a fresh budget.
    const spoofed = await post(`${url}/api/auth/forgot-password`, { email: 'x@usil.sa' }, { 'X-Forwarded-For': '203.0.113.10' });
    assert.equal(spoofed.res.status, 429);
    await close();
  });

  it('rate-limits reset attempts per IP', async () => {
    const dir = tmpDir();
    seedUser(dir, CLIENT);
    const { url, close } = await listen(appWithAuth(dir));
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const { res } = await post(`${url}/api/auth/reset-password`, { email: 'nobody@usil.sa', code: '123456', newPassword: 'new-secret9' });
      if (res.status === 429) limited = true;
    }
    assert.equal(limited, true);
    await close();
  });
});
