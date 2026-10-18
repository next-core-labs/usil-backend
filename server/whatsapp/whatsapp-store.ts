import crypto from 'crypto';
import path from 'path';
import { readJsonArray, readJsonFile, writeJsonFile } from '../shared/json-file';

/**
 * The shared WhatsApp inbox: one conversation per customer `waId`
 * (international digits, no «+»), each with its own messages document.
 *
 *   data/whatsapp/conversations.json        Conversation[]
 *   data/whatsapp/messages/<waId>.json      Message[] (oldest first, newest 3000 kept)
 *   data/whatsapp/media-index.json          { mediaId: waId } — which chat a media id belongs to
 *
 * All reads and writes are synchronous, so a read-modify-write never
 * interleaves with another request inside the single Durable Object.
 */

export const MESSAGES_KEPT = 3000;
const MEDIA_INDEX_KEPT = 20_000;
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export type MessageDirection = 'in' | 'out';
export type MessageStatus = 'received' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
export type MessageVia = 'dashboard' | 'phone' | 'customer';
export type Person = { id: string; name: string };

export type WhatsAppLocation = { latitude: number; longitude: number; name: string; address: string };

export type WhatsAppMessage = {
  id: string;
  wamid: string;
  direction: MessageDirection;
  type: string;
  text: string;
  caption: string;
  mediaId: string;
  mimeType: string;
  fileName: string;
  location: WhatsAppLocation | null;
  status: MessageStatus;
  error: string | null;
  at: string;
  sentBy: Person | null;
  via: MessageVia;
  template: { name: string; language: string } | null;
  /** For `type: 'reaction'`: the wamid of the message reacted to. */
  reactionTo: string | null;
};

export type LastMessage = { text: string; type: string; direction: MessageDirection; at: string };

type StoredConversation = {
  waId: string;
  /** Name set by staff; wins over the WhatsApp profile name. */
  customName: string;
  profileName: string;
  lastMessage: LastMessage | null;
  lastInboundAt: string | null;
  lastInboundWamid: string;
  readReceiptWamid: string;
  unread: number;
  assignedTo: Person | null;
  status: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
};

export type WhatsAppConversation = {
  waId: string;
  name: string;
  phone: string;
  lastMessage: LastMessage | null;
  lastInboundAt: string | null;
  windowOpen: boolean;
  unread: number;
  assignedTo: Person | null;
  status: 'open' | 'closed';
  updatedAt: string;
};

/** A message as parsed from a webhook, before it gets a local id. */
export type ParsedMessage = Pick<
  WhatsAppMessage,
  'wamid' | 'type' | 'text' | 'caption' | 'mediaId' | 'mimeType' | 'fileName' | 'location' | 'reactionTo'
> & { at: string };

export function isWaId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{7,15}$/.test(value);
}

/** Saudi numbers read as «05XXXXXXXX»; anything else as «+<digits>». */
export function displayPhone(waId: string): string {
  if (/^9665\d{8}$/.test(waId)) return `0${waId.slice(3)}`;
  return `+${waId}`;
}

/**
 * A phone typed by staff → waId. Saudi local forms («05…», «5…», «+9665…»,
 * «009665…», «966 05…») become 9665XXXXXXXX; other international numbers
 * (written with + or 00, or bare) are accepted at 10–15 digits.
 */
export function normalizeWhatsAppPhone(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  let value = String(raw)
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  if (!value || /[^\d\s+()\-.]/.test(value)) return null;
  const international = value.startsWith('+') || value.startsWith('00');
  let digits = value.replace(/\D/g, '');
  if (value.startsWith('00')) digits = digits.slice(2);
  if (!international) {
    if (/^05\d{8}$/.test(digits)) return `966${digits.slice(1)}`;
    if (/^5\d{8}$/.test(digits)) return `966${digits}`;
  }
  if (digits.startsWith('9660')) digits = `966${digits.slice(4)}`;
  if (digits.startsWith('966')) return /^9665\d{8}$/.test(digits) ? digits : null;
  if (digits.startsWith('0')) return null;
  return /^\d{10,15}$/.test(digits) ? digits : null;
}

function newMessageId(): string {
  return `wam-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

const STATUS_RANK: Record<MessageStatus, number> = {
  received: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 5,
};

/** Meta can deliver «delivered» after «read»; a status never moves backwards. Failure always lands. */
function nextStatus(current: MessageStatus, incoming: MessageStatus): MessageStatus {
  if (incoming === 'failed') return 'failed';
  if (current === 'failed') return current;
  return STATUS_RANK[incoming] > STATUS_RANK[current] ? incoming : current;
}

function summaryText(message: Pick<WhatsAppMessage, 'text' | 'caption' | 'fileName' | 'location'>): string {
  const text = message.text || message.caption || message.fileName || message.location?.name || message.location?.address || '';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export type InboundEvent = { kind: 'inbound'; waId: string; profileName: string; message: ParsedMessage };
export type EchoEvent = { kind: 'echo'; waId: string; message: ParsedMessage };
export type StatusEvent = { kind: 'status'; waId: string; wamid: string; status: MessageStatus; error: string | null };
export type WebhookEvent = InboundEvent | EchoEvent | StatusEvent;

export function createWhatsAppStore(dataDir: string, now: () => Date = () => new Date()) {
  const root = path.join(dataDir, 'whatsapp');
  const conversationsFile = path.join(root, 'conversations.json');
  const mediaIndexFile = path.join(root, 'media-index.json');
  const messagesFile = (waId: string) => path.join(root, 'messages', `${waId}.json`);
  /** Statuses that arrived before the send that produced their wamid was stored. */
  const pendingStatuses = new Map<string, { status: MessageStatus; error: string | null; at: number }>();

  function loadConversations(): StoredConversation[] {
    return readJsonArray<StoredConversation>(conversationsFile).filter((row) => row && isWaId(row.waId));
  }

  function saveConversations(rows: StoredConversation[]) {
    writeJsonFile(conversationsFile, rows);
  }

  function loadMessages(waId: string): WhatsAppMessage[] {
    if (!isWaId(waId)) return [];
    return readJsonArray<WhatsAppMessage>(messagesFile(waId));
  }

  function saveMessages(waId: string, rows: WhatsAppMessage[]) {
    writeJsonFile(messagesFile(waId), rows.length > MESSAGES_KEPT ? rows.slice(-MESSAGES_KEPT) : rows);
  }

  function indexMedia(mediaId: string, waId: string) {
    if (!mediaId) return;
    const index = readJsonFile<Record<string, string>>(mediaIndexFile, {});
    if (index[mediaId] === waId) return;
    index[mediaId] = waId;
    const keys = Object.keys(index);
    const trimmed =
      keys.length > MEDIA_INDEX_KEPT
        ? Object.fromEntries(keys.slice(-MEDIA_INDEX_KEPT).map((key) => [key, index[key]]))
        : index;
    writeJsonFile(mediaIndexFile, trimmed);
  }

  function windowOpen(row: StoredConversation): boolean {
    if (!row.lastInboundAt) return false;
    const at = Date.parse(row.lastInboundAt);
    return Number.isFinite(at) && now().getTime() - at < WINDOW_MS;
  }

  function toPublic(row: StoredConversation): WhatsAppConversation {
    return {
      waId: row.waId,
      name: row.customName || row.profileName || '',
      phone: displayPhone(row.waId),
      lastMessage: row.lastMessage || null,
      lastInboundAt: row.lastInboundAt || null,
      windowOpen: windowOpen(row),
      unread: Math.max(0, Number(row.unread) || 0),
      assignedTo: row.assignedTo || null,
      status: row.status === 'closed' ? 'closed' : 'open',
      updatedAt: row.updatedAt,
    };
  }

  function emptyConversation(waId: string): StoredConversation {
    const stamp = now().toISOString();
    return {
      waId,
      customName: '',
      profileName: '',
      lastMessage: null,
      lastInboundAt: null,
      lastInboundWamid: '',
      readReceiptWamid: '',
      unread: 0,
      assignedTo: null,
      status: 'open',
      createdAt: stamp,
      updatedAt: stamp,
    };
  }

  /** Load-or-create, mutate, save. Returns the saved row. */
  function upsert(waId: string, mutate: (row: StoredConversation) => void): StoredConversation {
    const rows = loadConversations();
    let row = rows.find((item) => item.waId === waId);
    if (!row) {
      row = emptyConversation(waId);
      rows.push(row);
    }
    mutate(row);
    saveConversations(rows);
    return row;
  }

  function activityAt(row: StoredConversation): number {
    return Date.parse(row.lastMessage?.at || row.updatedAt || row.createdAt) || 0;
  }

  function laterIso(a: string, b: string): string {
    return Date.parse(b) > Date.parse(a) ? b : a;
  }

  function touchLastMessage(row: StoredConversation, message: WhatsAppMessage) {
    // An older message replayed late must not replace a newer preview.
    if (row.lastMessage && Date.parse(row.lastMessage.at) > Date.parse(message.at)) return;
    row.lastMessage = { text: summaryText(message), type: message.type, direction: message.direction, at: message.at };
  }

  function buildMessage(parsed: ParsedMessage, extra: Partial<WhatsAppMessage>): WhatsAppMessage {
    return {
      id: newMessageId(),
      wamid: parsed.wamid,
      direction: 'in',
      type: parsed.type,
      text: parsed.text,
      caption: parsed.caption,
      mediaId: parsed.mediaId,
      mimeType: parsed.mimeType,
      fileName: parsed.fileName,
      location: parsed.location,
      status: 'received',
      error: null,
      at: parsed.at,
      sentBy: null,
      via: 'customer',
      template: null,
      reactionTo: parsed.reactionTo,
      ...extra,
    };
  }

  /** Append unless the wamid is already stored (Meta retries webhooks). */
  function appendMessage(waId: string, message: WhatsAppMessage): boolean {
    const rows = loadMessages(waId);
    if (message.wamid && rows.some((row) => row.wamid === message.wamid)) return false;
    const pending = message.wamid ? pendingStatuses.get(message.wamid) : undefined;
    if (pending) {
      pendingStatuses.delete(message.wamid);
      message.status = nextStatus(message.status, pending.status);
      if (pending.error) message.error = pending.error;
    }
    rows.push(message);
    // Webhooks can arrive out of order; keep the file in time order (stable for equal times).
    if (rows.length > 1 && Date.parse(rows[rows.length - 2].at) > Date.parse(message.at)) {
      rows.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
    }
    saveMessages(waId, rows);
    if (message.mediaId) indexMedia(message.mediaId, waId);
    return true;
  }

  function rememberPendingStatus(wamid: string, status: MessageStatus, error: string | null) {
    const stamp = Date.now();
    for (const [key, value] of pendingStatuses) {
      if (stamp - value.at > 10 * 60_000) pendingStatuses.delete(key);
    }
    if (pendingStatuses.size > 500) return;
    const previous = pendingStatuses.get(wamid);
    pendingStatuses.set(wamid, {
      status: previous ? nextStatus(previous.status, status) : status,
      error: error || previous?.error || null,
      at: stamp,
    });
  }

  function applyStatus(event: StatusEvent): boolean {
    const candidates = isWaId(event.waId)
      ? [event.waId]
      : loadConversations().map((row) => row.waId);
    for (const waId of candidates) {
      const rows = loadMessages(waId);
      const message = rows.find((row) => row.wamid === event.wamid && row.direction === 'out');
      if (!message) continue;
      const status = nextStatus(message.status, event.status);
      const error = event.status === 'failed' ? event.error || message.error || 'فشل الإرسال' : message.error;
      if (status === message.status && error === message.error) return true;
      message.status = status;
      message.error = error;
      saveMessages(waId, rows);
      return true;
    }
    rememberPendingStatus(event.wamid, event.status, event.error);
    return false;
  }

  function getConversation(waId: string): WhatsAppConversation | null {
    const row = loadConversations().find((item) => item.waId === waId);
    return row ? toPublic(row) : null;
  }

  return {
    list(): WhatsAppConversation[] {
      return loadConversations()
        .sort((a, b) => activityAt(b) - activityAt(a))
        .map(toPublic);
    },

    get: getConversation,

    /** The wamid a read receipt should point at, if one has not been sent for it yet. */
    pendingReadReceipt(waId: string): string {
      const row = loadConversations().find((item) => item.waId === waId);
      if (!row || !row.lastInboundWamid || row.readReceiptWamid === row.lastInboundWamid) return '';
      return row.lastInboundWamid;
    },

    markReadReceiptSent(waId: string, wamid: string) {
      if (!getConversation(waId)) return;
      upsert(waId, (row) => {
        row.readReceiptWamid = wamid;
      });
    },

    unreadCount(): number {
      return loadConversations().filter((row) => (Number(row.unread) || 0) > 0).length;
    },

    messages(waId: string, afterId?: string): WhatsAppMessage[] {
      const rows = loadMessages(waId);
      if (!afterId) return rows;
      const index = rows.findIndex((row) => row.id === afterId);
      return index === -1 ? rows : rows.slice(index + 1);
    },

    markRead(waId: string): WhatsAppConversation | null {
      if (!getConversation(waId)) return null;
      return toPublic(
        upsert(waId, (row) => {
          row.unread = 0;
        }),
      );
    },

    update(
      waId: string,
      patch: { assignedTo?: Person | null; status?: 'open' | 'closed'; name?: string },
    ): WhatsAppConversation | null {
      if (!getConversation(waId)) return null;
      return toPublic(
        upsert(waId, (row) => {
          if (patch.assignedTo !== undefined) row.assignedTo = patch.assignedTo;
          if (patch.status !== undefined) row.status = patch.status;
          if (patch.name !== undefined) row.customName = patch.name;
          row.updatedAt = now().toISOString();
        }),
      );
    },

    /** Create the conversation if missing (staff starting a chat). A given name only fills a blank one. */
    ensureConversation(waId: string, name = ''): WhatsAppConversation {
      return toPublic(
        upsert(waId, (row) => {
          if (name && !row.customName && !row.profileName) row.customName = name;
        }),
      );
    },

    /** Store a message sent from the dashboard (Graph already accepted it). */
    addOutbound(
      waId: string,
      fields: Pick<WhatsAppMessage, 'wamid' | 'type' | 'text'> &
        Partial<Pick<WhatsAppMessage, 'template' | 'sentBy'>>,
    ): WhatsAppMessage {
      const message: WhatsAppMessage = {
        id: newMessageId(),
        wamid: fields.wamid,
        direction: 'out',
        type: fields.type,
        text: fields.text,
        caption: '',
        mediaId: '',
        mimeType: '',
        fileName: '',
        location: null,
        status: 'sent',
        error: null,
        at: now().toISOString(),
        sentBy: fields.sentBy || null,
        via: 'dashboard',
        template: fields.template || null,
        reactionTo: null,
      };
      appendMessage(waId, message);
      upsert(waId, (row) => {
        touchLastMessage(row, message);
        // Staff answered, so the chat has been read.
        row.unread = 0;
        row.updatedAt = laterIso(row.updatedAt, message.at);
      });
      return message;
    },

    /** Apply one webhook event. Returns false for a duplicate or an unmatched status. */
    apply(event: WebhookEvent): boolean {
      if (event.kind === 'status') return applyStatus(event);
      if (!isWaId(event.waId)) return false;

      if (event.kind === 'inbound') {
        const message = buildMessage(event.message, {});
        const added = appendMessage(event.waId, message);
        if (!added) {
          // Still learn the profile name from a retry.
          if (event.profileName) {
            upsert(event.waId, (row) => {
              row.profileName = event.profileName;
            });
          }
          return false;
        }
        upsert(event.waId, (row) => {
          if (event.profileName) row.profileName = event.profileName;
          touchLastMessage(row, message);
          if (!row.lastInboundAt || Date.parse(message.at) >= Date.parse(row.lastInboundAt)) {
            row.lastInboundAt = message.at;
            row.lastInboundWamid = message.wamid;
          }
          row.unread = (Number(row.unread) || 0) + 1;
          row.status = 'open';
          row.updatedAt = laterIso(row.updatedAt, message.at);
        });
        return true;
      }

      const message = buildMessage(event.message, { direction: 'out', status: 'sent', via: 'phone' });
      if (!appendMessage(event.waId, message)) return false;
      upsert(event.waId, (row) => {
        touchLastMessage(row, message);
        row.updatedAt = laterIso(row.updatedAt, message.at);
      });
      return true;
    },

    /** Whether a media id appears in a stored message (the media proxy serves nothing else). */
    hasMedia(mediaId: string): boolean {
      const index = readJsonFile<Record<string, string>>(mediaIndexFile, {});
      const waId = index[mediaId];
      if (!isWaId(waId)) return false;
      return loadMessages(waId).some((row) => row.mediaId === mediaId);
    },
  };
}

export type WhatsAppStore = ReturnType<typeof createWhatsAppStore>;
