import path from 'path';
import { readJsonArray, writeJsonFile } from '../shared/json-file.ts';

/** رسالة من نموذج «الدعم» في الموقع. */
export type SupportMessage = {
  id: string;
  name: string;
  email: string;
  phone: string;
  message: string;
  createdAt: string;
};

export type SupportMessageInput = {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  message?: unknown;
};

export const SUPPORT_REQUIRED_FIELDS = 'الاسم والرسالة وبريد أو جوال مطلوبة.';

/** Free-text fields are capped so one submission cannot bloat the document. */
const MAX_NAME = 120;
const MAX_CONTACT = 120;
const MAX_MESSAGE = 2000;

export function validateSupportMessage(
  input: SupportMessageInput,
): { ok: true; value: Omit<SupportMessage, 'id' | 'createdAt'> } | { ok: false; error: string } {
  const name = String(input.name || '').trim().slice(0, MAX_NAME);
  const email = String(input.email || '').trim().slice(0, MAX_CONTACT);
  const phone = String(input.phone || '').trim().slice(0, MAX_CONTACT);
  const message = String(input.message || '').trim().slice(0, MAX_MESSAGE);

  // A name, something to say, and at least one way to reply.
  if (!name || !message || (!email && !phone)) {
    return { ok: false, error: SUPPORT_REQUIRED_FIELDS };
  }
  return { ok: true, value: { name, email, phone, message } };
}

export function createSupportStore(dataDir: string) {
  const file = path.join(dataDir, 'support-messages.json');

  function list(): SupportMessage[] {
    return readJsonArray<SupportMessage>(file);
  }

  /** Newest first, matching how the admin panel reads them. */
  function add(value: Omit<SupportMessage, 'id' | 'createdAt'>): SupportMessage {
    const row: SupportMessage = {
      id: `sup-${Date.now()}`,
      ...value,
      createdAt: new Date().toISOString(),
    };
    const rows = list();
    rows.unshift(row);
    writeJsonFile(file, rows);
    return row;
  }

  return { list, add };
}

export type SupportStore = ReturnType<typeof createSupportStore>;
