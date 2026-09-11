import path from 'path';
import { isValidNationalId } from '../vendors/vendor-applications';
import { readJsonArray, writeJsonFile } from '../shared/json-file.ts';
import {
  parseCourierProducts,
  parseFulfillmentLanes,
  type CourierProductLine,
  type ListingFulfillmentLane,
} from '../vendors/vendor-listings';

export const SAUDI_PLATE_LETTERS = ['ا', 'ب', 'ح', 'د', 'ر', 'س', 'ص', 'ط', 'ع', 'ق', 'ك', 'ل', 'م', 'ن', 'ه', 'و', 'ى'] as const;

export const COURIER_CAR_TYPES = ['سيدان', 'دفع رباعي', 'فان', 'دباب/سكوتر', 'بيك أب', 'أخرى'] as const;

export type CourierApplicationStatus = 'pending' | 'approved' | 'rejected';

export type CourierApplication = {
  id: string;
  firstName: string;
  familyName: string;
  nationalId: string;
  plateLetters: string;
  plateNumbers: string;
  carType: string;
  carTypeOther?: string;
  fulfillment: ListingFulfillmentLane[];
  products: CourierProductLine[];
  status: CourierApplicationStatus;
  createdAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  rejectReason?: string;
};

export type CourierApplicationInput = {
  firstName: string;
  familyName: string;
  nationalId: string;
  plateLetters: string;
  plateNumbers: string;
  carType: string;
  carTypeOther?: string;
  fulfillment?: unknown;
  products?: unknown;
};

export function maskNationalId(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 4) return '**********';
  return `${digits.slice(0, 2)}******${digits.slice(-2)}`;
}

export function normalizePlateLetters(raw: string): string {
  return String(raw || '')
    .replace(/[^\u0621-\u064A]/g, '')
    .replace(/ة/g, 'ه')
    .replace(/ي/g, 'ى')
    .replace(/أ|إ|آ/g, 'ا');
}

export function normalizePlateNumbers(raw: string): string {
  return String(raw || '').replace(/\D/g, '');
}

export function isValidSaudiPlateLetters(raw: string): boolean {
  const letters = normalizePlateLetters(raw);
  if (letters.length < 1 || letters.length > 3) return false;
  return [...letters].every((letter) => (SAUDI_PLATE_LETTERS as readonly string[]).includes(letter));
}

export function isValidSaudiPlateNumbers(raw: string): boolean {
  const numbers = normalizePlateNumbers(raw);
  return /^\d{1,4}$/.test(numbers);
}

export function resolvedCarType(type: string, other?: string): string {
  if (!(COURIER_CAR_TYPES as readonly string[]).includes(type)) {
    throw new Error('اختر نوع السيارة من القائمة');
  }
  if (type === 'أخرى') {
    const custom = String(other || '').trim();
    if (!custom) throw new Error('اكتب نوع السيارة في الخانة الفارغة');
    return custom;
  }
  return type;
}

export function validateCourierApplication(input: Partial<CourierApplicationInput>) {
  const firstName = String(input.firstName || '').trim();
  const familyName = String(input.familyName || '').trim();
  const nationalId = String(input.nationalId || '').replace(/\s+/g, '');
  const plateLetters = normalizePlateLetters(String(input.plateLetters || ''));
  const plateNumbers = normalizePlateNumbers(String(input.plateNumbers || ''));
  const carType = String(input.carType || '').trim();

  if (!firstName) throw new Error('اكتب الاسم');
  if (!familyName) throw new Error('اكتب اسم العائلة');
  if (!isValidNationalId(nationalId)) {
    throw new Error('رقم الهوية أو الإقامة يجب أن يكون 10 أرقام ويبدأ بـ 1 أو 2');
  }
  if (!isValidSaudiPlateLetters(plateLetters)) {
    throw new Error('حروف اللوحة: اكتب حرفاً إلى ثلاثة من حروف اللوحة السعودية');
  }
  if (!isValidSaudiPlateNumbers(plateNumbers)) {
    throw new Error('رقم اللوحة يجب أن يكون من رقم إلى أربعة أرقام');
  }
  const resolvedType = resolvedCarType(carType, input.carTypeOther);
  const carTypeOther = String(input.carTypeOther || '').trim() || undefined;
  const fulfillment = parseFulfillmentLanes(
    input.fulfillment,
    'اختر مساراً واحداً على الأقل في «أقدر أوصل»',
  );
  const products = parseCourierProducts(input.products).map((row) => ({
    name: row.name,
    fulfillment: row.fulfillment.length ? row.fulfillment : fulfillment,
  }));
  return {
    firstName,
    familyName,
    nationalId,
    plateLetters,
    plateNumbers,
    carType: resolvedType,
    carTypeOther,
    fulfillment,
    products,
  };
}

export function publicCourierApplication(row: CourierApplication, opts: { revealId?: boolean } = {}) {
  return {
    ...row,
    nationalId: opts.revealId ? row.nationalId : maskNationalId(row.nationalId),
  };
}

export function createCourierApplicationStore(dataDir: string) {
  const file = path.join(dataDir, 'courier-applications.json');

  function readAll(): CourierApplication[] {
    return readJsonArray<CourierApplication>(file);
  }

  function writeAll(rows: CourierApplication[]) {
    writeJsonFile(file, rows);
  }

  function findByNationalId(nationalId: string) {
    const id = String(nationalId || '').replace(/\s+/g, '');
    return readAll().find((row) => row.nationalId === id) || null;
  }

  function findById(id: string) {
    return readAll().find((row) => row.id === id) || null;
  }

  function submit(input: CourierApplicationInput): CourierApplication {
    const clean = validateCourierApplication(input);
    const existing = findByNationalId(clean.nationalId);
    if (existing?.status === 'pending') {
      throw new Error('هذا الرقم عليه طلب مندوب بانتظار موافقة إدارة يوصل');
    }
    if (existing?.status === 'approved') {
      throw new Error('هذا الرقم مسجّل كمندوب معتمد');
    }
    const row: CourierApplication = {
      id: `crr-${Date.now()}`,
      firstName: clean.firstName,
      familyName: clean.familyName,
      nationalId: clean.nationalId,
      plateLetters: clean.plateLetters,
      plateNumbers: clean.plateNumbers,
      carType: clean.carType,
      carTypeOther: clean.carTypeOther,
      fulfillment: clean.fulfillment,
      products: clean.products,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    writeAll([row, ...readAll().filter((item) => item.nationalId !== clean.nationalId)]);
    return row;
  }

  function decide(id: string, status: 'approved' | 'rejected', actorName: string, rejectReason?: string) {
    const rows = readAll();
    const row = rows.find((item) => item.id === id);
    if (!row) return null;
    if (row.status !== 'pending') throw new Error('هذا الطلب تمت مراجعته مسبقاً');
    row.status = status;
    row.reviewedAt = new Date().toISOString();
    row.reviewedBy = actorName;
    if (status === 'rejected') row.rejectReason = rejectReason || 'رفض إداري';
    writeAll(rows);
    return row;
  }

  return {
    file,
    list: readAll,
    findByNationalId,
    findById,
    submit,
    decide,
  };
}
