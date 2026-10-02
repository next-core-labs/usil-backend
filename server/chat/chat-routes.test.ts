import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerChatRoutes } from './chat-routes.ts';
import { roleAllowed } from '../auth/roles.ts';

type TestUser = { id: string; role: string; name: string };

const USERS: Record<string, TestUser> = {
  client: { id: 'usr-client', role: 'client', name: 'نواف' },
  other: { id: 'usr-other', role: 'client', name: 'سارة' },
  vendor: { id: 'usr-vendor', role: 'vendor', name: 'حساب المورّد' },
  admin: { id: 'usr-admin', role: 'admin', name: 'مالك يوصل' },
  manager: { id: 'usr-manager', role: 'accounts_manager', name: 'مدير الحسابات' },
  courier: { id: 'usr-courier', role: 'courier', name: 'مندوب' },
};

/** The caller picks who they are with an `x-test-user` header. */
function fakeAuth() {
  return {
    requireRole: (roles: string[]) => (req: Request, res: Response, next: NextFunction) => {
      const user = USERS[String(req.headers['x-test-user'] || '')];
      if (!user) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
      if (!roleAllowed(user.role, roles)) {
        return res.status(403).json({ success: false, error: 'ليست لديك صلاحية هذا الإجراء.' });
      }
      (req as Request & { user: TestUser }).user = user;
      next();
    },
  };
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

async function withServer(run: (call: Caller) => Promise<void>) {
  const app = express();
  app.use(express.json());
  registerChatRoutes(app, fakeAuth() as any, fs.mkdtempSync(path.join(os.tmpdir(), 'usil-chat-routes-')), {
    findVendor: (id) => (id === USERS.vendor.id ? { id, name: 'قهوة الضيافة' } : null),
  });
  const { url, close } = await listen(app);
  const call: Caller = async (as, method, route, body) => {
    const res = await fetch(`${url}${route}`, {
      method,
      headers: {
        ...(as ? { 'x-test-user': as } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  try {
    await run(call);
  } finally {
    await close();
  }
}

type Caller = (
  as: keyof typeof USERS | null,
  method: string,
  route: string,
  body?: unknown,
) => Promise<{ status: number; json: any }>;

describe('chat-routes', () => {
  it('rejects guests and couriers', async () => {
    await withServer(async (call) => {
      assert.equal((await call(null, 'GET', '/api/chats')).status, 401);
      assert.equal((await call('courier', 'GET', '/api/chats')).status, 403);
    });
  });

  it('lets a client start a thread with an approved vendor and the vendor reply', async () => {
    await withServer(async (call) => {
      const started = await call('client', 'POST', '/api/chats', {
        vendorId: USERS.vendor.id,
        body: 'متاحين يوم الخميس؟',
        context: { type: 'listing', id: 'lst-1', title: 'ركن قهوة' },
      });
      assert.equal(started.status, 201);
      const thread = started.json.data;
      assert.equal(thread.kind, 'client_vendor');
      assert.equal(thread.vendorName, 'قهوة الضيافة');
      assert.equal(thread.clientName, 'نواف');
      assert.equal(thread.messages[0].context.title, 'ركن قهوة');

      assert.equal((await call('vendor', 'GET', '/api/chats/unread')).json.data.count, 1);
      const reply = await call('vendor', 'POST', `/api/chats/${thread.id}/messages`, { body: 'نعم متاحين' });
      assert.equal(reply.status, 201);
      assert.equal(reply.json.data.senderName, 'قهوة الضيافة');
      assert.equal(reply.json.data.side, 'vendor');

      const polled = await call('client', 'GET', `/api/chats/${thread.id}?after=${thread.messages[0].id}`);
      assert.deepEqual(polled.json.data.messages.map((m: any) => m.body), ['نعم متاحين']);
      assert.equal((await call('client', 'GET', '/api/chats/unread')).json.data.count, 1);
      await call('client', 'POST', `/api/chats/${thread.id}/read`);
      assert.equal((await call('client', 'GET', '/api/chats/unread')).json.data.count, 0);

      const second = await call('client', 'POST', '/api/chats', { vendorId: USERS.vendor.id, body: 'شكراً' });
      assert.equal(second.status, 200);
      assert.equal(second.json.data.id, thread.id);
    });
  });

  it('refuses unknown vendors and empty messages', async () => {
    await withServer(async (call) => {
      assert.equal((await call('client', 'POST', '/api/chats', { vendorId: 'usr-nobody', body: 'مرحبا' })).status, 404);
      assert.equal((await call('client', 'POST', '/api/chats', { vendorId: USERS.vendor.id, body: '  ' })).status, 400);
      assert.equal((await call('client', 'POST', '/api/chats', { vendorId: USERS.vendor.id })).status, 400);
      assert.deepEqual((await call('client', 'GET', '/api/chats')).json.data, []);
    });
  });

  it('hides a thread from other clients and from the owner side', async () => {
    await withServer(async (call) => {
      const thread = (await call('client', 'POST', '/api/chats', { vendorId: USERS.vendor.id, body: 'مرحبا' })).json.data;
      assert.equal((await call('other', 'GET', `/api/chats/${thread.id}`)).status, 404);
      assert.equal((await call('other', 'POST', `/api/chats/${thread.id}/messages`, { body: 'x' })).status, 404);
      assert.equal((await call('admin', 'GET', `/api/chats/${thread.id}`)).status, 404);
      assert.deepEqual((await call('admin', 'GET', '/api/chats')).json.data, []);
    });
  });

  it('gives a vendor one thread with the Usil team, shared by every admin', async () => {
    await withServer(async (call) => {
      const fromVendor = await call('vendor', 'POST', '/api/chats', { body: 'أحتاج مساعدة في الدفعات' });
      assert.equal(fromVendor.status, 201);
      const thread = fromVendor.json.data;
      assert.equal(thread.kind, 'vendor_owner');
      assert.equal(thread.vendorId, USERS.vendor.id);

      assert.equal((await call('admin', 'GET', '/api/chats/unread')).json.data.count, 1);
      assert.equal((await call('manager', 'GET', '/api/chats')).json.data[0].id, thread.id);

      const fromOwner = await call('manager', 'POST', '/api/chats', { vendorId: USERS.vendor.id, body: 'أهلاً، كيف نخدمك؟' });
      assert.equal(fromOwner.status, 200);
      assert.equal(fromOwner.json.data.id, thread.id);
      assert.equal(fromOwner.json.data.messages[1].side, 'owner');
      assert.equal((await call('vendor', 'GET', '/api/chats/unread')).json.data.count, 1);

      assert.equal((await call('client', 'GET', `/api/chats/${thread.id}`)).status, 404);
    });
  });

  it('lets the owner open a thread with a vendor first', async () => {
    await withServer(async (call) => {
      const started = await call('admin', 'POST', '/api/chats', { vendorId: USERS.vendor.id, body: 'مرحباً بك في يوصل' });
      assert.equal(started.status, 201);
      assert.equal(started.json.data.kind, 'vendor_owner');
      const inbox = (await call('vendor', 'GET', '/api/chats')).json.data;
      assert.equal(inbox.length, 1);
      assert.equal(inbox[0].unread, 1);
    });
  });

  it('throttles a flood of messages', async () => {
    await withServer(async (call) => {
      const thread = (await call('client', 'POST', '/api/chats', { vendorId: USERS.vendor.id, body: '1' })).json.data;
      let last = 0;
      for (let i = 0; i < 31; i += 1) {
        last = (await call('client', 'POST', `/api/chats/${thread.id}/messages`, { body: `رسالة ${i}` })).status;
      }
      assert.equal(last, 429);
    });
  });
});
