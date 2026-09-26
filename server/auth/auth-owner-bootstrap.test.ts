import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createAuth, hashPassword } from './auth.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-owner-'));
}

function readUsers(dir: string): Array<{ email: string; role: string; passwordHash: string }> {
  const file = path.join(dir, 'users.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : [];
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

const OWNER = { OWNER_EMAIL: 'Owner@Usil.com', OWNER_PASSWORD: 'owner-secret-1' };

describe('owner bootstrap from OWNER_EMAIL / OWNER_PASSWORD', () => {
  it('creates an admin on an empty store, and that admin can log in', async () => {
    const dir = tmpDir();
    const auth = createAuth(dir, OWNER);
    const users = readUsers(dir);
    assert.equal(users.length, 1);
    assert.equal(users[0].email, 'owner@usil.com');
    assert.equal(users[0].role, 'admin');

    const app = express();
    app.use(express.json());
    app.post('/api/auth/login', (req, res) => auth.loginHandler(req, res));
    const server = await listen(app);
    try {
      const res = await fetch(`${server.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: 'owner@usil.com', password: 'owner-secret-1' }),
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).user.role, 'admin');
    } finally {
      await server.close();
    }
  });

  it('does nothing once any admin exists, so a restart never resets the password', () => {
    const dir = tmpDir();
    createAuth(dir, OWNER);
    const before = readUsers(dir)[0].passwordHash;
    createAuth(dir, { ...OWNER, OWNER_PASSWORD: 'a-different-pass' });
    const after = readUsers(dir);
    assert.equal(after.length, 1);
    assert.equal(after[0].passwordHash, before);
  });

  it('leaves a store that already has an admin untouched', () => {
    const dir = tmpDir();
    const existing = [
      { id: 'usr-a', name: 'مدير', email: 'boss@usil.sa', phone: '0551112222', role: 'admin', passwordHash: hashPassword('x-secret-9'), avatarUrl: '' },
    ];
    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(existing));
    createAuth(dir, OWNER);
    assert.deepEqual(readUsers(dir).map((u) => u.email), ['boss@usil.sa']);
  });

  it('ignores a short password, a reserved address, or a taken email', () => {
    for (const env of [
      { OWNER_EMAIL: 'owner@usil.com', OWNER_PASSWORD: 'short' },
      { OWNER_EMAIL: 'admin@usil.app', OWNER_PASSWORD: 'owner-secret-1' },
      { OWNER_EMAIL: 'nawafalmuhayya@gmail.com', OWNER_PASSWORD: 'owner-secret-1' },
    ]) {
      const dir = tmpDir();
      createAuth(dir, env);
      assert.equal(readUsers(dir).length, 0, env.OWNER_EMAIL);
    }

    const dir = tmpDir();
    const client = [
      { id: 'usr-c', name: 'عميل', email: 'owner@usil.com', phone: '0553334444', role: 'client', passwordHash: hashPassword('client-pass'), avatarUrl: '' },
    ];
    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(client));
    createAuth(dir, OWNER);
    assert.deepEqual(readUsers(dir).map((u) => u.role), ['client']);
  });

  it('is off when the variables are unset', () => {
    const dir = tmpDir();
    createAuth(dir, {});
    assert.equal(readUsers(dir).length, 0);
  });
});
