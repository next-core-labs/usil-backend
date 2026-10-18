import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createAuth } from './auth.ts';

/** A customer may sign up with name, email and password alone; the mobile is optional. */

function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

function buildApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-optional-phone-'));
  const auth = createAuth(dir);
  const app = express();
  app.use(express.json());
  app.post('/api/auth/register', (req, res) => auth.registerHandler(req, res));
  app.post('/api/auth/login', (req, res) => auth.loginHandler(req, res));
  app.post('/api/auth/resend-verification', (req, res) => auth.resendVerificationHandler(req, res));
  app.patch('/api/auth/me', (req, res) => auth.updateProfileHandler(req, res));
  return app;
}

async function post(url: string, route: string, body: unknown, cookie = '') {
  const res = await fetch(`${url}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { success?: boolean; error?: string; user?: { phone?: string } };
  return { status: res.status, json, cookie: (res.headers.getSetCookie()[0] || '').split(';')[0] };
}

describe('customer sign-up without a mobile', () => {
  it('creates the account, allows a second phone-less one, and still signs in by email', async () => {
    const { url, close } = await listen(buildApp());
    try {
      const first = await post(url, '/api/auth/register', { name: 'سارة', email: 'sara.np@usil.sa', password: 'secret123' });
      assert.equal(first.status, 201);
      assert.equal(first.json.user?.phone, '');
      // Two accounts without a mobile are not a duplicate.
      const second = await post(url, '/api/auth/register', { name: 'هند', email: 'hind.np@usil.sa', password: 'secret123' });
      assert.equal(second.status, 201);
      const login = await post(url, '/api/auth/login', { email: 'sara.np@usil.sa', password: 'secret123' });
      assert.equal(login.status, 200);
    } finally {
      await close();
    }
  });

  it('still validates and de-duplicates a mobile that is given', async () => {
    const { url, close } = await listen(buildApp());
    try {
      assert.equal((await post(url, '/api/auth/register', { name: 'أ', email: 'a.np@usil.sa', phone: '12', password: 'secret123' })).status, 400);
      assert.equal((await post(url, '/api/auth/register', { name: 'ب', email: 'b.np@usil.sa', phone: '0551234567', password: 'secret123' })).status, 201);
      const clash = await post(url, '/api/auth/register', { name: 'ج', email: 'c.np@usil.sa', phone: '0551234567', password: 'secret123' });
      assert.equal(clash.status, 409);
      assert.equal((await post(url, '/api/auth/register', { email: 'd.np@usil.sa', password: 'secret123' })).status, 400);
    } finally {
      await close();
    }
  });

  it('resends the email code without a mobile only for a phone-less account or its signed-in owner', async () => {
    const { url, close } = await listen(buildApp());
    try {
      await post(url, '/api/auth/register', { name: 'سارة', email: 'sara2.np@usil.sa', password: 'secret123' });
      const withPhone = await post(url, '/api/auth/register', { name: 'منى', email: 'mona.np@usil.sa', phone: '0559876543', password: 'secret123' });
      assert.equal((await post(url, '/api/auth/resend-verification', { email: 'sara2.np@usil.sa' })).status, 200);
      // An account with a mobile needs it, unless its owner is the one asking.
      assert.equal((await post(url, '/api/auth/resend-verification', { email: 'mona.np@usil.sa' })).status, 400);
      assert.equal((await post(url, '/api/auth/resend-verification', { email: 'mona.np@usil.sa' }, withPhone.cookie)).status, 200);
    } finally {
      await close();
    }
  });
});

describe('mobile forms and phone sign-in', () => {
  it('treats 05, +966, 00966 and Arabic digits as one number, refuses junk, and signs in by phone', async () => {
    const { url, close } = await listen(buildApp());
    try {
      const first = await post(url, '/api/auth/register', {
        name: 'خالد',
        email: 'khalid.p@usil.sa',
        phone: '٠٥٠٧٧١٢٢٤٤',
        password: 'secret123',
      });
      assert.equal(first.status, 201);
      assert.equal(first.json.user?.phone, '0507712244');
      for (const phone of ['00966507712244', '+966 50 771 2244']) {
        const again = await post(url, '/api/auth/register', { name: 'خالد', email: `k${phone.length}@usil.sa`, phone, password: 'secret123' });
        assert.equal(again.status, 409, phone);
      }
      const junk = await post(url, '/api/auth/register', { name: 'خالد', email: 'junk@usil.sa', phone: '123456789', password: 'secret123' });
      assert.equal(junk.status, 400);
      const longName = await post(url, '/api/auth/register', { name: 'ا'.repeat(200), email: 'long@usil.sa', password: 'secret123' });
      assert.equal(longName.status, 400);

      for (const identifier of ['0507712244', '00966507712244', '+966507712244']) {
        const login = await post(url, '/api/auth/login', { identifier, password: 'secret123' });
        assert.equal(login.status, 200, identifier);
      }
      const wrong = await post(url, '/api/auth/login', { identifier: '0507712244', password: 'wrong-pass' });
      assert.equal(wrong.status, 401);
    } finally {
      await close();
    }
  });
});

describe('editing your own profile', () => {
  it('changes name and mobile, checks the mobile, and needs the current password for a new one', async () => {
    const { url, close } = await listen(buildApp());
    const patch = async (cookie: string, body: unknown) => {
      const res = await fetch(`${url}/api/auth/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as { user?: { name?: string; phone?: string } } };
    };
    try {
      const taken = await post(url, '/api/auth/register', { name: 'هند', email: 'hind.e@usil.sa', phone: '0551112233', password: 'secret123' });
      assert.equal(taken.status, 201);
      const me = await post(url, '/api/auth/register', { name: 'سارة', email: 'sara.e@usil.sa', password: 'secret123' });
      assert.equal((await patch('', { name: 'x' })).status, 401);
      const edited = await patch(me.cookie, { name: '  سارة   العتيبي ', phone: '+966 55 333 6677' });
      assert.equal(edited.status, 200);
      assert.equal(edited.json.user?.name, 'سارة العتيبي');
      assert.equal(edited.json.user?.phone, '0553336677');
      assert.equal((await patch(me.cookie, { phone: '0551112233' })).status, 409);
      assert.equal((await patch(me.cookie, { phone: '123' })).status, 400);
      assert.equal((await patch(me.cookie, { currentPassword: 'wrong-one', newPassword: 'newsecret9' })).status, 403);
      assert.equal((await patch(me.cookie, { currentPassword: 'secret123', newPassword: 'newsecret9' })).status, 200);
      const login = await post(url, '/api/auth/login', { identifier: 'sara.e@usil.sa', password: 'newsecret9' });
      assert.equal(login.status, 200);
    } finally {
      await close();
    }
  });
});
