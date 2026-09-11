import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { registerIntegrationsRoutes } from './integrations-routes.ts';
import { createIntegrationsStore } from './integrations-store.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-integrations-api-'));
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

function fakeAuth(role: 'admin' | 'vendor' | null) {
  return {
    userFromRequest: () => (role ? { id: 'usr-x', role } : null),
    requireRole: (roles: string[]) => (_req: Request, res: Response, next: NextFunction) => {
      if (!role) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
      if (!roles.includes(role)) {
        return res.status(403).json({ success: false, error: 'ليست لديك صلاحية هذا الإجراء.' });
      }
      next();
    },
  };
}

function fakeFetch(status: number, body: unknown) {
  const bodies: string[] = [];
  const impl = (async (_url: unknown, init: unknown) => {
    bodies.push(String((init as RequestInit)?.body ?? ''));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

const ENV_NAMES = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'OPENAI_API_KEY'];
let savedEnv: Record<string, string | undefined> = {};

describe('integrations-routes', () => {
  beforeEach(() => {
    savedEnv = {};
    for (const name of ENV_NAMES) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name] as string;
    }
  });

  it('rejects guests and non-admins on every integrations endpoint', async () => {
    const dir = tmpDir();
    const guestApp = express();
    guestApp.use(express.json());
    registerIntegrationsRoutes(guestApp, fakeAuth(null) as any, dir);
    const vendorApp = express();
    vendorApp.use(express.json());
    registerIntegrationsRoutes(vendorApp, fakeAuth('vendor') as any, dir);

    const guest = await listen(guestApp);
    const vendor = await listen(vendorApp);

    assert.equal((await fetch(`${guest.url}/api/admin/integrations`)).status, 401);
    assert.equal(
      (
        await fetch(`${guest.url}/api/admin/integrations`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ openai: { apiKey: 'sk-hacker-key-0000' } }),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${guest.url}/api/admin/integrations/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'openai' }),
        })
      ).status,
      401,
    );
    assert.equal((await fetch(`${vendor.url}/api/admin/integrations`)).status, 403);
    assert.equal(fs.existsSync(path.join(dir, 'integrations.json')), false, 'no write from a rejected request');

    await guest.close();
    await vendor.close();
  });

  it('saves a key server-side and returns it masked, never raw', async () => {
    const dir = tmpDir();
    const app = express();
    app.use(express.json());
    registerIntegrationsRoutes(app, fakeAuth('admin') as any, dir);
    const { url, close } = await listen(app);

    const put = await fetch(`${url}/api/admin/integrations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaultProvider: 'anthropic',
        anthropic: { apiKey: 'sk-ant-panel-key-4242', model: 'claude-opus-4-1' },
      }),
    });
    const putText = await put.text();
    assert.equal(put.status, 200);
    assert.equal(putText.includes('sk-ant-panel-key-4242'), false, 'PUT response must not echo the key');

    const get = await fetch(`${url}/api/admin/integrations`);
    const getText = await get.text();
    assert.equal(getText.includes('sk-ant-panel-key-4242'), false, 'GET response must not echo the key');
    const json = JSON.parse(getText);
    assert.equal(json.data.defaultProvider, 'anthropic');
    assert.equal(json.data.providers.anthropic.configured, true);
    assert.equal(json.data.providers.anthropic.keyMasked, 'sk-…4242');
    assert.equal(json.data.providers.anthropic.model, 'claude-opus-4-1');
    assert.equal(json.data.cursor.supported, false);

    const onDisk = createIntegrationsStore(dir).load();
    assert.equal(onDisk.anthropic.apiKey, 'sk-ant-panel-key-4242', 'the real key lives on the server');
    assert.equal(fs.statSync(path.join(dir, 'integrations.json')).mode & 0o777, 0o600);

    await close();
  });

  it('keeps the saved key when a later save sends only a model change', async () => {
    const dir = tmpDir();
    const app = express();
    app.use(express.json());
    registerIntegrationsRoutes(app, fakeAuth('admin') as any, dir);
    const { url, close } = await listen(app);

    await fetch(`${url}/api/admin/integrations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openai: { apiKey: 'sk-openai-keep-1357' } }),
    });
    await fetch(`${url}/api/admin/integrations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openai: { model: 'gpt-4o-mini' } }),
    });

    const settings = createIntegrationsStore(dir).load();
    assert.equal(settings.openai.apiKey, 'sk-openai-keep-1357');
    assert.equal(settings.openai.model, 'gpt-4o-mini');

    await fetch(`${url}/api/admin/integrations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openai: { clearKey: true } }),
    });
    assert.equal(createIntegrationsStore(dir).load().openai.apiKey, '');

    await close();
  });

  it('runs a live test call and answers in Arabic without echoing the key', async () => {
    const dir = tmpDir();
    const app = express();
    app.use(express.json());
    const { impl, bodies } = fakeFetch(200, { content: [{ type: 'text', text: 'جاهز' }] });
    registerIntegrationsRoutes(app, fakeAuth('admin') as any, dir, { fetchImpl: impl });
    const { url, close } = await listen(app);

    await fetch(`${url}/api/admin/integrations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anthropic: { apiKey: 'sk-ant-test-key-9090', model: 'claude-sonnet-4-5' } }),
    });

    const res = await fetch(`${url}/api/admin/integrations/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic' }),
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.equal(text.includes('sk-ant-test-key-9090'), false);
    const json = JSON.parse(text);
    assert.equal(json.success, true);
    assert.match(json.message, /الاتصال ناجح/);
    assert.equal(bodies.length, 1, 'the test hits the provider once');
    assert.equal(JSON.parse(bodies[0]).max_tokens, 16, 'the test call stays tiny');

    await close();
  });

  it('returns an Arabic failure with a 400 when the provider rejects the key', async () => {
    const dir = tmpDir();
    const app = express();
    app.use(express.json());
    const { impl } = fakeFetch(401, { error: { message: 'invalid x-api-key' } });
    registerIntegrationsRoutes(app, fakeAuth('admin') as any, dir, { fetchImpl: impl });
    const { url, close } = await listen(app);

    await fetch(`${url}/api/admin/integrations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openai: { apiKey: 'sk-openai-wrong-1122' } }),
    });
    const res = await fetch(`${url}/api/admin/integrations/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai' }),
    });
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.equal(json.success, false);
    assert.match(json.error, /المفتاح مرفوض/);

    await close();
  });

  it('refuses a cursor test with an honest Arabic explanation', async () => {
    const app = express();
    app.use(express.json());
    registerIntegrationsRoutes(app, fakeAuth('admin') as any, tmpDir());
    const { url, close } = await listen(app);

    const res = await fetch(`${url}/api/admin/integrations/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'cursor' }),
    });
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.match(json.error, /كيرسر ما عنده API للمواقع/);

    const junk = await fetch(`${url}/api/admin/integrations/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'skynet' }),
    });
    assert.equal(junk.status, 400);

    await close();
  });

  it('exposes a public AI status flag without any key material', async () => {
    const dir = tmpDir();
    const app = express();
    app.use(express.json());
    registerIntegrationsRoutes(app, fakeAuth(null) as any, dir);
    const { url, close } = await listen(app);

    const before = await (await fetch(`${url}/api/ai/status`)).json();
    assert.equal(before.available, false);
    assert.equal(before.provider, null);
    assert.equal(before.cursor.supported, false);

    createIntegrationsStore(dir).save({
      defaultProvider: 'openai',
      openai: { apiKey: 'sk-openai-status-7788' },
    });
    const after = await (await fetch(`${url}/api/ai/status`)).text();
    assert.equal(after.includes('sk-openai-status-7788'), false);
    assert.equal(JSON.parse(after).available, true);
    assert.equal(JSON.parse(after).provider, 'openai');

    await close();
  });
});
