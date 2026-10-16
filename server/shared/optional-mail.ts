/**
 * Optional transactional mail. Missing mail env must never block auth —
 * send is best-effort and callers decide what to show when it fails.
 *
 * Resend (RESEND_API_KEY) is the transport; plain SMTP stays as a fallback
 * for hosts that already run one.
 */
import { publicSiteUrl } from '../auth/email-verification';

const RESEND_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 8000;
const DEFAULT_FROM = 'يوصل <noreply@usil.app>';

type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Tests swap the HTTP call; production uses global fetch. */
let fetchImpl: FetchLike = (url, init) => fetch(url, init);
export function setMailFetchForTests(next: FetchLike | null): void {
  fetchImpl = next || ((url, init) => fetch(url, init));
}

function hasResendConfig(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

function hasSmtpConfig(): boolean {
  return Boolean(
    process.env.SMTP_HOST ||
      process.env.MAIL_HOST ||
      process.env.SMTP_URL ||
      process.env.MAIL_URL ||
      process.env.SMTP_SERVER,
  );
}

export function hasMailConfig(): boolean {
  return hasResendConfig() || hasSmtpConfig();
}

function mailFrom(): string {
  return process.env.MAIL_FROM || process.env.SMTP_FROM || DEFAULT_FROM;
}

function isMailbox(to: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/** Right-to-left HTML twin of the text body; a 6-digit code gets its own large line. */
function htmlBody(subject: string, lines: string[]): string {
  const rows = lines
    .map((line) => {
      if (!line) return '<div style="height:12px"></div>';
      const code = /^(.*?)(\d{6})$/.exec(line);
      if (code) {
        return `<p style="margin:0 0 6px">${escapeHtml(code[1].trim())}</p><p dir="ltr" style="margin:0 0 12px;font:700 30px/1.2 monospace;letter-spacing:8px;color:#0A1A33">${code[2]}</p>`;
      }
      const link = /^(.*?)(https?:\/\/\S+)$/.exec(line);
      if (link) {
        return `<p style="margin:0 0 8px">${escapeHtml(link[1].trim())} <a href="${escapeHtml(link[2])}" style="color:#1D5BD8">${escapeHtml(link[2])}</a></p>`;
      }
      return `<p style="margin:0 0 8px">${escapeHtml(line)}</p>`;
    })
    .join('');
  return `<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;background:#F4F6FA;font-family:Tahoma,Arial,sans-serif;color:#1B2433"><div style="max-width:520px;margin:24px auto;background:#fff;border-radius:14px;padding:28px;text-align:right;line-height:1.7;font-size:15px"><h1 style="margin:0 0 16px;font-size:18px;color:#0A1A33">${escapeHtml(subject)}</h1>${rows}<p style="margin:20px 0 0;color:#8A94A6;font-size:12px">يوصل — ${escapeHtml(publicSiteUrl().replace(/^https?:\/\//, ''))}</p></div></body></html>`;
}

/** Fire-and-forget notice: failures are logged, never thrown at the caller. */
function notify(to: string, subject: string, lines: string[]): void {
  const address = String(to || '').trim().toLowerCase();
  if (!hasMailConfig() || !isMailbox(address)) return;
  void deliverMail(address, subject, lines).catch(() => undefined);
}

export function notifyPasswordChanged(email: string): void {
  notify(email, 'تم تغيير الرقم السري — يوصل', [
    'تم تغيير الرقم السري لحسابك على منصة يوصل.',
    'إذا لم تطلب ذلك فراجع حسابك فوراً أو تواصل مع الدعم.',
  ]);
}

export function notifyVendorApplicationReceived(email: string, projectName: string): void {
  notify(email, 'استلمنا طلب انضمامك — يوصل', [
    `استلمنا طلب انضمام «${projectName || 'متجرك'}» كمورّد في يوصل.`,
    'تراجع إدارة يوصل الطلب، ونرسل لك رسالة هنا فور اعتماده أو رفضه.',
  ]);
}

export function notifyVendorApplicationDecision(
  email: string,
  projectName: string,
  status: 'approved' | 'rejected',
  reason?: string,
): void {
  const name = projectName || 'متجرك';
  if (status === 'approved') {
    notify(email, 'تم اعتماد متجرك — يوصل', [
      `مبروك! تم اعتماد «${name}» كمورّد في يوصل.`,
      'ادخل لوحة المورّد بنفس البريد والرقم السري اللذين سجّلت بهما:',
      (process.env.VENDOR_CONSOLE_URL || publicSiteUrl()).replace(/\/$/, ''),
    ]);
    return;
  }
  notify(email, 'تحديث على طلب انضمامك — يوصل', [
    `نعتذر، لم يُعتمد طلب «${name}» كمورّد في يوصل.`,
    reason ? `السبب: ${reason}` : '',
    'يمكنك تعديل بياناتك وإرسال طلب جديد في أي وقت.',
  ]);
}

/** The vendor accepted an approval order — the client can pay now. */
export function notifyBookingApproved(email: string, bookingId: string, serviceName: string, paymentUrl?: string): void {
  notify(email, 'وافق المورّد على طلبك — يوصل', [
    `وافق المورّد على طلبك ${bookingId} — ${serviceName}.`,
    'أكمل الدفع لتثبيت الحجز:',
    paymentUrl || `${publicSiteUrl()}/orders`,
  ]);
}

/** The order ended without happening — rejected by the vendor, or cancelled by the vendor or Usil. */
export function notifyBookingRejected(email: string, bookingId: string, serviceName: string): void {
  notify(email, 'تحديث على طلبك — يوصل', [
    `نعتذر، تعذّر تنفيذ طلبك ${bookingId}${serviceName ? ` — ${serviceName}` : ''}، وأُلغي الطلب.`,
    'إن كنت دفعت فيُعاد المبلغ عبر ميسر بنفس وسيلة الدفع. تفاصيل الطلب في «طلباتي»:',
    `${publicSiteUrl()}/orders`,
  ]);
}

/**
 * A vendor has a new order: one waiting for their approval, or an instant
 * order that has just been paid and is now confirmed.
 */
export function notifyVendorNewOrder(
  email: string,
  bookingId: string,
  serviceName: string,
  needsApproval: boolean,
): void {
  const label = serviceName ? ` — ${serviceName}` : '';
  notify(
    email,
    needsApproval ? 'طلب جديد بانتظار موافقتك — يوصل' : 'طلب جديد مدفوع — يوصل',
    needsApproval
      ? [
          `وصلك طلب جديد ${bookingId}${label} ينتظر موافقتك.`,
          'العميل يدفع بعد موافقتك. راجع الطلب من لوحة المورّد:',
          (process.env.VENDOR_CONSOLE_URL || publicSiteUrl()).replace(/\/$/, ''),
        ]
      : [
          `وصلك طلب جديد ${bookingId}${label}، ودفعه العميل وتأكد.`,
          'جهّز الطلب لموعد المناسبة. التفاصيل في لوحة المورّد:',
          (process.env.VENDOR_CONSOLE_URL || publicSiteUrl()).replace(/\/$/, ''),
        ],
  );
}

export async function sendPasswordResetEmail(email: string, code: string): Promise<boolean> {
  const to = String(email || '').trim().toLowerCase();
  if (!hasMailConfig() || !isMailbox(to) || !/^\d{6}$/.test(code)) return false;
  const lines = [
    'رمز استعادة الحساب على منصة يوصل.',
    '',
    `رمز التأكيد: ${code}`,
    // Must match RESET_CODE_TTL_MS in auth.ts.
    'صالح لمدة 15 دقيقة.',
    '',
    'إذا لم تطلب استعادة الحساب فتجاهل هذه الرسالة. الرقم السري لا يتغيّر إلا بعد إدخال الرمز.',
  ];
  try {
    await deliverMail(to, 'استعادة الحساب — يوصل', lines);
    return true;
  } catch {
    return false;
  }
}

export async function sendVerificationEmail(email: string, code: string, token?: string): Promise<boolean> {
  const to = String(email || '').trim().toLowerCase();
  if (!hasMailConfig() || !isMailbox(to) || !/^\d{6}$/.test(code)) return false;
  const link = token ? `${publicSiteUrl()}/api/auth/verify-email?token=${encodeURIComponent(token)}` : '';
  const lines = [
    'أكد بريدك على منصة يوصل.',
    '',
    `رمز التأكيد: ${code}`,
    'صالح لمدة 30 دقيقة.',
    link ? `أو افتح الرابط: ${link}` : '',
    '',
    'إذا لم تطلب إنشاء حساب فتجاهل هذه الرسالة.',
  ];
  try {
    await deliverMail(to, 'أكد بريدك — يوصل', lines);
    return true;
  } catch {
    return false;
  }
}

/** Throws when the message was not accepted, so callers can report the failure. */
async function deliverMail(to: string, subject: string, rawLines: string[]): Promise<void> {
  const lines = rawLines.filter((line, i, all) => line || (i > 0 && all[i - 1]));
  const text = lines.join('\n');
  if (hasResendConfig()) {
    await deliverWithResend(to, subject, text, htmlBody(subject, lines));
    return;
  }
  await deliverWithSmtp(to, subject, text);
}

async function deliverWithResend(to: string, subject: string, text: string, html: string): Promise<void> {
  const res = await fetchImpl(RESEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: mailFrom(), to: [to], subject, text, html }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (res.ok) return;
  // Resend names the cause (unverified domain, bad key). It never echoes the
  // body, so the code in the message stays out of the logs.
  const detail = (await res.text().catch(() => '')).slice(0, 300);
  console.warn(`Resend rejected mail (${res.status}): ${detail}`);
  throw new Error(`resend ${res.status}`);
}

async function deliverWithSmtp(to: string, subject: string, text: string): Promise<void> {
  const host = process.env.SMTP_HOST || process.env.MAIL_HOST || process.env.SMTP_SERVER || '';
  const port = Number(process.env.SMTP_PORT || process.env.MAIL_PORT || 587);
  const user = process.env.SMTP_USER || process.env.MAIL_USER || '';
  const pass = process.env.SMTP_PASS || process.env.MAIL_PASS || '';
  if (!host) throw new Error('no mail transport');

  const nodemailer = await loadNodemailer();
  if (!nodemailer?.createTransport) throw new Error('nodemailer missing');

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: String(process.env.SMTP_SECURE || process.env.MAIL_SECURE || '') === '1' || port === 465,
    auth: user ? { user, pass } : undefined,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 5000,
  });

  await transporter.sendMail({ from: mailFrom(), to, subject, text });
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
