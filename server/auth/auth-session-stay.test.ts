import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createAuth, hashPassword } from './auth.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-stay-'));
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

function seedAdmin(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'users.json'),
    JSON.stringify([
      {
        id: 'usr-nawaf-admin',
        name: 'مدير كل الحسابات — يوصل',
        email: 'nawafalmuhayya@gmail.com',
        phone: '0504444444',
        role: 'admin',
        passwordHash: hashPassword('secret12'),
        avatarUrl: '',
      },
    ]),
    'utf-8',
  );
}

function appWithAuth(dir: string) {
  const auth = createAuth(dir);
  const app = express();
  app.use(express.json());
  app.post('/api/auth/login', (req, res) => auth.loginHandler(req, res));
  app.get('/api/auth/me', (req, res) => auth.meHandler(req, res));
  app.get('/api/admin/users', (req, res) => auth.listUsersHandler(req, res));
  return app;
}

function sid(res: Response): string {
  const cookie = res.headers.get('set-cookie') || '';
  const match = cookie.match(/midyaf_sid=([^;]+)/);
  return match ? match[1] : '';
}

describe('session stays after login', () => {
  it('keeps /api/auth/me logged in across repeated admin reads', async () => {
    const dir = tmpDir();
    seedAdmin(dir);
    const { url, close } = await listen(appWithAuth(dir));
    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'nawafalmuhayya@gmail.com',
        phone: '0504444444',
        password: 'secret12',
        remember: true,
      }),
    });
    const token = sid(login);
    assert.equal(login.status, 200);
    assert.ok(token);
    const cookie = `midyaf_sid=${token}`;
    const rounds = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetch(`${url}/api/admin/users`, { headers: { Cookie: cookie } }).then((r) => r.json()),
      ),
    );
    for (const row of rounds) {
      assert.equal(row.success, true);
    }
    const me = await fetch(`${url}/api/auth/me`, { headers: { Cookie: cookie } });
    const body = await me.json();
    assert.equal(body.user?.email, 'nawafalmuhayya@gmail.com');
    assert.equal(body.user?.role, 'admin');
    await close();
  });

  it('sets Domain=.usil.app when PUBLIC_SITE_URL is the live host', async () => {
    const prev = process.env.PUBLIC_SITE_URL;
    process.env.PUBLIC_SITE_URL = 'https://usil.app';
    const dir = tmpDir();
    seedAdmin(dir);
    const { url, close } = await listen(appWithAuth(dir));
    try {
      const login = await fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'nawafalmuhayya@gmail.com',
          phone: '0504444444',
          password: 'secret12',
          remember: true,
        }),
      });
      const cookie = login.headers.get('set-cookie') || '';
      assert.match(cookie, /Domain=\.usil\.app/);
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_SITE_URL;
      else process.env.PUBLIC_SITE_URL = prev;
      await close();
    }
  });


  it('drops session tokens whose user is gone and diagnostic tokens', async () => {
    const dir = tmpDir();
    seedAdmin(dir);
    fs.writeFileSync(
      path.join(dir, 'sessions.json'),
      JSON.stringify({
        deadtoken0123456789abcdef: 'usr-missing',
        diag0123456789abcdef012345: 'usr-nawaf-admin',
        short: 'usr-nawaf-admin',
      }),
      'utf-8',
    );
    const { url, close } = await listen(appWithAuth(dir));
    const me = await fetch(`${url}/api/auth/me`, {
      headers: { Cookie: 'midyaf_sid=diag0123456789abcdef012345' },
    });
    const body = await me.json();
    assert.equal(body.user, null);
    const sessions = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf-8'));
    assert.equal(Object.keys(sessions).length, 0);
    await close();
  });
});
