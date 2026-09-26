import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createAuth, hashPassword } from './auth.ts';

/** حراسة حدّ محاولات الدخول — بلا حدّ يصير تخمين الرقم السري مفتوحاً. */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-login-throttle-'));
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
        id: 'usr-throttle-1',
        name: 'عميل الحدّ',
        email: 'throttle@usil.sa',
        phone: '0591112233',
        role: 'client',
        passwordHash: hashPassword('secret12'),
        avatarUrl: '',
        emailVerified: true,
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
  return app;
}

function login(url: string, body: Record<string, unknown>) {
  return fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('حدّ محاولات تسجيل الدخول', () => {
  it('يرد 429 بعد تجاوز الحد بأرقام سرية خاطئة، ولا يقبل الصحيح بعدها', async () => {
    const dir = tmpDir();
    seedUser(dir);
    const server = await listen(appWithAuth(dir));
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const res = await login(server.url, {
          email: 'throttle@usil.sa',
          phone: '0591112233',
          password: 'wrong-guess',
        });
        statuses.push(res.status);
      }

      assert.equal(statuses[0], 401, 'أول محاولة خاطئة ترد 401');
      assert.ok(
        statuses.includes(429),
        `توقعنا 429 بعد تكرار المحاولات، والحاصل: ${statuses.join(',')}`,
      );

      // الحد يمنع حتى الرقم السري الصحيح — فالتخمين ما يفيد المهاجم.
      const correct = await login(server.url, {
        email: 'throttle@usil.sa',
        phone: '0591112233',
        password: 'secret12',
      });
      assert.equal(correct.status, 429);
    } finally {
      await server.close();
    }
  });

  it('تغيير الـ IP ما يفتح التخمين: حدّ ثانٍ على البريد وحده بعد 30 محاولة', async () => {
    const dir = tmpDir();
    seedUser(dir);
    // Tests reach the server from 127.0.0.1; a trusted header stands in for many callers.
    const previous = process.env.CLIENT_IP_HEADER;
    process.env.CLIENT_IP_HEADER = 'x-test-ip';
    const server = await listen(appWithAuth(dir));
    const from = (ip: string, body: Record<string, unknown>) =>
      fetch(`${server.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-ip': ip },
        body: JSON.stringify(body),
      });
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const res = await from(`198.51.100.${attempt + 1}`, {
          email: 'throttle@usil.sa',
          phone: '0591112233',
          password: 'wrong-guess',
        });
        statuses.push(res.status);
      }
      assert.deepEqual([...new Set(statuses)], [401], 'كل IP جديد تحت حدّه، فالثلاثون كلها 401');

      const fresh = await from('203.0.113.77', {
        email: 'throttle@usil.sa',
        phone: '0591112233',
        password: 'secret12',
      });
      assert.equal(fresh.status, 429, 'المحاولة 31 من IP جديد تُرفض حتى بالرقم الصحيح');

      // حساب آخر من نفس الـ IP الجديد ما يتأثر.
      const other = await from('203.0.113.77', {
        email: 'someone-else@usil.sa',
        phone: '0590000000',
        password: 'wrong-guess',
      });
      assert.equal(other.status, 401);
    } finally {
      if (previous === undefined) delete process.env.CLIENT_IP_HEADER;
      else process.env.CLIENT_IP_HEADER = previous;
      await server.close();
    }
  });

  it('الحدّ لكل بريد على حدة، فحساب غيرك ما يتعطّل بسببك', async () => {
    const dir = tmpDir();
    seedUser(dir);
    const server = await listen(appWithAuth(dir));
    try {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await login(server.url, {
          email: 'attacked@usil.sa',
          phone: '0590000000',
          password: 'wrong-guess',
        });
      }

      // نفس الـ IP، بريد مختلف — لازم يبقى قادراً على الدخول.
      const mine = await login(server.url, {
        email: 'throttle@usil.sa',
        phone: '0591112233',
        password: 'secret12',
      });
      assert.equal(mine.status, 200);
      const payload = (await mine.json()) as { success?: boolean };
      assert.equal(payload.success, true);
    } finally {
      await server.close();
    }
  });
});
