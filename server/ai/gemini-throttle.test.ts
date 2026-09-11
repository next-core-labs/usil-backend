import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerGeminiRoutes } from './gemini-routes.ts';

/**
 * حراسة حدّ مسارات الذكاء الاصطناعي.
 *
 * These routes are open to anonymous visitors on purpose, so the throttle is
 * the only guard on a paid provider key. Without a provider configured the
 * handlers return their canned fallbacks, which is exactly what we want here —
 * we are asserting the limiter, not the model.
 */

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

function appWithGemini() {
  const app = express();
  app.use(express.json());
  registerGeminiRoutes(app, {});
  return app;
}

function post(url: string, route: string) {
  return fetch(`${url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'اختبار' }),
  });
}

describe('حدّ مسارات المساعد الذكي', () => {
  it('المسارات الثقيلة (صورة/موسيقى/صوت) لها حدّ أضيق', async () => {
    const server = await listen(appWithGemini());
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        statuses.push((await post(server.url, '/api/gemini/generate-music')).status);
      }
      assert.ok(
        statuses.includes(429),
        `توقعنا 429 على المسار الثقيل، والحاصل: ${statuses.join(',')}`,
      );
      assert.notEqual(statuses[0], 429, 'أول طلب لازم يمر');
    } finally {
      await server.close();
    }
  });

  it('المسارات النصية لها حدّ أوسع ولا تتأثر بحدّ الثقيلة', async () => {
    const server = await listen(appWithGemini());
    try {
      // استنزف حدّ الثقيلة أولاً.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await post(server.url, '/api/gemini/generate-image');
      }
      const text = await post(server.url, '/api/gemini/generate-review');
      assert.notEqual(text.status, 429, 'المسار النصي لازم يبقى شغالاً');
    } finally {
      await server.close();
    }
  });

  it('GET /status ما يستهلك الحدّ لأنه ما يكلّم أي مزود', async () => {
    const server = await listen(appWithGemini());
    try {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const res = await fetch(`${server.url}/api/gemini/status`);
        assert.equal(res.status, 200);
      }
    } finally {
      await server.close();
    }
  });
});
