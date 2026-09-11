import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isKnownSpaPath, parseLocation } from './siteRoutes.ts';

describe('siteRoutes', () => {
  it('maps store, legal, about, and package paths', () => {
    assert.equal(parseLocation('/').sitePage, null);
    assert.equal(parseLocation('/about').sitePage, 'about');
    assert.equal(parseLocation('/privacy').sitePage, 'privacy');
    assert.equal(parseLocation('/terms').sitePage, 'terms');
    assert.equal(parseLocation('/refund').sitePage, 'refund');
    assert.equal(parseLocation('/REFUND').sitePage, 'refund');
    assert.equal(parseLocation('/cancellation').sitePage, 'refund');
    assert.equal(isKnownSpaPath('/REFUND'), true);
    assert.equal(isKnownSpaPath('/cancellation'), true);
    assert.equal(parseLocation('/support').sitePage, 'support');
    assert.equal(parseLocation('/courier').courier, true);
    assert.equal(parseLocation('/ai-packages').sitePage, 'notfound');
    assert.equal(parseLocation('/ai-studio').sitePage, 'notfound');
    assert.equal(isKnownSpaPath('/ai-studio'), false);
    assert.equal(isKnownSpaPath('/ai-packages'), false);
    assert.equal(parseLocation('/', '#about').sitePage, 'about');
  });

  it('returns Arabic 404 for unknown website paths', () => {
    assert.equal(parseLocation('/this-page-does-not-exist').sitePage, 'notfound');
    assert.equal(parseLocation('/midyaf').sitePage, 'notfound');
    assert.equal(isKnownSpaPath('/about'), true);
    assert.equal(isKnownSpaPath('/privacy'), true);
    assert.equal(isKnownSpaPath('/refund'), true);
    assert.equal(isKnownSpaPath('/not-a-real-page'), false);
    assert.equal(isKnownSpaPath('/service/royal-saudi-coffee'), true);
    assert.equal(isKnownSpaPath('/payment/success'), true);
    assert.equal(isKnownSpaPath('/payment/cancelled'), true);
    assert.equal(parseLocation('/vendor/usr-abc').sitePage, 'vendor-file');
    assert.equal(parseLocation('/vendor/usr-abc').vendorPublicId, 'usr-abc');
    assert.equal(isKnownSpaPath('/vendor/usr-abc'), true);
  });
});
