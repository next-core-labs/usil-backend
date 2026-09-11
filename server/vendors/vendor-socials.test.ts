import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVendorSocials,
  setSocialVerification,
  normalizeSaudiWhatsApp,
  publicSocials,
  SOCIAL_NETWORKS,
} from './vendor-socials.ts';

describe('vendor-socials', () => {
  it('normalizes Saudi WhatsApp to wa.me', () => {
    assert.deepEqual(normalizeSaudiWhatsApp('0501234567'), {
      handle: '0501234567',
      url: 'https://wa.me/966501234567',
    });
    assert.deepEqual(normalizeSaudiWhatsApp('501234567'), {
      handle: '0501234567',
      url: 'https://wa.me/966501234567',
    });
    assert.equal(normalizeSaudiWhatsApp('123'), null);
  });

  it('accepts official hosts and @handles', () => {
    const socials = parseVendorSocials({
      instagram: '@usil.cafe',
      tiktok: 'https://www.tiktok.com/@usil.cafe',
      snapchat: 'usilcafe',
      x: 'twitter.com/usil_cafe',
      youtube: 'youtube.com/@usil',
      whatsapp: '0551111222',
      confirmedOwn: true,
    });
    assert.equal(socials.links.length, 6);
    assert.equal(socials.links.find((l) => l.network === 'instagram')?.url, 'https://www.instagram.com/usil.cafe');
    assert.equal(socials.links.find((l) => l.network === 'tiktok')?.url, 'https://www.tiktok.com/@usil.cafe');
    assert.equal(socials.links.find((l) => l.network === 'snapchat')?.url, 'https://www.snapchat.com/add/usilcafe');
    assert.equal(socials.links.find((l) => l.network === 'x')?.url, 'https://x.com/usil_cafe');
    assert.equal(socials.links.find((l) => l.network === 'youtube')?.url, 'https://www.youtube.com/@usil');
    assert.equal(socials.links.find((l) => l.network === 'whatsapp')?.url, 'https://wa.me/966551111222');
    assert.ok(socials.links.every((l) => l.status === 'linked'));
  });

  it('rejects a foreign host', () => {
    assert.throws(
      () => parseVendorSocials({ instagram: 'https://evil.example/phish', confirmedOwn: true }),
      /instagram.com/,
    );
  });

  it('marks pending until the vendor confirms ownership', () => {
    const socials = parseVendorSocials({ instagram: '@brand', confirmedOwn: false });
    assert.equal(socials.links[0].status, 'pending');
  });

  it('requires at least one account for new applications', () => {
    assert.throws(() => parseVendorSocials({}, { requireAtLeastOne: true }), /حساب تواصل واحد/);
  });

  it('allows existing vendors to save empty socials', () => {
    const socials = parseVendorSocials({}, { requireAtLeastOne: false });
    assert.deepEqual(socials.links, []);
  });

  it('keeps admin verification when the same URL is saved again', () => {
    const first = parseVendorSocials({ instagram: '@brand', confirmedOwn: true });
    const verified = setSocialVerification(first, 'instagram', true, 'إدارة يوصل');
    assert.equal(verified.links[0].status, 'verified');
    const again = parseVendorSocials({ instagram: 'instagram.com/brand', confirmedOwn: true }, { previous: verified });
    assert.equal(again.links[0].status, 'verified');
    assert.equal(again.links[0].verifiedBy, 'إدارة يوصل');
  });

  it('drops verification if the vendor changes the URL', () => {
    const first = parseVendorSocials({ instagram: '@brand', confirmedOwn: true });
    const verified = setSocialVerification(first, 'instagram', true, 'إدارة يوصل');
    const changed = parseVendorSocials({ instagram: '@other', confirmedOwn: true }, { previous: verified });
    assert.equal(changed.links[0].status, 'linked');
    assert.equal(changed.links[0].verifiedBy, undefined);
  });

  it('unverify returns linked when the vendor confirmed ownership', () => {
    const first = parseVendorSocials({ instagram: '@brand', confirmedOwn: true });
    const verified = setSocialVerification(first, 'instagram', true, 'إدارة يوصل');
    const undone = setSocialVerification(verified, 'instagram', false, 'إدارة يوصل');
    assert.equal(undone.links[0].status, 'linked');
  });

  it('exposes all six networks and public links for the vendor file', () => {
    assert.deepEqual([...SOCIAL_NETWORKS], ['instagram', 'tiktok', 'snapchat', 'x', 'youtube', 'whatsapp']);
    const socials = parseVendorSocials({ instagram: '@ab', confirmedOwn: true });
    assert.equal(publicSocials(socials).length, 1);
    assert.equal(publicSocials(emptyLike()).length, 0);
  });
});

function emptyLike() {
  return { confirmedOwn: false, links: [] };
}
