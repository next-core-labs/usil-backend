import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  applyMoyasarRuntime,
  loadMoyasarSettings,
  maskMoyasarKey,
  publicMoyasarStatus,
  sanitizeMoyasarPublishable,
  sanitizeMoyasarSecret,
  saveMoyasarSettings,
} from './moyasar-store.ts';

const ENV_NAMES = [
  'MOYASAR_SECRET_KEY',
  'MOYASAR_API_KEY',
  'PAYMENT_PROVIDER_SECRET_KEY',
  'MOYASAR_PUBLISHABLE_KEY',
  'MOYASAR_WEBHOOK_SECRET',
];
let savedEnv: Record<string, string | undefined> = {};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-moyasar-store-'));
}

describe('moyasar-store', () => {
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

  it('rejects starred, pk_, and short secrets', () => {
    assert.equal(sanitizeMoyasarSecret('sk_live_************************'), '');
    assert.equal(sanitizeMoyasarSecret('pk_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), '');
    assert.equal(sanitizeMoyasarSecret('sk_test_short'), '');
    assert.equal(
      sanitizeMoyasarSecret('sk_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      'sk_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
  });

  it('accepts publishable pk_ keys only', () => {
    assert.equal(sanitizeMoyasarPublishable('sk_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), '');
    assert.equal(sanitizeMoyasarPublishable('pk_test_short'), '');
    assert.equal(
      sanitizeMoyasarPublishable('pk_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      'pk_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
  });

  it('masks keys without returning the full secret', () => {
    const secret = 'sk_live_abcdefghijklmnopqrstuvwxyz012345';
    const masked = maskMoyasarKey(secret);
    assert.equal(masked.includes(secret), false);
    assert.equal(masked.startsWith('sk_live_'), true);
    assert.equal(masked.endsWith('2345'), true);
  });

  it('persists keys to data/moyasar.json and applies them to process.env', () => {
    const dir = tmpDir();
    const secret = 'sk_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    saveMoyasarSettings(dir, {
      secretKey: secret,
      publishableKey: 'pk_live_cccccccccccccccccccccccccccccccccccc',
      updatedAt: '',
    });
    assert.equal(fs.existsSync(path.join(dir, 'moyasar.json')), true);
    const loaded = loadMoyasarSettings(dir);
    assert.equal(loaded.secretKey, secret);
    applyMoyasarRuntime(dir);
    assert.equal(process.env.MOYASAR_SECRET_KEY, secret);
    assert.equal(process.env.PAYMENT_PROVIDER_SECRET_KEY, secret);
    const publicStatus = publicMoyasarStatus(dir, 'https://hooks.usil.app/api/payments/webhook');
    assert.equal(publicStatus.configured, true);
    assert.equal(publicStatus.live, true);
    assert.equal(publicStatus.secretSource, 'saved');
    assert.equal(JSON.stringify(publicStatus).includes(secret), false);
  });
});
