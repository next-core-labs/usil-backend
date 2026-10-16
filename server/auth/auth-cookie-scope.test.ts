import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createAuth, expireLegacySessionCookie, hashPassword } from './auth.ts';

/**
 * usil.app, owner.usil.app and vendor.usil.app share one backend. The session
 * cookie must stay host-only, or one browser holds a single sign-in for all
 * three: the owner's account showed up inside the store, and the reverse.
 */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-cookie-scope-'));
}

function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

function buildApp(dir: string) {
  fs.writeFileSync(
    path.join(dir, 'users.json'),
    JSON.stringify([
      {
        id: 'usr-owner-7',
        name: 'المالك',
        email: 'owner@usil.sa',
        phone: '0590000001',
        role: 'admin',
        passwordHash: hashPassword('secret12'),
      },
      {
        id: 'usr-shopper-7',
        name: 'ريم الشمري',
        email: 'client@usil.sa',
        phone: '0590000002',
        role: 'client',
        passwordHash: hashPassword('secret12'),
      },
    ]),
    'utf-8',
  );
  const auth = createAuth(dir);
  const app = express();
  app.use(expireLegacySessionCookie);
  app.use(express.json());
  app.post('/api/auth/login', (req, res) => auth.loginHandler(req, res));
  app.post('/api/auth/logout', (req, res) => auth.logoutHandler(req, res));
  app.get('/api/auth/me', (req, res) => auth.meHandler(req, res));
  return app;
}

async function login(url: string, email: string, phone: string): Promise<string> {
  const res = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, phone, password: 'secret12' }),
  });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie().find((c) => c.startsWith('usil_sid=')) || '';
}

describe('session cookie scope', () => {
  const saved = { PUBLIC_SITE_URL: process.env.PUBLIC_SITE_URL, COOKIE_DOMAIN: process.env.COOKIE_DOMAIN };
  beforeEach(() => {
    // Production's site URL used to switch on a `.usil.app` Domain.
    process.env.PUBLIC_SITE_URL = 'https://usil.app';
    delete process.env.COOKIE_DOMAIN;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('signs in with a host-only cookie, so each subdomain keeps its own session', async () => {
    const { url, close } = await listen(buildApp(tmpDir()));
    try {
      const cookie = await login(url, 'owner@usil.sa', '0590000001');
      assert.match(cookie, /^usil_sid=[^;]+/);
      assert.doesNotMatch(cookie, /Domain=/i);
    } finally {
      await close();
    }
  });

  it('keeps two sign-ins apart: the owner session and a client session answer as themselves', async () => {
    const { url, close } = await listen(buildApp(tmpDir()));
    try {
      const owner = (await login(url, 'owner@usil.sa', '0590000001')).split(';')[0];
      const client = (await login(url, 'client@usil.sa', '0590000002')).split(';')[0];
      const me = async (cookie: string) =>
        ((await (await fetch(`${url}/api/auth/me`, { headers: { Cookie: cookie } })).json()) as { user?: { email?: string } })
          .user?.email;
      assert.equal(await me(owner), 'owner@usil.sa');
      assert.equal(await me(client), 'client@usil.sa');
    } finally {
      await close();
    }
  });

  it('never trusts the old shared midyaf_sid and expires it on .usil.app', async () => {
    const dir = tmpDir();
    const { url, close } = await listen(buildApp(dir));
    try {
      const token = (await login(url, 'owner@usil.sa', '0590000001')).split(';')[0].split('=')[1];
      const res = await fetch(`${url}/api/auth/me`, { headers: { Cookie: `midyaf_sid=${token}` } });
      const body = (await res.json()) as { user?: unknown };
      assert.equal(body.user ?? null, null);
      const cleared = res.headers.getSetCookie().filter((c) => c.startsWith('midyaf_sid=;'));
      assert.equal(cleared.length, 2);
      assert.ok(cleared.every((c) => /Max-Age=0/.test(c)));
      assert.ok(cleared.some((c) => /Domain=\.usil\.app/.test(c)));
    } finally {
      await close();
    }
  });

  it('still honours an explicit COOKIE_DOMAIN', async () => {
    process.env.COOKIE_DOMAIN = '.example.test';
    const { url, close } = await listen(buildApp(tmpDir()));
    try {
      assert.match(await login(url, 'owner@usil.sa', '0590000001'), /Domain=\.example\.test/);
    } finally {
      await close();
    }
  });
});
