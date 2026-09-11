/**
 * Optional transactional mail. Missing SMTP/MAIL env must never block auth.
 * Founder launch has no mail server — send is best-effort.
 */
import { publicSiteUrl } from '../auth/email-verification';

export function hasMailConfig(): boolean {
  return Boolean(
    process.env.SMTP_HOST ||
      process.env.MAIL_HOST ||
      process.env.SMTP_URL ||
      process.env.MAIL_URL ||
      process.env.SMTP_SERVER,
  );
}

export function notifyPasswordChanged(email: string): void {
  const to = String(email || '').trim().toLowerCase();
  if (!hasMailConfig() || !to.includes('@')) return;
  void deliverMail(to, 'تم تغيير الرقم السري — يوصل', 'تم تغيير الرقم السري لحسابك على منصة يوصل. إذا لم تطلب ذلك فراجع حسابك فوراً.').catch(
    () => undefined,
  );
}

export async function sendPasswordResetEmail(email: string, code: string): Promise<boolean> {
  const to = String(email || '').trim().toLowerCase();
  if (!hasMailConfig() || !to.includes('@') || !/^\d{6}$/.test(code)) return false;
  const text = [
    'رمز استعادة الحساب على منصة يوصل.',
    '',
    `رمز التأكيد: ${code}`,
    'صالح لمدة 30 دقيقة.',
    '',
    'إذا لم تطلب استعادة الحساب فتجاهل هذه الرسالة. الرقم السري لا يتغيّر إلا بعد إدخال الرمز.',
  ].join('\n');
  try {
    await deliverMail(to, 'استعادة الحساب — يوصل', text);
    return true;
  } catch {
    return false;
  }
}

export async function sendVerificationEmail(email: string, code: string, token?: string): Promise<boolean> {
  const to = String(email || '').trim().toLowerCase();
  if (!hasMailConfig() || !to.includes('@') || !/^\d{6}$/.test(code)) return false;
  const link = token ? `${publicSiteUrl()}/api/auth/verify-email?token=${encodeURIComponent(token)}` : '';
  const text = [
    'أكد بريدك على منصة يوصل.',
    '',
    `رمز التأكيد: ${code}`,
    'صالح لمدة 30 دقيقة.',
    link ? `أو افتح الرابط: ${link}` : '',
    '',
    'إذا لم تطلب إنشاء حساب فتجاهل هذه الرسالة.',
  ]
    .filter(Boolean)
    .join('\n');
  try {
    await deliverMail(to, 'أكد بريدك — يوصل', text);
    return true;
  } catch {
    return false;
  }
}

async function deliverMail(to: string, subject: string, text: string): Promise<void> {
  const host = process.env.SMTP_HOST || process.env.MAIL_HOST || process.env.SMTP_SERVER || '';
  const port = Number(process.env.SMTP_PORT || process.env.MAIL_PORT || 587);
  const user = process.env.SMTP_USER || process.env.MAIL_USER || '';
  const pass = process.env.SMTP_PASS || process.env.MAIL_PASS || '';
  const from =
    process.env.MAIL_FROM ||
    process.env.SMTP_FROM ||
    '"يوصل" <noreply@usil.app>';
  if (!host) return;

  const nodemailer = await loadNodemailer();
  if (!nodemailer?.createTransport) return;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: String(process.env.SMTP_SECURE || process.env.MAIL_SECURE || '') === '1' || port === 465,
    auth: user ? { user, pass } : undefined,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 5000,
  });

  await transporter.sendMail({
    from,
    to,
    subject,
    text,
  });
}

async function loadNodemailer(): Promise<{
  createTransport?: (opts: unknown) => { sendMail: (opts: unknown) => Promise<unknown> };
} | null> {
  try {
    const specifier = 'nodemailer';
    const imported = (await import(specifier)) as {
      default?: { createTransport?: (opts: unknown) => { sendMail: (opts: unknown) => Promise<unknown> } };
      createTransport?: (opts: unknown) => { sendMail: (opts: unknown) => Promise<unknown> };
    };
    return imported.default || imported;
  } catch {
    return null;
  }
}
