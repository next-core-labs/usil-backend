import type { Express, Request, Response } from 'express';
import { createSlidingWindowLimiter } from '../shared/booking-guards';
import { createGraphClient, fillTemplateBody, type GraphTemplate } from './whatsapp-graph';
import {
  canSend,
  ensureVerifyToken,
  loadWhatsAppSettings,
  publicWhatsAppSettings,
  resolveWhatsAppConfig,
  sanitizeNumericId,
  sanitizeSecret,
  saveWhatsAppSettings,
  WEBHOOK_PATH,
  WHATSAPP_CLEARABLE_FIELDS,
  type WhatsAppConfig,
  type WhatsAppField,
} from './whatsapp-settings';
import { createWhatsAppStore, isWaId, normalizeWhatsAppPhone, type Person } from './whatsapp-store';
import { parseWhatsAppWebhook, rawBodyOf, verifyKapsoSignature, verifyWhatsAppSignature } from './whatsapp-webhook';

type Guard = (req: Request, res: Response, next: () => void) => void;

type StaffUser = { id: string; name: string; role: string };

type AuthLike = {
  requireRole: (roles: Array<'client' | 'vendor' | 'admin'>, options?: { exact?: boolean }) => Guard;
  /** Admins and accounts managers: the people a chat can be assigned to. */
  listUsersByRole?: (role: 'admin' | 'accounts_manager') => StaffUser[];
};

export type WhatsAppRouteOptions = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

const NOT_CONFIGURED = 'واتساب غير مربوط بعد. أدخل Access Token و Phone Number ID من إعدادات واتساب.';
const WINDOW_CLOSED =
  'مرّ أكثر من 24 ساعة على آخر رسالة من العميل — واتساب يسمح فقط برسالة قالب معتمدة.';
const UNKNOWN_CHAT = 'المحادثة غير موجودة.';
const TEMPLATE_CACHE_MS = 5 * 60_000;

/** Media types a browser may show inline; anything else downloads, so a sent HTML file never runs on our origin. */
const INLINE_MEDIA = /^(image\/(jpeg|png|gif|webp)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf)$/i;

function sessionUser(req: Request): Person | null {
  const user = (req as Request & { user?: { id?: unknown; name?: unknown } }).user;
  if (!user || typeof user.id !== 'string') return null;
  return { id: user.id, name: typeof user.name === 'string' ? user.name : '' };
}

export function registerWhatsAppRoutes(
  app: Express,
  auth: AuthLike,
  dataDir: string,
  options: WhatsAppRouteOptions = {},
) {
  const now = options.now || (() => new Date());
  const graph = createGraphClient(options.fetchImpl || fetch);
  const store = createWhatsAppStore(dataDir, now);
  /** Admin + accounts_manager: everyone who works the inbox. */
  const requireStaff = auth.requireRole(['admin']);
  /** The number's credentials stay with «مدير كل الحسابات». */
  const requireOwnerAdmin = auth.requireRole(['admin'], { exact: true });
  const settingsLimiter = createSlidingWindowLimiter(8, 60_000);
  const sendLimiter = createSlidingWindowLimiter(60, 60_000);

  let templateCache: { key: string; at: number; rows: GraphTemplate[] } | null = null;

  async function loadTemplates(config: WhatsAppConfig, fresh = false) {
    const key = `${config.businessAccountId}:${config.accessToken.slice(-8)}`;
    if (!fresh && templateCache && templateCache.key === key && Date.now() - templateCache.at < TEMPLATE_CACHE_MS) {
      return { ok: true as const, data: templateCache.rows };
    }
    const result = await graph.templates(config);
    if (result.ok === true) templateCache = { key, at: Date.now(), rows: result.data };
    return result;
  }

  function staffList(): StaffUser[] {
    const list = auth.listUsersByRole;
    if (!list) return [];
    return [...list('admin'), ...list('accounts_manager')].map((user) => ({
      id: user.id,
      name: user.name,
      role: user.role,
    }));
  }

  async function verifyNumber(config: WhatsAppConfig) {
    const result = await graph.phoneNumber(config);
    if (result.ok === false) {
      return {
        ok: false as const,
        error: `تعذر التحقق من رقم واتساب لدى Meta: ${result.message}. تأكد من Access Token و Phone Number ID.`,
      };
    }
    return { ok: true as const, data: result.data };
  }

  /** The config that saving `saved` would produce: env values still win. */
  function effectiveConfig(saved: { accessToken: string; phoneNumberId: string }): WhatsAppConfig {
    const config = resolveWhatsAppConfig(dataDir);
    // Kapso is configured entirely from the environment, not this saved form.
    if (config.provider === 'kapso') return config;
    const envSet = (name: string) => Boolean(String(process.env[name] || '').trim());
    return {
      ...config,
      accessToken: envSet('WHATSAPP_ACCESS_TOKEN') ? config.accessToken : saved.accessToken,
      phoneNumberId: envSet('WHATSAPP_PHONE_NUMBER_ID') ? config.phoneNumberId : saved.phoneNumberId,
    };
  }

  function sendFailed(res: Response, message: string) {
    return res.status(502).json({ success: false, error: `تعذر إرسال الرسالة عبر واتساب: ${message}` });
  }

  function chatParam(req: Request): string {
    const waId = String(req.params.waId || '');
    return isWaId(waId) ? waId : '';
  }

  function validTemplateInput(body: unknown, nameKey: 'name' | 'template'):
    | { ok: true; name: string; language: string; params: string[] }
    | { ok: false; error: string } {
    const input = (body || {}) as Record<string, unknown>;
    const name = String(input[nameKey] ?? '').trim();
    const language = String(input.language ?? '').trim();
    if (!/^[a-z0-9_]{1,512}$/.test(name)) return { ok: false, error: 'اختر قالباً معتمداً.' };
    if (!/^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,8})?$/.test(language)) return { ok: false, error: 'لغة القالب غير صحيحة.' };
    const rawParams = input.params === undefined ? [] : input.params;
    if (!Array.isArray(rawParams) || rawParams.length > 30) return { ok: false, error: 'متغيرات القالب غير صحيحة.' };
    const params = rawParams.map((value) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''));
    if (params.some((value) => !value || value.length > 1024)) {
      return { ok: false, error: 'عبّئ كل متغيرات القالب (حتى 1024 حرفاً لكل متغير).' };
    }
    return { ok: true, name, language, params };
  }

  /** Send an approved template; returns the stored text + wamid, or a Graph error. */
  async function sendTemplate(config: WhatsAppConfig, waId: string, name: string, language: string, params: string[]) {
    let known: GraphTemplate | undefined;
    if (config.businessAccountId) {
      const templates = await loadTemplates(config).catch(() => null);
      if (templates && templates.ok === true) {
        known =
          templates.data.find((row) => row.name === name && row.language === language) ||
          templates.data.find((row) => row.name === name);
      }
    }
    const parameters = params.map((text, index) =>
      known?.named && known.paramNames[index]
        ? { type: 'text', parameter_name: known.paramNames[index], text }
        : { type: 'text', text },
    );
    const sent = await graph.sendMessage(config, {
      recipient_type: 'individual',
      to: waId,
      type: 'template',
      template: {
        name,
        language: { code: language },
        components: parameters.length ? [{ type: 'body', parameters }] : [],
      },
    });
    const text = known?.body ? fillTemplateBody(known.body, params) : `[قالب: ${name}]`;
    return { sent, text };
  }

  // ─── Settings ───

  app.get('/api/admin/whatsapp/settings', requireStaff, (_req: Request, res: Response) => {
    res.json({ success: true, data: publicWhatsAppSettings(dataDir) });
  });

  app.put('/api/admin/whatsapp/settings', requireOwnerAdmin, async (req: Request, res: Response) => {
    if (!settingsLimiter.allow('admin-whatsapp-save')) {
      return res.status(429).json({ success: false, error: 'كثرت محاولات الحفظ. انتظر دقيقة ثم أعد المحاولة.' });
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const clear = new Set(
      (Array.isArray(body.clear) ? body.clear : []).filter((field): field is WhatsAppField =>
        WHATSAPP_CLEARABLE_FIELDS.includes(field as WhatsAppField),
      ),
    );
    const pasted = (key: string) => (typeof body[key] === 'string' ? (body[key] as string).trim() : '');

    const incoming = {
      accessToken: sanitizeSecret(body.accessToken),
      phoneNumberId: sanitizeNumericId(body.phoneNumberId),
      businessAccountId: sanitizeNumericId(body.businessAccountId),
      appSecret: sanitizeSecret(body.appSecret),
    };
    if (pasted('phoneNumberId') && !incoming.phoneNumberId) {
      return res.status(400).json({ success: false, error: 'Phone Number ID أرقام فقط — انسخه من WhatsApp Manager › API Setup.' });
    }
    if (pasted('businessAccountId') && !incoming.businessAccountId) {
      return res
        .status(400)
        .json({ success: false, error: 'WhatsApp Business Account ID أرقام فقط — انسخه من WhatsApp Manager › API Setup.' });
    }
    if (incoming.accessToken && incoming.accessToken.length < 20) {
      return res.status(400).json({ success: false, error: 'Access Token ناقص. انسخه كاملاً من Meta.' });
    }

    ensureVerifyToken(dataDir);
    const previous = loadWhatsAppSettings(dataDir);
    const next = { ...previous };
    for (const field of WHATSAPP_CLEARABLE_FIELDS) {
      if (clear.has(field)) next[field] = '';
      else if (incoming[field]) next[field] = incoming[field];
    }
    if (next.accessToken !== previous.accessToken || next.phoneNumberId !== previous.phoneNumberId) {
      next.displayPhone = '';
      next.verifiedName = '';
    }

    // Check the credentials that will be in effect (env still wins) before anything
    // is written, so a mistyped token never replaces one that works.
    const effective = effectiveConfig(next);
    if (canSend(effective)) {
      const verified = await verifyNumber(effective);
      if (verified.ok === false) return res.status(400).json({ success: false, error: verified.error });
      next.displayPhone = verified.data.displayPhone;
      next.verifiedName = verified.data.verifiedName;
    }

    saveWhatsAppSettings(dataDir, next);
    templateCache = null;
    res.json({ success: true, data: publicWhatsAppSettings(dataDir) });
  });

  app.post('/api/admin/whatsapp/settings/test', requireOwnerAdmin, async (_req: Request, res: Response) => {
    if (!settingsLimiter.allow('admin-whatsapp-save')) {
      return res.status(429).json({ success: false, error: 'كثرت المحاولات. انتظر دقيقة ثم أعد المحاولة.' });
    }
    const config = resolveWhatsAppConfig(dataDir);
    if (!canSend(config)) return res.status(503).json({ success: false, error: NOT_CONFIGURED });
    const verified = await verifyNumber(config);
    if (verified.ok === false) return res.status(400).json({ success: false, error: verified.error });
    saveWhatsAppSettings(dataDir, { ...loadWhatsAppSettings(dataDir), ...verified.data });
    res.json({ success: true, data: verified.data });
  });

  // ─── Webhook (public; Meta authenticates by signature) ───

  app.get(WEBHOOK_PATH, (req: Request, res: Response) => {
    const mode = String(req.query['hub.mode'] || '');
    const token = String(req.query['hub.verify_token'] || '');
    const challenge = String(req.query['hub.challenge'] || '');
    const expected = ensureVerifyToken(dataDir);
    if (mode === 'subscribe' && token && expected && token === expected) {
      return res.status(200).type('text/plain').send(challenge);
    }
    res.status(403).type('text/plain').send('Forbidden');
  });

  app.post(WEBHOOK_PATH, (req: Request, res: Response) => {
    const config = resolveWhatsAppConfig(dataDir);
    const raw = rawBodyOf(req);
    let valid = false;
    if (config.provider === 'kapso') {
      if (!config.webhookSecret) {
        return res.status(503).json({ success: false, error: 'Kapso webhook secret is not configured.' });
      }
      // Kapso has sent both header spellings across versions; accept either.
      const signature = req.headers['x-webhook-signature'] ?? req.headers['x-kapso-signature'];
      valid = Boolean(raw) && verifyKapsoSignature(config.webhookSecret, raw as Buffer, signature);
    } else {
      if (!config.appSecret) {
        return res.status(503).json({ success: false, error: 'WhatsApp app secret is not configured.' });
      }
      valid = Boolean(raw) && verifyWhatsAppSignature(config.appSecret, raw as Buffer, req.headers['x-hub-signature-256']);
    }
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Invalid signature.' });
    }
    try {
      const events = parseWhatsAppWebhook(req.body, { now: now(), phoneNumberId: config.phoneNumberId });
      for (const event of events) store.apply(event);
    } catch (error) {
      // A storage failure: a non-200 makes Meta retry, and the wamid de-dup makes that safe.
      console.error('[whatsapp] webhook processing failed', error);
      return res.status(500).json({ received: false });
    }
    res.status(200).json({ received: true });
  });

  // ─── Inbox ───

  app.get('/api/admin/whatsapp/conversations', requireStaff, (_req: Request, res: Response) => {
    res.json({ success: true, data: store.list() });
  });

  app.get('/api/admin/whatsapp/unread', requireStaff, (_req: Request, res: Response) => {
    res.json({ success: true, data: { count: store.unreadCount() } });
  });

  app.get('/api/admin/whatsapp/team', requireStaff, (_req: Request, res: Response) => {
    res.json({ success: true, data: staffList() });
  });

  app.get('/api/admin/whatsapp/conversations/:waId/messages', requireStaff, (req: Request, res: Response) => {
    const waId = chatParam(req);
    const conversation = waId ? store.get(waId) : null;
    if (!conversation) return res.status(404).json({ success: false, error: UNKNOWN_CHAT });
    const after = typeof req.query.after === 'string' ? req.query.after : '';
    res.json({ success: true, data: { conversation, messages: store.messages(waId, after) } });
  });

  app.post('/api/admin/whatsapp/conversations/:waId/read', requireStaff, async (req: Request, res: Response) => {
    const waId = chatParam(req);
    const conversation = waId ? store.markRead(waId) : null;
    if (!conversation) return res.status(404).json({ success: false, error: UNKNOWN_CHAT });
    const wamid = store.pendingReadReceipt(waId);
    const config = resolveWhatsAppConfig(dataDir);
    if (wamid && canSend(config)) {
      // Best effort: the blue ticks are a courtesy, never a reason to fail.
      const receipt = await graph.markRead(config, wamid).catch(() => null);
      if (receipt && receipt.ok === true) store.markReadReceiptSent(waId, wamid);
    }
    res.json({ success: true, data: conversation });
  });

  app.patch('/api/admin/whatsapp/conversations/:waId', requireStaff, (req: Request, res: Response) => {
    const waId = chatParam(req);
    if (!waId || !store.get(waId)) return res.status(404).json({ success: false, error: UNKNOWN_CHAT });
    const body = (req.body || {}) as { assignedTo?: unknown; status?: unknown; name?: unknown };
    const patch: { assignedTo?: Person | null; status?: 'open' | 'closed'; name?: string } = {};

    if (body.assignedTo !== undefined) {
      if (body.assignedTo === null || body.assignedTo === '') {
        patch.assignedTo = null;
      } else {
        const member = staffList().find((user) => user.id === body.assignedTo);
        if (!member) return res.status(400).json({ success: false, error: 'اختر موظفاً من فريق الإدارة.' });
        patch.assignedTo = { id: member.id, name: member.name };
      }
    }
    if (body.status !== undefined) {
      if (body.status !== 'open' && body.status !== 'closed') {
        return res.status(400).json({ success: false, error: 'حالة المحادثة غير صحيحة.' });
      }
      patch.status = body.status;
    }
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length > 80) {
        return res.status(400).json({ success: false, error: 'الاسم حتى 80 حرفاً.' });
      }
      patch.name = body.name.trim();
    }
    res.json({ success: true, data: store.update(waId, patch) });
  });

  app.post('/api/admin/whatsapp/conversations/:waId/messages', requireStaff, async (req: Request, res: Response) => {
    const waId = chatParam(req);
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim() || text.length > 4096) {
      return res.status(400).json({ success: false, error: 'اكتب رسالة (حتى 4096 حرفاً).' });
    }
    const conversation = waId ? store.get(waId) : null;
    if (!conversation) return res.status(404).json({ success: false, error: UNKNOWN_CHAT });
    const config = resolveWhatsAppConfig(dataDir);
    if (!canSend(config)) return res.status(503).json({ success: false, error: NOT_CONFIGURED });
    if (!conversation.windowOpen) {
      return res.status(409).json({ success: false, error: WINDOW_CLOSED, windowClosed: true });
    }
    const user = sessionUser(req);
    if (!sendLimiter.allow(user?.id || 'staff')) {
      return res.status(429).json({ success: false, error: 'رسائل كثيرة خلال دقيقة. انتظر قليلاً ثم أعد المحاولة.' });
    }
    const sent = await graph.sendMessage(config, {
      recipient_type: 'individual',
      to: waId,
      type: 'text',
      text: { body: text, preview_url: true },
    });
    if (sent.ok === false) return sendFailed(res, sent.message);
    const message = store.addOutbound(waId, { wamid: sent.data.wamid, type: 'text', text, sentBy: user });
    res.status(201).json({ success: true, data: message });
  });

  app.get('/api/admin/whatsapp/templates', requireStaff, async (_req: Request, res: Response) => {
    const config = resolveWhatsAppConfig(dataDir);
    if (!config.accessToken) return res.status(503).json({ success: false, error: NOT_CONFIGURED });
    if (!config.businessAccountId) {
      return res.status(503).json({
        success: false,
        error: 'أدخل WhatsApp Business Account ID في إعدادات واتساب لعرض القوالب المعتمدة.',
      });
    }
    const result = await loadTemplates(config, true);
    if (result.ok === false) {
      return res.status(502).json({ success: false, error: `تعذر جلب القوالب من واتساب: ${result.message}` });
    }
    res.json({
      success: true,
      data: result.data.map(({ name, language, category, body, paramCount }) => ({
        name,
        language,
        category,
        body,
        paramCount,
      })),
    });
  });

  app.post('/api/admin/whatsapp/conversations/:waId/template', requireStaff, async (req: Request, res: Response) => {
    const waId = chatParam(req);
    if (!waId || !store.get(waId)) return res.status(404).json({ success: false, error: UNKNOWN_CHAT });
    const input = validTemplateInput(req.body, 'name');
    if (input.ok === false) return res.status(400).json({ success: false, error: input.error });
    const config = resolveWhatsAppConfig(dataDir);
    if (!canSend(config)) return res.status(503).json({ success: false, error: NOT_CONFIGURED });
    const user = sessionUser(req);
    if (!sendLimiter.allow(user?.id || 'staff')) {
      return res.status(429).json({ success: false, error: 'رسائل كثيرة خلال دقيقة. انتظر قليلاً ثم أعد المحاولة.' });
    }
    const { sent, text } = await sendTemplate(config, waId, input.name, input.language, input.params);
    if (sent.ok === false) return sendFailed(res, sent.message);
    const message = store.addOutbound(waId, {
      wamid: sent.data.wamid,
      type: 'template',
      text,
      sentBy: user,
      template: { name: input.name, language: input.language },
    });
    res.status(201).json({ success: true, data: message });
  });

  app.post('/api/admin/whatsapp/start', requireStaff, async (req: Request, res: Response) => {
    const phone = normalizeWhatsAppPhone(req.body?.phone);
    if (!phone) {
      return res.status(400).json({ success: false, error: 'رقم الجوال غير صحيح. اكتبه مثل 05XXXXXXXX أو بالصيغة الدولية.' });
    }
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : '';
    const input = validTemplateInput(req.body, 'template');
    if (input.ok === false) return res.status(400).json({ success: false, error: input.error });
    const config = resolveWhatsAppConfig(dataDir);
    if (!canSend(config)) return res.status(503).json({ success: false, error: NOT_CONFIGURED });
    const user = sessionUser(req);
    if (!sendLimiter.allow(user?.id || 'staff')) {
      return res.status(429).json({ success: false, error: 'رسائل كثيرة خلال دقيقة. انتظر قليلاً ثم أعد المحاولة.' });
    }
    const { sent, text } = await sendTemplate(config, phone, input.name, input.language, input.params);
    if (sent.ok === false) return sendFailed(res, sent.message);
    // Meta may report the number's canonical wa_id; inbound replies arrive from that one.
    const waId = isWaId(sent.data.waId) ? sent.data.waId : phone;
    store.ensureConversation(waId, name);
    const message = store.addOutbound(waId, {
      wamid: sent.data.wamid,
      type: 'template',
      text,
      sentBy: user,
      template: { name: input.name, language: input.language },
    });
    res.status(201).json({ success: true, data: { conversation: store.get(waId), message } });
  });

  app.get('/api/admin/whatsapp/media/:mediaId', requireStaff, async (req: Request, res: Response) => {
    const mediaId = String(req.params.mediaId || '');
    if (!/^[\w.-]{1,128}$/.test(mediaId) || !store.hasMedia(mediaId)) {
      return res.status(404).json({ success: false, error: 'الملف غير موجود.' });
    }
    const config = resolveWhatsAppConfig(dataDir);
    if (!config.accessToken) return res.status(503).json({ success: false, error: NOT_CONFIGURED });
    const info = await graph.mediaInfo(config, mediaId);
    if (info.ok === false) {
      return res.status(502).json({ success: false, error: `تعذر جلب الملف من واتساب: ${info.message}` });
    }
    const download = await graph.download(config, info.data.url);
    if (!download || !download.body) {
      return res.status(502).json({ success: false, error: 'تعذر تنزيل الملف من واتساب.' });
    }
    const type = (info.data.mimeType || download.headers.get('content-type') || 'application/octet-stream')
      .split(';')[0]
      .trim();
    res.status(200);
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (INLINE_MEDIA.test(type)) {
      res.setHeader('Content-Disposition', 'inline');
    } else {
      res.setHeader('Content-Disposition', 'attachment');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
    }
    const length = download.headers.get('content-length');
    if (length && /^\d+$/.test(length)) res.setHeader('Content-Length', length);
    // Streamed chunk by chunk (documents can be up to 100MB), with plain stream
    // reads so it behaves the same under Node and inside the Durable Object.
    const reader = download.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (res.destroyed) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => {
            res.once('drain', () => resolve());
            res.once('close', () => resolve());
          });
        }
      }
      res.end();
    } catch {
      res.destroy();
    } finally {
      reader.cancel().catch(() => undefined);
    }
  });
}
