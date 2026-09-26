import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { registerGeminiRoutes } from './gemini-routes.ts';
import { seedApprovedAndRejected } from '../shared/approved-catalog.fixtures.ts';

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

function seededApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-gemini-'));
  seedApprovedAndRejected(dir);
  const app = express();
  app.use(express.json());
  registerGeminiRoutes(app, { dataDir: dir });
  return app;
}

async function post(url: string, route: string, body: unknown) {
  const res = await fetch(`${url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe('gemini routes without a configured provider', () => {
  before(() => {
    delete process.env.GEMINI_API_KEY;
  });

  it('answers 503 with an Arabic message instead of fabricating results', async () => {
    const { url, close } = await listen(seededApp());
    try {
      const cases: Array<[string, unknown]> = [
        ['/api/gemini/generate-review', { role: 'client', partyName: 'مورد', serviceTitle: 'قهوة', rating: 5 }],
        ['/api/gemini/analyze-reviews', { targetName: 'مورد', targetType: 'vendor', reviews: [] }],
        ['/api/gemini/generate-music', { prompt: 'زفة' }],
        ['/api/gemini/transcribe-audio', { base64Audio: 'data:audio/webm;base64,AAAA' }],
        ['/api/gemini/search-grounding', { query: 'أسعار البن' }],
        ['/api/gemini/maps-grounding', { query: 'قاعات الرياض' }],
        ['/api/gemini/chat', { messages: [{ role: 'user', content: 'مرحبا' }] }],
        ['/api/gemini/generate-image', { prompt: 'دلة' }],
      ];
      for (const [route, body] of cases) {
        const { status, json } = await post(url, route, body);
        assert.equal(status, 503, route);
        assert.equal(json.aiGenerated, false, route);
        assert.match(String(json.error || ''), /[؀-ۿ]/, `${route} has an Arabic error`);
        for (const fabricated of ['audioUrl', 'transcription', 'structuredEvent', 'aiTrustScore', 'review', 'answer', 'reply']) {
          assert.equal(fabricated in json, false, `${route} returned ${fabricated}`);
        }
      }
    } finally {
      await close();
    }
  });

  it('keeps /status reporting availability and counts only approved listings', async () => {
    const { url, close } = await listen(seededApp());
    try {
      const res = await fetch(`${url}/api/gemini/status`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.available, false);
      assert.equal(json.geminiAvailable, false);
      assert.equal(json.catalogSize, 1);
    } finally {
      await close();
    }
  });

  it('never offers a rejected vendor listing in catalog matching or the voice fallback', async () => {
    const { url, close } = await listen(seededApp());
    try {
      const match = await post(url, '/api/gemini/match-packages', { brief: 'قهوة لمناسبة في الرياض', city: 'الرياض' });
      assert.equal(match.status, 200);
      assert.equal(match.json.catalogSize, 1);
      assert.doesNotMatch(JSON.stringify(match.json), /lst-rejected|المورد المرفوض/);

      const voice = await post(url, '/api/gemini/voice-assistant', { userSpeech: 'أبي قهوة وضيافة' });
      assert.equal(voice.status, 200);
      assert.equal(voice.json.suggestedServiceIds.includes('lst-rejected'), false);
      assert.deepEqual(voice.json.suggestedServiceIds, ['lst-approved']);
    } finally {
      await close();
    }
  });

  it('prefers the injected approved-vendor list over users.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-gemini-'));
    seedApprovedAndRejected(dir);
    const app = express();
    app.use(express.json());
    registerGeminiRoutes(app, { dataDir: dir, listVendorUsers: () => [] });
    const { url, close } = await listen(app);
    try {
      const json = await (await fetch(`${url}/api/gemini/status`)).json();
      assert.equal(json.catalogSize, 0);
    } finally {
      await close();
    }
  });
});

describe('gemini routes log labels', () => {
  it('names the active provider, not Gemini, when a text route fails', async () => {
    const failing = {
      activeProvider: () => 'anthropic',
      settings: () => ({}),
      textClient: () => ({
        models: {
          generateContent: async () => {
            throw new Error('boom');
          },
        },
      }),
    };
    const app = express();
    app.use(express.json());
    registerGeminiRoutes(app, { ai: failing as never });
    const original = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(String(args[0]));
    };
    const { url, close } = await listen(app);
    try {
      const { status } = await post(url, '/api/gemini/chat', { messages: [{ role: 'user', content: 'مرحبا' }] });
      assert.equal(status, 502);
    } finally {
      console.error = original;
      await close();
    }
    assert.ok(logged.some((line) => line.includes('Anthropic')), logged.join('\n'));
    assert.ok(!logged.some((line) => line.includes('Gemini')));
  });
});
