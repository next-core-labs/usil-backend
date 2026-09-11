import fs from 'fs';
import path from 'path';
import { readJsonFile, writeJsonFile } from '../shared/json-file';
import { isMoyasarSecretKey, moyasarPublishableKey, moyasarSecretKey } from './moyasar';

export type MoyasarSavedSettings = {
  secretKey: string;
  publishableKey: string;
  updatedAt: string;
};

export type MoyasarPublicStatus = {
  configured: boolean;
  form: boolean;
  live: boolean;
  secretMasked: string;
  secretSource: 'saved' | 'env' | 'none';
  publishableMasked: string;
  publishableSource: 'saved' | 'env' | 'none';
  webhookUrl: string;
  webhookSecretSet: boolean;
  updatedAt: string | null;
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function moyasarStorePath(dataDir: string): string {
  return path.join(dataDir, 'moyasar.json');
}

export function emptyMoyasarSettings(): MoyasarSavedSettings {
  return { secretKey: '', publishableKey: '', updatedAt: '' };
}

export function maskMoyasarKey(key: string): string {
  const value = String(key || '');
  if (!value) return '';
  if (value.length <= 12) return '••••';
  const prefix = value.startsWith('sk_live_')
    ? 'sk_live_'
    : value.startsWith('sk_test_')
      ? 'sk_test_'
      : value.startsWith('pk_live_')
        ? 'pk_live_'
        : value.startsWith('pk_test_')
          ? 'pk_test_'
          : value.slice(0, 3);
  return `${prefix}…${value.slice(-4)}`;
}

export function sanitizeMoyasarSecret(raw: unknown): string {
  const value = asString(raw).replace(/[^\x21-\x7e]/g, '');
  if (!isMoyasarSecretKey(value) || value.includes('*')) return '';
  return value;
}

export function sanitizeMoyasarPublishable(raw: unknown): string {
  const value = asString(raw).replace(/[^\x21-\x7e]/g, '');
  if (!(value.startsWith('pk_test_') || value.startsWith('pk_live_')) || value.length < 40) return '';
  return value;
}

export function loadMoyasarSettings(dataDir: string): MoyasarSavedSettings {
  const row = readJsonFile<Partial<MoyasarSavedSettings>>(moyasarStorePath(dataDir), {});
  return {
    secretKey: sanitizeMoyasarSecret(row.secretKey),
    publishableKey: sanitizeMoyasarPublishable(row.publishableKey),
    updatedAt: asString(row.updatedAt),
  };
}

export function saveMoyasarSettings(dataDir: string, next: MoyasarSavedSettings): MoyasarSavedSettings {
  const saved: MoyasarSavedSettings = {
    secretKey: sanitizeMoyasarSecret(next.secretKey),
    publishableKey: sanitizeMoyasarPublishable(next.publishableKey),
    updatedAt: new Date().toISOString(),
  };
  writeJsonFile(moyasarStorePath(dataDir), saved);
  try {
    fs.chmodSync(moyasarStorePath(dataDir), 0o600);
  } catch {
    /* best-effort on Windows */
  }
  return saved;
}

/** Apply saved keys into process.env so invoice + webhook code keep reading env. */
export function applyMoyasarRuntime(dataDir: string): MoyasarSavedSettings {
  const saved = loadMoyasarSettings(dataDir);
  if (saved.secretKey) {
    process.env.MOYASAR_SECRET_KEY = saved.secretKey;
    process.env.PAYMENT_PROVIDER_SECRET_KEY = saved.secretKey;
  }
  if (saved.publishableKey) {
    process.env.MOYASAR_PUBLISHABLE_KEY = saved.publishableKey;
  }
  return saved;
}

export function publicMoyasarStatus(dataDir: string, webhookUrl: string): MoyasarPublicStatus {
  const saved = loadMoyasarSettings(dataDir);
  const envSecret = moyasarSecretKey();
  const envPublishable = moyasarPublishableKey();
  const secret = saved.secretKey || envSecret;
  const publishable = saved.publishableKey || envPublishable;
  return {
    configured: isMoyasarSecretKey(secret),
    form: isMoyasarSecretKey(secret) && Boolean(publishable),
    live: secret.startsWith('sk_live_'),
    secretMasked: maskMoyasarKey(secret),
    secretSource: saved.secretKey ? 'saved' : envSecret ? 'env' : 'none',
    publishableMasked: maskMoyasarKey(publishable),
    publishableSource: saved.publishableKey ? 'saved' : envPublishable ? 'env' : 'none',
    webhookUrl,
    webhookSecretSet: Boolean(String(process.env.MOYASAR_WEBHOOK_SECRET || '').trim()),
    updatedAt: saved.updatedAt || null,
  };
}
