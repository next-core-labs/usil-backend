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

  it('never trusts a raw X-Forwarded-For — falls back to the TCP peer', () => {
    const spoofed = { headers: { 'x-forwarded-for': '10.1.2.3, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
    assert.equal(clientIp(spoofed, {}), '127.0.0.1');
    assert.equal(clientIp(spoofed, { NODE_ENV: 'production' }), '127.0.0.1');
    assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, {}), '127.0.0.1');
    assert.equal(clientIp({ headers: {} }, {}), 'unknown');
  });

  it('uses cf-connecting-ip by default in production only', () => {
    const req = { headers: { 'cf-connecting-ip': '198.51.100.7' }, socket: { remoteAddress: '172.18.0.2' } };
    assert.equal(clientIp(req, { NODE_ENV: 'production' }), '198.51.100.7');
    assert.equal(clientIp(req, { NODE_ENV: 'development' }), '172.18.0.2');
    assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '172.18.0.2' } }, { NODE_ENV: 'production' }), '172.18.0.2');
  });

  it('reads the header named by CLIENT_IP_HEADER (first value)', () => {
    const req = {
      headers: { 'x-real-ip': '203.0.113.5, 10.0.0.1', 'cf-connecting-ip': '198.51.100.7' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    assert.equal(clientIp(req, { CLIENT_IP_HEADER: 'X-Real-IP' }), '203.0.113.5');
    assert.equal(clientIp(req, { CLIENT_IP_HEADER: 'x-real-ip', NODE_ENV: 'production' }), '203.0.113.5');
    assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, { CLIENT_IP_HEADER: 'x-real-ip' }), '127.0.0.1');
  });
});
