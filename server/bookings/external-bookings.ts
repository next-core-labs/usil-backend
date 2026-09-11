import path from 'path';
import { normalizeSaudiMobile } from '../shared/booking-guards';
import { readJsonArray, writeJsonFile } from '../shared/json-file.ts';

export const EXTERNAL_BOOKING_STATUSES = ['جديد', 'مؤكد', 'منفّذ', 'ملغي'] as const;
export type ExternalBookingStatus = (typeof EXTERNAL_BOOKING_STATUSES)[number];

export const COLLECTION_METHODS = ['cash', 'transfer', 'vendor_collect'] as const;
export type CollectionMethod = (typeof COLLECTION_METHODS)[number];

export const COLLECTION_LABEL_AR: Record<CollectionMethod, string> = {
  cash: 'كاش',
  transfer: 'تحويل',
  vendor_collect: 'تحصيل مع المورّد',
};

export type ExternalBooking = {
  id: string;
  courierId: string;
  courierName: string;
  customerName: string;
  phone: string;
  city: string;
  serviceType: string;
  eventDate: string;
  deliveryTime: string;
  guests: number | null;
  amount: number;
  taxIncluded: boolean;
  collection: CollectionMethod;
  vendorId: string;
  vendorName: string;
  address: string;
  notes: string;
  status: ExternalBookingStatus;
  createdAt: string;
  createdBy: string;
  updatedAt?: string;
};

export type ExternalBookingInput = Partial<{
  courierId: string;
  courierName: string;
  customerName: string;
  phone: string;
  city: string;
  serviceType: string;
  eventDate: string;
  deliveryTime: string;
  guests: unknown;
  amount: unknown;
  taxIncluded: unknown;
  collection: string;
  vendorId: string;
  vendorName: string;
  address: string;
  notes: string;
  status: string;
}>;

const MAX_TEXT = 400;
const MAX_NOTES = 1200;

function text(value: unknown, limit = MAX_TEXT): string {
  return String(value ?? '').trim().slice(0, limit);
}

export function isExternalBookingStatus(value: unknown): value is ExternalBookingStatus {
  return (EXTERNAL_BOOKING_STATUSES as readonly string[]).includes(String(value));
}

export function normalizeCollection(value: unknown): CollectionMethod | null {
  const raw = String(value || '').trim();
  if ((COLLECTION_METHODS as readonly string[]).includes(raw)) return raw as CollectionMethod;
  const arabic: Record<string, CollectionMethod> = {
    كاش: 'cash',
    تحويل: 'transfer',
    'تحصيل مع المورّد': 'vendor_collect',
    'تحصيل مع المورد': 'vendor_collect',
  };
  return arabic[raw] || null;
}

/** تاريخ ميلادي بصيغة YYYY-MM-DD كما ترسله خانة التاريخ. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateExternalBooking(input: ExternalBookingInput) {
  const courierId = text(input.courierId, 80);
  const courierName = text(input.courierName, 120);
  const customerName = text(input.customerName, 120);
  const phoneRaw = text(input.phone, 30);
  const city = text(input.city, 80);
  const serviceType = text(input.serviceType, 160);
  const eventDate = text(input.eventDate, 20);
  const deliveryTime = text(input.deliveryTime, 20);
  const collection = normalizeCollection(input.collection);

  if (!courierId) throw new Error('اختر المندوب صاحب الحجز');
  if (!customerName) throw new Error('اكتب اسم العميل');
  const phone = normalizeSaudiMobile(phoneRaw);
  if (!phone) throw new Error('أدخل جوالاً سعودياً صحيحاً بصيغة 05xxxxxxxx');
  if (!city) throw new Error('اكتب المدينة');
  if (!serviceType) throw new Error('اكتب نوع المناسبة أو الخدمة');
  if (!isIsoDate(eventDate)) throw new Error('اختر تاريخ المناسبة');
  if (deliveryTime && !/^\d{2}:\d{2}$/.test(deliveryTime)) {
    throw new Error('وقت التسليم يكون بصيغة 14:30');
  }
  if (!collection) throw new Error('اختر طريقة التحصيل: كاش أو تحويل أو تحصيل مع المورّد');

  const guestsRaw = input.guests;
  let guests: number | null = null;
  if (guestsRaw !== undefined && guestsRaw !== null && String(guestsRaw).trim() !== '') {
    const parsed = Number(guestsRaw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100000) {
      throw new Error('عدد الضيوف يجب أن يكون رقماً صحيحاً');
    }
    guests = Math.round(parsed);
  }

  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000) {
    throw new Error('اكتب المبلغ المتفق عليه بالريال');
  }

  const status = isExternalBookingStatus(input.status) ? input.status : 'جديد';

  return {
    courierId,
    courierName,
    customerName,
    phone,
    city,
    serviceType,
    eventDate,
    deliveryTime,
    guests,
    amount: Math.round(amount * 100) / 100,
    taxIncluded: input.taxIncluded === true || input.taxIncluded === 'true',
    collection,
    vendorId: text(input.vendorId, 80),
    vendorName: text(input.vendorName, 160),
    address: text(input.address, 300),
    notes: text(input.notes, MAX_NOTES),
    status,
  };
}

export function createExternalBookingStore(dataDir: string) {
  const file = path.join(dataDir, 'external-bookings.json');

  function readAll(): ExternalBooking[] {
    return readJsonArray<ExternalBooking>(file);
  }

  function writeAll(rows: ExternalBooking[]) {
    writeJsonFile(file, rows);
  }

  function listFor(actor: { id: string; role: string }): ExternalBooking[] {
    const rows = readAll();
    if (actor.role === 'courier') return rows.filter((row) => row.courierId === actor.id);
    return rows;
  }

  function findById(id: string): ExternalBooking | null {
    return readAll().find((row) => row.id === id) || null;
  }

  function create(input: ExternalBookingInput, createdBy: string): ExternalBooking {
    const clean = validateExternalBooking(input);
    const row: ExternalBooking = {
      id: `EXB-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 900 + 100)}`,
      ...clean,
      createdAt: new Date().toISOString(),
      createdBy,
    };
    writeAll([row, ...readAll()]);
    return row;
  }

  function update(id: string, patch: ExternalBookingInput): ExternalBooking | null {
    const rows = readAll();
    const row = rows.find((item) => item.id === id);
    if (!row) return null;
    const merged = validateExternalBooking({
      ...row,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
      courierId: row.courierId,
      courierName: row.courierName,
    });
    Object.assign(row, merged, { updatedAt: new Date().toISOString() });
    writeAll(rows);
    return row;
  }

  function remove(id: string): boolean {
    const rows = readAll();
    const next = rows.filter((row) => row.id !== id);
    if (next.length === rows.length) return false;
    writeAll(next);
    return true;
  }

  return { file, list: readAll, listFor, findById, create, update, remove };
}
