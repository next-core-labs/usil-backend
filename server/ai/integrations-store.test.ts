import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createIntegrationsStore,
  defaultIntegrations,
  effectiveKey,
  effectiveModel,
  maskApiKey,
  publicIntegrationsPayload,
  sanitizeApiKey,
  sanitizeIntegrations,
  sanitizeModel,
  sanitizeProviderId,
} from './integrations-store.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-integrations-'));
}

const ENV_NAMES = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'OPENAI_API_KEY'];
let savedEnv: Record<string, string | undefined> = {};

describe('integrations-store', () => {
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

  it('masks keys down to a short prefix and the last four characters', () => {
    assert.equal(maskApiKey('sk-ant-api03-abcdefghijklmnop1234'), 'sk-…1234');
    assert.equal(maskApiKey('sk-proj-XYZWabcd'), 'sk-…abcd');
    assert.equal(maskApiKey('short'), '••••');
    assert.equal(maskApiKey(''), '');
  });

  it('strips non-printable characters so a key cannot inject an HTTP header', () => {
    assert.equal(sanitizeApiKey('  sk-ant-abc123\n\r  '), 'sk-ant-abc123');
    assert.equal(sanitizeApiKey('sk-ant\u0000-عربي-abc'), 'sk-ant--abc');
    assert.equal(sanitizeApiKey(undefined), '');
    assert.equal(sanitizeApiKey('a'.repeat(500)).length, 300);
  });

  it('accepts free-text model names but rejects junk characters', () => {
    assert.equal(sanitizeModel('claude-opus-4-1', 'x'), 'claude-opus-4-1');
    assert.equal(sanitizeModel('gpt-5', 'x'), 'gpt-5');
    assert.equal(sanitizeModel('  ', 'gpt-4o'), 'gpt-4o');
    assert.equal(sanitizeModel('gpt 4o<script>', 'x'), 'gpt4oscript');
  });

  it('falls back to gemini for an unknown provider id', () => {
    assert.equal(sanitizeProviderId('anthropic'), 'anthropic');
    assert.equal(sanitizeProviderId('OpenAI'), 'openai');
    assert.equal(sanitizeProviderId('cursor'), 'gemini');
    assert.equal(sanitizeProviderId(null, 'openai'), 'openai');
  });

  it('keeps the stored key when the incoming key is empty and clears it on request', () => {
    const first = sanitizeIntegrations({ anthropic: { apiKey: 'sk-ant-first-key-1234', model: 'claude-sonnet-4-5' } });
    assert.equal(first.anthropic.apiKey, 'sk-ant-first-key-1234');

    const kept = sanitizeIntegrations({ anthropic: { model: 'claude-opus-4-1' } }, first);
    assert.equal(kept.anthropic.apiKey, 'sk-ant-first-key-1234');
    assert.equal(kept.anthropic.model, 'claude-opus-4-1');

    const cleared = sanitizeIntegrations({ anthropic: { clearKey: true } }, kept);
    assert.equal(cleared.anthropic.apiKey, '');
  });

  it('never puts a raw key in the browser payload', () => {
    const settings = sanitizeIntegrations({
      defaultProvider: 'anthropic',
      anthropic: { apiKey: 'sk-ant-secret-value-9876' },
      openai: { apiKey: 'sk-openai-secret-5432' },
    });
    const payload = publicIntegrationsPayload(settings);
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes('sk-ant-secret-value-9876'), false);
    assert.equal(serialized.includes('sk-openai-secret-5432'), false);
    assert.equal(payload.providers.anthropic.configured, true);
    assert.equal(payload.providers.anthropic.keyMasked, 'sk-…9876');
    assert.equal(payload.providers.anthropic.keySource, 'saved');
    assert.equal(payload.providers.gemini.configured, false);
    assert.equal(payload.providers.gemini.keyMasked, '');
    assert.equal(payload.defaultProvider, 'anthropic');
    assert.equal(payload.activeProvider, 'anthropic');
    assert.equal(payload.cursor.supported, false);
    assert.match(payload.cursor.note, /كيرسر أداة برمجة/);
  });

  it('falls back to another configured provider when the default has no key', () => {
    const settings = sanitizeIntegrations({
      defaultProvider: 'anthropic',
      openai: { apiKey: 'sk-openai-only-key-1111' },
    });
    const payload = publicIntegrationsPayload(settings);
    assert.equal(payload.defaultProvider, 'anthropic');
    assert.equal(payload.activeProvider, 'openai');
  });

  it('reads server env vars when no key is saved in the panel', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env-key-7777';
    const settings = defaultIntegrations();
    assert.equal(effectiveKey(settings, 'anthropic'), 'sk-ant-from-env-key-7777');
    const payload = publicIntegrationsPayload(settings);
    assert.equal(payload.providers.anthropic.keySource, 'env');
    assert.equal(payload.providers.anthropic.keyMasked, 'sk-…7777');
    assert.equal(JSON.stringify(payload).includes('sk-ant-from-env-key-7777'), false);
  });

  it('prefers the panel key over the env var', () => {
    process.env.OPENAI_API_KEY = 'sk-env-openai-0000';
    const settings = sanitizeIntegrations({ openai: { apiKey: 'sk-panel-openai-1234' } });
    assert.equal(effectiveKey(settings, 'openai'), 'sk-panel-openai-1234');
    assert.equal(publicIntegrationsPayload(settings).providers.openai.keySource, 'saved');
  });

  it('leaves the gemini model empty so each route keeps its own default', () => {
    const settings = defaultIntegrations();
    assert.equal(effectiveModel(settings, 'gemini'), '');
    assert.equal(effectiveModel(settings, 'anthropic'), 'claude-sonnet-4-5');
    assert.equal(effectiveModel(settings, 'openai'), 'gpt-4o');
  });

  it('writes integrations.json with owner-only permissions and reloads it', () => {
    const dir = tmpDir();
    const store = createIntegrationsStore(dir);
    assert.equal(fs.existsSync(store.file), false, 'no file before the first save');

    store.save({ defaultProvider: 'openai', openai: { apiKey: 'sk-disk-key-4321', model: 'gpt-5' } });
    const mode = fs.statSync(store.file).mode & 0o777;
    assert.equal(mode, 0o600);

    const reloaded = createIntegrationsStore(dir).load();
    assert.equal(reloaded.defaultProvider, 'openai');
    assert.equal(reloaded.openai.apiKey, 'sk-disk-key-4321');
    assert.equal(reloaded.openai.model, 'gpt-5');
  });

  it('falls back to defaults when the file on disk is corrupt', () => {
    const dir = tmpDir();
    const store = createIntegrationsStore(dir);
    fs.writeFileSync(store.file, '{ not json', 'utf-8');
    assert.equal(store.load().defaultProvider, 'gemini');
  });
});
