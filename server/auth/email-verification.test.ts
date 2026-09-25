import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createAuth, hashPassword } from './auth.ts';
import {
  bookingBlockedReason,
  generateSixDigitCode,
  hashVerifyValue,
  isSixDigitCode,
  needsEmailVerification,
  verifyValueMatches,
} from './email-verification.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-email-'));
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

function mount(dir: string) {
  const auth = createAuth(dir);
  const app = express();
  app.use(express.json());
  app.post('/api/auth/register', (req, res) => auth.registerHandler(req, res));
  app.post('/api/auth/login', (req, res) => auth.loginHandler(req, res));
  app.post('/api/auth/verify-email', (req, res) => auth.verifyEmailHandler(req, res));
  app.get('/api/auth/verify-email', (req, res) => auth.verifyEmailTokenHandler(req, res));
  app.post('/api/auth/resend-verification', (req, res) => auth.resendVerificationHandler(req, res));
  app.get('/api/auth/me', (req, res) => auth.meHandler(req, res));
  app.get('/api/admin/users', (req, res) => auth.listUsersHandler(req, res));
  app.patch('/api/admin/users/:id', (req, res) => auth.updateUserHandler(req, res));
  app.post('/api/bookings', (req, res) => {
    const user = auth.userFromRequest(req);
    const blocked = bookingBlockedReason(user);
    if (blocked) return res.status(403).json({ success: false, error: blocked });
    res.status(201).json({ success: true });
  });
  return { app, auth };
}

describe('email verification helpers', () => {
  it('hashes codes without keeping plaintext and binds them to email', () => {
    const code = generateSixDigitCode();
    assert.equal(isSixDigitCode(code), true);
    const hash = hashVerifyValue(code, 'a@usil.app');
    assert.equal(hash.includes(code), false);
    assert.equal(verifyValueMatches(code, hash, 'a@usil.app'), true);
    assert.equal(verifyValueMatches(code, hash, 'b@usil.app'), false);
  });

  it('does not lock admin or grandfathered accounts', () => {
    assert.equal(needsEmailVerification({ role: 'admin', emailVerified: false }), false);
    assert.equal(needsEmailVerification({ role: 'client' }), false);
    assert.equal(needsEmailVerification({ role: 'client', emailVerified: false }), true);
    assert.equal(bookingBlockedReason({ role: 'vendor', emailVerified: false }), null);
    assert.equal(bookingBlockedReason({ role: 'client', emailVerified: false }), null);
  });
});

describe('email verification API', () => {
  it('registers unverified, returns a one-time code without SMTP, and verifies it', async () => {
    const dir = tmpDir();
    const { app } = mount(dir);
    const { url, close } = await listen(app);
    const email = 'verify.launch@usil.sa';
    const phone = '0593333444';
    const res = await fetch(`${url}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'عميل تأكيد', email, phone, password: 'secret12' }),
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.user.emailVerified, false);
    assert.equal(json.emailSent, false);
    assert.equal(isSixDigitCode(json.verificationCode), true);
    const cookie = res.headers.get('set-cookie') || '';

    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf-8'));
    assert.equal(stored[0].emailVerified, false);
    assert.ok(stored[0].emailVerifyCodeHash);
    assert.equal(JSON.stringify(stored).includes(json.verificationCode), false);

    const me = await fetch(`${url}/api/auth/me`, { headers: { cookie } });
    const meJson = await me.json();
    assert.equal(meJson.user.emailVerified, false);
    assert.equal(meJson.user.emailVerifyCodeHash, undefined);
    assert.equal(meJson.verificationCode, undefined);

    const bookedUnverified = await fetch(`${url}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'x', phone }),
    });
    assert.equal(bookedUnverified.status, 201);

    const empty = await fetch(`${url}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, phone, code: '' }),
    });
    const emptyJson = await empty.json();
    assert.equal(emptyJson.success, false);
    assert.match(emptyJson.error, /رمز التأكيد/);

    const bad = await fetch(`${url}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, phone, code: '000000' }),
    });
    assert.equal((await bad.json()).success, false);

    const ok = await fetch(`${url}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ email, phone, code: json.verificationCode }),
    });
    const okJson = await ok.json();
    assert.equal(okJson.success, true);
    assert.equal(okJson.user.emailVerified, true);
    assert.match(okJson.message, /تم تأكيد/);

    const me2 = await fetch(`${url}/api/auth/me`, { headers: { cookie } });
    assert.equal((await me2.json()).user.emailVerified, true);
    const booked = await fetch(`${url}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'x', phone }),
    });
    assert.equal(booked.status, 201);
    await close();
  });

  it('lets unverified users log in and rate-limits resend', async () => {
    const dir = tmpDir();
    const { app } = mount(dir);
    const { url, close } = await listen(app);
    const email = 'login.verify@usil.sa';
    const phone = '0595555666';
    const created = await fetch(`${url}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'دخول غير مؤكد', email, phone, password: 'secret12' }),
    });
    const createdJson = await created.json();
    assert.equal(createdJson.user.emailVerified, false);

    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, phone, password: 'secret12' }),
    });
    const loginJson = await login.json();
    assert.equal(loginJson.success, true);
    assert.equal(loginJson.needsEmailVerification, true);
    assert.equal(loginJson.verificationCode, undefined);

    const codes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const resend = await fetch(`${url}/api/auth/resend-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, phone }),
      });
      const body = await resend.json();
      assert.equal(resend.status, 200);
      assert.equal(body.emailSent, false);
      codes.push(body.verificationCode);
    }
    const fourth = await fetch(`${url}/api/auth/resend-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, phone }),
    });
    assert.equal(fourth.status, 429);
    const lastCode = codes[codes.length - 1];
    const verify = await fetch(`${url}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, phone, code: lastCode }),
    });
    assert.equal((await verify.json()).success, true);
    await close();
  });

  it('accepts a long token link and lets admin mark verified without exposing hashes', async () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, 'users.json'),
      JSON.stringify([
        {
          id: 'usr-admin',
          name: 'مدير',
          email: 'nawafalmuhayya@gmail.com',
          phone: '0504444444',
          role: 'admin',
          passwordHash: hashPassword('admin-secret'),
          emailVerified: true,
        },
        {
          id: 'usr-old',
          name: 'حساب قديم',
          email: 'legacy.client@usil.sa',
          phone: '0597777888',
          role: 'client',
          passwordHash: hashPassword('legacy12'),
        },
      ]),
    );
    const { app } = mount(dir);
    const { url, close } = await listen(app);

    const legacy = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'legacy.client@usil.sa', phone: '0597777888', password: 'legacy12' }),
    });
    const legacyJson = await legacy.json();
    assert.equal(legacyJson.user.emailVerified, true);
    assert.equal(legacyJson.needsEmailVerification, false);

    const created = await fetch(`${url}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'رابط تأكيد',
        email: 'token.verify@usil.sa',
        phone: '0598888999',
        password: 'secret12',
      }),
    });
    const createdJson = await created.json();
    const users = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf-8'));
    const row = users.find((item: { email: string }) => item.email === 'token.verify@usil.sa');
    assert.ok(row.emailVerifyTokenHash);
    assert.equal(JSON.stringify(users).includes(createdJson.verificationCode), false);

    const adminLogin = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'nawafalmuhayya@gmail.com',
        phone: '0504444444',
        password: 'admin-secret',
      }),
    });
    const adminCookie = adminLogin.headers.get('set-cookie') || '';
    const list = await fetch(`${url}/api/admin/users`, { headers: { cookie: adminCookie } });
    const listJson = await list.json();
    const listed = listJson.data.find((item: { email: string }) => item.email === 'token.verify@usil.sa');
    assert.equal(listed.emailVerified, false);
    assert.equal(listed.emailVerifyCodeHash, undefined);
    assert.equal(listed.verificationCode, undefined);

    const mark = await fetch(`${url}/api/admin/users/${listed.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ emailVerified: true }),
    });
    assert.equal((await mark.json()).user.emailVerified, true);
    await close();
  });

  it('never mints an admin from public sign-up with the founder email', async () => {
    const dir = tmpDir();
    const { app } = mount(dir);
    const { url, close } = await listen(app);
    const res = await fetch(`${url}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'نواف المهيع',
        email: 'NawafAlmuhayya@gmail.com',
        phone: '0504111222',
        password: 'secret12',
      }),
    });
    const json = await res.json();
    assert.equal(res.status, 409);
    assert.equal(json.success, false);
    assert.equal(res.headers.get('set-cookie'), null);
    const users = JSON.parse(fs.existsSync(path.join(dir, 'users.json')) ? fs.readFileSync(path.join(dir, 'users.json'), 'utf-8') : '[]');
    assert.equal(users.some((user: { role?: string }) => user.role === 'admin'), false);
    await close();
  });
});
