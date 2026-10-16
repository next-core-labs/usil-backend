import path from 'path';
import { readJsonArray, writeJsonFile } from '../shared/json-file.ts';
import { normalizeSaudiMobile } from '../shared/booking-guards';
import {
  emptyVendorSocials,
  parseVendorSocials,
  setSocialVerification,
  type SocialNetwork,
  type VendorSocials,
} from './vendor-socials';

export const PROJECT_TYPES = [
  'تنظيم حفلات ومناسبات',
  'حفلات زواج وملكة',
  'حفلات تخرج ونجاح',
  'أعياد ميلاد ومولود',
  'حفلات خطوبة وشبّكة',
  'عزاء ومآتم',
  'ضيافة قهوة وشاي',
  'بوفيه وتموين مناسبات',
  'تموين معارض ومؤتمرات',
  'تنظيم معارض وبوثات',
  'تنظيم مؤتمرات وملتقيات',
  'قاعات واستراحات',
  'تصوير فوتوغرافي وفيديو',
  'تصوير أعراس ومناسبات',
  'صوتيات وإضاءة وشاشات',
  'مسارح ومنصات عرض',
  'ورد وتنسيق طاولات',
  'كوش أفراح وديكور حفلات',
  'حلويات وكيك وعصائر',
  'صبابين وطاقم تقديم',
  'تأجير أثاث وديكور',
  'تأجير خيام ومظلات',
  'فرق تراثية وفنون شعبية',
  'دي جي وفقرات ترفيه',
  'حراسات وتنظيم دخول',
  'طباعة دعوات وهدايا تذكارية',
  'نقل وتوصيل مستلزمات',
  'أخرى',
] as const;

export const SAUDI_BANKS = [
  'مصرف الراجحي',
  'البنك الأهلي السعودي',
  'بنك الرياض',
  'مصرف الإنماء',
  'بنك البلاد',
  'بنك الجزيرة',
  'البنك العربي الوطني',
  'بنك ساب',
  'البنك السعودي للاستثمار',
  'بنك الخليج الدولي',
  'بنك الإمارات دبي الوطني',
  'بنك الكويت الوطني',
  'بنك قطر الوطني',
  'البنك الأهلي المصري',
  'ستاندرد تشارترد',
  'دويتشه بنك',
  'بنك مسقط',
  'بنك البحرين الوطني',
  'جي بي مورغان',
  'بنك الصين',
] as const;

export type VendorApplicationStatus = 'pending' | 'approved' | 'rejected';

export const VENDOR_PASSWORD_MIN_LENGTH = 8;

const FULFILLMENT_IDS = ['hour', 'same_day', 'tomorrow', 'instant'] as const;
export type VendorFulfillmentLane = (typeof FULFILLMENT_IDS)[number];

export function parseVendorFulfillment(raw: unknown): VendorFulfillmentLane[] {
  const list = Array.isArray(raw) ? raw : [];
  const lanes = list.filter((item): item is VendorFulfillmentLane =>
    (FULFILLMENT_IDS as readonly string[]).includes(String(item)),
  );
  if (!lanes.length) {
    throw new Error('اختر مساراً واحداً على الأقل في «أقدر أخدم في»');
  }
  return Array.from(new Set(lanes));
}

export type VendorApplication = {
  id: string;
  firstName: string;
  fatherName: string;
  familyName: string;
  projectName: string;
  nationalId: string;
  email: string;
  phone: string;
  commercialRegister?: string;
  projectType: string;
  projectTypeOther?: string;
  bankName: string;
  iban: string;
  accountHolderName: string;
  fulfillment: VendorFulfillmentLane[];
  passwordHash: string;
  logoUrl?: string;
  socials?: VendorSocials;
  status: VendorApplicationStatus;
  /**
   * `quick`: filed from the vendor console with only a name, store and
   * contact; everything else is completed in the dashboard before approval.
   * Absent on the storefront's full form.
   */
  signup?: 'quick';
  createdAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  rejectReason?: string;
};

export type VendorApplicationInput = {
  firstName: string;
  fatherName: string;
  familyName: string;
  projectName: string;
  nationalId: string;
  email: string;
  phone: string;
  commercialRegister?: string;
  projectType: string;
  projectTypeOther?: string;
  bankName: string;
  iban: string;
  accountHolderName: string;
  password: string;
  fulfillment?: VendorFulfillmentLane[];
  socials?: VendorSocials;
  confirmedOwn?: boolean;
  instagram?: string;
  tiktok?: string;
  snapchat?: string;
  x?: string;
  youtube?: string;
  whatsapp?: string;
};

export function normalizeIban(raw: string): string {
  return String(raw || '').replace(/\s+/g, '').toUpperCase();
}

export function isValidSaudiIban(raw: string): boolean {
  return /^SA\d{22}$/.test(normalizeIban(raw));
}

export function isValidNationalId(raw: string): boolean {
  return /^[12]\d{9}$/.test(String(raw || '').replace(/\s+/g, ''));
}

export function resolvedProjectType(type: string, other?: string): string {
  if (type === 'أخرى') {
    const custom = String(other || '').trim();
    if (!custom) throw new Error('اكتب نوع المشروع في الخانة الفارغة');
    return custom;
  }
  if (!(PROJECT_TYPES as readonly string[]).includes(type)) {
    throw new Error('نوع المشروع غير صالح');
  }
  return type;
}

export function validateVendorApplication(input: Partial<VendorApplicationInput>) {
  const required: Array<keyof VendorApplicationInput> = [
    'firstName',
    'fatherName',
    'familyName',
    'projectName',
    'nationalId',
    'email',
    'phone',
    'projectType',
    'bankName',
    'iban',
    'accountHolderName',
    'password',
  ];
  for (const key of required) {
    if (!String(input[key] || '').trim()) {
      throw new Error('أكمل كل الحقول المطلوبة في صفحتي التسجيل');
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input.email).trim())) {
    throw new Error('اكتب بريداً إلكترونياً صحيحاً');
  }
  if (!normalizeSaudiMobile(String(input.phone))) {
    throw new Error('اكتب جوالاً سعودياً صحيحاً بصيغة 05xxxxxxxx');
  }
  if (!isValidNationalId(String(input.nationalId))) {
    throw new Error('رقم الهوية أو الإقامة يجب أن يكون 10 أرقام ويبدأ بـ 1 أو 2');
  }
  if (!isValidSaudiIban(String(input.iban))) {
    throw new Error('رقم الآيبان يجب أن يبدأ بـ SA ويتبعه 22 رقماً');
  }
  if (!(SAUDI_BANKS as readonly string[]).includes(String(input.bankName))) {
    throw new Error('اختر بنكاً سعودياً من القائمة');
  }
  // Same minimum as every other account on the platform.
  if (String(input.password).length < VENDOR_PASSWORD_MIN_LENGTH) {
    throw new Error(`الرقم السري يجب ألا يقل عن ${VENDOR_PASSWORD_MIN_LENGTH} خانات`);
  }
  return resolvedProjectType(String(input.projectType), input.projectTypeOther);
}

export type QuickSignupInput = {
  name: string;
  projectName: string;
  projectType: string;
  projectTypeOther?: string;
  email: string;
  /** Optional; when given it must be a Saudi mobile. */
  phone?: string;
  password: string;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEXT_MAX = 120;

function text(value: unknown): string {
  return String(value ?? '').trim().slice(0, TEXT_MAX);
}

/** The vendor console's short sign-up: who you are, your store, how to reach you. */
export function validateQuickSignup(input: Partial<QuickSignupInput>): string {
  if (!text(input.name)) throw new Error('اكتب اسمك');
  if (!text(input.projectName)) throw new Error('اكتب اسم المتجر');
  if (!EMAIL_PATTERN.test(String(input.email || '').trim())) throw new Error('اكتب بريداً إلكترونياً صحيحاً');
  const phone = String(input.phone || '').trim();
  if (phone && !normalizeSaudiMobile(phone)) {
    throw new Error('اكتب جوالاً سعودياً صحيحاً بصيغة 05xxxxxxxx — أو اتركه فارغاً');
  }
  if (String(input.password || '').length < VENDOR_PASSWORD_MIN_LENGTH) {
    throw new Error(`الرقم السري يجب ألا يقل عن ${VENDOR_PASSWORD_MIN_LENGTH} خانات`);
  }
  if (!String(input.projectType || '').trim()) throw new Error('اختر نوع المشروع');
  return resolvedProjectType(String(input.projectType), input.projectTypeOther);
}

/** «سالم أحمد العتيبي» → first / father / family; the vendor corrects it in the dashboard. */
export function splitPersonName(name: string): { firstName: string; fatherName: string; familyName: string } {
  const parts = text(name).split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { firstName: parts[0] || '', fatherName: '', familyName: '' };
  return {
    firstName: parts[0],
    fatherName: parts.slice(1, -1).join(' '),
    familyName: parts[parts.length - 1],
  };
}

/** What a pending vendor fills in from the dashboard. Every field is optional; a sent field must be valid. */
export type VendorDetailsInput = Partial<{
  firstName: string;
  fatherName: string;
  familyName: string;
  nationalId: string;
  commercialRegister: string;
  projectName: string;
  projectType: string;
  projectTypeOther: string;
  bankName: string;
  iban: string;
  accountHolderName: string;
  fulfillment: unknown;
  logoUrl: string;
}>;

type DetailsPatch = Partial<
  Pick<
    VendorApplication,
    | 'firstName'
    | 'fatherName'
    | 'familyName'
    | 'nationalId'
    | 'commercialRegister'
    | 'projectName'
    | 'projectType'
    | 'projectTypeOther'
    | 'bankName'
    | 'iban'
    | 'accountHolderName'
    | 'fulfillment'
    | 'logoUrl'
  >
>;

export function parseVendorDetails(input: VendorDetailsInput): DetailsPatch {
  const has = (key: keyof VendorDetailsInput) => Object.prototype.hasOwnProperty.call(input, key);
  const patch: DetailsPatch = {};
  for (const key of ['firstName', 'fatherName', 'familyName', 'accountHolderName'] as const) {
    if (has(key)) patch[key] = text(input[key]);
  }
  if (has('projectName')) {
    const projectName = text(input.projectName);
    if (!projectName) throw new Error('اكتب اسم المتجر');
    patch.projectName = projectName;
  }
  if (has('projectType')) {
    const type = String(input.projectType || '');
    patch.projectType = resolvedProjectType(type, input.projectTypeOther);
    patch.projectTypeOther = type === 'أخرى' ? text(input.projectTypeOther) : undefined;
  }
  if (has('nationalId')) {
    const nationalId = String(input.nationalId || '').replace(/\s+/g, '');
    if (nationalId && !isValidNationalId(nationalId)) {
      throw new Error('رقم الهوية أو الإقامة يجب أن يكون 10 أرقام ويبدأ بـ 1 أو 2');
    }
    patch.nationalId = nationalId;
  }
  if (has('commercialRegister')) patch.commercialRegister = text(input.commercialRegister) || undefined;
  if (has('bankName')) {
    const bankName = String(input.bankName || '');
    if (bankName && !(SAUDI_BANKS as readonly string[]).includes(bankName)) {
      throw new Error('اختر بنكاً سعودياً من القائمة');
    }
    patch.bankName = bankName;
  }
  if (has('iban')) {
    const iban = normalizeIban(String(input.iban || ''));
    if (iban && !isValidSaudiIban(iban)) throw new Error('رقم الآيبان يجب أن يبدأ بـ SA ويتبعه 22 رقماً');
    patch.iban = iban;
  }
  if (has('fulfillment')) {
    const list = Array.isArray(input.fulfillment) ? input.fulfillment : [];
    patch.fulfillment = Array.from(
      new Set(list.filter((item): item is VendorFulfillmentLane => (FULFILLMENT_IDS as readonly string[]).includes(String(item)))),
    );
  }
  if (has('logoUrl')) patch.logoUrl = String(input.logoUrl || '') || undefined;
  return patch;
}

export type MissingKey = 'names' | 'nationalId' | 'bank' | 'fulfillment' | 'socials' | 'listings';

export type MissingItem = { key: MissingKey; label: string };

/**
 * What still stands between a pending vendor and approval. The owner cannot
 * approve while this is non-empty, and the vendor sees the same list.
 */
export function missingForApproval(
  row: Pick<
    VendorApplication,
    'firstName' | 'fatherName' | 'familyName' | 'nationalId' | 'bankName' | 'iban' | 'accountHolderName' | 'fulfillment'
  >,
  extra: { listingCount: number; socialCount: number },
): MissingItem[] {
  const missing: MissingItem[] = [];
  if (!row.firstName?.trim() || !row.fatherName?.trim() || !row.familyName?.trim()) {
    missing.push({ key: 'names', label: 'الاسم الثلاثي' });
  }
  if (!isValidNationalId(row.nationalId || '')) missing.push({ key: 'nationalId', label: 'رقم الهوية أو الإقامة' });
  if (!(SAUDI_BANKS as readonly string[]).includes(row.bankName || '') || !isValidSaudiIban(row.iban || '') || !row.accountHolderName?.trim()) {
    missing.push({ key: 'bank', label: 'الحساب البنكي (البنك والآيبان واسم صاحب الحساب)' });
  }
  if (!row.fulfillment?.length) missing.push({ key: 'fulfillment', label: 'مسار التوصيل «أقدر أخدم في»' });
  if (extra.socialCount < 1) missing.push({ key: 'socials', label: 'حساب تواصل واحد على الأقل' });
  if (extra.listingCount < 1) missing.push({ key: 'listings', label: 'منتج واحد على الأقل بصوره وسعره' });
  return missing;
}

export function publicApplication(app: VendorApplication) {
  const { passwordHash: _hidden, ...rest } = app;
  return rest;
}

export function createVendorApplicationStore(dataDir: string) {
  const file = path.join(dataDir, 'vendor-applications.json');

  function readAll(): VendorApplication[] {
    return readJsonArray<VendorApplication>(file);
  }

  function writeAll(rows: VendorApplication[]) {
    writeJsonFile(file, rows);
  }

  function findByEmail(email: string) {
    const normalized = String(email || '').trim().toLowerCase();
    return readAll().find((row) => row.email === normalized) || null;
  }

  function findById(id: string) {
    return readAll().find((row) => row.id === id) || null;
  }

  function statusForEmail(email: string): VendorApplicationStatus | null {
    return findByEmail(email)?.status || null;
  }

  function submit(input: VendorApplicationInput, passwordHash: string): VendorApplication {
    const projectType = validateVendorApplication(input);
    const fulfillment = parseVendorFulfillment(input.fulfillment);
    const email = String(input.email).trim().toLowerCase();
    const existing = findByEmail(email);
    if (existing?.status === 'pending') {
      throw new Error('هذا البريد عليه طلب مورّد بانتظار موافقة إدارة يوصل');
    }
    if (existing?.status === 'approved') {
      throw new Error('هذا البريد مسجّل كمورّد معتمد. استخدم تسجيل الدخول');
    }
    const row: VendorApplication = {
      id: `vap-${Date.now()}`,
      firstName: input.firstName.trim(),
      fatherName: input.fatherName.trim(),
      familyName: input.familyName.trim(),
      projectName: input.projectName.trim(),
      nationalId: String(input.nationalId).replace(/\s+/g, ''),
      email,
      phone: normalizeSaudiMobile(input.phone) || input.phone.trim(),
      commercialRegister: input.commercialRegister?.trim() || undefined,
      projectType,
      projectTypeOther: input.projectType === 'أخرى' ? input.projectTypeOther?.trim() : undefined,
      bankName: input.bankName,
      iban: normalizeIban(input.iban),
      accountHolderName: input.accountHolderName.trim(),
      fulfillment,
      passwordHash,
      logoUrl: (input as VendorApplicationInput & { logoUrl?: string }).logoUrl,
      socials: parseVendorSocials(input, { requireAtLeastOne: true }),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    writeAll([row, ...readAll().filter((item) => item.email !== email)]);
    return row;
  }

  function submitQuick(input: QuickSignupInput, passwordHash: string): VendorApplication {
    const projectType = validateQuickSignup(input);
    const email = String(input.email).trim().toLowerCase();
    const existing = findByEmail(email);
    if (existing?.status === 'pending') {
      throw new Error('هذا البريد عليه طلب مورّد بانتظار موافقة إدارة يوصل. سجّل الدخول لإكماله');
    }
    if (existing?.status === 'approved') {
      throw new Error('هذا البريد مسجّل كمورّد معتمد. استخدم تسجيل الدخول');
    }
    const row: VendorApplication = {
      id: `vap-${Date.now()}`,
      ...splitPersonName(input.name),
      projectName: text(input.projectName),
      nationalId: '',
      email,
      phone: normalizeSaudiMobile(String(input.phone || '')) || '',
      projectType,
      projectTypeOther: input.projectType === 'أخرى' ? text(input.projectTypeOther) : undefined,
      bankName: '',
      iban: '',
      accountHolderName: '',
      fulfillment: [],
      passwordHash,
      status: 'pending',
      signup: 'quick',
      createdAt: new Date().toISOString(),
    };
    writeAll([row, ...readAll().filter((item) => item.email !== email)]);
    return row;
  }

  /** A pending application's own details, filled in from the vendor dashboard. */
  function updateDetails(id: string, input: VendorDetailsInput): VendorApplication | null {
    const patch = parseVendorDetails(input);
    const rows = readAll();
    const row = rows.find((item) => item.id === id);
    if (!row) return null;
    if (row.status !== 'pending') throw new Error('هذا الطلب تمت مراجعته — ما يمكن تعديله الآن');
    Object.assign(row, patch);
    writeAll(rows);
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

  function saveSocials(id: string, socials: VendorSocials) {
    const rows = readAll();
    const row = rows.find((item) => item.id === id);
    if (!row) return null;
    row.socials = socials;
    writeAll(rows);
    return row;
  }

  function verifySocial(id: string, network: SocialNetwork, verified: boolean, actorName: string) {
    const rows = readAll();
    const row = rows.find((item) => item.id === id);
    if (!row) return null;
    row.socials = setSocialVerification(row.socials || emptyVendorSocials(), network, verified, actorName);
    writeAll(rows);
    return row;
  }

  return {
    file,
    list: readAll,
    findByEmail,
    findById,
    statusForEmail,
    submit,
    submitQuick,
    updateDetails,
    decide,
    saveSocials,
    verifySocial,
  };
}
