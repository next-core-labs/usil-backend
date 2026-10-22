import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import type { MessageStatus, ParsedMessage, WebhookEvent } from './whatsapp-store';
import { isWaId } from './whatsapp-store';
import { WEBHOOK_PATH } from './whatsapp-settings';

/**
 * Meta signs each webhook POST with the app secret over the exact bytes it sent,
 * so the JSON body parser keeps those bytes for this one path. Pass this as
 * `express.json({ verify })`.
 */
export function captureWhatsAppRawBody(req: IncomingMessage, _res: unknown, buf: Buffer) {
  if (String(req.url || '').startsWith(WEBHOOK_PATH)) {
    (req as IncomingMessage & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
  }
}

export function rawBodyOf(req: unknown): Buffer | null {
  const raw = (req as { rawBody?: unknown }).rawBody;
  return Buffer.isBuffer(raw) ? (raw as Buffer) : null;
}

/** `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(appSecret, raw body)>`, compared in constant time. */
export function verifyWhatsAppSignature(appSecret: string, raw: Buffer, header: unknown): boolean {
  if (!appSecret || typeof header !== 'string') return false;
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!match) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(raw).digest();
  const given = Buffer.from(match[1], 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * Kapso signs each forwarded webhook with `X-Webhook-Signature: <hex
 * HMAC-SHA256(secret, raw body)>` (a bare hex digest, optionally `sha256=`
 * prefixed), using the `secret_key` the webhook was registered with.
 */
export function verifyKapsoSignature(secret: string, raw: Buffer, header: unknown): boolean {
  if (!secret || typeof header !== 'string') return false;
  const hex = header.trim().replace(/^sha256=/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest();
  const given = Buffer.from(hex, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown, max = 4096): string {
  if (typeof value === 'string') return value.slice(0, max);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Meta's unix-seconds timestamp → ISO; now when missing or nonsense. */
export function timestampToIso(value: unknown, now: Date): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return now.toISOString();
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? now.toISOString() : date.toISOString();
}

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

/** One `messages[]` / `message_echoes[]` entry → the stored shape. Unknown types become 'unsupported'. */
export function parseWhatsAppMessage(raw: unknown, now: Date): ParsedMessage | null {
  const m = obj(raw);
  const wamid = str(m.id, 256);
  if (!wamid) return null;
  const type = str(m.type, 40);
  const base: ParsedMessage = {
    wamid,
    type: 'unsupported',
    text: '',
    caption: '',
    mediaId: '',
    mimeType: '',
    fileName: '',
    location: null,
    reactionTo: null,
    at: timestampToIso(m.timestamp, now),
  };

  if (type === 'text') {
    return { ...base, type, text: str(obj(m.text).body) };
  }
  if (MEDIA_TYPES.has(type)) {
    const media = obj(m[type]);
    return {
      ...base,
      type,
      mediaId: str(media.id, 128),
      mimeType: str(media.mime_type, 200),
      caption: str(media.caption, 4096),
      fileName: str(media.filename, 255),
    };
  }
  if (type === 'location') {
    const loc = obj(m.location);
    const location = {
      latitude: num(loc.latitude),
      longitude: num(loc.longitude),
      name: str(loc.name, 500),
      address: str(loc.address, 1000),
    };
    return { ...base, type, location, text: location.name || location.address };
  }
  if (type === 'button') {
    const button = obj(m.button);
    return { ...base, type, text: str(button.text) || str(button.payload) };
  }
  if (type === 'interactive') {
    const interactive = obj(m.interactive);
    const reply = obj(interactive.button_reply).title ?? obj(interactive.list_reply).title;
    return { ...base, type, text: str(reply) };
  }
  if (type === 'reaction') {
    const reaction = obj(m.reaction);
    return { ...base, type, text: str(reaction.emoji, 32), reactionTo: str(reaction.message_id, 256) || null };
  }
  return base;
}

const STATUS_VALUES = new Set<MessageStatus>(['sent', 'delivered', 'read', 'failed']);

function statusError(raw: Obj): string | null {
  const first = obj(arr(raw.errors)[0]);
  const message = str(first.message, 500) || str(first.title, 500);
  const details = str(obj(first.error_data).details, 500);
  if (!message && !details) return null;
  if (message && details && !message.includes(details)) return `${message} — ${details}`;
  return message || details;
}

/**
 * The events in one webhook delivery. Only `messages` and
 * `smb_message_echoes` changes count; anything else, or any shape we do not
 * recognise, is skipped rather than thrown on. When `phoneNumberId` is set,
 * changes for other numbers on the same app are ignored.
 */
export function parseWhatsAppWebhook(body: unknown, options: { now: Date; phoneNumberId?: string }): WebhookEvent[] {
  const events: WebhookEvent[] = [];
  for (const entry of arr(obj(body).entry)) {
    for (const rawChange of arr(obj(entry).changes)) {
      const change = obj(rawChange);
      const field = str(change.field, 64);
      if (field !== 'messages' && field !== 'smb_message_echoes') continue;
      const value = obj(change.value);
      const metaPhoneId = str(obj(value.metadata).phone_number_id, 64);
      if (options.phoneNumberId && metaPhoneId && metaPhoneId !== options.phoneNumberId) continue;

      if (field === 'smb_message_echoes') {
        for (const raw of arr(value.message_echoes)) {
          const to = str(obj(raw).to, 32).replace(/^\+/, '');
          const message = parseWhatsAppMessage(raw, options.now);
          if (message && isWaId(to)) events.push({ kind: 'echo', waId: to, message });
        }
        continue;
      }

      const names = new Map<string, string>();
      for (const raw of arr(value.contacts)) {
        const contact = obj(raw);
        const waId = str(contact.wa_id, 32);
        const name = str(obj(contact.profile).name, 120).trim();
        if (waId && name) names.set(waId, name);
      }
      for (const raw of arr(value.messages)) {
        const from = str(obj(raw).from, 32).replace(/^\+/, '');
        const message = parseWhatsAppMessage(raw, options.now);
        if (message && isWaId(from)) {
          events.push({ kind: 'inbound', waId: from, profileName: names.get(from) || '', message });
        }
      }
      for (const raw of arr(value.statuses)) {
        const status = obj(raw);
        const wamid = str(status.id, 256);
        const state = str(status.status, 20) as MessageStatus;
        if (!wamid || !STATUS_VALUES.has(state)) continue;
        events.push({
          kind: 'status',
          waId: str(status.recipient_id, 32).replace(/^\+/, ''),
          wamid,
          status: state,
          error: state === 'failed' ? statusError(status) : null,
        });
      }
    }
  }
  return events;
}
