import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { parseQuoteInput, registerLegacyRoutes } from './legacy-routes.ts';

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

function appWith(aiAvailable: boolean) {
  const app = express();
  app.use(express.json());
  registerLegacyRoutes(app, { aiAvailable: () => aiAvailable });
  return app;
}

async function post(url: string, route: string, body: string) {
  const res = await fetch(`${url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return { status: res.status, json: await res.json() };
}

describe('legacy-routes', () => {
  it('keeps the valid quote response unchanged', async () => {
    const { url, close } = await listen(appWith(false));
    try {
      const ok = await post(url, '/api/calculate-quote', JSON.stringify({ serviceIds: [1, 2], attendees: 120, days: 2 }));
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.json, {
        success: true,
        quote: { servicesCount: 0, attendees: 120, days: 2, subtotal: 0, tax: 0, totalWithTax: 0 },
      });
      const defaults = await post(url, '/api/calculate-quote', '{}');
      assert.equal(defaults.status, 200);
      assert.equal(defaults.json.quote.attendees, 50);
      assert.equal(defaults.json.quote.days, 1);
    } finally {
      await close();
    }
  });

  it('answers 400 for garbage quote input instead of nulls', async () => {
    const { url, close } = await listen(appWith(false));
    try {
      for (const body of [
        { attendees: 'abc' },
        { attendees: -5 },
        { attendees: 1.5 },
        { days: 0 },
        { days: 'x' },
        { serviceIds: 'all' },
        { serviceIds: [null] },
        { serviceIds: [{}] },
        [1, 2, 3],
      ]) {
        const res = await post(url, '/api/calculate-quote', JSON.stringify(body));
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(res.json.success, false);
        assert.match(res.json.error, /[؀-ۿ]/);
      }
    } finally {
      await close();
    }
    assert.equal(parseQuoteInput(undefined).ok, true);
    assert.equal(parseQuoteInput({ attendees: '80' }).ok, true);
  });

  it('answers 503 from the planner when no AI provider is configured', async () => {
    const off = await listen(appWith(false));
    const on = await listen(appWith(true));
    try {
      const disabled = await post(off.url, '/api/ai-planner', JSON.stringify({ eventType: 'زواج', guests: 100 }));
      assert.equal(disabled.status, 503);
      assert.equal(disabled.json.success, false);
      assert.equal('plan' in disabled.json, false);
      assert.match(disabled.json.error, /غير مفعّل/);
      const enabled = await post(on.url, '/api/ai-planner', JSON.stringify({ eventType: 'زواج', guests: 100 }));
      assert.equal(enabled.status, 200);
      assert.equal(enabled.json.success, true);
    } finally {
      await off.close();
      await on.close();
    }
  });
});
