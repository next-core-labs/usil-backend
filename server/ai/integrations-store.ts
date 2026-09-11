import fs from 'fs';
import path from 'path';
import { readJsonFile, writeJsonFile } from '../shared/json-file.ts';

export const AI_PROVIDER_IDS = ['gemini', 'anthropic', 'openai'] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export type ProviderConfig = {
  apiKey: string;
  model: string;
};

export type IntegrationsSettings = {
  defaultProvider: AiProviderId;
  gemini: ProviderConfig;
  anthropic: ProviderConfig;
  openai: ProviderConfig;
  updatedAt: string;
};

export type ProviderStatus = {
  configured: boolean;
  keyMasked: string;
  /** 'saved' = من لوحة التكاملات، 'env' = متغير بيئة على الخادم، 'none' = غير مُعد */
  keySource: 'saved' | 'env' | 'none';
  model: string;
};

export const PROVIDER_LABEL_AR: Record<AiProviderId, string> = {
  gemini: 'Google Gemini',
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (ChatGPT)',
};

export const CURSOR_NOTE_AR =
  'كيرسر أداة برمجة، ما عنده API للمواقع. الربط يكون مع Claude أو OpenAI أو Gemini.';

/** موديل Gemini يُترك فارغاً افتراضياً حتى تبقى كل نقطة نهاية على موديلها الحالي. */
const DEFAULT_MODELS: Record<AiProviderId, string> = {
  gemini: '',
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
};

const ENV_KEY_NAMES: Record<AiProviderId, string[]> = {
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
  openai: ['OPENAI_API_KEY'],
};

const ENV_MODEL_NAMES: Record<AiProviderId, string> = {
  gemini: 'GEMINI_MODEL',
  anthropic: 'ANTHROPIC_MODEL',
  openai: 'OPENAI_MODEL',
};

export function defaultIntegrations(): IntegrationsSettings {
  return {
    defaultProvider: 'gemini',
    gemini: { apiKey: '', model: DEFAULT_MODELS.gemini },
    anthropic: { apiKey: '', model: DEFAULT_MODELS.anthropic },
    openai: { apiKey: '', model: DEFAULT_MODELS.openai },
    updatedAt: new Date().toISOString(),
  };
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** المفاتيح تُقبل كمحارف ASCII مطبوعة فقط، حتى لا يتسرب سطر جديد إلى ترويسة HTTP. */
export function sanitizeApiKey(raw: unknown): string {
  const text = asString(raw).trim();
  if (!text) return '';
  const cleaned = text.replace(/[^\x21-\x7e]/g, '');
  return cleaned.slice(0, 300);
}

export function sanitizeModel(raw: unknown, fallback: string): string {
  const text = asString(raw).trim();
  if (!text) return fallback;
  const cleaned = text.replace(/[^A-Za-z0-9._:@/-]/g, '');
  return cleaned.slice(0, 80) || fallback;
}

export function sanitizeProviderId(raw: unknown, fallback: AiProviderId = 'gemini'): AiProviderId {
  const text = asString(raw).trim().toLowerCase();
  return (AI_PROVIDER_IDS as readonly string[]).includes(text) ? (text as AiProviderId) : fallback;
}

/** يعرض آخر 4 محارف فقط مع بادئة قصيرة — لا يُرجع المفتاح كاملاً أبداً. */
export function maskApiKey(key: string): string {
  const value = String(key || '');
  if (!value) return '';
  if (value.length <= 8) return '••••';
  const prefix = value.slice(0, 3);
  return `${prefix}…${value.slice(-4)}`;
}

function envKey(provider: AiProviderId): string {
  for (const name of ENV_KEY_NAMES[provider]) {
    const value = sanitizeApiKey(process.env[name]);
    if (value) return value;
  }
  return '';
}

function envModel(provider: AiProviderId): string {
  return sanitizeModel(process.env[ENV_MODEL_NAMES[provider]], '');
}

export function sanitizeIntegrations(input: unknown, previous?: IntegrationsSettings): IntegrationsSettings {
  const base = previous ? { ...defaultIntegrations(), ...previous } : defaultIntegrations();
  const row = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};

  const readProvider = (provider: AiProviderId): ProviderConfig => {
    const incoming = row[provider] && typeof row[provider] === 'object'
      ? (row[provider] as Record<string, unknown>)
      : {};
    const current = base[provider] || { apiKey: '', model: DEFAULT_MODELS[provider] };
    const nextKey = sanitizeApiKey(incoming.apiKey);
    const cleared = incoming.clearKey === true;
    return {
      apiKey: cleared ? '' : nextKey || current.apiKey,
      model: sanitizeModel(incoming.model, current.model || DEFAULT_MODELS[provider]),
    };
  };

  return {
    defaultProvider: sanitizeProviderId(row.defaultProvider, base.defaultProvider),
    gemini: readProvider('gemini'),
    anthropic: readProvider('anthropic'),
    openai: readProvider('openai'),
    updatedAt: new Date().toISOString(),
  };
}

/** المفتاح الفعلي: المحفوظ من اللوحة أولاً، ثم متغير البيئة على الخادم. */
export function effectiveKey(settings: IntegrationsSettings, provider: AiProviderId): string {
  return settings[provider]?.apiKey || envKey(provider);
}

export function effectiveModel(settings: IntegrationsSettings, provider: AiProviderId): string {
  return settings[provider]?.model || envModel(provider) || DEFAULT_MODELS[provider];
}

export function providerStatus(settings: IntegrationsSettings, provider: AiProviderId): ProviderStatus {
  const saved = settings[provider]?.apiKey || '';
  const fromEnv = saved ? '' : envKey(provider);
  const key = saved || fromEnv;
  return {
    configured: Boolean(key),
    keyMasked: maskApiKey(key),
    keySource: saved ? 'saved' : fromEnv ? 'env' : 'none',
    model: effectiveModel(settings, provider),
  };
}

/** الحمولة الوحيدة المسموح إرسالها للمتصفح: أقنعة وحالات، بلا مفاتيح. */
export function publicIntegrationsPayload(settings: IntegrationsSettings) {
  const providers = {} as Record<AiProviderId, ProviderStatus>;
  for (const provider of AI_PROVIDER_IDS) {
    providers[provider] = providerStatus(settings, provider);
  }
  const configuredDefault = providers[settings.defaultProvider].configured;
  return {
    defaultProvider: settings.defaultProvider,
    activeProvider: configuredDefault
      ? settings.defaultProvider
      : AI_PROVIDER_IDS.find((provider) => providers[provider].configured) || null,
    providers,
    cursor: { supported: false, note: CURSOR_NOTE_AR },
    updatedAt: settings.updatedAt,
  };
}

export function createIntegrationsStore(dataDir: string) {
  const file = path.join(dataDir, 'integrations.json');

  function readFile(): IntegrationsSettings {
    const stored = readJsonFile<unknown>(file, null);
    return stored === null ? defaultIntegrations() : sanitizeIntegrations(stored);
  }

  function writeFile(settings: IntegrationsSettings) {
    // Holds provider API keys — owner-only, and never world-readable even
    // briefly, so the temp file is created with the same mode.
    writeJsonFile(file, settings, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* بعض أنظمة الملفات لا تدعم chmod — الملف يبقى خارج مجلد الويب */
    }
  }

  function load(): IntegrationsSettings {
    return readFile();
  }

  function save(input: unknown): IntegrationsSettings {
    const next = sanitizeIntegrations(input, readFile());
    writeFile(next);
    return next;
  }

  return { file, load, save };
}

export type IntegrationsStore = ReturnType<typeof createIntegrationsStore>;
