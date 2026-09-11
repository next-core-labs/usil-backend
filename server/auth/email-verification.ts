import crypto from 'crypto';
import { FOUNDER_ADMIN_EMAIL } from './dummy-accounts';
import { isVendorSupervisor } from './roles';

export const EMAIL_VERIFY_TTL_MS = 30 * 60 * 1000;
export const EMAIL_RESEND_LIMIT = 3;
export const EMAIL_RESEND_WINDOW_MS = 15 * 60 * 1000;
export const EMAIL_VERIFY_ATTEMPT_LIMIT = 8;
export const EMAIL_VERIFY_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

export const EMAIL_VERIFY_EMPTY = 'أدخل رمز التأكيد المكوّن من 6 أرقام.';
export const EMAIL_VERIFY_INVALID = 'رمز التأكيد غير صحيح.';
export const EMAIL_VERIFY_EXPIRED = 'انتهت صلاحية الرمز. اضغط إعادة إرسال.';
export const EMAIL_VERIFY_SUCCESS = 'تم تأكيد بريدك.';
export const EMAIL_VERIFY_ALREADY = 'بريدك مؤكد مسبقاً.';
export const EMAIL_VERIFY_NOT_FOUND = 'لا يوجد حساب يطابق البريد والجوال.';
export const EMAIL_VERIFY_RATE = 'حدّ إعادة الإرسال. انتظر 15 دقيقة ثم أعد المحاولة.';
export const EMAIL_VERIFY_ATTEMPT_RATE = 'محاولات كثيرة. انتظر قليلاً ثم أعد المحاولة.';
export const EMAIL_VERIFY_BOOKING_BLOCK = 'أكد بريدك قبل إتمام الحجز أو الدفع.';

/** الحجز والدفع يتأكدان بجوال سعودي 05xxxxxxxx — لا يُغلقان على تأكيد البريد. */
export const EMAIL_RESEND_SENT = 'أرسلنا رمز تأكيد جديداً إلى بريدك.';
export const EMAIL_RESEND_FALLBACK = 'تعذر إرسال البريد الآن. هذا الرمز يظهر مرة واحدة فقط في هذه الجلسة.';

export function normalizeVerifyEmail(raw: string): string {
  return String(raw || '').trim().toLowerCase();
}

export function generateSixDigitCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function generateEmailVerifyToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

export function hashVerifyValue(value: string, email: string): string {
  return crypto.createHash('sha256').update(`${normalizeVerifyEmail(email)}:${value}`).digest('hex');
}

export function verifyValueMatches(plain: string, hash: string, email: string): boolean {
  if (!plain || !hash) return false;
  const next = hashVerifyValue(plain, email);
  if (next.length !== hash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(next), Buffer.from(hash));
}

export function isSixDigitCode(raw: string): boolean {
  return /^\d{6}$/.test(String(raw || '').trim());
}

export function isEmailVerificationExpired(expiresAt?: number, now = Date.now()): boolean {
  if (!expiresAt) return true;
  return now > expiresAt;
}

export function needsEmailVerification(user: {
  role?: string;
  email?: string;
  emailVerified?: boolean;
} | null | undefined): boolean {
  if (!user) return false;
  if (isVendorSupervisor(user.role)) return false;
  if (normalizeVerifyEmail(user.email || '') === FOUNDER_ADMIN_EMAIL) return false;
  return user.emailVerified === false;
}

export function isStoredEmailVerified(user: {
  role?: string;
  email?: string;
  emailVerified?: boolean;
}): boolean {
  return !needsEmailVerification(user);
}

export function bookingBlockedReason(_user: {
  role?: string;
  email?: string;
  emailVerified?: boolean;
} | null | undefined): string | null {
  return null;
}

export function publicSiteUrl(): string {
  return (process.env.PUBLIC_SITE_URL || process.env.APP_URL || 'https://usil.app').replace(/\/$/, '');
}
