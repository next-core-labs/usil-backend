import crypto from 'crypto';
import path from 'path';
import { readJsonArray, writeJsonFile } from '../shared/json-file.ts';
import type { VendorOffice } from './vendor-office.ts';

/**
 * روابط الدفع — a vendor sends an invoice or a quotation from the console and
 * the client pays it through Usil's Moyasar account. The money joins the
 * vendor's balance like a store order (same commission), and the paid
 * invoice or quotation in the vendor's office is updated to match.
 *
 * The amount always comes from the stored document, never from the request:
 * an invoice charges what is still owed, a quotation its deposit.
 */
export type PayLinkKind = 'invoice' | 'quotation';

/**
 * `open` — sent, not paid. `replaced` — the document changed and a new link
 * was raised; a payment that still lands on it is settled all the same.
 */
export type PayLinkStatus = 'open' | 'replaced' | 'paid' | 'refunded';

export type VendorPayLink = {
  id: string;
  vendorId: string;
  kind: PayLinkKind;
  /** The invoice or quotation id in the vendor's office. */
  docId: string;
  docNumber: string;
  clientName: string;
  clientPhone: string;
  /** Riyals, VAT included. */
  amount: number;
  description: string;
  moyasarInvoiceId: string;
  url: string;
  status: PayLinkStatus;
  paymentId?: string;
  paidAt?: string;
  refundedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export class PayLinkError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PayLinkError';
    this.status = status;
  }
}

export const PAY_LINK_KINDS: readonly PayLinkKind[] = ['invoice', 'quotation'];

/** Moyasar metadata `source` on every pay-link invoice. */
export const PAY_LINK_SOURCE = 'usil-vendor-link';

/** What the client sees on the receipt; the paid invoice/quotation shows it too. */
export const PAY_LINK_METHOD = 'رابط دفع ميسر';

export type Payable = {
  amount: number;
  docNumber: string;
  clientName: string;
  clientPhone: string;
};

type Row = Record<string, unknown>;

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (value: number) => Math.round(value * 100) / 100;

function docOf(office: VendorOffice, kind: PayLinkKind, docId: string): Row | null {
  const list = (kind === 'invoice' ? office.invoices : office.quotations) || [];
  const found = list.find((row) => row && typeof row === 'object' && text((row as Row).id) === docId);
  return (found as Row) || null;
}

/** What a link for this document charges, or why it cannot have one. */
export function payableFor(office: VendorOffice, kind: PayLinkKind, docId: string): Payable {
  const doc = docOf(office, kind, docId);
  if (!doc) throw new PayLinkError(kind === 'invoice' ? 'الفاتورة غير موجودة.' : 'عرض السعر غير موجود.', 404);

  if (kind === 'invoice') {
    // Store orders were paid at checkout; their invoice is a receipt.
    if (text(doc.bookingId) || doc.channelSource === 'mithyaf') {
      throw new PayLinkError('هذه فاتورة طلب من متجر يوصل، ودفعها العميل عند الطلب.', 409);
    }
    if (doc.status === 'paid') throw new PayLinkError('الفاتورة مدفوعة بالكامل.', 409);
    if (doc.status === 'draft') throw new PayLinkError('الفاتورة مسودة. أصدرها أولاً ثم أرسل رابط الدفع.', 409);
    const total = num(doc.total);
    const owed = round2(doc.remainingBalance === undefined ? total - num(doc.depositPaid) : num(doc.remainingBalance));
    if (owed < 1) throw new PayLinkError('ما فيه مبلغ متبقٍ على هذه الفاتورة.', 409);
    return { amount: owed, docNumber: text(doc.invoiceNumber), clientName: text(doc.clientName), clientPhone: text(doc.clientPhone) };
  }

  if (doc.status === 'rejected') throw new PayLinkError('عرض السعر مرفوض.', 409);
  if (num(doc.depositPaidOnline) > 0) throw new PayLinkError('العميل دفع عربون هذا العرض.', 409);
  const deposit = round2(num(doc.depositRequired));
  if (deposit < 1) throw new PayLinkError('حدّد نسبة العربون في العرض أولاً، فالرابط يكون بقيمة العربون.', 409);
  return { amount: deposit, docNumber: text(doc.quoteNumber), clientName: text(doc.clientName), clientPhone: text(doc.clientPhone) };
}

/**
 * The office after this payment: the invoice's paid and remaining amounts,
 * or the quotation marked accepted with its deposit. Null when the document
 * is gone (the payment still counts in the vendor's balance).
 */
export function applyPaymentToOffice(office: VendorOffice, link: VendorPayLink, paidAt: string): VendorOffice | null {
  const key = link.kind === 'invoice' ? 'invoices' : 'quotations';
  const list = office[key] || [];
  const index = list.findIndex((row) => row && typeof row === 'object' && text((row as Row).id) === link.docId);
  if (index < 0) return null;
  const doc = { ...(list[index] as Row) };

  if (link.kind === 'invoice') {
    const total = num(doc.total);
    const paid = round2(num(doc.depositPaid) + link.amount);
    const remaining = round2(Math.max(0, total - paid));
    doc.depositPaid = paid;
    doc.remainingBalance = remaining;
    doc.status = remaining <= 0 ? 'paid' : 'partial';
    doc.paymentMethod = PAY_LINK_METHOD;
  } else {
    doc.status = 'accepted';
    doc.depositPaidOnline = link.amount;
    doc.updatedAt = paidAt;
  }
  doc.paidOnlineAt = paidAt;

  const next = [...list];
  next[index] = doc;
  return { [key]: next };
}

export function createPayLinkStore(dataDir: string, now: () => Date = () => new Date()) {
  const file = path.join(dataDir, 'vendor-pay-links.json');

  const list = (): VendorPayLink[] => readJsonArray<VendorPayLink>(file);
  const save = (rows: VendorPayLink[]) => writeJsonFile(file, rows);

  function listForVendor(vendorId: string): VendorPayLink[] {
    return list()
      .filter((row) => row.vendorId === vendorId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** The unpaid link already sent for this document, if any. */
  function openFor(vendorId: string, kind: PayLinkKind, docId: string): VendorPayLink | null {
    return list().find((row) => row.vendorId === vendorId && row.kind === kind && row.docId === docId && row.status === 'open') || null;
  }

  function add(input: Omit<VendorPayLink, 'id' | 'status' | 'createdAt' | 'updatedAt'>): VendorPayLink {
    const stamp = now().toISOString();
    const row: VendorPayLink = { ...input, id: `pl-${crypto.randomUUID()}`, status: 'open', createdAt: stamp, updatedAt: stamp };
    save([row, ...list()]);
    return row;
  }

  function update(id: string, patch: Partial<VendorPayLink>): VendorPayLink | null {
    const rows = list();
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) return null;
    rows[index] = { ...rows[index], ...patch, updatedAt: now().toISOString() };
    save(rows);
    return rows[index];
  }

  function findForMoyasar(ref: { payLinkId?: string; invoiceId?: string }): VendorPayLink | null {
    const rows = list();
    return (
      (ref.payLinkId && rows.find((row) => row.id === ref.payLinkId)) ||
      (ref.invoiceId && rows.find((row) => row.moyasarInvoiceId === ref.invoiceId)) ||
      null
    );
  }

  return { list, listForVendor, openFor, add, update, findForMoyasar };
}

export type PayLinkStore = ReturnType<typeof createPayLinkStore>;
