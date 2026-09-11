import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createSeoStore,
  defaultSeoSettings,
  normalizeHtmlFileToken,
  pathToPageKey,
  publicSeoPayload,
  sanitizeSeoSettings,
} from './seo-store.ts';

describe('seo-store', () => {
  it('ships Arabic defaults for title, description, and keywords', () => {
    const seo = defaultSeoSettings();
    assert.equal(seo.title, 'يوصل | سوق توريد المناسبات في السعودية');
    assert.match(seo.description, /ضيافة/);
    assert.match(seo.keywords, /يوصل/);
    assert.match(seo.robotsTxt, /Sitemap: https:\/\/usil.app\/sitemap.xml/);
    assert.equal(seo.pages.hospitality.title.includes('ضيافة'), true);
  });

  it('rejects javascript URLs and bad analytics IDs', () => {
    const seo = sanitizeSeoSettings({
      ogImage: 'javascript:alert(1)',
      canonicalBaseUrl: 'ftp://evil.example',
      analyticsId: 'not-a-real-id',
      googleHtmlFileToken: '../secret.html',
    });
    assert.equal(seo.ogImage, 'https://usil.app/og/og-default.png');
    assert.equal(seo.canonicalBaseUrl, 'https://usil.app');
    assert.equal(seo.analyticsId, '');
    assert.equal(seo.googleHtmlFileToken, '');
  });

  it('accepts GTM and Search Console HTML file names', () => {
    const seo = sanitizeSeoSettings({
      analyticsId: 'GTM-ABC123',
      googleHtmlFileToken: 'google123abc.html',
      googleSiteVerification: 'token-from-search-console',
    });
    assert.equal(seo.analyticsId, 'GTM-ABC123');
    assert.equal(normalizeHtmlFileToken(seo.googleHtmlFileToken), 'google123abc.html');
    assert.equal(seo.googleSiteVerification, 'token-from-search-console');
  });

  it('persists to the JSON file DB and maps paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-seo-'));
    const store = createSeoStore(dir);
    const saved = store.save({ title: 'عنوان تجريبي | يوصل', description: 'وصف تجريبي للموقع.' });
    assert.equal(saved.title, 'عنوان تجريبي | يوصل');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'seo.json'), 'utf-8'));
    assert.equal(raw.title, 'عنوان تجريبي | يوصل');
    assert.equal(store.load().title, 'عنوان تجريبي | يوصل');
    assert.equal(pathToPageKey('/privacy'), 'privacy');
    assert.equal(pathToPageKey('/refund'), 'refund');
    assert.equal(pathToPageKey('/hospitality/'), 'hospitality');
    assert.equal(pathToPageKey('/about'), 'about');
    assert.equal(pathToPageKey('/courier'), 'courier');
    assert.equal(pathToPageKey('/ai-studio'), 'home');
    assert.equal(pathToPageKey('/ai-packages'), 'home');
    const pub = publicSeoPayload(saved);
    assert.equal('robotsTxt' in pub, false);
    assert.equal('googleHtmlFileToken' in pub, false);
  });
});
