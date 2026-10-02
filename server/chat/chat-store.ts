import crypto from 'crypto';
import path from 'path';
import { readJsonArray, writeJsonFile } from '../shared/json-file.ts';

/**
 * In-app chat. Two kinds of thread, each one per pair so a party always lands
 * back in the same conversation:
 *
 * - `client_vendor`: one signed-in client and one vendor.
 * - `vendor_owner`: one vendor and the Usil team. Every admin and accounts
 *   manager reads the same thread, so the owner side is a shared inbox.
 *
 * Clients never see owner threads and the owner side never sees client
 * threads; `canAccess` is the one place that rule lives.
 */
export const CHAT_KINDS = ['client_vendor', 'vendor_owner'] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];

export type ChatSide = 'client' | 'vendor' | 'owner';

/** What a message is about — shown above it as «بخصوص: …». */
export type ChatContext = { type: 'listing' | 'booking'; id: string; title: string };

export type ChatMessage = {
  id: string;
  /** Position in its thread, 1-based and never reused; read markers point at it. */
  seq: number;
  side: ChatSide;
  /** The account that sent it; for the owner side, which admin answered. */
  senderId: string;
  senderName: string;
  body: string;
  context?: ChatContext;
  createdAt: string;
};

export type Conversation = {
  id: string;
  kind: ChatKind;
  vendorId: string;
  vendorName: string;
  clientId?: string;
  clientName?: string;
  messages: ChatMessage[];
  /**
   * The last message each side has seen, by `seq`. A sequence rather than a
   * timestamp, because two messages can share a millisecond.
   */
  readSeq: Partial<Record<ChatSide, number>>;
  createdAt: string;
  updatedAt: string;
};

export type ConversationSummary = Omit<Conversation, 'messages' | 'readSeq'> & {
  lastMessage: ChatMessage | null;
  unread: number;
};

export type ChatViewer = { side: ChatSide; userId: string };

export const MAX_CHAT_BODY = 2000;
/** Oldest messages are dropped past this, so one thread cannot bloat the document. */
export const MAX_THREAD_MESSAGES = 2000;
const MAX_CONTEXT_ID = 80;
const MAX_CONTEXT_TITLE = 160;

export const CHAT_BODY_REQUIRED = 'اكتب رسالتك أولاً.';

export function sideForRole(role: string | undefined | null): ChatSide | null {
  if (role === 'client') return 'client';
  if (role === 'vendor') return 'vendor';
  if (role === 'admin' || role === 'accounts_manager') return 'owner';
  return null;
}

export function validateChatBody(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, error: CHAT_BODY_REQUIRED };
  if (value.length > MAX_CHAT_BODY) {
    return { ok: false, error: `الرسالة طويلة. الحد ${MAX_CHAT_BODY} حرف.` };
  }
  return { ok: true, value };
}

/** A malformed context is dropped rather than failing the message it rides on. */
export function parseChatContext(raw: unknown): ChatContext | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const input = raw as Record<string, unknown>;
  if (input.type !== 'listing' && input.type !== 'booking') return undefined;
  const id = String(input.id ?? '').trim().slice(0, MAX_CONTEXT_ID);
  const title = String(input.title ?? '').trim().slice(0, MAX_CONTEXT_TITLE);
  if (!id) return undefined;
  return { type: input.type, id, title };
}

export function canAccess(row: Conversation, viewer: ChatViewer): boolean {
  if (viewer.side === 'client') return row.kind === 'client_vendor' && row.clientId === viewer.userId;
  if (viewer.side === 'vendor') return row.vendorId === viewer.userId;
  return row.kind === 'vendor_owner';
}

function unreadFor(row: Conversation, side: ChatSide): number {
  const seen = row.readSeq?.[side] || 0;
  return row.messages.filter((message) => message.side !== side && message.seq > seen).length;
}

function summarize(row: Conversation, side: ChatSide): ConversationSummary {
  const { messages, readSeq: _readSeq, ...rest } = row;
  return { ...rest, lastMessage: messages[messages.length - 1] || null, unread: unreadFor(row, side) };
}

let lastStamp = 0;

/**
 * Strictly increasing timestamps, so «newest activity first» has one answer
 * even when two threads change in the same millisecond.
 */
function stamp(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
}

export class ChatStoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type OpenThreadInput =
  | { kind: 'client_vendor'; vendorId: string; vendorName: string; clientId: string; clientName: string }
  | { kind: 'vendor_owner'; vendorId: string; vendorName: string };

export function createChatStore(dataDir: string) {
  const file = path.join(dataDir, 'chats.json');

  function load(): Conversation[] {
    return readJsonArray<Conversation>(file);
  }

  function save(rows: Conversation[]) {
    writeJsonFile(file, rows);
  }

  function findOwned(rows: Conversation[], id: string, viewer: ChatViewer): Conversation {
    const row = rows.find((item) => item.id === id);
    // A thread the viewer may not read answers exactly like a missing one.
    if (!row || !canAccess(row, viewer)) throw new ChatStoreError('المحادثة غير موجودة.', 404);
    return row;
  }

  /** Newest activity first. */
  function list(viewer: ChatViewer): ConversationSummary[] {
    return load()
      .filter((row) => canAccess(row, viewer))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((row) => summarize(row, viewer.side));
  }

  function unreadCount(viewer: ChatViewer): number {
    return load()
      .filter((row) => canAccess(row, viewer))
      .reduce((total, row) => total + unreadFor(row, viewer.side), 0);
  }

  /**
   * The full thread, or only the messages after `afterId` when the caller is
   * polling. An unknown `afterId` returns everything, so a client that lost its
   * place resynchronises instead of silently missing messages.
   */
  function get(id: string, viewer: ChatViewer, afterId?: string): Conversation {
    const row = findOwned(load(), id, viewer);
    if (!afterId) return row;
    const index = row.messages.findIndex((message) => message.id === afterId);
    return index === -1 ? row : { ...row, messages: row.messages.slice(index + 1) };
  }

  function samePair(row: Conversation, input: Pick<OpenThreadInput, 'kind' | 'vendorId'> & { clientId?: string }) {
    return (
      row.kind === input.kind &&
      row.vendorId === input.vendorId &&
      (input.kind === 'vendor_owner' || row.clientId === input.clientId)
    );
  }

  function hasPair(input: Pick<OpenThreadInput, 'kind' | 'vendorId'> & { clientId?: string }): boolean {
    return load().some((row) => samePair(row, input));
  }

  /** Find the pair's thread or start it. Names are refreshed on every open. */
  function open(input: OpenThreadInput): { conversation: Conversation; created: boolean } {
    const rows = load();
    const existing = rows.find((row) => samePair(row, input));
    if (existing) {
      existing.vendorName = input.vendorName || existing.vendorName;
      if (input.kind === 'client_vendor') existing.clientName = input.clientName || existing.clientName;
      save(rows);
      return { conversation: existing, created: false };
    }
    const now = stamp();
    const conversation: Conversation = {
      id: newId('chat'),
      kind: input.kind,
      vendorId: input.vendorId,
      vendorName: input.vendorName,
      ...(input.kind === 'client_vendor' ? { clientId: input.clientId, clientName: input.clientName } : {}),
      messages: [],
      readSeq: {},
      createdAt: now,
      updatedAt: now,
    };
    rows.push(conversation);
    save(rows);
    return { conversation, created: true };
  }

  function send(
    id: string,
    viewer: ChatViewer,
    input: { senderName: string; body: string; context?: ChatContext },
  ): ChatMessage {
    const rows = load();
    const row = findOwned(rows, id, viewer);
    const message: ChatMessage = {
      id: newId('msg'),
      seq: (row.messages[row.messages.length - 1]?.seq || 0) + 1,
      side: viewer.side,
      senderId: viewer.userId,
      senderName: input.senderName,
      body: input.body,
      ...(input.context ? { context: input.context } : {}),
      createdAt: stamp(),
    };
    row.messages.push(message);
    if (row.messages.length > MAX_THREAD_MESSAGES) {
      row.messages.splice(0, row.messages.length - MAX_THREAD_MESSAGES);
    }
    // Sending means you have seen everything before your own message.
    row.readSeq = { ...row.readSeq, [viewer.side]: message.seq };
    row.updatedAt = message.createdAt;
    save(rows);
    return message;
  }

  function markRead(id: string, viewer: ChatViewer): void {
    const rows = load();
    const row = findOwned(rows, id, viewer);
    const last = row.messages[row.messages.length - 1];
    if (!last || (row.readSeq?.[viewer.side] || 0) >= last.seq) return;
    row.readSeq = { ...row.readSeq, [viewer.side]: last.seq };
    save(rows);
  }

  return { list, unreadCount, get, hasPair, open, send, markRead };
}

export type ChatStore = ReturnType<typeof createChatStore>;
