import crypto from 'crypto';
import path from 'path';
import { readJsonFile, writeJsonFile } from '../shared/json-file';

/**
 * WhatsApp Business Platform (Cloud API) credentials for Usil's one number.
 *
 * Saved in `data/whatsapp-settings.json` (mode 0600) from the owner console;
 * each `WHATSAPP_*` environment variable, when set, wins over the saved value.
 */

export type WhatsAppSavedSettings = {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
  appSecret: string;
  verifyToken: string;
  displayPhone: string;
  verifiedName: string;
  updatedAt: string;
};

export type WhatsAppField = 'accessToken' | 'phoneNumberId' | 'businessAccountId' | 'appSecret';
export const WHATSAPP_CLEARABLE_FIELDS: readonly WhatsAppField[] = [
  'accessToken',
  'phoneNumberId',
  'businessAccountId',
  'appSecret',
];

export type SettingSource = 'env' | 'saved' | 'none';

/** What the app actually uses: env over saved. */
export type WhatsAppConfig = {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
  appSecret: string;
  verifyToken: string;
  graphBase: string;
  graphVersion: string;
};

export type WhatsAppPublicSettings = {
  configured: boolean;
  phoneNumberId: string;
  businessAccountId: string;
  tokenMasked: string;
  appSecretSet: boolean;
  verifyToken: string;
  webhookUrl: string;
  displayPhone: string;
  verifiedName: string;
  graphVersion: string;
  updatedAt: string | null;
  source: {
    token: SettingSource;
    phoneNumberId: SettingSource;
    businessAccountId: SettingSource;
    appSecret: SettingSource;
    verifyToken: SettingSource;
  };
};

const ENV_NAME: Record<WhatsAppField | 'verifyToken', string> = {
  accessToken: 'WHATSAPP_ACCESS_TOKEN',
  phoneNumberId: 'WHATSAPP_PHONE_NUMBER_ID',
  businessAccountId: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
  appSecret: 'WHATSAPP_APP_SECRET',
  verifyToken: 'WHATSAPP_VERIFY_TOKEN',
};

export const DEFAULT_GRAPH_VERSION = 'v23.0';
export const DEFAULT_GRAPH_BASE = 'https://graph.facebook.com';
export const WEBHOOK_PATH = '/api/whatsapp/webhook';

function envValue(name: string): string {
  return String(process.env[name] || '').trim();
}

/** Printable ASCII only, no spaces; a pasted masked value («…», «•», «*») counts as blank. */
export function sanitizeSecret(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  if (!value || /[*…•]/.test(value)) return '';
  return value.replace(/[^\x21-\x7e]/g, '');
}

/** Meta object IDs (phone number ID, WABA ID) are digits. */
export function sanitizeNumericId(raw: unknown): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') return '';
  const value = String(raw).trim();
  return /^\d{5,30}$/.test(value) ? value : '';
}

export function maskToken(token: string): string {
  const value = String(token || '');
  if (!value) return '';
  if (value.length <= 12) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function whatsappSettingsPath(dataDir: string): string {
  return path.join(dataDir, 'whatsapp-settings.json');
}

export function whatsappWebhookUrl(): string {
  const base = envValue('WHATSAPP_WEBHOOK_URL').replace(/\/+$/, '') || 'https://hooks.usil.app';
  return `${base}${WEBHOOK_PATH}`;
}

function asText(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function loadWhatsAppSettings(dataDir: string): WhatsAppSavedSettings {
  const row = readJsonFile<Partial<WhatsAppSavedSettings>>(whatsappSettingsPath(dataDir), {});
  return {
    accessToken: sanitizeSecret(row.accessToken),
    phoneNumberId: sanitizeNumericId(row.phoneNumberId),
    businessAccountId: sanitizeNumericId(row.businessAccountId),
    appSecret: sanitizeSecret(row.appSecret),
    verifyToken: sanitizeSecret(row.verifyToken),
    displayPhone: asText(row.displayPhone),
    verifiedName: asText(row.verifiedName),
    updatedAt: asText(row.updatedAt),
  };
}

export function saveWhatsAppSettings(dataDir: string, next: WhatsAppSavedSettings): WhatsAppSavedSettings {
  const saved: WhatsAppSavedSettings = { ...next, updatedAt: new Date().toISOString() };
  writeJsonFile(whatsappSettingsPath(dataDir), saved, { mode: 0o600 });
  return saved;
}

/** The verify token Meta echoes during the webhook handshake. Generated once, then kept. */
export function ensureVerifyToken(dataDir: string): string {
  const fromEnv = envValue(ENV_NAME.verifyToken);
  if (fromEnv) return fromEnv;
  const saved = loadWhatsAppSettings(dataDir);
  if (saved.verifyToken) return saved.verifyToken;
  const verifyToken = `usil-${crypto.randomBytes(18).toString('hex')}`;
  saveWhatsAppSettings(dataDir, { ...saved, verifyToken });
  return verifyToken;
}

export function resolveWhatsAppConfig(dataDir: string): WhatsAppConfig {
  const saved = loadWhatsAppSettings(dataDir);
  return {
    accessToken: sanitizeSecret(envValue(ENV_NAME.accessToken)) || saved.accessToken,
    phoneNumberId: sanitizeNumericId(envValue(ENV_NAME.phoneNumberId)) || saved.phoneNumberId,
    businessAccountId: sanitizeNumericId(envValue(ENV_NAME.businessAccountId)) || saved.businessAccountId,
    appSecret: sanitizeSecret(envValue(ENV_NAME.appSecret)) || saved.appSecret,
    verifyToken: envValue(ENV_NAME.verifyToken) || saved.verifyToken,
    graphBase: (envValue('WHATSAPP_GRAPH_BASE') || DEFAULT_GRAPH_BASE).replace(/\/+$/, ''),
    graphVersion: envValue('WHATSAPP_GRAPH_VERSION') || DEFAULT_GRAPH_VERSION,
  };
}

/** Enough to send and receive: token + phone number ID + app secret (webhook signatures). */
export function isWhatsAppConfigured(config: WhatsAppConfig): boolean {
  return Boolean(config.accessToken && config.phoneNumberId && config.appSecret);
}

/** Enough to call the send endpoints. */
export function canSend(config: WhatsAppConfig): boolean {
  return Boolean(config.accessToken && config.phoneNumberId);
}

function sourceOf(field: WhatsAppField | 'verifyToken', saved: WhatsAppSavedSettings): SettingSource {
  if (envValue(ENV_NAME[field])) return 'env';
  return saved[field] ? 'saved' : 'none';
}

export function publicWhatsAppSettings(dataDir: string): WhatsAppPublicSettings {
  ensureVerifyToken(dataDir);
  const saved = loadWhatsAppSettings(dataDir);
  const config = resolveWhatsAppConfig(dataDir);
  return {
    configured: isWhatsAppConfigured(config),
    phoneNumberId: config.phoneNumberId,
    businessAccountId: config.businessAccountId,
    tokenMasked: maskToken(config.accessToken),
    appSecretSet: Boolean(config.appSecret),
    verifyToken: config.verifyToken,
    webhookUrl: whatsappWebhookUrl(),
    displayPhone: saved.displayPhone,
    verifiedName: saved.verifiedName,
    graphVersion: config.graphVersion,
    updatedAt: saved.updatedAt || null,
    source: {
      token: sourceOf('accessToken', saved),
      phoneNumberId: sourceOf('phoneNumberId', saved),
      businessAccountId: sourceOf('businessAccountId', saved),
      appSecret: sourceOf('appSecret', saved),
      verifyToken: sourceOf('verifyToken', saved),
    },
  };
}
