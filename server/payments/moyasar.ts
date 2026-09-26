import { randomUUID, timingSafeEqual } from 'node:crypto';
import { publicSiteUrl } from '../auth/email-verification';

/** Hostname that must stay DNS-only (grey cloud) so Moyasar can POST past Bot Fight Mode. */
export const MOYASAR_HOOKS_HOST = 'hooks.usil.app';

export type MoyasarInvoice = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  description: string;
  url: string;
};

export type MoyasarPayment = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  description: string;
  invoiceId?: string;
  invoice_id?: string | null;
  bookingId?: string;
  transactionUrl?: string;
  metadata?: Record<string, string> | null;
  source?: { type: string; company?: string; message?: string | null; transaction_url?: string };
};

const MOYASAR_API = 'https://api.moyasar.com/v1';

/** One message for every "no secret key" path, so checkout, callback and lookups agree. */
export const MOYASAR_NOT_CONFIGURED = 'ميسر غير مفعّل على الخادم حالياً. حاول لاحقاً أو تواصل مع إدارة يوصل.';

/**
 * Why a Moyasar call failed, so routes pick the status code: `not_configured`
 * is ours (503), `not_found` is Moyasar's 404, `upstream` is anything else it
 * or the network got wrong (502). Routes never forward Moyasar's raw text.
 */
export type MoyasarFailureCode = 'not_configured' | 'invalid' | 'not_found' | 'upstream';
export type MoyasarFailure = { ok: false; error: string; code: MoyasarFailureCode };

export class MoyasarError extends Error {
  readonly code: MoyasarFailureCode;
  constructor(message: string, code: MoyasarFailureCode) {
    super(message);
    this.name = 'MoyasarError';
    this.code = code;
  }
}

export function moyasarErrorCode(error: unknown): MoyasarFailureCode | null {
  return error instanceof MoyasarError ? error.code : null;
}

export function moyasarSecretKey(): string {
  return String(
    process.env.MOYASAR_SECRET_KEY ||
      process.env.MOYASAR_API_KEY ||
      process.env.PAYMENT_PROVIDER_SECRET_KEY ||
      '',
  ).trim();
}

/** Full secret from the eye icon — not the starred Secret Key ID. */
export function isMoyasarSecretKey(raw: string): boolean {
  return /^sk_(test|live)_[A-Za-z0-9]{24,}$/.test(String(raw || '').trim());
}

export function moyasarPublishableKey(): string {
  const key = String(process.env.MOYASAR_PUBLISHABLE_KEY || '').trim();
  return key.startsWith('pk_test_') || key.startsWith('pk_live_') ? key : '';
}

export function moyasarConfigured(): boolean {
  return isMoyasarSecretKey(moyasarSecretKey());
}

export function moyasarFormReady(): boolean {
  return moyasarConfigured() && Boolean(moyasarPublishableKey());
}

export function moyasarWebhookSecret(): string {
  return String(process.env.MOYASAR_WEBHOOK_SECRET || '').trim();
}

export function moyasarWebhookAuthorized(secretToken: unknown): boolean {
  const expected = moyasarWebhookSecret();
  if (!expected) return false;
  const got = String(secretToken || '');
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isUsilHttpsUrl(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'usil.app' || host.endsWith('.usil.app');
}

/** Invoice callback + account webhook. Prefer grey-cloud hooks.usil.app so Cloudflare Bot Fight cannot 403 Moyasar. */
export function moyasarWebhookUrl(): string {
  const fallback = `${publicSiteUrl()}/api/payments/webhook`;
  const raw = String(process.env.MOYASAR_WEBHOOK_URL || '').trim();
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (!isUsilHttpsUrl(parsed)) return fallback;
    if (!parsed.pathname || parsed.pathname === '/') {
      return `${parsed.origin}/api/payments/webhook`;
    }
    return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

export function sarToHalalas(amountSar: number): number {
  const n = Number(amountSar);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

export function isMoyasarCheckoutUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'moyasar.com' || host.endsWith('.moyasar.com');
  } catch {
    return false;
  }
}

function moyasarAuthHeader(): string {
  if (!moyasarConfigured()) {
    throw new MoyasarError(MOYASAR_NOT_CONFIGURED, 'not_configured');
  }
  return `Basic ${Buffer.from(`${moyasarSecretKey()}:`).toString('base64')}`;
}

export function isSafeMoyasarId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{8,80}$/.test(id);
}

function asMetadata(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return Object.keys(out).length ? out : null;
}

function bookingIdFromMetadata(raw: unknown): string {
  const meta = asMetadata(raw);
  if (!meta) return '';
  return String(meta.bookingId || meta.order_id || meta.orderId || '').trim();
}

/**
 * ينشئ فاتورة ويعيد رابط صفحة الدفع المستضافة عند ميسر.
 * amountSar بالريال — يُحوَّل إلى هللات (أقل مبلغ مقبول 1 ريال).
 */
export async function createInvoice(input: {
  amountSar: number;
  description: string;
  successUrl: string;
  backUrl: string;
  callbackUrl: string;
  metadata?: Record<string, string>;
  fetchImpl?: typeof fetch;
}): Promise<MoyasarInvoice> {
  if (!moyasarConfigured()) {
    throw new MoyasarError(MOYASAR_NOT_CONFIGURED, 'not_configured');
  }
  const amount = sarToHalalas(input.amountSar);
  if (amount < 100) {
    throw new MoyasarError('المبلغ (amount) بالريال مطلوب ولا يقل عن 1', 'invalid');
  }
  const description = String(input.description || '').trim();
  if (!description) {
    throw new MoyasarError('وصف الطلب (description) مطلوب', 'invalid');
  }

  const fetchImpl = input.fetchImpl || fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${MOYASAR_API}/invoices`, {
      method: 'POST',
      headers: {
        Authorization: moyasarAuthHeader(),
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({
        amount,
        currency: 'SAR',
        description: description.slice(0, 220),
        success_url: input.successUrl,
        back_url: input.backUrl,
        callback_url: input.callbackUrl,
        metadata: input.metadata,
      }),
    });
  } catch {
    throw new MoyasarError('تعذر الاتصال بميسر. حاول مرة أخرى.', 'upstream');
  }

  const data = (await res.json().catch(() => ({}))) as Partial<MoyasarInvoice> & { message?: string };
  const url = String(data.url || '');
  if (!res.ok || !data.id || !isMoyasarCheckoutUrl(url)) {
    // Moyasar's own text goes to the log, not to the customer.
    console.warn('[moyasar] invoice refused', res.status, data.message || '');
    throw new MoyasarError('تعذر إنشاء رابط الدفع من ميسر. حاول بعد قليل.', 'upstream');
  }

  return {
    id: String(data.id),
    status: String(data.status || 'initiated'),
    amount,
    currency: 'SAR',
    description: String(data.description || description),
    url,
  };
}

export async function createMoyasarInvoice(input: {
  amountSar: number;
  description: string;
  bookingId: string;
  successPath?: string;
  backPath?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; invoice: MoyasarInvoice } | MoyasarFailure> {
  const site = publicSiteUrl();
  try {
    const invoice = await createInvoice({
      amountSar: input.amountSar,
      description: String(input.description || 'طلب يوصل').slice(0, 220),
      successUrl: `${site}${input.successPath || '/payment/success'}`,
      backUrl: `${site}${input.backPath || '/payment/cancelled'}`,
      callbackUrl: moyasarWebhookUrl(),
      metadata: {
        bookingId: input.bookingId,
        order_id: input.bookingId,
        source: 'usil',
      },
      fetchImpl: input.fetchImpl,
    });
    return { ok: true, invoice };
  } catch (error) {
    return {
      ok: false,
      error: (error as Error).message || 'تعذر إنشاء فاتورة ميسر.',
      code: moyasarErrorCode(error) || 'upstream',
    };
  }
}

/** GET /v1/payments/:id — الحالة المدفوعة لا تُؤخذ من العميل. */
export async function fetchMoyasarPayment(
  paymentId: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; payment: MoyasarPayment } | MoyasarFailure> {
  if (!moyasarConfigured()) {
    return { ok: false, error: MOYASAR_NOT_CONFIGURED, code: 'not_configured' };
  }
  const id = String(paymentId || '').trim();
  if (!isSafeMoyasarId(id)) {
    return { ok: false, error: 'رقم عملية ميسر غير صالح.', code: 'invalid' };
  }

  const impl = fetchImpl || fetch;
  let res: Response;
  try {
    res = await impl(`${MOYASAR_API}/payments/${encodeURIComponent(id)}`, {
      headers: { Authorization: moyasarAuthHeader() },
    });
  } catch {
    return { ok: false, error: 'تعذر التحقق من عملية ميسر.', code: 'upstream' };
  }

  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    status?: string;
    amount?: number;
    currency?: string;
    description?: string;
    invoice_id?: string;
    metadata?: unknown;
    source?: { type?: string; company?: string; message?: string | null; transaction_url?: string };
    message?: string;
  };
  if (res.status === 404) {
    return { ok: false, error: 'عملية ميسر غير موجودة.', code: 'not_found' };
  }
  if (!res.ok || !data.id) {
    console.warn('[moyasar] payment lookup failed', res.status, data.message || '');
    return { ok: false, error: 'تعذر التحقق من عملية ميسر.', code: 'upstream' };
  }

  const transactionUrl = String(data.source?.transaction_url || '');
  if (transactionUrl && !isMoyasarCheckoutUrl(transactionUrl)) {
    return { ok: false, error: 'رابط إكمال الدفع من ميسر غير صالح.', code: 'upstream' };
  }

  const metadata = asMetadata(data.metadata);
  return {
    ok: true,
    payment: {
      id: String(data.id),
      status: String(data.status || ''),
      amount: Number(data.amount) || 0,
      currency: String(data.currency || 'SAR'),
      description: String(data.description || ''),
      invoiceId: data.invoice_id ? String(data.invoice_id) : undefined,
      invoice_id: data.invoice_id ? String(data.invoice_id) : null,
      bookingId: bookingIdFromMetadata(data.metadata) || undefined,
      transactionUrl: transactionUrl || undefined,
      metadata,
      source: {
        type: String(data.source?.type || ''),
        company: data.source?.company,
        message: data.source?.message ?? null,
      },
    },
  };
}

/** يجلب حالة عملية دفع — هذا هو مصدر الحقيقة، لا نعتمد على محتوى الويبهوك وحده. */
export async function fetchPayment(
  paymentId: string,
  fetchImpl?: typeof fetch,
): Promise<MoyasarPayment> {
  const out = await fetchMoyasarPayment(paymentId, fetchImpl);
  if (out.ok === false) throw new MoyasarError(out.error, out.code);
  return out.payment;
}

/** Confirms invoice status with Moyasar. Never trust a client-supplied paid flag. */
export async function fetchMoyasarInvoice(
  invoiceId: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; invoice: MoyasarInvoice } | MoyasarFailure> {
  if (!moyasarConfigured()) {
    return { ok: false, error: MOYASAR_NOT_CONFIGURED, code: 'not_configured' };
  }
  const id = String(invoiceId || '').trim();
  if (!isSafeMoyasarId(id)) {
    return { ok: false, error: 'رقم فاتورة ميسر غير صالح.', code: 'invalid' };
  }

  const impl = fetchImpl || fetch;
  let res: Response;
  try {
    res = await impl(`${MOYASAR_API}/invoices/${encodeURIComponent(id)}`, {
      headers: { Authorization: moyasarAuthHeader() },
    });
  } catch {
    return { ok: false, error: 'تعذر التحقق من فاتورة ميسر.', code: 'upstream' };
  }

  const data = (await res.json().catch(() => ({}))) as Partial<MoyasarInvoice> & { message?: string };
  const url = String(data.url || '');
  if (res.status === 404) {
    return { ok: false, error: 'فاتورة ميسر غير موجودة.', code: 'not_found' };
  }
  if (!res.ok || !data.id) {
    console.warn('[moyasar] invoice lookup failed', res.status, data.message || '');
    return { ok: false, error: 'تعذر التحقق من فاتورة ميسر.', code: 'upstream' };
  }
  if (url && !isMoyasarCheckoutUrl(url)) {
    return { ok: false, error: 'رابط فاتورة ميسر غير صالح.', code: 'upstream' };
  }

  return {
    ok: true,
    invoice: {
      id: String(data.id),
      status: String(data.status || ''),
      amount: Number(data.amount) || 0,
      currency: String(data.currency || 'SAR'),
      description: String(data.description || ''),
      url: url || `https://checkout.moyasar.com/invoices/${id}`,
    },
  };
}

export async function verifyMoyasarCheckout(
  id: string,
  fetchImpl?: typeof fetch,
): Promise<
  | { ok: true; kind: 'payment'; payment: MoyasarPayment }
  | { ok: true; kind: 'invoice'; invoice: MoyasarInvoice }
  | MoyasarFailure
> {
  const payment = await fetchMoyasarPayment(id, fetchImpl);
  if (payment.ok === true) return { ok: true, kind: 'payment', payment: payment.payment };
  // Without a key (or with a malformed id) the invoice lookup fails the same way.
  if (payment.code === 'not_configured' || payment.code === 'invalid') return payment;
  const invoice = await fetchMoyasarInvoice(id, fetchImpl);
  if (invoice.ok === true) return { ok: true, kind: 'invoice', invoice: invoice.invoice };
  // Unknown to both endpoints is "not found"; any other failure is the provider's.
  if (payment.code === 'not_found' && invoice.code === 'not_found') return invoice;
  return payment.code === 'upstream' ? payment : invoice;
}

const WEBHOOK_EVENTS = [
  'payment_paid',
  'payment_failed',
  'payment_refunded',
  'payment_voided',
];

function listedWebhooks(payload: unknown): Array<{ url?: string; id?: string }> {
  if (!payload || typeof payload !== 'object') return [];
  const row = payload as { webhooks?: unknown; data?: unknown };
  if (Array.isArray(row.webhooks)) return row.webhooks as Array<{ url?: string; id?: string }>;
  if (Array.isArray(row.data)) return row.data as Array<{ url?: string; id?: string }>;
  if (Array.isArray(payload)) return payload as Array<{ url?: string; id?: string }>;
  return [];
}

function basicAuthForSecret(secret: string): string {
  return `Basic ${Buffer.from(`${secret}:`).toString('base64')}`;
}

/** Confirms the secret with Moyasar before we persist it. Never logs the key. */
export async function verifyMoyasarSecretKey(
  secret: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const key = String(secret || '').trim();
  if (!isMoyasarSecretKey(key) || key.includes('*')) {
    return {
      ok: false,
      error: 'المفتاح ناقص أو فيه نجوم أو pk_. اضغط العين بجانب Secret Key وانسخ sk_ الكامل.',
    };
  }
  const impl = fetchImpl || fetch;
  let res: Response;
  try {
    res = await impl(`${MOYASAR_API}/webhooks`, {
      headers: { Authorization: basicAuthForSecret(key), Accept: 'application/json' },
    });
  } catch {
    return { ok: false, error: 'تعذر الاتصال بميسر. تحقق من النت وأعد المحاولة.' };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: 'ميسر رفض المفتاح. تأكد أنه sk_live_ أو sk_test_ من لوحة ميسر، مو pk_.' };
  }
  if (!res.ok) {
    return { ok: false, error: `ميسر رد HTTP ${res.status} أثناء التحقق من المفتاح.` };
  }
  return { ok: true };
}

export async function ensureMoyasarWebhook(
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; status: 'existing' | 'created' } | { ok: false; error: string }> {
  if (!moyasarConfigured()) {
    return { ok: false, error: 'ميسر غير مفعّل على الخادم.' };
  }
  const shared = moyasarWebhookSecret();
  if (!shared) {
    return { ok: false, error: 'سر الويبهوك غير مضبوط على الخادم.' };
  }
  const url = moyasarWebhookUrl();
  const impl = fetchImpl || fetch;
  const headers = {
    Authorization: moyasarAuthHeader(),
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  let listed: Response;
  try {
    listed = await impl(`${MOYASAR_API}/webhooks`, { headers });
  } catch {
    return { ok: false, error: 'تعذر جلب ويبهوكات ميسر.' };
  }
  if (listed.status === 401) {
    return { ok: false, error: 'ميسر رفض المفتاح أثناء تسجيل الويبهوك.' };
  }
  if (!listed.ok) {
    return { ok: false, error: `تعذر جلب الويبهوكات من ميسر (HTTP ${listed.status}).` };
  }
  const payload = (await listed.json().catch(() => ({}))) as unknown;
  const existing = listedWebhooks(payload);
  if (existing.some((row) => String(row.url || '').replace(/\/$/, '') === url.replace(/\/$/, ''))) {
    return { ok: true, status: 'existing' };
  }

  let created: Response;
  try {
    created = await impl(`${MOYASAR_API}/webhooks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        http_method: 'post',
        url,
        shared_secret: shared,
        events: WEBHOOK_EVENTS,
      }),
    });
  } catch {
    return { ok: false, error: 'تعذر تسجيل ويبهوك ميسر.' };
  }
  if (!created.ok) {
    const body = (await created.json().catch(() => ({}))) as { message?: string };
    return { ok: false, error: body.message || `ميسر رفض تسجيل الويبهوك (HTTP ${created.status}).` };
  }
  return { ok: true, status: 'created' };
}
