import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clientIp,
  createSlidingWindowLimiter,
  isValidSaudiMobile,
  normalizeSaudiMobile,
} from './booking-guards.ts';

describe('booking-guards', () => {
  it('accepts common Saudi mobile formats used at checkout', () => {
    assert.equal(normalizeSaudiMobile('0501234567'), '0501234567');
    assert.equal(normalizeSaudiMobile('+966 50 123 4567'), '0501234567');
    assert.equal(normalizeSaudiMobile('966501234567'), '0501234567');
    assert.equal(normalizeSaudiMobile('501234567'), '0501234567');
    assert.equal(isValidSaudiMobile('0559876543'), true);
  });

  it('rejects missing or non-Saudi numbers', () => {
    assert.equal(isValidSaudiMobile(''), false);
    assert.equal(isValidSaudiMobile('123'), false);
    assert.equal(isValidSaudiMobile('0401234567'), false);
    assert.equal(isValidSaudiMobile('+1 202 555 0100'), false);
    assert.equal(isValidSaudiMobile('050123456'), false);
  });

  it('rate-limits an IP to 10 requests per minute', () => {
    const limiter = createSlidingWindowLimiter(10, 60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) assert.equal(limiter.allow('1.2.3.4', t0 + i), true);
    assert.equal(limiter.allow('1.2.3.4', t0 + 11), false);
    assert.equal(limiter.allow('9.9.9.9', t0 + 11), true);
    assert.equal(limiter.allow('1.2.3.4', t0 + 60_001), true);
  });

  it('reads client IP from X-Forwarded-For without inventing a captcha', () => {
    assert.equal(
      clientIp({ headers: { 'x-forwarded-for': '10.1.2.3, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } }),
      '10.1.2.3',
    );
    assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
  });
});
