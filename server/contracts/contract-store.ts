import crypto from 'crypto';
import path from 'path';
import { readJsonFile, writeJsonFile } from '../shared/json-file.ts';
import { normalizeSaudiMobile } from '../shared/booking-guards.ts';

/**
 * العقود الإلكترونية — a vendor's service contracts, signed by the CLIENT on a
 * private link (`/sign/<token>` on the store), not by a button the vendor presses.
 *
 * Lifecycle: draft → sent (link issued) → signed, or cancelled from draft/sent.
 * A signed contract is immutable. Editing a sent contract changes its
 * `contentHash`, so a signing page opened before the edit is refused (409).
 *
 * Everything lives in one document, `data/contracts.json`, written through
 * `json-file.ts` (and so through `data-fs.ts` on Cloudflare).
 */

export type ContractStatus = 'draft' | 'sent' | 'signed' | 'cancelled';
export type ContractSourceKind = 'order' | 'booking' | 'manual';

export type ContractClient = { name: string; phone: string; email?: string; nationalId?: string };
export type ContractEvent = { date: string; time?: string; location: string; service: string };
export type ContractAmounts = { total: number; deposit: number; remaining: number; currency: 'SAR' };

export type ContractSignature = {
  name: string;
  /** PNG data URL drawn by the client. Empty on a legacy record. */
  image: string;
  signedAt: string;
  ip: string;
  userAgent: string;
  /** The fingerprint of exactly what was on the client's screen when they signed. */
  contentHash: string;
  /** Legacy records only: who recorded it and that it is not a verified client signature. */
  note?: string;
};

export type Contract = {
  id: string;
  number: string;
  vendorId: string;
  vendorName: string;
  source: { kind: ContractSourceKind; ref?: string };
  client: ContractClient;
  event: ContractEvent;
  amounts: ContractAmounts;
  terms: string[];
  notes?: string;
  status: ContractStatus;
  /** Random 32 bytes, base64url. Only set once the contract is sent. */
  shareToken?: string;
  contentHash: string;
  sentAt?: string;
  signedAt?: string;
  cancelledAt?: string;
  signature?: ContractSignature;
  /** «صادر من» — set when the vendor sends the contract. */
  vendorSignature?: { name: string; at: string };
  /** Imported from the old dashboard's workspace `contracts`. */
  legacy?: boolean;
  legacyId?: string;
  createdAt: string;
  updatedAt: string;
};

type ContractsDocument = {
  contracts: Contract[];
  /** Vendors whose old workspace contracts were already imported (once each). */
  legacyImported: string[];
};

export class ContractError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = 'ContractError';
    this.status = status;
    this.code = code;
  }
}

export const CONTRACT_CHANGED = 'العقد تغيّر — حدّث الصفحة';
export const CONTRACT_ALREADY_SIGNED = 'هذا العقد موقّع من قبل.';
export const LEGACY_SIGNATURE_NOTE = 'سجّله المورّد في اللوحة القديمة — ليس توقيعاً موثّقاً من العميل.';

export const SIGNATURE_MAX_CHARS = 300 * 1024;
const SIGNATURE_PREFIX = 'data:image/png;base64,';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const MAX_TERMS = 60;
const MAX_TERM_CHARS = 1500;
const MAX_NOTES_CHARS = 3000;
const MAX_AMOUNT = 100_000_000;

/* ── Small helpers ─────────────────────────────────────────────────── */

function text(value: unknown, max: number): string {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Multi-line text (terms, notes): keep line breaks, trim the rest. */
function longText(value: unknown, max: number): string {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

const round2 = (value: number) => Math.round(value * 100) / 100;

function money(value: unknown, label: string): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) throw new ContractError(`${label} غير صالح.`);
  return round2(n);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Saudi mobiles become `05xxxxxxxx`; other numbers keep their digits (and a leading +). */
export function normalizeContractPhone(raw: unknown): string {
  const input = String(raw ?? '').trim();
  if (!input) return '';
  const saudi = normalizeSaudiMobile(input);
  if (saudi) return saudi;
  const digits = input.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) throw new ContractError('رقم جوال العميل غير صالح.');
  return input.startsWith('+') ? `+${digits}` : digits;
}

const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
function riyadhYear(now: Date): string {
  return new Date(now.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 4);
}

/* ── Fingerprint ───────────────────────────────────────────────────── */

/** JSON with sorted keys and no undefined values — the same content always gives the same string. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

/** What the client signs: number, vendor, parties, event, amounts, terms, notes. */
export function signableContent(contract: Pick<Contract, 'number' | 'vendorName' | 'client' | 'event' | 'amounts' | 'terms' | 'notes'>) {
  return {
    number: contract.number,
    vendorName: contract.vendorName,
    client: contract.client,
    event: contract.event,
    amounts: contract.amounts,
    terms: contract.terms,
    notes: contract.notes || '',
  };
}

export function contractContentHash(contract: Parameters<typeof signableContent>[0]): string {
  return crypto.createHash('sha256').update(canonicalJson(signableContent(contract)), 'utf8').digest('hex');
}

export function newShareToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function isShareTokenShape(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{40,128}$/.test(token);
}

/* ── Input ─────────────────────────────────────────────────────────── */

export type ContractInput = {
  source: Contract['source'];
  client: ContractClient;
  event: ContractEvent;
  amounts: ContractAmounts;
  terms: string[];
  notes?: string;
};

/** Validates a create / edit body. Every field is required on create; an edit sends the whole contract too. */
export function parseContractInput(body: unknown): ContractInput {
  const input = isObject(body) ? body : {};
  const rawSource = isObject(input.source) ? input.source : {};
  const kind = (['order', 'booking', 'manual'] as const).find((k) => k === rawSource.kind) || 'manual';
  const ref = text(rawSource.ref, 120);

  const rawClient = isObject(input.client) ? input.client : {};
  const clientName = text(rawClient.name, 120);
  if (clientName.length < 2) throw new ContractError('اكتب اسم العميل.');
  const phone = normalizeContractPhone(rawClient.phone);
  if (!phone) throw new ContractError('اكتب جوال العميل — يصله رابط التوقيع عليه.');
  const email = text(rawClient.email, 160).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ContractError('بريد العميل غير صالح.');
  const nationalId = text(rawClient.nationalId, 20).replace(/\s/g, '');
  if (nationalId && !/^[0-9A-Za-z-]{5,20}$/.test(nationalId)) throw new ContractError('رقم الهوية غير صالح.');

  const rawEvent = isObject(input.event) ? input.event : {};
  const date = text(rawEvent.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new ContractError('اختر تاريخ المناسبة.');
  }
  const time = text(rawEvent.time, 5);
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new ContractError('وقت المناسبة غير صالح.');
  const location = text(rawEvent.location, 300);
  const service = text(rawEvent.service, 300);
  if (!service) throw new ContractError('اكتب الخدمة المتفق عليها.');

  const rawAmounts = isObject(input.amounts) ? input.amounts : {};
  const total = money(rawAmounts.total, 'إجمالي العقد');
  const deposit = money(rawAmounts.deposit, 'العربون');
  if (deposit > total) throw new ContractError('العربون أكبر من إجمالي العقد.');

  const rawTerms = Array.isArray(input.terms) ? input.terms : [];
  if (rawTerms.length > MAX_TERMS) throw new ContractError(`البنود كثيرة — الحد ${MAX_TERMS} بنداً.`);
  const terms = rawTerms.map((term) => longText(term, MAX_TERM_CHARS)).filter(Boolean);
  if (!terms.length) throw new ContractError('أضف بنداً واحداً على الأقل.');

  const notes = longText(input.notes, MAX_NOTES_CHARS);

  return {
    source: ref ? { kind, ref } : { kind },
    client: {
      name: clientName,
      phone,
      ...(email ? { email } : {}),
      ...(nationalId ? { nationalId } : {}),
    },
    event: { date, ...(time ? { time } : {}), location, service },
    amounts: { total, deposit, remaining: round2(total - deposit), currency: 'SAR' },
    terms,
    ...(notes ? { notes } : {}),
  };
}

export type SignInput = { name: string; image: string; contentHash: string };

/** The PNG's pixel size, read from its IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) return null;
  if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** A drawn signature: a real PNG data URL, at most 300KB, of a sane size. */
export function parseSignatureImage(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith(SIGNATURE_PREFIX)) {
    throw new ContractError('التوقيع لازم يكون صورة PNG مرسومة.');
  }
  if (raw.length > SIGNATURE_MAX_CHARS) throw new ContractError('صورة التوقيع كبيرة — امسحها وارسم من جديد.', 413);
  const b64 = raw.slice(SIGNATURE_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new ContractError('صورة التوقيع غير صالحة.');
  const bytes = Buffer.from(b64, 'base64');
  const size = pngSize(bytes);
  if (!size) throw new ContractError('صورة التوقيع غير صالحة.');
  if (size.width < 40 || size.height < 20 || size.width > 4000 || size.height > 4000) {
    throw new ContractError('مقاس صورة التوقيع غير صالح.');
  }
  return raw;
}

export function parseSignInput(body: unknown): SignInput {
  const input = isObject(body) ? body : {};
  if (input.agree !== true) throw new ContractError('أكّد أنك قرأت العقد وتوافق على بنوده.');
  const name = text(input.name, 120);
  if (name.length < 3) throw new ContractError('اكتب اسمك الكامل كما في الهوية.');
  const image = parseSignatureImage(input.signature);
  const contentHash = text(input.contentHash, 64);
  if (!/^[0-9a-f]{64}$/.test(contentHash)) throw new ContractError(CONTRACT_CHANGED, 409, 'changed');
  return { name, image, contentHash };
}

/* ── Legacy import (old dashboard's workspace `contracts`) ─────────── */

function legacyDate(value: unknown, fallback: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw) ? `${raw.replace(' ', 'T')}:00+03:00` : raw);
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
}

/** One old `SmartServiceContract` row as a contract; null when it is not salvageable. */
export function mapLegacyContract(raw: unknown, vendorId: string, vendorName: string, now: Date): Contract | null {
  if (!isObject(raw)) return null;
  const nowIso = now.toISOString();
  const createdAt = legacyDate(raw.createdAt, nowIso);
  const total = Math.max(0, round2(Number(raw.totalAmount) || 0));
  const deposit = Math.min(total, Math.max(0, round2(Number(raw.depositAmount) || 0)));
  const terms = (Array.isArray(raw.terms) ? raw.terms : []).map((term) => longText(term, MAX_TERM_CHARS)).filter(Boolean);
  const eventDate = text(raw.eventDate, 10);
  const bookingRef = text(raw.bookingId, 120);
  const name = text(raw.vendorName, 160) || vendorName;
  const base = {
    number: text(raw.contractNumber, 40) || `LEGACY-${text(raw.id, 30) || Date.now()}`,
    vendorName: name,
    client: {
      name: text(raw.clientName, 120) || '—',
      phone: text(raw.clientPhone, 20),
      ...(text(raw.clientNationalId, 20) ? { nationalId: text(raw.clientNationalId, 20) } : {}),
    },
    event: {
      date: /^\d{4}-\d{2}-\d{2}$/.test(eventDate) ? eventDate : createdAt.slice(0, 10),
      location: text(raw.eventLocation, 300),
      service: text(raw.serviceTitle, 300) || 'خدمة',
    },
    amounts: { total, deposit, remaining: round2(total - deposit), currency: 'SAR' as const },
    terms: terms.length ? terms : ['—'],
  };
  const contentHash = contractContentHash(base);
  const oldStatus = String(raw.status || '');
  const signedBefore = oldStatus === 'signed_active' || oldStatus === 'completed';
  const oldClientSig = isObject(raw.clientSignature) ? raw.clientSignature : null;
  const oldVendorSig = isObject(raw.vendorSignature) ? raw.vendorSignature : null;
  const signedAt = signedBefore ? legacyDate(oldClientSig?.signedAt, createdAt) : undefined;
  return {
    id: `ctr-${now.getTime().toString(36)}-${crypto.randomBytes(5).toString('hex')}`,
    ...base,
    vendorId,
    source: bookingRef ? { kind: 'booking', ref: bookingRef } : { kind: 'manual' },
    // Never a live link: an old «pending» contract comes back as a draft to send for real.
    status: signedBefore ? 'signed' : 'draft',
    contentHash,
    ...(signedBefore
      ? {
          signedAt,
          signature: {
            name: text(oldClientSig?.signedByName, 120) || base.client.name,
            image: '',
            signedAt: signedAt as string,
            ip: '',
            userAgent: '',
            contentHash,
            note: LEGACY_SIGNATURE_NOTE,
          },
        }
      : {}),
    ...(oldVendorSig
      ? { vendorSignature: { name: text(oldVendorSig.signedByName, 160) || name, at: legacyDate(oldVendorSig.signedAt, createdAt) } }
      : {}),
    legacy: true,
    legacyId: text(raw.id, 120) || undefined,
    createdAt,
    updatedAt: nowIso,
  };
}

/* ── Store ─────────────────────────────────────────────────────────── */

export function contractsFile(dataDir: string): string {
  return path.join(dataDir, 'contracts.json');
}

export function createContractStore(dataDir: string, now: () => Date = () => new Date()) {
  const file = contractsFile(dataDir);

  function read(): ContractsDocument {
    const raw = readJsonFile<unknown>(file, {});
    const doc = isObject(raw) ? raw : {};
    return {
      contracts: Array.isArray(doc.contracts) ? (doc.contracts as Contract[]) : [],
      legacyImported: Array.isArray(doc.legacyImported) ? doc.legacyImported.map(String) : [],
    };
  }

  function write(doc: ContractsDocument) {
    writeJsonFile(file, doc);
  }

  function newId(): string {
    return `ctr-${now().getTime().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
  }

  /** `CN-2026-0001`: per vendor and year, never reusing a number on that vendor's list. */
  function nextNumber(contracts: Contract[], vendorId: string): string {
    const year = riyadhYear(now());
    const pattern = new RegExp(`^CN-${year}-(\\d+)$`);
    const own = contracts.filter((row) => row.vendorId === vendorId);
    const taken = new Set(own.map((row) => row.number));
    let next = own.reduce((max, row) => {
      const match = pattern.exec(row.number);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1;
    while (taken.has(`CN-${year}-${String(next).padStart(4, '0')}`)) next += 1;
    return `CN-${year}-${String(next).padStart(4, '0')}`;
  }

  function mustOwn(doc: ContractsDocument, vendorId: string, id: string): Contract {
    const row = doc.contracts.find((item) => item.id === id && item.vendorId === vendorId);
    // Another vendor's id answers exactly like a missing one.
    if (!row) throw new ContractError('العقد غير موجود.', 404);
    return row;
  }

  function listForVendor(vendorId: string): Contract[] {
    return read()
      .contracts.filter((row) => row.vendorId === vendorId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  function findForVendor(vendorId: string, id: string): Contract | null {
    return read().contracts.find((row) => row.id === id && row.vendorId === vendorId) || null;
  }

  /** Constant-time compare, so response timing never hints at a near-miss token. */
  function byToken(contracts: Contract[], token: string): Contract | undefined {
    if (!isShareTokenShape(token)) return undefined;
    const wanted = Buffer.from(token);
    return contracts.find((row) => {
      if (!row.shareToken) return false;
      const have = Buffer.from(row.shareToken);
      return have.length === wanted.length && crypto.timingSafeEqual(have, wanted);
    });
  }

  function findByToken(token: string): Contract | null {
    return byToken(read().contracts, token) || null;
  }

  /**
   * Copies the vendor's old workspace contracts in, once per vendor. Returns
   * how many were imported (0 when this vendor was already done).
   */
  function importLegacyOnce(vendorId: string, vendorName: string, rows: unknown[]): number {
    const doc = read();
    if (doc.legacyImported.includes(vendorId)) return 0;
    const at = now();
    const imported = (Array.isArray(rows) ? rows : [])
      .map((row) => mapLegacyContract(row, vendorId, vendorName, at))
      .filter((row): row is Contract => !!row);
    doc.contracts.push(...imported);
    doc.legacyImported.push(vendorId);
    write(doc);
    return imported.length;
  }

  function create(vendorId: string, vendorName: string, input: ContractInput): Contract {
    const doc = read();
    const stamp = now().toISOString();
    const base = { ...input, number: nextNumber(doc.contracts, vendorId), vendorName };
    const row: Contract = {
      id: newId(),
      vendorId,
      ...base,
      status: 'draft',
      contentHash: contractContentHash(base),
      createdAt: stamp,
      updatedAt: stamp,
    };
    doc.contracts.push(row);
    write(doc);
    return row;
  }

  function update(vendorId: string, id: string, vendorName: string, input: ContractInput): Contract {
    const doc = read();
    const row = mustOwn(doc, vendorId, id);
    if (row.status !== 'draft' && row.status !== 'sent') {
      throw new ContractError(
        row.status === 'signed' ? 'العقد موقّع — ما يمكن تعديله.' : 'العقد ملغي — ما يمكن تعديله.',
        409,
      );
    }
    Object.assign(row, input, { vendorName: vendorName || row.vendorName });
    if (!input.notes) delete row.notes;
    if (!input.client.email) delete row.client.email;
    if (!input.client.nationalId) delete row.client.nationalId;
    if (!input.event.time) delete row.event.time;
    row.contentHash = contractContentHash(row);
    row.updatedAt = now().toISOString();
    write(doc);
    return row;
  }

  function remove(vendorId: string, id: string): void {
    const doc = read();
    const row = mustOwn(doc, vendorId, id);
    if (row.status !== 'draft') {
      throw new ContractError('تُحذف المسودات فقط. ألغِ العقد بدل حذفه.', 409);
    }
    doc.contracts = doc.contracts.filter((item) => item !== row);
    write(doc);
  }

  /** Issues (or re-uses) the signing link. Sending again keeps the same link. */
  function send(vendorId: string, id: string, issuerName: string): Contract {
    const doc = read();
    const row = mustOwn(doc, vendorId, id);
    if (row.status === 'signed') throw new ContractError(CONTRACT_ALREADY_SIGNED, 409);
    if (row.status === 'cancelled') throw new ContractError('العقد ملغي — أنشئ عقداً جديداً.', 409);
    const stamp = now().toISOString();
    if (!row.shareToken) row.shareToken = newShareToken();
    row.status = 'sent';
    row.sentAt = row.sentAt || stamp;
    row.vendorSignature = { name: issuerName || row.vendorName, at: stamp };
    row.contentHash = contractContentHash(row);
    row.updatedAt = stamp;
    write(doc);
    return row;
  }

  function cancel(vendorId: string, id: string): Contract {
    const doc = read();
    const row = mustOwn(doc, vendorId, id);
    if (row.status === 'signed') throw new ContractError('العقد موقّع من العميل — ما يمكن إلغاؤه من هنا.', 409);
    if (row.status === 'cancelled') throw new ContractError('العقد ملغي من قبل.', 409);
    const stamp = now().toISOString();
    row.status = 'cancelled';
    row.cancelledAt = stamp;
    row.updatedAt = stamp;
    write(doc);
    return row;
  }

  /** The client's signature. Re-checks everything against the stored copy. */
  function sign(token: string, input: SignInput, meta: { ip: string; userAgent: string }): Contract {
    const doc = read();
    const row = byToken(doc.contracts, token);
    if (!row || row.status === 'cancelled' || row.status === 'draft') {
      throw new ContractError('رابط العقد غير صالح أو أُلغي.', 404);
    }
    if (row.status === 'signed') throw new ContractError(CONTRACT_ALREADY_SIGNED, 409, 'already_signed');
    const current = contractContentHash(row);
    if (input.contentHash !== current || row.contentHash !== current) {
      throw new ContractError(CONTRACT_CHANGED, 409, 'changed');
    }
    const stamp = now().toISOString();
    row.status = 'signed';
    row.signedAt = stamp;
    row.signature = {
      name: input.name,
      image: input.image,
      signedAt: stamp,
      ip: meta.ip,
      userAgent: String(meta.userAgent || '').slice(0, 400),
      contentHash: current,
    };
    row.updatedAt = stamp;
    write(doc);
    return row;
  }

  return {
    file,
    listForVendor,
    findForVendor,
    findByToken,
    importLegacyOnce,
    create,
    update,
    remove,
    send,
    cancel,
    sign,
  };
}

export type ContractStore = ReturnType<typeof createContractStore>;
