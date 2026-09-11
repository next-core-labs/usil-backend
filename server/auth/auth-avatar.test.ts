import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createAuth } from './auth.ts';
import { purgeLiveDummyData } from './dummy-accounts.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-auth-'));
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

describe('auth avatars and dummy purge', () => {
  it('register always returns a stored avatarUrl that serves 200', async () => {
    const dir = tmpDir();
    const auth = createAuth(dir);
    const app = express();
    app.use(express.json());
    app.post('/api/auth/register', (req, res) => auth.registerHandler(req, res));
    app.get('/api/auth/me', (req, res) => auth.meHandler(req, res));
    app.use('/uploads', express.static(path.join(dir, 'uploads')));
    const { url, close } = await listen(app);
    const res = await fetch(`${url}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'خالد التجريبي',
        email: 'khalid.launch@usil.sa',
        phone: '0591111222',
        password: 'secret12',
      }),
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.match(json.user.avatarUrl, /^\/uploads\/avatar-/);
    const cookie = res.headers.get('set-cookie') || '';
    const img = await fetch(`${url}${json.user.avatarUrl}`);
    assert.equal(img.status, 200);
    const svg = await img.text();
    assert.match(svg, /svg/i);
    assert.match(svg, /#0A1A33/i);
    const me = await fetch(`${url}/api/auth/me`, { headers: { cookie } });
    const meJson = await me.json();
    assert.equal(meJson.user.avatarUrl, json.user.avatarUrl);
    await close();
  });

  it('purges seeded demo users and keeps the founder', () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, 'users.json'),
      JSON.stringify([
        { id: 'usr-client', name: 'عميل مِضياف', email: 'client@usil.app', phone: '0501111111', role: 'client' },
        {
          id: 'usr-nawaf-admin',
          name: 'مدير كل الحسابات — يوصل',
          email: 'nawafalmuhayya@gmail.com',
          phone: '0504444444',
          role: 'admin',
        },
      ]),
    );
    fs.writeFileSync(
      path.join(dir, 'sessions.json'),
      JSON.stringify({ aaa: 'usr-client', bbb: 'usr-nawaf-admin' }),
    );
    const result = purgeLiveDummyData(dir);
    assert.ok(result.removedUsers.includes('client@usil.app'));
    const users = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf-8'));
    assert.equal(users.length, 1);
    assert.equal(users[0].email, 'nawafalmuhayya@gmail.com');
    const sessions = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf-8'));
    assert.equal(sessions.aaa, undefined);
    assert.equal(sessions.bbb, 'usr-nawaf-admin');
  });
});
