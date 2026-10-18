import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createAuth, hashPassword } from '../auth/auth.ts';
import { registerAuthRoutes } from '../auth/auth-routes.ts';
import { registerWhatsAppRoutes } from './whatsapp-routes.ts';
import { captureWhatsAppRawBody } from './whatsapp-webhook.ts';
import { createApp } from '../app.ts';

const PASSWORD = 'secret123';
const USERS = {
  admin: { id: 'usr-wa-admin', name: 'ماهر', email: 'wa-owner@example.sa', phone: '0500000101', role: 'admin' },
  manager: { id: 'usr-wa-manager', name: 'سارة', email: 'wa-manager@example.sa', phone: '0500000102', role: 'accounts_manager' },
  client: { id: 'usr-wa-client', name: 'عميل', email: 'wa-client@example.sa', phone: '0500000103', role: 'client' },
  vendor: { id: 'usr-wa-vendor', name: 'مورّد', email: 'wa-vendor@example.sa', phone: '0500000104', role: 'vendor' },
} as const;
type Who = keyof typeof USERS;

const TOKEN = 'EAAGtesttokenabcdefghijklmnopqrstuvwxyz0123x9Q4';
const PHONE_ID = '109876543210987';
const WABA_ID = '209876543210987';
const APP_SECRET = 'app-secret-for-tests-0123456789abcdef';
const VERIFY = 'verify-me-please';
const GRAPH = 'http://graph.test';
const CUSTOMER = '966501234567';

const ENV_NAMES = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_BUSINESS_ACCOUNT_ID',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_GRAPH_VERSION',
  'WHATSAPP_GRAPH_BASE',
  'WHATSAPP_WEBHOOK_URL',
];
let savedEnv: Record<string, string | undefined> = {};

function useEnvConfig() {
  process.env.WHATSAPP_ACCESS_TOKEN = TOKEN;
  process.env.WHATSAPP_PHONE_NUMBER_ID = PHONE_ID;
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = WABA_ID;
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_VERIFY_TOKEN = VERIFY;
}

type GraphCall = { method: string; url: string; path: string; auth: string; body: any };

const TEMPLATES = [
  {
    name: 'order_update',
    language: 'ar',
    category: 'UTILITY',
    status: 'APPROVED',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'يوصل' },
      { type: 'BODY', text: 'مرحباً {{1}}، طلبك {{2}} جاهز. شكراً {{1}}' },
    ],
  },
  { name: 'hello', language: 'ar', category: 'MARKETING', status: 'APPROVED', components: [{ type: 'BODY', text: 'أهلاً بك في يوصل' }] },
];

/** A stand-in for graph.facebook.com: records each call, answers like Meta. */
function mockGraph() {
  const calls: GraphCall[] = [];
  const state = {
    sendError: null as null | { status: number; message: string },
    verifyError: null as null | string,
    readError: false,
    sent: 0,
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || 'GET';
    const auth = new Headers(init?.headers).get('authorization') || '';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const parsed = new URL(url);
    calls.push({ method, url, path: parsed.pathname, auth, body });
    if (auth !== `Bearer ${TOKEN}`) return json(401, { error: { message: 'Invalid OAuth access token.', code: 190 } });

    if (method === 'GET' && parsed.pathname === `/v23.0/${PHONE_ID}`) {
      if (state.verifyError) return json(400, { error: { message: state.verifyError, code: 100 } });
      return json(200, { display_phone_number: '+966 59 500 1957', verified_name: 'Usil', id: PHONE_ID });
    }
    if (method === 'POST' && parsed.pathname === `/v23.0/${PHONE_ID}/messages`) {
      if (body?.status === 'read') {
        return state.readError ? json(500, { error: { message: 'boom' } }) : json(200, { success: true });
      }
      if (state.sendError) {
        return json(state.sendError.status, {
          error: { message: state.sendError.message, code: 131047, error_data: { details: 'Message failed to send' } },
        });
      }
      state.sent += 1;
      return json(200, {
        messaging_product: 'whatsapp',
        contacts: [{ input: body.to, wa_id: body.to }],
        messages: [{ id: `wamid.OUT${state.sent}` }],
      });
    }
    if (method === 'GET' && parsed.pathname === `/v23.0/${WABA_ID}/message_templates`) {
      return json(200, { data: TEMPLATES });
    }
    if (method === 'GET' && parsed.pathname === '/v23.0/MEDIA1') {
      return json(200, { url: `${GRAPH}/download/MEDIA1`, mime_type: 'image/jpeg', id: 'MEDIA1' });
    }
    if (method === 'GET' && parsed.pathname === '/download/MEDIA1') {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    return json(404, { error: { message: `no mock for ${method} ${parsed.pathname}` } });
  }) as typeof fetch;
  return { calls, state, fetchImpl };
}

function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

function writeUsers(dir: string) {
  fs.writeFileSync(
    path.join(dir, 'users.json'),
    JSON.stringify(
      Object.values(USERS).map((user) => ({
        avatarUrl: '',
        emailVerified: true,
        passwordHash: hashPassword(PASSWORD),
        ...user,
      })),
    ),
  );
}

function sign(raw: string, secret = APP_SECRET) {
  return `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
}

type Harness = Awaited<ReturnType<typeof setup>>;

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-whatsapp-'));
  writeUsers(dir);
  const graph = mockGraph();
  const clock = { now: new Date('2026-10-19T10:00:00.000Z') };
  const auth = createAuth(dir);
  // Boot wipes vendor accounts once (live dummy-data purge); put ours back after it.
  writeUsers(dir);
  const app = express();
  app.use(express.json({ limit: '16mb', verify: captureWhatsAppRawBody }));
  registerAuthRoutes(app, auth, dir);
  registerWhatsAppRoutes(app, auth, dir, { fetchImpl: graph.fetchImpl, now: () => clock.now });
  const server = await listen(app);
  const cookies: Partial<Record<Who, string>> = {};

  async function login(who: Who) {
    if (cookies[who]) return cookies[who] as string;
    const user = USERS[who];
    const res = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, phone: user.phone, password: PASSWORD }),
    });
    assert.equal(res.status, 200, `login ${who}`);
    cookies[who] = (res.headers.get('set-cookie') || '').split(';')[0];
    return cookies[who] as string;
  }

  async function call(method: string, route: string, body?: unknown, who: Who | null = 'manager') {
    const cookie = who ? await login(who) : '';
    const res = await fetch(`${server.url}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { res, json, text };
  }

  async function webhook(payload: unknown, signature?: string | null) {
    const raw = JSON.stringify(payload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const sig = signature === undefined ? sign(raw) : signature;
    if (sig) headers['X-Hub-Signature-256'] = sig;
    const res = await fetch(`${server.url}/api/whatsapp/webhook`, { method: 'POST', headers, body: raw });
    return { res, json: (await res.json().catch(() => null)) as any };
  }

  return { dir, graph, clock, server, call, webhook, login, close: server.close };
}

function secondsAgo(clock: { now: Date }, seconds: number) {
  return String(Math.floor(clock.now.getTime() / 1000) - seconds);
}

function inboundPayload(
  message: Record<string, unknown>,
  options: { name?: string; from?: string; phoneNumberId?: string } = {},
) {
  const from = options.from || CUSTOMER;
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA_ID,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '966595001957', phone_number_id: options.phoneNumberId || PHONE_ID },
              contacts: [{ wa_id: from, profile: { name: options.name ?? 'نواف' } }],
              messages: [{ from, ...message }],
            },
          },
        ],
      },
    ],
  };
}

function statusPayload(statuses: Array<Record<string, unknown>>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA_ID,
        changes: [
          {
            field: 'messages',
            value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID }, statuses },
          },
        ],
      },
    ],
  };
}

async function inboundText(h: Harness, wamid: string, body: string, ago = 60, extra: { name?: string; from?: string } = {}) {
  const { res } = await h.webhook(
    inboundPayload({ id: wamid, timestamp: secondsAgo(h.clock, ago), type: 'text', text: { body } }, extra),
  );
  assert.equal(res.status, 200);
}

describe('whatsapp inbox routes', () => {
  let h: Harness;

  beforeEach(async () => {
    savedEnv = {};
    for (const name of ENV_NAMES) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
    process.env.WHATSAPP_GRAPH_BASE = GRAPH;
    h = await setup();
  });

  afterEach(async () => {
    await h.close();
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name] as string;
    }
  });

  describe('webhook handshake', () => {
    it('echoes the challenge only for the right verify token', async () => {
      useEnvConfig();
      const good = await fetch(
        `${h.server.url}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`,
      );
      assert.equal(good.status, 200);
      assert.equal(await good.text(), '12345');
      const bad = await fetch(
        `${h.server.url}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345`,
      );
      assert.equal(bad.status, 403);
      const noMode = await fetch(`${h.server.url}/api/whatsapp/webhook?hub.verify_token=${VERIFY}&hub.challenge=1`);
      assert.equal(noMode.status, 403);
    });

    it('generates a verify token on first read, keeps it, and the handshake accepts it', async () => {
      const first = await h.call('GET', '/api/admin/whatsapp/settings', undefined, 'admin');
      const token = first.json.data.verifyToken as string;
      assert.ok(token.length >= 20);
      assert.equal(first.json.data.source.verifyToken, 'saved');
      const second = await h.call('GET', '/api/admin/whatsapp/settings', undefined, 'admin');
      assert.equal(second.json.data.verifyToken, token);
      const ok = await fetch(
        `${h.server.url}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=abc`,
      );
      assert.equal(await ok.text(), 'abc');
    });
  });

  describe('webhook signature', () => {
    it('accepts a valid signature and rejects a bad or missing one', async () => {
      useEnvConfig();
      const payload = inboundPayload({ id: 'wamid.IN1', timestamp: secondsAgo(h.clock, 5), type: 'text', text: { body: 'hi' } });
      const missing = await h.webhook(payload, null);
      assert.equal(missing.res.status, 401);
      const wrong = await h.webhook(payload, sign(JSON.stringify(payload), 'other-secret'));
      assert.equal(wrong.res.status, 401);
      const garbage = await h.webhook(payload, 'sha256=xyz');
      assert.equal(garbage.res.status, 401);
      assert.equal((await h.call('GET', '/api/admin/whatsapp/conversations')).json.data.length, 0);

      const ok = await h.webhook(payload);
      assert.equal(ok.res.status, 200);
      assert.deepEqual(ok.json, { received: true });
      assert.equal((await h.call('GET', '/api/admin/whatsapp/conversations')).json.data.length, 1);
    });

    it('signs over the raw bytes, not re-serialized JSON', async () => {
      useEnvConfig();
      // Spacing and key order that JSON.stringify would not reproduce.
      const raw = `{ "object":"whatsapp_business_account",  "entry": [ ] }`;
      const res = await fetch(`${h.server.url}/api/whatsapp/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(raw) },
        body: raw,
      });
      assert.equal(res.status, 200);
    });

    it('answers 503 when no app secret is configured', async () => {
      const res = await h.webhook({ object: 'whatsapp_business_account', entry: [] });
      assert.equal(res.res.status, 503);
    });

    it('never throws on unknown shapes', async () => {
      useEnvConfig();
      for (const payload of [
        {},
        { entry: 'x' },
        { entry: [{ changes: [{ field: 'messages', value: null }] }] },
        { entry: [{ changes: [{ field: 'account_update', value: { foo: 1 } }] }] },
        { entry: [{ changes: [{ field: 'messages', value: { messages: [{ from: 'abc', id: 'w' }, null, 5] } }] }] },
        [1, 2, 3],
      ]) {
        const res = await h.webhook(payload);
        assert.equal(res.res.status, 200, JSON.stringify(payload));
      }
      assert.equal((await h.call('GET', '/api/admin/whatsapp/conversations')).json.data.length, 0);
    });

    it('ignores changes for another phone number on the same app', async () => {
      useEnvConfig();
      const res = await h.webhook(
        inboundPayload(
          { id: 'wamid.OTHER', timestamp: secondsAgo(h.clock, 5), type: 'text', text: { body: 'x' } },
          { phoneNumberId: '555555555555' },
        ),
      );
      assert.equal(res.res.status, 200);
      assert.equal((await h.call('GET', '/api/admin/whatsapp/conversations')).json.data.length, 0);
    });
  });

  describe('inbound', () => {
    it('creates the conversation with the contact name, unread and an open window', async () => {
      useEnvConfig();
      await inboundText(h, 'wamid.IN1', 'السلام عليكم', 120);
      const list = await h.call('GET', '/api/admin/whatsapp/conversations');
      assert.equal(list.res.status, 200);
      assert.equal(list.json.success, true);
      const [chat] = list.json.data;
      assert.equal(chat.waId, CUSTOMER);
      assert.equal(chat.name, 'نواف');
      assert.equal(chat.phone, '0501234567');
      assert.equal(chat.unread, 1);
      assert.equal(chat.windowOpen, true);
      assert.equal(chat.status, 'open');
      assert.equal(chat.assignedTo, null);
      assert.equal(chat.lastInboundAt, new Date(h.clock.now.getTime() - 120_000).toISOString());
      assert.deepEqual(chat.lastMessage, {
        text: 'السلام عليكم',
        type: 'text',
        direction: 'in',
        at: chat.lastInboundAt,
      });
      assert.deepEqual((await h.call('GET', '/api/admin/whatsapp/unread')).json, { success: true, data: { count: 1 } });

      const thread = await h.call('GET', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages`);
      assert.equal(thread.res.status, 200);
      assert.equal(thread.json.data.conversation.waId, CUSTOMER);
      const [message] = thread.json.data.messages;
      assert.match(message.id, /^wam-/);
      assert.equal(message.wamid, 'wamid.IN1');
      assert.equal(message.direction, 'in');
      assert.equal(message.status, 'received');
      assert.equal(message.via, 'customer');
      assert.equal(message.sentBy, null);
      assert.equal(message.template, null);
      assert.equal(message.location, null);
      assert.equal(message.error, null);
    });

    it('ignores a Meta retry of the same wamid', async () => {
      useEnvConfig();
      await inboundText(h, 'wamid.IN1', 'مرحبا');
      await inboundText(h, 'wamid.IN1', 'مرحبا');
      const thread = await h.call('GET', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages`);
      assert.equal(thread.json.data.messages.length, 1);
      assert.equal(thread.json.data.conversation.unread, 1);
    });

    it('stores media, location, button, interactive, reaction and unknown types', async () => {
      useEnvConfig();
      const ts = secondsAgo(h.clock, 30);
      const payload = inboundPayload({ id: 'x', timestamp: ts, type: 'text', text: { body: 'a' } });
      payload.entry[0].changes[0].value.messages = [
        { from: CUSTOMER, id: 'w1', timestamp: ts, type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg', caption: 'صورة' } },
        {
          from: CUSTOMER,
          id: 'w2',
          timestamp: ts,
          type: 'document',
          document: { id: 'DOC1', mime_type: 'application/pdf', filename: 'عرض.pdf' },
        },
        {
          from: CUSTOMER,
          id: 'w3',
          timestamp: ts,
          type: 'location',
          location: { latitude: 24.7, longitude: 46.6, name: 'البوليفارد', address: 'الرياض' },
        },
        { from: CUSTOMER, id: 'w4', timestamp: ts, type: 'button', button: { text: 'نعم', payload: 'YES' } },
        { from: CUSTOMER, id: 'w5', timestamp: ts, type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'a', title: 'الخيار أ' } } },
        { from: CUSTOMER, id: 'w6', timestamp: ts, type: 'reaction', reaction: { message_id: 'wamid.OUT1', emoji: '👍' } },
        { from: CUSTOMER, id: 'w7', timestamp: ts, type: 'contacts', contacts: [] },
        { from: CUSTOMER, id: 'w8', timestamp: ts, type: 'audio', audio: { id: 'AUD1', mime_type: 'audio/ogg; codecs=opus' } },
      ] as any;
      assert.equal((await h.webhook(payload)).res.status, 200);
      const messages = (await h.call('GET', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages`)).json.data.messages;
      const by = (wamid: string) => messages.find((m: any) => m.wamid === wamid);
      assert.equal(by('w1').type, 'image');
      assert.equal(by('w1').mediaId, 'MEDIA1');
      assert.equal(by('w1').caption, 'صورة');
      assert.equal(by('w2').fileName, 'عرض.pdf');
      assert.equal(by('w2').mimeType, 'application/pdf');
      assert.deepEqual(by('w3').location, { latitude: 24.7, longitude: 46.6, name: 'البوليفارد', address: 'الرياض' });
      assert.equal(by('w4').text, 'نعم');
      assert.equal(by('w5').type, 'interactive');
      assert.equal(by('w5').text, 'الخيار أ');
      assert.equal(by('w6').type, 'reaction');
      assert.equal(by('w6').text, '👍');
      assert.equal(by('w6').reactionTo, 'wamid.OUT1');
      assert.equal(by('w7').type, 'unsupported');
      assert.equal(by('w8').type, 'audio');
      const chat = (await h.call('GET', '/api/admin/whatsapp/conversations')).json.data[0];
      assert.equal(chat.unread, 8);
    });

    it('marks the window closed after 24 hours', async () => {
      useEnvConfig();
      await inboundText(h, 'wamid.IN1', 'hi', 25 * 3600);
      const chat = (await h.call('GET', '/api/admin/whatsapp/conversations')).json.data[0];
      assert.equal(chat.windowOpen, false);
    });

    it('sorts conversations by last activity', async () => {
      useEnvConfig();
      await inboundText(h, 'wamid.A', 'old', 600, { from: '966500000001', name: 'أ' });
      await inboundText(h, 'wamid.B', 'new', 60, { from: '966500000002', name: 'ب' });
      await inboundText(h, 'wamid.C', 'middle', 300, { from: '447700900123', name: 'C' });
      const list = (await h.call('GET', '/api/admin/whatsapp/conversations')).json.data;
      assert.deepEqual(
        list.map((c: any) => c.waId),
        ['966500000002', '447700900123', '966500000001'],
      );
      assert.equal(list[1].phone, '+447700900123');
      assert.equal((await h.call('GET', '/api/admin/whatsapp/unread')).json.data.count, 3);
    });
  });

  describe('sending', () => {
    it('sends text inside the window with the right Graph request and stores it with sentBy', async () => {
      useEnvConfig();
      await inboundText(h, 'wamid.IN1', 'كم السعر؟');
      const sent = await h.call('POST', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages`, { text: '٥٠٠ ريال' });
      assert.equal(sent.res.status, 201);
      assert.equal(sent.json.success, true);
      const message = sent.json.data;
      assert.equal(message.wamid, 'wamid.OUT1');
      assert.equal(message.direction, 'out');
      assert.equal(message.status, 'sent');
      assert.equal(message.via, 'dashboard');
      assert.equal(message.text, '٥٠٠ ريال');
      assert.deepEqual(message.sentBy, { id: USERS.manager.id, name: USERS.manager.name });

      const call = h.graph.calls.find((c) => c.method === 'POST' && c.body?.type === 'text');
      assert.ok(call);
      assert.equal(call.url, `${GRAPH}/v23.0/${PHONE_ID}/messages`);
      assert.equal(call.auth, `Bearer ${TOKEN}`);
      assert.deepEqual(call.body, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: CUSTOMER,
        type: 'text',
        text: { body: '٥٠٠ ريال', preview_url: true },
      });

      const thread = (await h.call('GET', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages`)).json.data;
      assert.equal(thread.messages.length, 2);
      assert.equal(thread.conversation.lastMessage.direction, 'out');
      assert.equal(thread.conversation.lastMessage.text, '٥٠٠ ريال');

      const after = await h.call('GET', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages?after=${thread.messages[0].id}`);
      assert.deepEqual(after.json.data.messages.map((m: any) => m.wamid), ['wamid.OUT1']);
    });

    it('honours WHATSAPP_GRAPH_VERSION', async () => {
      useEnvConfig();
      process.env.WHATSAPP_GRAPH_VERSION = 'v99.0';
      await inboundText(h, 'wamid.IN1', 'hi');
      await h.call('POST', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages`, { text: 'x' });
      assert.ok(h.graph.calls.some((c) => c.url === `${GRAPH}/v99.0/${PHONE_ID}/messages`));
    });

    it('refuses free text once the 24-hour window has closed', async () => {
      useEnvConfig();
      await inboundText(h, 'wamid.IN1', 'hi', 60);
      h.clock.now = new Date(h.clock.now.getTime() + 25 * 3600_000);
      const res = await h.call('POST', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages`, { text: 'متأخر' });
      assert.equal(res.res.status, 409);
      assert.deepEqual(res.json, {
        success: false,
        error: 'مرّ أكثر من 24 ساعة على آخر رسالة من العميل — واتساب يسمح فقط برسالة قالب معتمدة.',
        windowClosed: true,
      });
      assert.equal(h.graph.calls.filter((c) => c.method === 'POST').length, 0);
    });

    it('answers 502 on a Graph error and stores nothing', async () => {
      useEnvConfig();
      await inboundText(h, 'wamid.IN1', 'hi');
      h.graph.state.sendError = { status: 400, message: 'Re-engagement message' };
      const res = await h.call('POST', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages`, { text: 'x' });
      assert.equal(res.res.status, 502);
      assert.equal(res.json.success, false);
      assert.match(res.json.error, /Re-engagement message/);
      assert.match(res.json.error, /تعذر/);
      const thread = (await h.call('GET', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages`)).json.data;
      assert.equal(thread.messages.length, 1);
      assert.equal(thread.conversation.lastMessage.direction, 'in');
    });

    it('validates text, unknown chats and missing configuration', async () => {
      useEnvConfig();
      await inboundText(h, 'wamid.IN1', 'hi');
      assert.equal((await h.call('POST', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages`, { text: '  ' })).res.status, 400);
      assert.equal(
        (await h.call('POST', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages`, { text: 'x'.repeat(4097) })).res.status,
        400,
      );
      assert.equal((await h.call('POST', '/api/admin/whatsapp/conversations/966500000999/messages', { text: 'x' })).res.status, 404);
      assert.equal((await h.call('GET', '/api/admin/whatsapp/conversations/966500000999/messages')).res.status, 404);
      assert.equal((await h.call('GET', '/api/admin/whatsapp/conversations/..%2Fusers/messages')).res.status, 404);
      delete process.env.WHATSAPP_ACCESS_TOKEN;
      const res = await h.call('POST', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages`, { text: 'x' });
      assert.equal(res.res.status, 503);
    });

    it('applies delivered/read/failed statuses to outbound messages without moving backwards', async () => {
      useEnvConfig();
      await inboundText(h, 'wamid.IN1', 'hi');
      await h.call('POST', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages`, { text: 'one' });
      await h.call('POST', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages`, { text: 'two' });
      const ts = secondsAgo(h.clock, 0);
      await h.webhook(statusPayload([{ id: 'wamid.OUT1', status: 'delivered', timestamp: ts, recipient_id: CUSTOMER }]));
      let messages = (await h.call('GET', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages`)).json.data.messages;
      assert.equal(messages.find((m: any) => m.wamid === 'wamid.OUT1').status, 'delivered');

      await h.webhook(statusPayload([{ id: 'wamid.OUT1', status: 'read', timestamp: ts, recipient_id: CUSTOMER }]));
      await h.webhook(statusPayload([{ id: 'wamid.OUT1', status: 'delivered', timestamp: ts, recipient_id: CUSTOMER }]));
      await h.webhook(
        statusPayload([
          {
            id: 'wamid.OUT2',
            status: 'failed',
            timestamp: ts,
            recipient_id: CUSTOMER,
            errors: [{ code: 131026, title: 'Message undeliverable', message: 'Message undeliverable' }],
          },
        ]),
      );
      // A status for an inbound message id or an unknown id changes nothing.
      await h.webhook(statusPayload([{ id: 'wamid.IN1', status: 'read', timestamp: ts, recipient_id: CUSTOMER }]));
      await h.webhook(statusPayload([{ id: 'wamid.NOPE', status: 'read', timestamp: ts, recipient_id: CUSTOMER }]));

      messages = (await h.call('GET', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages`)).json.data.messages;
      const one = messages.find((m: any) => m.wamid === 'wamid.OUT1');
      const two = messages.find((m: any) => m.wamid === 'wamid.OUT2');
      assert.equal(one.status, 'read');
      assert.equal(one.error, null);
      assert.equal(two.status, 'failed');
      assert.equal(two.error, 'Message undeliverable');
      assert.equal(messages.find((m: any) => m.wamid === 'wamid.IN1').status, 'received');
    });

    it('stores smb_message_echoes as outbound messages sent from the phone', async () => {
      useEnvConfig();
      await inboundText(h, 'wamid.IN1', 'hi');
      await h.call('POST', `/api/admin/whatsapp/conversations/${CUSTOMER}/read`);
      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: WABA_ID,
            changes: [
              {
                field: 'smb_message_echoes',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '966595001957', phone_number_id: PHONE_ID },
                  message_echoes: [
                    {
                      from: '966595001957',
                      to: CUSTOMER,
                      id: 'wamid.ECHO1',
                      timestamp: secondsAgo(h.clock, 10),
                      type: 'text',
                      text: { body: 'رديت من الجوال' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      assert.equal((await h.webhook(payload)).res.status, 200);
      assert.equal((await h.webhook(payload)).res.status, 200);
      const thread = (await h.call('GET', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages`)).json.data;
      const echoes = thread.messages.filter((m: any) => m.wamid === 'wamid.ECHO1');
      assert.equal(echoes.length, 1);
      assert.equal(echoes[0].direction, 'out');
      assert.equal(echoes[0].via, 'phone');
      assert.equal(echoes[0].sentBy, null);
      assert.equal(echoes[0].text, 'رديت من الجوال');
      assert.equal(thread.conversation.unread, 0);
      assert.equal(thread.conversation.lastMessage.direction, 'out');

      // An echo to a number with no chat yet opens one.
      payload.entry[0].changes[0].value.message_echoes[0].to = '966500000777';
      payload.entry[0].changes[0].value.message_echoes[0].id = 'wamid.ECHO2';
      await h.webhook(payload);
      const fresh = (await h.call('GET', '/api/admin/whatsapp/conversations')).json.data.find((c: any) => c.waId === '966500000777');
      assert.ok(fresh);
      assert.equal(fresh.unread, 0);
      assert.equal(fresh.windowOpen, false);
    });
  });

  describe('templates', () => {
    it('lists approved templates with body and parameter count', async () => {
      useEnvConfig();
      const res = await h.call('GET', '/api/admin/whatsapp/templates');
      assert.equal(res.res.status, 200);
      assert.deepEqual(res.json.data, [
        { name: 'order_update', language: 'ar', category: 'UTILITY', body: 'مرحباً {{1}}، طلبك {{2}} جاهز. شكراً {{1}}', paramCount: 2 },
        { name: 'hello', language: 'ar', category: 'MARKETING', body: 'أهلاً بك في يوصل', paramCount: 0 },
      ]);
      const call = h.graph.calls.find((c) => c.path.endsWith('/message_templates'));
      assert.ok(call);
      const url = new URL(call.url);
      assert.equal(url.searchParams.get('status'), 'APPROVED');
      assert.equal(url.searchParams.get('limit'), '200');
      assert.equal(url.searchParams.get('fields'), 'name,language,category,status,components');
    });

    it('needs the business account id', async () => {
      useEnvConfig();
      delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
      const res = await h.call('GET', '/api/admin/whatsapp/templates');
      assert.equal(res.res.status, 503);
      assert.match(res.json.error, /Business Account ID/);
    });

    it('sends a template with params even when the window is closed', async () => {
      useEnvConfig();
      await inboundText(h, 'wamid.IN1', 'hi', 3 * 24 * 3600);
      const res = await h.call(
        'POST',
        `/api/admin/whatsapp/conversations/${CUSTOMER}/template`,
        { name: 'order_update', language: 'ar', params: ['نواف', 'BK-1001'] },
        'admin',
      );
      assert.equal(res.res.status, 201);
      const message = res.json.data;
      assert.equal(message.type, 'template');
      assert.equal(message.text, 'مرحباً نواف، طلبك BK-1001 جاهز. شكراً نواف');
      assert.deepEqual(message.template, { name: 'order_update', language: 'ar' });
      assert.deepEqual(message.sentBy, { id: USERS.admin.id, name: USERS.admin.name });
      assert.equal(message.via, 'dashboard');
      const call = h.graph.calls.find((c) => c.method === 'POST' && c.body?.type === 'template');
      assert.ok(call);
      assert.deepEqual(call.body, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: CUSTOMER,
        type: 'template',
        template: {
          name: 'order_update',
          language: { code: 'ar' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: 'نواف' },
                { type: 'text', text: 'BK-1001' },
              ],
            },
          ],
        },
      });
    });

    it('sends a template with no params and falls back to a label when the body is unknown', async () => {
      useEnvConfig();
      await inboundText(h, 'wamid.IN1', 'hi');
      const known = await h.call('POST', `/api/admin/whatsapp/conversations/${CUSTOMER}/template`, { name: 'hello', language: 'ar' });
      assert.equal(known.res.status, 201);
      assert.equal(known.json.data.text, 'أهلاً بك في يوصل');
      const sentBody = h.graph.calls.filter((c) => c.body?.type === 'template').at(-1)?.body;
      assert.deepEqual(sentBody.template.components, []);

      delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
      const unknown = await h.call('POST', `/api/admin/whatsapp/conversations/${CUSTOMER}/template`, {
        name: 'promo_new',
        language: 'en_US',
        params: [],
      });
      assert.equal(unknown.res.status, 201);
      assert.equal(unknown.json.data.text, '[قالب: promo_new]');
    });

    it('rejects bad template input', async () => {
      useEnvConfig();
      await inboundText(h, 'wamid.IN1', 'hi');
      const route = `/api/admin/whatsapp/conversations/${CUSTOMER}/template`;
      assert.equal((await h.call('POST', route, { name: 'Bad Name', language: 'ar' })).res.status, 400);
      assert.equal((await h.call('POST', route, { name: 'hello', language: '' })).res.status, 400);
      assert.equal((await h.call('POST', route, { name: 'hello', language: 'ar', params: ['ok', ''] })).res.status, 400);
      assert.equal((await h.call('POST', route, { name: 'hello', language: 'ar', params: 'x' })).res.status, 400);
    });

    it('starts a new conversation from a local Saudi number', async () => {
      useEnvConfig();
      const res = await h.call('POST', '/api/admin/whatsapp/start', {
        phone: '050 123 4567',
        name: 'عميل جديد',
        template: 'order_update',
        language: 'ar',
        params: ['أحمد', 'BK-7'],
      });
      assert.equal(res.res.status, 201);
      assert.equal(res.json.data.conversation.waId, CUSTOMER);
      assert.equal(res.json.data.conversation.name, 'عميل جديد');
      assert.equal(res.json.data.conversation.phone, '0501234567');
      assert.equal(res.json.data.conversation.windowOpen, false);
      assert.equal(res.json.data.message.text, 'مرحباً أحمد، طلبك BK-7 جاهز. شكراً أحمد');
      assert.equal(h.graph.calls.find((c) => c.body?.type === 'template')?.body.to, CUSTOMER);
      assert.equal((await h.call('GET', '/api/admin/whatsapp/conversations')).json.data.length, 1);
    });

    it('normalizes every accepted phone form and refuses bad ones without sending', async () => {
      useEnvConfig();
      const start = (phone: string) =>
        h.call('POST', '/api/admin/whatsapp/start', { phone, template: 'hello', language: 'ar' });
      for (const phone of ['0501234567', '501234567', '+966501234567', '00966501234567', '+966 0501234567']) {
        const res = await start(phone);
        assert.equal(res.res.status, 201, phone);
        assert.equal(res.json.data.conversation.waId, CUSTOMER, phone);
      }
      const intl = await start('+44 7700 900123');
      assert.equal(intl.json.data.conversation.waId, '447700900123');
      assert.equal(intl.json.data.conversation.phone, '+447700900123');
      const sentBefore = h.graph.state.sent;
      for (const phone of ['12345', '0401234567', '+96650123', 'abc', '']) {
        const res = await start(phone);
        assert.equal(res.res.status, 400, phone);
      }
      assert.equal(h.graph.state.sent, sentBefore);
      assert.equal((await h.call('GET', '/api/admin/whatsapp/conversations')).json.data.length, 2);
    });

    it('creates nothing when the template send fails', async () => {
      useEnvConfig();
      h.graph.state.sendError = { status: 400, message: 'Template name does not exist in the translation' };
      const res = await h.call('POST', '/api/admin/whatsapp/start', { phone: '0501234567', template: 'hello', language: 'ar' });
      assert.equal(res.res.status, 502);
      assert.match(res.json.error, /Template name does not exist/);
      assert.equal((await h.call('GET', '/api/admin/whatsapp/conversations')).json.data.length, 0);
    });
  });

  describe('conversation management', () => {
    it('read zeroes unread and sends a best-effort read receipt for the last inbound message', async () => {
      useEnvConfig();
      await inboundText(h, 'wamid.IN1', 'one', 120);
      await inboundText(h, 'wamid.IN2', 'two', 60);
      const res = await h.call('POST', `/api/admin/whatsapp/conversations/${CUSTOMER}/read`);
      assert.equal(res.res.status, 200);
      assert.equal(res.json.data.unread, 0);
      assert.equal((await h.call('GET', '/api/admin/whatsapp/unread')).json.data.count, 0);
      const receipts = h.graph.calls.filter((c) => c.body?.status === 'read');
      assert.equal(receipts.length, 1);
      assert.deepEqual(receipts[0].body, { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.IN2' });

      // Already receipted: no second call.
      await h.call('POST', `/api/admin/whatsapp/conversations/${CUSTOMER}/read`);
      assert.equal(h.graph.calls.filter((c) => c.body?.status === 'read').length, 1);

      // A failing receipt never fails the request.
      await inboundText(h, 'wamid.IN3', 'three', 30);
      h.graph.state.readError = true;
      const again = await h.call('POST', `/api/admin/whatsapp/conversations/${CUSTOMER}/read`);
      assert.equal(again.res.status, 200);
      assert.equal(again.json.data.unread, 0);
      assert.equal((await h.call('POST', '/api/admin/whatsapp/conversations/966500000999/read')).res.status, 404);
    });

    it('assigns to staff, refuses non-staff, closes, renames, and an inbound message reopens', async () => {
      useEnvConfig();
      await inboundText(h, 'wamid.IN1', 'hi');
      const route = `/api/admin/whatsapp/conversations/${CUSTOMER}`;
      const assigned = await h.call('PATCH', route, { assignedTo: USERS.manager.id });
      assert.equal(assigned.res.status, 200);
      assert.deepEqual(assigned.json.data.assignedTo, { id: USERS.manager.id, name: USERS.manager.name });

      assert.equal((await h.call('PATCH', route, { assignedTo: USERS.client.id })).res.status, 400);
      assert.equal((await h.call('PATCH', route, { assignedTo: 'usr-nobody' })).res.status, 400);
      assert.equal((await h.call('PATCH', route, { status: 'archived' })).res.status, 400);

      const closed = await h.call('PATCH', route, { status: 'closed', name: 'نواف العتيبي' });
      assert.equal(closed.json.data.status, 'closed');
      assert.equal(closed.json.data.name, 'نواف العتيبي');
      assert.deepEqual(closed.json.data.assignedTo, { id: USERS.manager.id, name: USERS.manager.name });

      await inboundText(h, 'wamid.IN2', 'رجعت', 10);
      const chat = (await h.call('GET', '/api/admin/whatsapp/conversations')).json.data[0];
      assert.equal(chat.status, 'open');
      // A staff-set name survives the profile name on later messages.
      assert.equal(chat.name, 'نواف العتيبي');

      const unassigned = await h.call('PATCH', route, { assignedTo: null, name: '' });
      assert.equal(unassigned.json.data.assignedTo, null);
      assert.equal(unassigned.json.data.name, 'نواف');
      assert.equal((await h.call('PATCH', '/api/admin/whatsapp/conversations/966500000999', { status: 'closed' })).res.status, 404);
    });

    it('lists the team for the assign dropdown', async () => {
      const res = await h.call('GET', '/api/admin/whatsapp/team');
      assert.equal(res.res.status, 200);
      assert.deepEqual(
        res.json.data.sort((a: any, b: any) => a.id.localeCompare(b.id)),
        [
          { id: USERS.admin.id, name: USERS.admin.name, role: 'admin' },
          { id: USERS.manager.id, name: USERS.manager.name, role: 'accounts_manager' },
        ],
      );
    });
  });

  describe('media proxy', () => {
    it('refuses a media id that is not in a stored message', async () => {
      useEnvConfig();
      const res = await h.call('GET', '/api/admin/whatsapp/media/MEDIA1');
      assert.equal(res.res.status, 404);
      assert.equal(h.graph.calls.length, 0);
    });

    it('streams a stored media id with its content type and a private cache header', async () => {
      useEnvConfig();
      await h.webhook(
        inboundPayload({
          id: 'wamid.IMG',
          timestamp: secondsAgo(h.clock, 5),
          type: 'image',
          image: { id: 'MEDIA1', mime_type: 'image/jpeg' },
        }),
      );
      const cookie = await h.login('manager');
      const res = await fetch(`${h.server.url}/api/admin/whatsapp/media/MEDIA1`, { headers: { cookie } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/jpeg');
      assert.equal(res.headers.get('cache-control'), 'private, max-age=300');
      assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0xff, 0xd8, 0xff, 1, 2, 3]);
      const download = h.graph.calls.find((c) => c.path === '/download/MEDIA1');
      assert.equal(download?.auth, `Bearer ${TOKEN}`);

      delete process.env.WHATSAPP_ACCESS_TOKEN;
      assert.equal((await h.call('GET', '/api/admin/whatsapp/media/MEDIA1')).res.status, 503);
    });
  });

  describe('permissions', () => {
    it('401 without a session, 403 for clients and vendors, accounts_manager works the inbox but cannot change settings', async () => {
      useEnvConfig();
      const inbox: Array<[string, string, unknown?]> = [
        ['GET', '/api/admin/whatsapp/conversations'],
        ['GET', '/api/admin/whatsapp/unread'],
        ['GET', '/api/admin/whatsapp/team'],
        ['GET', '/api/admin/whatsapp/settings'],
        ['GET', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages`],
        ['POST', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages`, { text: 'x' }],
        ['POST', `/api/admin/whatsapp/conversations/${CUSTOMER}/read`],
        ['POST', `/api/admin/whatsapp/conversations/${CUSTOMER}/template`, { name: 'hello', language: 'ar' }],
        ['PATCH', `/api/admin/whatsapp/conversations/${CUSTOMER}`, { status: 'closed' }],
        ['GET', '/api/admin/whatsapp/templates'],
        ['POST', '/api/admin/whatsapp/start', { phone: '0501234567', template: 'hello', language: 'ar' }],
        ['GET', '/api/admin/whatsapp/media/MEDIA1'],
        ['PUT', '/api/admin/whatsapp/settings', {}],
        ['POST', '/api/admin/whatsapp/settings/test'],
      ];
      for (const [method, route, body] of inbox) {
        assert.equal((await h.call(method, route, body, null)).res.status, 401, `guest ${method} ${route}`);
        assert.equal((await h.call(method, route, body, 'client')).res.status, 403, `client ${method} ${route}`);
        assert.equal((await h.call(method, route, body, 'vendor')).res.status, 403, `vendor ${method} ${route}`);
      }
      assert.equal(h.graph.calls.length, 0);

      await inboundText(h, 'wamid.IN1', 'hi');
      assert.equal((await h.call('GET', '/api/admin/whatsapp/conversations', undefined, 'manager')).res.status, 200);
      assert.equal((await h.call('GET', '/api/admin/whatsapp/settings', undefined, 'manager')).res.status, 200);
      assert.equal(
        (await h.call('POST', `/api/admin/whatsapp/conversations/${CUSTOMER}/messages`, { text: 'x' }, 'manager')).res.status,
        201,
      );
      assert.equal((await h.call('PUT', '/api/admin/whatsapp/settings', { appSecret: 'x' }, 'manager')).res.status, 403);
      assert.equal((await h.call('POST', '/api/admin/whatsapp/settings/test', undefined, 'manager')).res.status, 403);
      assert.equal((await h.call('POST', '/api/admin/whatsapp/settings/test', undefined, 'admin')).res.status, 200);
    });
  });

  describe('settings', () => {
    it('saves, verifies with Meta, masks the token and never echoes secrets', async () => {
      const put = await h.call(
        'PUT',
        '/api/admin/whatsapp/settings',
        { accessToken: TOKEN, phoneNumberId: PHONE_ID, businessAccountId: WABA_ID, appSecret: APP_SECRET },
        'admin',
      );
      assert.equal(put.res.status, 200);
      const data = put.json.data;
      assert.equal(data.configured, true);
      assert.equal(data.tokenMasked, 'EAAG…x9Q4');
      assert.equal(data.appSecretSet, true);
      assert.equal(data.phoneNumberId, PHONE_ID);
      assert.equal(data.businessAccountId, WABA_ID);
      assert.equal(data.displayPhone, '+966 59 500 1957');
      assert.equal(data.verifiedName, 'Usil');
      assert.equal(data.graphVersion, 'v23.0');
      assert.equal(data.webhookUrl, 'https://hooks.usil.app/api/whatsapp/webhook');
      assert.deepEqual(data.source, {
        token: 'saved',
        phoneNumberId: 'saved',
        businessAccountId: 'saved',
        appSecret: 'saved',
        verifyToken: 'saved',
      });
      assert.equal(put.text.includes(TOKEN), false);
      assert.equal(put.text.includes(APP_SECRET), false);
      const verify = h.graph.calls.find((c) => c.path === `/v23.0/${PHONE_ID}`);
      assert.ok(verify);
      assert.equal(new URL(verify.url).searchParams.get('fields'), 'display_phone_number,verified_name');
      assert.equal(verify.auth, `Bearer ${TOKEN}`);

      const file = path.join(h.dir, 'whatsapp-settings.json');
      const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
      assert.equal(saved.accessToken, TOKEN);
      assert.equal(saved.appSecret, APP_SECRET);
      if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

      // Blank and masked values keep what is saved.
      const keep = await h.call('PUT', '/api/admin/whatsapp/settings', { accessToken: 'EAAG…x9Q4', appSecret: '' }, 'admin');
      assert.equal(keep.res.status, 200);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf-8')).accessToken, TOKEN);
      assert.equal(keep.json.data.appSecretSet, true);

      // The webhook now verifies with the saved secret.
      const hook = await h.webhook(inboundPayload({ id: 'w', timestamp: secondsAgo(h.clock, 1), type: 'text', text: { body: 'x' } }));
      assert.equal(hook.res.status, 200);

      // Clearing removes a value.
      const cleared = await h.call('PUT', '/api/admin/whatsapp/settings', { clear: ['appSecret', 'businessAccountId'] }, 'admin');
      assert.equal(cleared.res.status, 200);
      assert.equal(cleared.json.data.appSecretSet, false);
      assert.equal(cleared.json.data.businessAccountId, '');
      assert.equal(cleared.json.data.configured, false);
      assert.equal(cleared.json.data.source.appSecret, 'none');
    });

    it('returns Meta’s error in Arabic and writes nothing when verification fails', async () => {
      h.graph.state.verifyError = 'Unsupported get request. Object with ID does not exist';
      const put = await h.call('PUT', '/api/admin/whatsapp/settings', { accessToken: TOKEN, phoneNumberId: PHONE_ID }, 'admin');
      assert.equal(put.res.status, 400);
      assert.equal(put.json.success, false);
      assert.match(put.json.error, /Object with ID does not exist/);
      assert.match(put.json.error, /تعذر/);
      const saved = JSON.parse(fs.readFileSync(path.join(h.dir, 'whatsapp-settings.json'), 'utf-8'));
      assert.equal(saved.accessToken, '');
      assert.equal(saved.phoneNumberId, '');

      const badId = await h.call('PUT', '/api/admin/whatsapp/settings', { phoneNumberId: 'abc' }, 'admin');
      assert.equal(badId.res.status, 400);
    });

    it('lets env vars override saved values and reports the source', async () => {
      await h.call(
        'PUT',
        '/api/admin/whatsapp/settings',
        { accessToken: TOKEN, phoneNumberId: PHONE_ID, appSecret: 'saved-secret-aaaaaaaaaaaa' },
        'admin',
      );
      process.env.WHATSAPP_APP_SECRET = APP_SECRET;
      process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = WABA_ID;
      process.env.WHATSAPP_VERIFY_TOKEN = VERIFY;
      process.env.WHATSAPP_GRAPH_VERSION = 'v24.0';
      process.env.WHATSAPP_WEBHOOK_URL = 'https://example.test/';
      const get = await h.call('GET', '/api/admin/whatsapp/settings', undefined, 'manager');
      const data = get.json.data;
      assert.equal(data.source.appSecret, 'env');
      assert.equal(data.source.businessAccountId, 'env');
      assert.equal(data.source.token, 'saved');
      assert.equal(data.source.verifyToken, 'env');
      assert.equal(data.verifyToken, VERIFY);
      assert.equal(data.businessAccountId, WABA_ID);
      assert.equal(data.graphVersion, 'v24.0');
      assert.equal(data.webhookUrl, 'https://example.test/api/whatsapp/webhook');
      // The env secret, not the saved one, signs webhooks now.
      const payload = { object: 'whatsapp_business_account', entry: [] };
      assert.equal((await h.webhook(payload, sign(JSON.stringify(payload), 'saved-secret-aaaaaaaaaaaa'))).res.status, 401);
      assert.equal((await h.webhook(payload)).res.status, 200);
    });

    it('test endpoint verifies the number, 503 when unconfigured', async () => {
      const none = await h.call('POST', '/api/admin/whatsapp/settings/test', undefined, 'admin');
      assert.equal(none.res.status, 503);
      useEnvConfig();
      const ok = await h.call('POST', '/api/admin/whatsapp/settings/test', undefined, 'admin');
      assert.deepEqual(ok.json, { success: true, data: { displayPhone: '+966 59 500 1957', verifiedName: 'Usil' } });
      h.graph.state.verifyError = 'Error validating access token';
      const bad = await h.call('POST', '/api/admin/whatsapp/settings/test', undefined, 'admin');
      assert.equal(bad.res.status, 400);
      assert.match(bad.json.error, /Error validating access token/);
    });
  });
});

describe('createApp wiring', () => {
  it('keeps the raw webhook body through the global JSON parser', async () => {
    const saved = process.env.WHATSAPP_APP_SECRET;
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-whatsapp-app-'));
    const { url, close } = await listen(createApp({ rootDir, readIndexHtml: () => '<html></html>' }));
    try {
      const raw = `{"object":"whatsapp_business_account","entry":[{"changes":[{"field":"messages","value":{"contacts":[{"wa_id":"${CUSTOMER}","profile":{"name":"نواف"}}],"messages":[{"from":"${CUSTOMER}","id":"wamid.APP1","timestamp":"1760000000","type":"text","text":{"body":"hi"}}]}}]}]}`;
      const post = (signature: string) =>
        fetch(`${url}/api/whatsapp/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
          body: raw,
        });
      assert.equal((await post(sign(raw, 'wrong'))).status, 401);
      assert.equal((await post(sign(raw))).status, 200);
      const conversations = JSON.parse(fs.readFileSync(path.join(rootDir, 'data', 'whatsapp', 'conversations.json'), 'utf-8'));
      assert.equal(conversations[0].waId, CUSTOMER);
      // Everything else still parses JSON as before.
      const login = await fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@usil.sa', password: 'x' }),
      });
      assert.notEqual(login.status, 500);
      assert.equal((await fetch(`${url}/api/admin/whatsapp/conversations`)).status, 401);
    } finally {
      await close();
      if (saved === undefined) delete process.env.WHATSAPP_APP_SECRET;
      else process.env.WHATSAPP_APP_SECRET = saved;
    }
  });
});
