import type { WhatsAppConfig } from './whatsapp-settings';

/**
 * The few Graph API calls the inbox needs. Every call goes through the injected
 * `fetchImpl`, so tests point it at a local mock and never reach Meta.
 */

export type GraphResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

export type GraphTemplate = {
  name: string;
  language: string;
  category: string;
  body: string;
  paramCount: number;
  /** NAMED templates use `{{first_name}}`-style placeholders and need `parameter_name` when sent. */
  paramNames: string[];
  named: boolean;
};

const TIMEOUT_MS = 15_000;

function graphUrl(config: WhatsAppConfig, pathAndQuery: string): string {
  return `${config.graphBase}/${config.graphVersion}/${pathAndQuery.replace(/^\/+/, '')}`;
}

/**
 * Meta takes the access token as a Bearer; Kapso's proxy takes the project key
 * as `X-API-Key`. The request shapes are otherwise identical.
 */
function authHeader(config: WhatsAppConfig): Record<string, string> {
  return config.provider === 'kapso'
    ? { 'X-API-Key': config.accessToken }
    : { Authorization: `Bearer ${config.accessToken}` };
}

/** Meta's `error.message`, plus `error_data.details` when it says more. */
export function graphErrorMessage(body: unknown, status: number): string {
  const error = (body as { error?: { message?: unknown; error_data?: { details?: unknown } } } | null)?.error;
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  const details = typeof error?.error_data?.details === 'string' ? error.error_data.details.trim() : '';
  if (message && details && !message.includes(details)) return `${message} — ${details}`;
  return message || details || `HTTP ${status}`;
}

async function graphCall<T>(
  fetchImpl: typeof fetch,
  config: WhatsAppConfig,
  pathAndQuery: string,
  init: { method?: string; body?: unknown } = {},
): Promise<GraphResult<T>> {
  let res: Response;
  try {
    res = await fetchImpl(graphUrl(config, pathAndQuery), {
      method: init.method || 'GET',
      headers: {
        ...authHeader(config),
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, message: reason || 'network error' };
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok || (body && typeof body === 'object' && 'error' in body)) {
    return { ok: false, status: res.status, message: graphErrorMessage(body, res.status) };
  }
  return { ok: true, data: (body || {}) as T };
}

export function createGraphClient(fetchImpl: typeof fetch) {
  return {
    async phoneNumber(config: WhatsAppConfig): Promise<GraphResult<{ displayPhone: string; verifiedName: string }>> {
      const result = await graphCall<{ display_phone_number?: string; verified_name?: string }>(
        fetchImpl,
        config,
        `${config.phoneNumberId}?fields=display_phone_number,verified_name`,
      );
      if (result.ok === false) return result;
      return {
        ok: true,
        data: {
          displayPhone: String(result.data.display_phone_number || ''),
          verifiedName: String(result.data.verified_name || ''),
        },
      };
    },

    /** POST /{phone-number-id}/messages; returns the new wamid and the recipient's wa_id. */
    async sendMessage(
      config: WhatsAppConfig,
      payload: Record<string, unknown>,
    ): Promise<GraphResult<{ wamid: string; waId: string }>> {
      const result = await graphCall<{ messages?: Array<{ id?: string }>; contacts?: Array<{ wa_id?: string }> }>(
        fetchImpl,
        config,
        `${config.phoneNumberId}/messages`,
        { method: 'POST', body: { messaging_product: 'whatsapp', ...payload } },
      );
      if (result.ok === false) return result;
      const wamid = String(result.data.messages?.[0]?.id || '');
      if (!wamid) return { ok: false, status: 502, message: 'Graph response had no message id' };
      return { ok: true, data: { wamid, waId: String(result.data.contacts?.[0]?.wa_id || '') } };
    },

    async markRead(config: WhatsAppConfig, wamid: string): Promise<GraphResult<unknown>> {
      return graphCall(fetchImpl, config, `${config.phoneNumberId}/messages`, {
        method: 'POST',
        body: { messaging_product: 'whatsapp', status: 'read', message_id: wamid },
      });
    },

    async templates(config: WhatsAppConfig): Promise<GraphResult<GraphTemplate[]>> {
      const result = await graphCall<{ data?: unknown[] }>(
        fetchImpl,
        config,
        `${config.businessAccountId}/message_templates?status=APPROVED&limit=200&fields=name,language,category,status,components`,
      );
      if (result.ok === false) return result;
      const rows = Array.isArray(result.data.data) ? result.data.data : [];
      return { ok: true, data: rows.map(toTemplate).filter((row): row is GraphTemplate => Boolean(row)) };
    },

    /** Media metadata: a short-lived download URL. */
    async mediaInfo(config: WhatsAppConfig, mediaId: string): Promise<GraphResult<{ url: string; mimeType: string }>> {
      const result = await graphCall<{ url?: string; mime_type?: string }>(fetchImpl, config, mediaId);
      if (result.ok === false) return result;
      const url = String(result.data.url || '');
      if (!/^https?:\/\//i.test(url)) return { ok: false, status: 502, message: 'Graph response had no media url' };
      return { ok: true, data: { url, mimeType: String(result.data.mime_type || '') } };
    },

    /** The media bytes; the download URL needs the same bearer token. */
    async download(config: WhatsAppConfig, url: string): Promise<Response | null> {
      try {
        const res = await fetchImpl(url, {
          headers: authHeader(config),
          signal: AbortSignal.timeout(60_000),
        });
        return res.ok ? res : null;
      } catch {
        return null;
      }
    },
  };
}

export type GraphClient = ReturnType<typeof createGraphClient>;

/** Distinct `{{1}}` / `{{name}}` placeholders, in order of first appearance. */
export function templatePlaceholders(body: string): string[] {
  const seen: string[] = [];
  for (const match of String(body || '').matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
    if (!seen.includes(match[1])) seen.push(match[1]);
  }
  return seen;
}

/** Fill a template body: `{{n}}` takes params[n-1]; named placeholders take params in order of appearance. */
export function fillTemplateBody(body: string, params: string[]): string {
  const names = templatePlaceholders(body);
  return String(body || '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, key: string) => {
    const index = /^\d+$/.test(key) ? Number(key) - 1 : names.indexOf(key);
    const value = index >= 0 ? params[index] : undefined;
    return value === undefined ? whole : value;
  });
}

function toTemplate(raw: unknown): GraphTemplate | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as {
    name?: unknown;
    language?: unknown;
    category?: unknown;
    components?: Array<{ type?: unknown; text?: unknown }>;
  };
  const name = typeof row.name === 'string' ? row.name : '';
  if (!name) return null;
  const bodyComponent = Array.isArray(row.components)
    ? row.components.find((c) => String(c?.type || '').toUpperCase() === 'BODY')
    : undefined;
  const body = typeof bodyComponent?.text === 'string' ? bodyComponent.text : '';
  const paramNames = templatePlaceholders(body);
  return {
    name,
    language: typeof row.language === 'string' ? row.language : '',
    category: typeof row.category === 'string' ? row.category : '',
    body,
    paramCount: paramNames.length,
    paramNames,
    named: paramNames.some((n) => !/^\d+$/.test(n)),
  };
}
