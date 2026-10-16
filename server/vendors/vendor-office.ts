import crypto from 'crypto';
import path from 'path';
import { fs } from '../shared/data-fs.ts';
import { readJsonFile, writeJsonFile } from '../shared/json-file.ts';

/**
 * المكتب الخلفي للمورّد — invoices, crew, expenses, payroll, vouchers,
 * payouts, POS, receivables, brand settings, trackings, work logs and
 * attendance from the vendor console.
 *
 * The server does not interpret these records; it keeps the vendor's copy so
 * it survives a reload or a second device. Each vendor's office is its own
 * document under `data/vendor-offices/`, apart from `vendor-workspaces.json`,
 * because the catalog reads the workspaces file on every request and an
 * office can be large.
 */

/** Keys whose value is a list of records. Anything else in the body is dropped. */
export const OFFICE_ARRAY_KEYS = [
  'invoices',
  'crewMembers',
  'expenses',
  'payrollEntries',
  'consolidatedVouchers',
  'payouts',
  'posItems',
  'posSales',
  'receivables',
  'trackings',
  'workLogs',
  'attendance',
] as const;

export type OfficeArrayKey = (typeof OFFICE_ARRAY_KEYS)[number];

export type VendorOffice = Partial<Record<OfficeArrayKey, unknown[]>> & {
  brandSettings?: Record<string, unknown>;
};

/** Cap on one vendor's serialized office. */
export const OFFICE_MAX_BYTES = 1.5 * 1024 * 1024;
export const OFFICE_TOO_LARGE =
  'بيانات المكتب كبيرة (أكثر من 1.5 ميجابايت). احذف سجلات قديمة أو صوراً مرفقة ثم احفظ.';
export const OFFICE_INVALID = 'بيانات المكتب غير صالحة.';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Keeps only the known keys: each list key must be an array and
 * `brandSettings` an object; a key of the wrong shape is dropped.
 */
export function sanitizeOffice(raw: unknown): VendorOffice {
  if (!isPlainObject(raw)) return {};
  const out: VendorOffice = {};
  for (const key of OFFICE_ARRAY_KEYS) {
    if (Array.isArray(raw[key])) out[key] = raw[key] as unknown[];
  }
  if (isPlainObject(raw.brandSettings)) out.brandSettings = raw.brandSettings;
  return out;
}

export function officeBytes(office: VendorOffice): number {
  return Buffer.byteLength(JSON.stringify(office), 'utf8');
}

type OfficeDocument = { vendorId: string; office: VendorOffice; updatedAt: string };

export function vendorOfficeDir(dataDir: string): string {
  return path.join(dataDir, 'vendor-offices');
}

export function createVendorOfficeStore(dataDir: string) {
  const dir = vendorOfficeDir(dataDir);

  /** Vendor ids are not file-name safe, so the file is named by a hash of the id. */
  function fileFor(vendorId: string): string {
    const key = crypto.createHash('sha256').update(String(vendorId)).digest('hex').slice(0, 40);
    return path.join(dir, `${key}.json`);
  }

  function get(vendorId: string): VendorOffice {
    if (!vendorId) return {};
    const doc = readJsonFile<Partial<OfficeDocument>>(fileFor(vendorId), {});
    return sanitizeOffice(doc.office);
  }

  /** Replaces the whole office. Callers validate size and shape first. */
  function save(vendorId: string, office: VendorOffice): VendorOffice {
    const clean = sanitizeOffice(office);
    const doc: OfficeDocument = { vendorId, office: clean, updatedAt: new Date().toISOString() };
    writeJsonFile(fileFor(vendorId), doc);
    return clean;
  }

  function remove(vendorId: string): boolean {
    if (!vendorId) return false;
    const file = fileFor(vendorId);
    if (!fs.existsSync(file)) return false;
    try {
      fs.unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  }

  /** Approval moved the vendor to a new id: the office follows unless the target already has one. */
  function move(fromId: string, toId: string): void {
    if (!fromId || !toId || fromId === toId) return;
    const from = fileFor(fromId);
    if (!fs.existsSync(from)) return;
    if (!fs.existsSync(fileFor(toId))) save(toId, get(fromId));
    remove(fromId);
  }

  function wipeAll(): number {
    if (!fs.existsSync(dir)) return 0;
    let removed = 0;
    for (const name of fs.readdirSync(dir)) {
      if (!String(name).endsWith('.json')) continue;
      try {
        fs.unlinkSync(path.join(dir, String(name)));
        removed += 1;
      } catch {
        /* already gone */
      }
    }
    return removed;
  }

  return { get, save, remove, move, wipeAll, fileFor };
}

export type VendorOfficeStore = ReturnType<typeof createVendorOfficeStore>;
