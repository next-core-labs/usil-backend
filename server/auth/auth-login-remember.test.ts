import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createAuth, hashPassword } from './auth.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-remember-'));
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

function seedUser(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'users.json'),
    JSON.stringify([
      {
        id: 'usr-remember-1',
        name: 'عميل حفظ البيانات',
        email: 'remember@usil.sa',
        phone: '0597777888',
        role: 'client',
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
  app.post('/api/auth/register', (req, res) => auth.registerHandler(req, res));
  return app;
}

function cookieHeader(res: Response): string {
  return res.headers.get('set-cookie') || '';
}

describe('login remember cookie', () => {
  it('sets midyaf_sid Max-Age to 30 days when remember is true', async () => {
    const dir = tmpDir();
    seedUser(dir);
    const { url, close } = await listen(appWithAuth(dir));
    const res = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'remember@usil.sa',
        phone: '0597777888',
        password: 'secret12',
        remember: true,
      }),
    });
    const cookie = cookieHeader(res);
    assert.equal(res.status, 200);
    assert.match(cookie, /midyaf_sid=/);
    assert.match(cookie, /Max-Age=2592000/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    await close();
  });

  it('sets a 1-day Max-Age when remember is unchecked or omitted', async () => {
    const dir = tmpDir();
    seedUser(dir);
    const { url, close } = await listen(appWithAuth(dir));
    const unchecked = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'remember@usil.sa',
        phone: '0597777888',
        password: 'secret12',
        remember: false,
      }),
    });
    const omitted = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'remember@usil.sa',
        phone: '0597777888',
        password: 'secret12',
      }),
    });
    const uncheckedCookie = cookieHeader(unchecked);
    const omittedCookie = cookieHeader(omitted);
    assert.equal(unchecked.status, 200);
    assert.equal(omitted.status, 200);
    assert.match(uncheckedCookie, /Max-Age=86400/);
    assert.match(omittedCookie, /Max-Age=86400/);
    assert.match(uncheckedCookie, /HttpOnly/i);
    assert.match(uncheckedCookie, /SameSite=Lax/i);
    assert.equal(/Max-Age=2592000/.test(uncheckedCookie), false);
    await close();
  });

  it('keeps register on the previous 7-day cookie', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(appWithAuth(dir));
    const res = await fetch(`${url}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'عميل جديد',
        email: 'new.remember@usil.sa',
        phone: '0598888999',
        password: 'secret12',
      }),
    });
    const cookie = cookieHeader(res);
    assert.equal(res.status, 201);
    assert.match(cookie, /Max-Age=604800/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    await close();
  });

});
