import path from 'path';
import { readJsonArray, writeJsonFile } from '../shared/json-file.ts';

/**
 * حجوزات المنصة — الطلبات القادمة من متجر يوصل نفسه.
 *
 * Distinct from `external-bookings.ts`, which holds offline bookings a courier
 * files by hand. These rows are created by guest or signed-in checkout and are
 * the records Moyasar webhooks settle against.
 */
export type PlatformBooking = {
  id: string;
  name: string;
  phone: string;
  email: string;
  serviceId?: unknown;
  serviceName: string;
  notes: string;
  city: string;
  eventDate: string;
  paymentMethod: string;
  settlement: string;
  items: unknown[];
  totalAmount: number;
  bookingMode: 'instant' | 'approval';
  status: string;
  paymentStatus: 'unpaid' | 'paid';
  createdAt: string;
  moyasarInvoiceId?: string;
  moyasarPaymentId?: string;
  paymentUrl?: string;
};

/** Identifiers a Moyasar callback or webhook can arrive with. */
export type MoyasarSettlement = {
  paymentId?: string;
  invoiceId?: string;
  bookingId?: string;
  status: string;
};

const PAID_SETTLEMENT_LABEL = 'ميسر — دفع إلكتروني';

export function createBookingStore(dataDir: string) {
  const file = path.join(dataDir, 'bookings.json');

  function list(): PlatformBooking[] {
    return readJsonArray<PlatformBooking>(file);
  }

  function save(rows: PlatformBooking[]) {
    writeJsonFile(file, rows);
  }

  /**
   * A client sees only their own orders, matched on either identifier because
   * a guest checkout may supply a phone without an email. Blank identifiers
   * never match, so an empty stored email cannot become a wildcard.
   */
  function listForClient(identity: { email?: string; phone?: string }): PlatformBooking[] {
    return list().filter(
      (row) =>
        (Boolean(identity.email) && row.email === identity.email) ||
        (Boolean(identity.phone) && row.phone === identity.phone),
    );
  }

  function count(): number {
    return list().length;
  }

  /** Newest first. */
  function add(booking: PlatformBooking): PlatformBooking {
    const rows = list();
    rows.unshift(booking);
    save(rows);
    return booking;
  }

  function updateStatus(id: string, status: string): PlatformBooking | null {
    const rows = list();
    const item = rows.find((row) => row.id === id);
    if (!item) return null;
    item.status = status;
    save(rows);
    return item;
  }

  function remove(id: string): void {
    save(list().filter((row) => row.id !== id));
  }

  /**
   * Settle a booking from a Moyasar payment, invoice, or booking id — a
   * webhook, an invoice creation, and a browser callback each carry a
   * different subset, so all three are accepted.
   *
   * Returns `null` when no row matches, which is normal: invoices are also
   * raised for things that are not platform bookings.
   */
  function markPaidFromMoyasar(input: MoyasarSettlement): PlatformBooking | null {
    const bookingId = String(input.bookingId || '').trim();
    const paymentId = String(input.paymentId || '').trim();
    const invoiceId = String(input.invoiceId || '').trim();

    const rows = list();
    const item = rows.find((row) => {
      if (bookingId && row.id === bookingId) return true;
      if (paymentId && (row.moyasarInvoiceId === paymentId || row.moyasarPaymentId === paymentId)) return true;
      if (invoiceId && row.moyasarInvoiceId === invoiceId) return true;
      return false;
    });
    if (!item) return null;

    if (paymentId) item.moyasarPaymentId = paymentId;
    if (invoiceId) item.moyasarInvoiceId = invoiceId;
    if (input.status === 'paid') {
      item.paymentStatus = 'paid';
      item.settlement = PAID_SETTLEMENT_LABEL;
    }
    save(rows);
    return item;
  }

  return { list, listForClient, count, add, updateStatus, remove, markPaidFromMoyasar };
}

export type BookingStore = ReturnType<typeof createBookingStore>;
