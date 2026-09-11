import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createAiRouter, providerErrorMessageAr, redactSecrets } from './ai-providers.ts';
import { createIntegrationsStore } from './integrations-store.ts';

function tmpStore() {
  return createIntegrationsStore(fs.mkdtempSync(path.join(os.tmpdir(), 'usil-ai-router-')));
}

type Call = { url: string; init: RequestInit };

function fakeFetch(handler: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const impl = (async (url: unknown, init: unknown) => {
    const call = { url: String(url), init: (init || {}) as RequestInit };
    calls.push(call);
    const { status, body } = handler(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ENV_NAMES = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'OPENAI_API_KEY'];
let savedEnv: Record<string, string | undefined> = {};

describe('ai-providers', () => {
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

  it('redacts keys out of any text before it can reach a log', () => {
    const key = 'sk-ant-api03-supersecretvalue';
    assert.equal(redactSecrets(`failed for ${key}`, [key]), 'failed for ***');
    assert.equal(redactSecrets('bad key sk-proj-abcdefghijkl'), 'bad key sk-***');
    assert.equal(redactSecrets('bad key AIzaSyABCDEFGHIJKL'), 'bad key AIza***');
  });

  it('maps provider HTTP codes to Arabic operator messages', () => {
    assert.match(providerErrorMessageAr('anthropic', 401), /المفتاح مرفوض/);
    assert.match(providerErrorMessageAr('openai', 404), /اسم الموديل غير موجود/);
    assert.match(providerErrorMessageAr('openai', 429), /حد الاستخدام/);
    assert.match(providerErrorMessageAr('gemini', 0), /تعذر وصول الخادم/);
    assert.match(providerErrorMessageAr('gemini', 503), /يرد بخطأ من جهته/);
  });

  it('reports no active provider until a key is saved', () => {
    const store = tmpStore();
    const router = createAiRouter(store);
    assert.equal(router.activeProvider(), null);
    store.save({ defaultProvider: 'anthropic', anthropic: { apiKey: 'sk-ant-key-abcd1234' } });
    assert.equal(router.activeProvider(), 'anthropic');
  });

  it('routes chat through Claude with the saved model and never leaks the key into the body', async () => {
    const store = tmpStore();
    store.save({
      defaultProvider: 'anthropic',
      anthropic: { apiKey: 'sk-ant-live-key-8888', model: 'claude-opus-4-1' },
    });
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      body: { content: [{ type: 'text', text: 'يا هلا فيك في يوصل' }] },
    }));
    const router = createAiRouter(store, { fetchImpl: impl });

    const result = await router.generateText({
      system: 'أنت مستشار يوصل',
      messages: [{ role: 'user', content: 'أبغى ضيافة قهوة' }],
    });

    assert.equal(result?.provider, 'anthropic');
    assert.equal(result?.model, 'claude-opus-4-1');
    assert.equal(result?.text, 'يا هلا فيك في يوصل');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /api\.anthropic\.com/);
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], 'sk-ant-live-key-8888');
    assert.equal(headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.model, 'claude-opus-4-1');
    assert.equal(String(calls[0].init.body).includes('sk-ant-live-key-8888'), false);
  });

  it('routes chat through OpenAI with a system turn and JSON mode', async () => {
    const store = tmpStore();
    store.save({ defaultProvider: 'openai', openai: { apiKey: 'sk-openai-live-4444', model: 'gpt-5' } });
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      body: { choices: [{ message: { content: '{"summary":"تم"}' } }] },
    }));
    const router = createAiRouter(store, { fetchImpl: impl });

    const result = await router.generateText({
      system: 'أنت مستشار يوصل',
      messages: [{ role: 'user', content: 'طابق باقة' }],
      json: true,
    });

    assert.equal(result?.provider, 'openai');
    assert.equal(result?.text, '{"summary":"تم"}');
    assert.match(calls[0].url, /api\.openai\.com/);
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer sk-openai-live-4444');
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.model, 'gpt-5');
    assert.equal(body.messages[0].role, 'system');
    assert.deepEqual(body.response_format, { type: 'json_object' });
  });

  it('turns a rejected key into an Arabic message that omits the key', async () => {
    const store = tmpStore();
    store.save({ defaultProvider: 'openai', openai: { apiKey: 'sk-openai-bad-key-2222' } });
    const { impl } = fakeFetch(() => ({
      status: 401,
      body: { error: { message: 'Incorrect API key provided: sk-openai-bad-key-2222' } },
    }));
    const router = createAiRouter(store, { fetchImpl: impl });

    const result = await router.test('openai');
    assert.equal(result.success, false);
    assert.match(result.message, /المفتاح مرفوض/);
    assert.equal(result.message.includes('sk-openai-bad-key-2222'), false);
  });

  it('asks the admin to save a key before testing an unconfigured provider', async () => {
    const router = createAiRouter(tmpStore());
    const result = await router.test('anthropic');
    assert.equal(result.success, false);
    assert.match(result.message, /الصق مفتاح/);
  });

  it('reports a successful test with the model that answered', async () => {
    const store = tmpStore();
    store.save({ defaultProvider: 'anthropic', anthropic: { apiKey: 'sk-ant-ok-key-1234', model: 'claude-sonnet-4-5' } });
    const { impl } = fakeFetch(() => ({ status: 200, body: { content: [{ type: 'text', text: 'جاهز' }] } }));
    const router = createAiRouter(store, { fetchImpl: impl });

    const result = await router.test('anthropic');
    assert.equal(result.success, true);
    assert.match(result.message, /الاتصال ناجح/);
    assert.match(result.message, /claude-sonnet-4-5/);
  });

  it('flags an empty provider reply instead of pretending it worked', async () => {
    const store = tmpStore();
    store.save({ defaultProvider: 'openai', openai: { apiKey: 'sk-openai-empty-3333' } });
    const { impl } = fakeFetch(() => ({ status: 200, body: { choices: [{ message: { content: '' } }] } }));
    const router = createAiRouter(store, { fetchImpl: impl });

    const result = await router.test('openai');
    assert.equal(result.success, false);
    assert.match(result.message, /رد بدون نص/);
  });

  it('reports a network failure as an Arabic server-side message', async () => {
    const store = tmpStore();
    store.save({ defaultProvider: 'anthropic', anthropic: { apiKey: 'sk-ant-offline-5555' } });
    const impl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.anthropic.com');
    }) as unknown as typeof fetch;
    const router = createAiRouter(store, { fetchImpl: impl });

    const result = await router.test('anthropic');
    assert.equal(result.success, false);
    assert.match(result.message, /تعذر وصول الخادم/);
  });

  it('exposes a gemini-shaped text client so existing routes keep their call pattern', async () => {
    const store = tmpStore();
    store.save({ defaultProvider: 'anthropic', anthropic: { apiKey: 'sk-ant-shim-key-6666' } });
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      body: { content: [{ type: 'text', text: '{"review":"تجربة راقية","tags":["دقة"]}' }] },
    }));
    const router = createAiRouter(store, { fetchImpl: impl });

    const client = router.textClient();
    assert.ok(client);
    const response = await client!.models.generateContent({
      model: 'gemini-3.7-flash',
      contents: 'اكتب تقييماً',
      config: { responseMimeType: 'application/json' },
    });

    assert.equal(response.provider, 'anthropic');
    assert.match(response.text, /تجربة راقية/);
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.model, 'claude-sonnet-4-5', 'route-level gemini model must not leak to Claude');
    assert.match(body.system, /JSON/);
  });

  it('keeps the per-route gemini model when gemini is the active provider', async () => {
    const store = tmpStore();
    store.save({ defaultProvider: 'gemini', gemini: { apiKey: 'AIzaTestKey1234' } });
    const seen: string[] = [];
    const router = createAiRouter(store, {
      geminiText: async ({ model }) => {
        seen.push(model);
        return 'رد جيميناي';
      },
    });

    const client = router.textClient();
    const response = await client!.models.generateContent({
      model: 'gemini-3.7-flash',
      contents: [{ role: 'user', parts: [{ text: 'مرحبا' }] }],
      config: { temperature: 0.2 },
    });

    assert.equal(response.text, 'رد جيميناي');
    assert.deepEqual(seen, ['gemini-3.7-flash']);
  });

  it('honours a pinned gemini model over the per-route default', async () => {
    const store = tmpStore();
    store.save({ defaultProvider: 'gemini', gemini: { apiKey: 'AIzaTestKey1234', model: 'gemini-pinned' } });
    const seen: string[] = [];
    const router = createAiRouter(store, {
      geminiText: async ({ model }) => {
        seen.push(model);
        return 'رد';
      },
    });

    await router.textClient()!.models.generateContent({ model: 'gemini-3.7-flash', contents: 'مرحبا' });
    assert.deepEqual(seen, ['gemini-pinned']);
  });

  it('returns null from generateText when no provider is configured', async () => {
    const router = createAiRouter(tmpStore());
    assert.equal(await router.generateText({ messages: [{ role: 'user', content: 'مرحبا' }] }), null);
    assert.equal(router.textClient(), null);
  });
});
