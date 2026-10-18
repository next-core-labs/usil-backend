import path from 'path';
import crypto from 'crypto';
import { normalizeSaudiMobile } from '../shared/booking-guards';
import { readJsonArray, writeJsonFile } from '../shared/json-file.ts';

/**
 * أرقام المورّدين المحتملين — a contact list the owner builds (usually from an
 * Excel sheet) to invite suppliers to Usil over WhatsApp. These are not
 * accounts: nobody can sign in with a lead, and importing creates none.
 */

export const LEAD_STATUSES = ['new', 'contacted', 'interested', 'joined', 'declined'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_STATUS_AR: Record<LeadStatus, string> = {
  new: 'جديد',
  contacted: 'تم التواصل',
  interested: 'مهتم',
  joined: 'انضم',
  declined: 'غير مهتم',
};

export function isLeadStatus(value: unknown): value is LeadStatus {
  return (LEAD_STATUSES as readonly string[]).includes(String(value));
}

export type VendorLead = {
  id: string;
  name: string;
  /** Saudi mobile, normalised to 05XXXXXXXX — the de-duplication key. */
  phone: string;
  city: string;
  /** What they supply (قهوة، خيام، تصوير…). */
  activity: string;
  note: string;
  status: LeadStatus;
  source: 'import' | 'manual';
  createdAt: string;
  updatedAt: string;
};

export type LeadInput = { name?: unknown; phone?: unknown; city?: unknown; activity?: unknown; note?: unknown };

/** One import is capped so a wrong file can't flood the list or the request. */
export const LEAD_IMPORT_MAX_ROWS = 2000;

const text = (value: unknown, max: number) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

export type ParsedLead = Pick<VendorLead, 'name' | 'phone' | 'city' | 'activity' | 'note'>;

/** A row is usable with a valid Saudi mobile; every other field is optional. */
export function parseLeadInput(input: LeadInput): { ok: true; value: ParsedLead } | { ok: false; error: string } {
  const rawPhone = String(input.phone ?? '').trim();
  if (!rawPhone) return { ok: false, error: 'رقم الجوال فارغ' };
  const phone = normalizeSaudiMobile(rawPhone);
  if (!phone) return { ok: false, error: 'رقم جوال سعودي غير صحيح' };
  return {
    ok: true,
    value: {
      name: text(input.name, 80),
      phone,
      city: text(input.city, 60),
      activity: text(input.activity, 60),
      note: text(input.note, 300),
    },
  };
}

export type LeadImportResult = {
  added: number;
  /** Numbers already on the list, or repeated inside the same file. */
  duplicates: number;
  invalid: Array<{ row: number; phone: string; error: string }>;
  total: number;
};

export function createVendorLeadStore(dataDir: string) {
  const file = path.join(dataDir, 'vendor-leads.json');
  const read = (): VendorLead[] => readJsonArray<VendorLead>(file);
  const write = (rows: VendorLead[]) => writeJsonFile(file, rows);
  const newId = () => `lead-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

  function build(value: ParsedLead, source: VendorLead['source'], at: string): VendorLead {
    return { id: newId(), ...value, status: 'new', source, createdAt: at, updatedAt: at };
  }

  return {
    list(): VendorLead[] {
      return read();
    },

    /** Rows numbered from 1, as the spreadsheet shows them (after its header). */
    importRows(rows: LeadInput[], now = new Date()): LeadImportResult {
      const at = now.toISOString();
      const current = read();
      const known = new Set(current.map((row) => row.phone));
      const added: VendorLead[] = [];
      const invalid: LeadImportResult['invalid'] = [];
      let duplicates = 0;
      rows.forEach((input, index) => {
        const parsed = parseLeadInput(input || {});
        if (parsed.ok === false) {
          invalid.push({ row: index + 1, phone: String(input?.phone ?? '').slice(0, 30), error: parsed.error });
          return;
        }
        if (known.has(parsed.value.phone)) {
          duplicates += 1;
          return;
        }
        known.add(parsed.value.phone);
        added.push(build(parsed.value, 'import', at));
      });
      if (added.length) write([...added, ...current]);
      return { added: added.length, duplicates, invalid, total: rows.length };
    },

    addOne(input: LeadInput, now = new Date()): { ok: true; lead: VendorLead } | { ok: false; error: string; status: number } {
      const parsed = parseLeadInput(input);
      if (parsed.ok === false) return { ok: false, error: parsed.error, status: 400 };
      const current = read();
      if (current.some((row) => row.phone === parsed.value.phone)) {
        return { ok: false, error: 'هذا الرقم موجود في القائمة.', status: 409 };
      }
      const lead = build(parsed.value, 'manual', now.toISOString());
      write([lead, ...current]);
      return { ok: true, lead };
    },

    update(id: string, patch: { status?: unknown; note?: unknown; name?: unknown; city?: unknown; activity?: unknown }): VendorLead | null {
      const rows = read();
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return null;
      const next = { ...rows[index] };
      if (patch.status !== undefined && isLeadStatus(patch.status)) next.status = patch.status;
      if (patch.note !== undefined) next.note = text(patch.note, 300);
      if (patch.name !== undefined) next.name = text(patch.name, 80);
      if (patch.city !== undefined) next.city = text(patch.city, 60);
      if (patch.activity !== undefined) next.activity = text(patch.activity, 60);
      next.updatedAt = new Date().toISOString();
      rows[index] = next;
      write(rows);
      return next;
    },

    remove(id: string): boolean {
      const rows = read();
      const next = rows.filter((row) => row.id !== id);
      if (next.length === rows.length) return false;
      write(next);
      return true;
    },
  };
}
