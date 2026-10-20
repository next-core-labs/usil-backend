import crypto from 'crypto';
import path from 'path';
import { readJsonArray, writeJsonFile } from '../shared/json-file.ts';
import { isValidSaudiIban, normalizeIban } from '../vendors/vendor-applications.ts';

/**
 * طلبات سحب الأرباح — a vendor asks Usil to transfer part of their available
 * balance. Nothing here moves money: the owner transfers by hand in the bank,
 * then marks the request paid with the transfer reference.
 */
export type PayoutStatus = 'requested' | 'approved' | 'paid' | 'rejected';

export const PAYOUT_STATUSES: readonly PayoutStatus[] = ['requested', 'approved', 'paid', 'rejected'];

export type PayoutRequest = {
  id: string;
  vendorId: string;
  vendorName: string;
  /** Riyals, at most two decimals. */
  amount: number;
  /** `SA` + 22 digits, no spaces. */
  iban: string;
  accountHolder: string;
  bankName: string;
  status: PayoutStatus;
  /** The vendor's own note on the request. */
  note: string;
  /** The admin's note — shown to the vendor (e.g. why it was rejected). */
  adminNote: string;
  /** Bank transfer reference, set when the request is marked paid. */
  reference: string;
  createdAt: string;
  updatedAt: string;
  /** Who approved, rejected or paid it last. */
  decidedBy: string;
};

export class PayoutError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PayoutError';
    this.status = status;
  }
}

export const NOTE_MAX = 500;
const NAME_MAX = 120;
const BANK_MAX = 80;
const REFERENCE_MAX = 100;

/**
 * Allowed moves. `paid` and `rejected` are final; a request is approved
 * before it is paid, so the owner always reviews it first.
 */
const TRANSITIONS: Record<PayoutStatus, readonly PayoutStatus[]> = {
  requested: ['approved', 'rejected'],
  approved: ['paid', 'rejected'],
  paid: [],
  rejected: [],
};

export function canTransition(from: PayoutStatus, to: PayoutStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

function text(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Riyals to two decimals, or NaN when the input is not a positive amount. */
export function parseAmount(value: unknown): number {
  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw === '' || raw === null || raw === undefined || typeof raw === 'boolean') return NaN;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  return Math.round(n * 100) / 100;
}

export type PayoutInput = { amount: number; iban: string; accountHolder: string; bankName: string; note: string };

/** Shape checks only — the balance check needs the bookings and lives in the routes. */
export function parsePayoutInput(body: unknown): PayoutInput {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const amount = parseAmount(input.amount);
  if (!Number.isFinite(amount)) throw new PayoutError('اكتب مبلغاً صحيحاً أكبر من صفر.');
  const iban = normalizeIban(String(input.iban ?? ''));
  if (!isValidSaudiIban(iban)) throw new PayoutError('رقم الآيبان يجب أن يبدأ بـ SA ويتبعه 22 رقماً.');
  const accountHolder = text(input.accountHolder, NAME_MAX);
  if (!accountHolder) throw new PayoutError('اكتب اسم صاحب الحساب كما هو في البنك.');
  const bankName = text(input.bankName, BANK_MAX);
  if (!bankName) throw new PayoutError('اختر البنك.');
  const note = String(input.note ?? '').trim().slice(0, NOTE_MAX);
  return { amount, iban, accountHolder, bankName, note };
}

export function createPayoutStore(dataDir: string, now: () => Date = () => new Date()) {
  const file = path.join(dataDir, 'payouts.json');

  function list(): PayoutRequest[] {
    return readJsonArray<PayoutRequest>(file);
  }

  function save(rows: PayoutRequest[]) {
    writeJsonFile(file, rows);
  }

  function listForVendor(vendorId: string): PayoutRequest[] {
    return list().filter((row) => row.vendorId === vendorId);
  }

  function findById(id: string): PayoutRequest | null {
    return list().find((row) => row.id === id) || null;
  }

  /** Newest first. */
  function add(vendorId: string, vendorName: string, input: PayoutInput): PayoutRequest {
    const at = now().toISOString();
    const row: PayoutRequest = {
      id: `PO-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      vendorId,
      vendorName,
      amount: input.amount,
      iban: input.iban,
      accountHolder: input.accountHolder,
      bankName: input.bankName,
      status: 'requested',
      note: input.note,
      adminNote: '',
      reference: '',
      createdAt: at,
      updatedAt: at,
      decidedBy: '',
    };
    save([row, ...list()]);
    return row;
  }

  /**
   * Moves a request along `TRANSITIONS`. `paid` needs the bank transfer
   * reference. Throws `PayoutError` (404/409/400) on a refused change.
   */
  function decide(
    id: string,
    input: { status: unknown; reference?: unknown; adminNote?: unknown },
    decidedBy: string,
  ): PayoutRequest {
    const rows = list();
    const row = rows.find((item) => item.id === id);
    if (!row) throw new PayoutError('طلب السحب غير موجود.', 404);
    const next = String(input.status ?? '') as PayoutStatus;
    if (!['approved', 'paid', 'rejected'].includes(next)) throw new PayoutError('حالة غير معروفة.');
    if (!canTransition(row.status, next)) {
      throw new PayoutError(
        row.status === 'paid' || row.status === 'rejected'
          ? 'هذا الطلب مُغلق ولا يمكن تغييره.'
          : 'يجب اعتماد الطلب قبل تسجيله كمحوّل.',
        409,
      );
    }
    const reference = text(input.reference, REFERENCE_MAX);
    if (next === 'paid' && !reference) throw new PayoutError('اكتب رقم مرجع التحويل البنكي.');
    if (input.adminNote !== undefined) row.adminNote = String(input.adminNote ?? '').trim().slice(0, NOTE_MAX);
    if (next === 'paid') row.reference = reference;
    row.status = next;
    row.decidedBy = decidedBy;
    row.updatedAt = now().toISOString();
    save(rows);
    return row;
  }

  return { list, listForVendor, findById, add, decide };
}

export type PayoutStore = ReturnType<typeof createPayoutStore>;
