import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { registerSiteAppearanceRoutes } from './site-appearance-routes.ts';
import { createSiteAppearanceStore, defaultSiteAppearance, sanitizeSiteAppearance } from './site-appearance-store.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-site-appearance-'));
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
    requireRole: (roles: string[]) => (_req: Request, res: Response, next: NextFunction) => {
      if (!role) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
      if (!roles.includes(role)) return res.status(403).json({ success: false, error: 'ليست لديك صلاحية.' });
      next();
    },
  };
}

function appFor(role: 'admin' | 'vendor' | null, dir: string) {
  const app = express();
  app.use(express.json());
  registerSiteAppearanceRoutes(app, fakeAuth(role), dir);
  return app;
}

describe('site-appearance-store', () => {
  it('defaults to the design photos on the design grounds', () => {
    const { heroCards } = defaultSiteAppearance();
    assert.equal(heroCards.length, 3);
    assert.deepEqual(
      heroCards.map((card) => card.color),
      ['#163A78', '#155EEF', '#DBE7FF'],
    );
    assert.ok(heroCards.every((card) => card.image === '' && card.showImage));
  });

  it('keeps only server uploads and hex colours', () => {
    const { heroCards } = sanitizeSiteAppearance({
      heroCards: [
        { image: 'https://evil.example/x.png', color: 'red' },
        { image: '/uploads/site-hero-abc123.webp', color: '#ff8800', showImage: false },
        { image: 'javascript:alert(1)', color: '#12345' },
      ],
    });
    assert.equal(heroCards[0].image, '');
    assert.equal(heroCards[0].color, '#163A78');
    assert.deepEqual(heroCards[1], { image: '/uploads/site-hero-abc123.webp', showImage: false, color: '#FF8800' });
    assert.equal(heroCards[2].image, '');
    assert.equal(heroCards[2].color, '#DBE7FF');
  });

  it('leaves cards missing from a save as they were', () => {
    const store = createSiteAppearanceStore(tmpDir());
    store.save({ heroCards: [{ color: '#000000' }, { color: '#111111' }, { color: '#222222' }] });
    const saved = store.save({ heroCards: [{ color: '#333333' }] });
    assert.deepEqual(
      saved.heroCards.map((card) => card.color),
      ['#333333', '#111111', '#222222'],
    );
    assert.ok(saved.updatedAt);
  });
});

describe('site-appearance-routes', () => {
  it('serves the appearance publicly and saves it for the owner only', async () => {
    const dir = tmpDir();
    const body = JSON.stringify({ heroCards: [{ color: '#0F766E', showImage: false }] });
    const headers = { 'Content-Type': 'application/json' };

    for (const role of [null, 'vendor'] as const) {
      const { url, close } = await listen(appFor(role, dir));
      const res = await fetch(`${url}/api/admin/site/appearance`, { method: 'PUT', headers, body });
      assert.equal(res.status, role ? 403 : 401);
      await close();
    }

    const owner = await listen(appFor('admin', dir));
    const bad = await fetch(`${owner.url}/api/admin/site/appearance`, { method: 'PUT', headers, body: '{}' });
    assert.equal(bad.status, 400);
    const saved = await fetch(`${owner.url}/api/admin/site/appearance`, { method: 'PUT', headers, body });
    assert.equal(saved.status, 200);
    await owner.close();

    const guest = await listen(appFor(null, dir));
    const res = await fetch(`${guest.url}/api/site/appearance`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(json.data.heroCards[0], { image: '', showImage: false, color: '#0F766E' });
    assert.equal(json.data.heroCards[1].color, '#155EEF');
    await guest.close();
  });
});
