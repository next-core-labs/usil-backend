import path from 'path';
import { readJsonArray, writeJsonFile } from '../shared/json-file.ts';
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
  if (!isValidNationalId(String(input.nationalId))) {
    throw new Error('رقم الهوية أو الإقامة يجب أن يكون 10 أرقام ويبدأ بـ 1 أو 2');
  }
  if (!isValidSaudiIban(String(input.iban))) {
    throw new Error('رقم الآيبان يجب أن يبدأ بـ SA ويتبعه 22 رقماً');
  }
  if (!(SAUDI_BANKS as readonly string[]).includes(String(input.bankName))) {
    throw new Error('اختر بنكاً سعودياً من القائمة');
  }
  if (String(input.password).length < 6) {
    throw new Error('الرقم السري يجب ألا يقل عن 6 خانات');
  }
  return resolvedProjectType(String(input.projectType), input.projectTypeOther);
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
      phone: input.phone.trim(),
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
    decide,
    saveSocials,
    verifySocial,
  };
}
