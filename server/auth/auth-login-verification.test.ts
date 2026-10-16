import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createAuth } from './auth.ts';
import { setMailFetchForTests } from '../shared/optional-mail.ts';

/**
 * Signing in to an unconfirmed account used to show «تأكيد البريد» without
 * sending anything; the sign-up code had long expired, so no email ever came.
 */

const MAIL_VARS = ['RESEND_API_KEY', 'MAIL_FROM', 'SMTP_HOST', 'MAIL_HOST', 'SMTP_URL', 'MAIL_URL', 'SMTP_SERVER'];

function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

async function post(url: string, route: string, body: unknown) {
  const res = await fetch(`${url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('sign-in to an unconfirmed account', () => {
  const saved: Record<string, string | undefined> = {};
  let sent: string[] = [];
  beforeEach(() => {
    for (const key of MAIL_VARS) saved[key] = process.env[key];
    for (const key of MAIL_VARS) delete process.env[key];
    process.env.RESEND_API_KEY = 're_test_key';
    sent = [];
    setMailFetchForTests(async (_url, init) => {
      sent.push(JSON.parse(String(init.body)).to[0]);
      return { ok: true, status: 200, text: async () => '{}' };
    });
  });
  afterEach(() => {
    setMailFetchForTests(null);
    for (const key of MAIL_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('mails a fresh code once the sign-up code is old, but not right after sign-up', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-login-verify-'));
    const auth = createAuth(dir);
    const app = express();
    app.use(express.json());
    app.post('/api/auth/register', (req, res) => auth.registerHandler(req, res));
    app.post('/api/auth/login', (req, res) => auth.loginHandler(req, res));
    const { url, close } = await listen(app);
    try {
      const email = 'late.verify@usil.sa';
      assert.equal((await post(url, '/api/auth/register', { name: 'ليان', email, password: 'secret123' })).status, 201);
      assert.equal(sent.length, 1);

      // Straight after sign-up the code just sent is reused: no second email.
      const soon = await post(url, '/api/auth/login', { email, password: 'secret123' });
      assert.equal(soon.json.needsEmailVerification, true);
      assert.equal(soon.json.emailSent, true);
      assert.equal(sent.length, 1);

      // Age the code past the reuse window, as on a later visit.
      const usersFile = path.join(dir, 'users.json');
      const users = JSON.parse(fs.readFileSync(usersFile, 'utf-8')) as Array<Record<string, unknown>>;
      const row = users.find((u) => u.email === email)!;
      row.emailVerifyExpiresAt = Date.now() - 1000;
      fs.writeFileSync(usersFile, JSON.stringify(users));

      const later = await post(url, '/api/auth/login', { email, password: 'secret123' });
      assert.equal(later.status, 200);
      assert.equal(later.json.needsEmailVerification, true);
      assert.equal(later.json.emailSent, true);
      assert.deepEqual(sent, [email, email]);
      const after = JSON.parse(fs.readFileSync(usersFile, 'utf-8')) as Array<Record<string, number>>;
      assert.ok(after.find((u) => (u as unknown as { email: string }).email === email)!.emailVerifyExpiresAt > Date.now());
    } finally {
      await close();
    }
  });
});
