import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createAuth, hashPassword } from './auth.ts';
import { registerAuthRoutes } from './auth-routes.ts';
import { clientOwnsBooking } from '../bookings/booking-store.ts';

const PASSWORD = 'secret123';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-authfix-'));
}

function seed(dir: string, users: Array<{ id: string; email: string; phone: string; role: string }>) {
  fs.writeFileSync(
    path.join(dir, 'users.json'),
    JSON.stringify(
      users.map((user) => ({ name: user.id, avatarUrl: '', emailVerified: true, passwordHash: hashPassword(PASSWORD), ...user })),
    ),
  );
}

async function mount(dir: string) {
  const auth = createAuth(dir);
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app, auth, dir);
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const post = async (route: string, body: unknown, cookie = '') => {
    const res = await fetch(`${url}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
    // Login may also clear an older cookie; keep the one that carries a session.
    const session = res.headers.getSetCookie().map((line) => line.split(';')[0]).filter((pair) => !pair.endsWith('=')).pop() || '';
    return { status: res.status, json: (await res.json()) as Record<string, any>, cookie: session };
  };
  const close = () =>
    new Promise<void>((done) => {
      server.closeAllConnections?.();
      server.close(() => done());
    });
  return { auth, url, post, close };
}

describe('vendor applicants never get a verified email for free', () => {
  it('creates applicant and newly approved vendor accounts unverified', () => {
    const dir = tmpDir();
    const auth = createAuth(dir);
    const applicant = auth.ensureApplicantUser(
      { name: 'متقدم', email: 'guest-buyer@nclabs.dev', phone: '0551110000', passwordHash: hashPassword(PASSWORD) },
      null,
    );
    assert.equal(applicant.emailVerified, false);
    // The guest-order rule now refuses this account until the mailbox proves itself.
    const guestOrder = { email: 'guest-buyer@nclabs.dev', userId: undefined } as never;
    assert.equal(clientOwnsBooking(applicant, guestOrder), false);

    const vendor = auth.addVendorUser({
      name: 'مورّد',
      email: 'fresh-vendor@nclabs.dev',
      phone: '0551110001',
      passwordHash: hashPassword(PASSWORD),
    });
    assert.equal(vendor.emailVerified, false);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf-8')) as Array<Record<string, unknown>>;
    assert.ok(stored.every((row) => row.emailVerifyCodeHash), 'both accounts can verify by code');
  });
});

describe('sign-up and login input', () => {
  it('refuses a malformed email or phone at sign-up', async () => {
    const { post, close } = await mount(tmpDir());
    try {
      for (const body of [
        { email: 'a@b', phone: '0551234567' },
        { email: 'ok@nclabs.dev', phone: '12' },
      ]) {
        const res = await post('/api/auth/register', { name: 'x', password: PASSWORD, ...body });
        assert.equal(res.status, 400, JSON.stringify(body));
      }
    } finally {
      await close();
    }
  });

  it('logs in with just email and password, and counts only failed attempts', async () => {
    const dir = tmpDir();
    seed(dir, [{ id: 'usr-c', email: 'often@nclabs.dev', phone: '0551234500', role: 'client' }]);
    const { post, close } = await mount(dir);
    try {
      const plain = await post('/api/auth/login', { email: 'often@nclabs.dev', password: PASSWORD });
      assert.equal(plain.status, 200, JSON.stringify(plain.json));
      // Far past the 10-attempt window: successes never lock the owner out.
      for (let i = 0; i < 12; i += 1) {
        assert.equal((await post('/api/auth/login', { email: 'often@nclabs.dev', password: PASSWORD })).status, 200, `login ${i}`);
      }
      const wrong = await post('/api/auth/login', { email: 'often@nclabs.dev', password: 'nope-nope' });
      assert.equal(wrong.status, 401);
      assert.doesNotMatch(String(wrong.json.error), /الجوال/);
    } finally {
      await close();
    }
  });
});

describe('deleting an account', () => {
  it('tells listeners, so its workspace and chats go with it', async () => {
    const dir = tmpDir();
    seed(dir, [
      { id: 'usr-boss', email: 'boss@nclabs.dev', phone: '0551234501', role: 'admin' },
      { id: 'usr-shop', email: 'shop@nclabs.dev', phone: '0551234502', role: 'client' },
    ]);
    const { auth, url, post, close } = await mount(dir);
    const deleted: string[] = [];
    auth.onUserDeleted((user) => deleted.push(user.id));
    auth.onUserDeleted(() => {
      throw new Error('a failing listener must not fail the delete');
    });
    try {
      const login = await post('/api/auth/login', { email: 'boss@nclabs.dev', password: PASSWORD });
      assert.equal(login.status, 200, JSON.stringify(login.json));
      assert.ok(login.cookie, 'session cookie');
      const res = await fetch(`${url}/api/admin/users/usr-shop`, { method: 'DELETE', headers: { cookie: login.cookie } });
      assert.equal(res.status, 200);
      assert.deepEqual(deleted, ['usr-shop']);
    } finally {
      await close();
    }
  });
});
