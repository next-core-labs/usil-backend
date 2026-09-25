import type { Express, Request, Response } from 'express';

/**
 * Vestigial endpoints. **Do not build on these.**
 *
 * They predate the current marketplace and no part of the frontend calls them.
 * They read an intentionally empty in-process service list, so the quote always
 * totals zero and the planner returns fixed copy. They stay registered only
 * because they are published API surface and removing them would be a breaking
 * change; they are isolated here so nobody mistakes them for live behaviour.
 *
 * Real product data comes from `GET /api/catalog/listings`, and real planning
 * from `POST /api/gemini/match-packages`.
 */

/** Empty by design — the storefront never shows a seeded catalog. */
const LEGACY_SERVICES: Array<{ id: number; name: string; price: number }> = [];

const VAT_RATE = 0.15;
const GUESTS_PER_PRICE_TIER = 50;
const MAX_ATTENDEES = 100_000;
const MAX_DAYS = 365;
const MAX_SERVICE_IDS = 200;

export const AI_PLANNER_NOT_CONFIGURED =
  'مخطط المناسبات الذكي غير مفعّل حالياً — لم يُضبط مزود ذكاء على الخادم. أضف المفتاح من لوحة الإدارة › تكاملات ومفاتيح API.';

type QuoteInput = { serviceIds: Array<string | number>; attendees: number; days: number };

function positiveInt(value: unknown, fallback: number, max: number): number | null {
  if (value === undefined) return fallback;
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
}

/** Parse a quote request, or return an Arabic error for anything malformed. */
export function parseQuoteInput(body: unknown): { ok: true; value: QuoteInput } | { ok: false; error: string } {
  if (body === undefined || body === null) body = {};
  if (typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'صيغة الطلب غير صحيحة.' };
  const row = body as Record<string, unknown>;
  const serviceIds = row.serviceIds === undefined ? [] : row.serviceIds;
  if (
    !Array.isArray(serviceIds) ||
    serviceIds.length > MAX_SERVICE_IDS ||
    serviceIds.some((id) => !(typeof id === 'number' && Number.isFinite(id)) && !(typeof id === 'string' && id.trim()))
  ) {
    return { ok: false, error: 'serviceIds يجب أن تكون قائمة معرّفات خدمات.' };
  }
  const attendees = positiveInt(row.attendees, 50, MAX_ATTENDEES);
  if (attendees === null) return { ok: false, error: `عدد الحضور يجب أن يكون رقماً صحيحاً من 1 إلى ${MAX_ATTENDEES}.` };
  const days = positiveInt(row.days, 1, MAX_DAYS);
  if (days === null) return { ok: false, error: `عدد الأيام يجب أن يكون رقماً صحيحاً من 1 إلى ${MAX_DAYS}.` };
  return { ok: true, value: { serviceIds: serviceIds as Array<string | number>, attendees, days } };
}

export type LegacyRouteDeps = {
  /** Whether an AI provider is configured; without one the planner answers 503. */
  aiAvailable?: () => boolean;
};

function envAiAvailable(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
}

export function registerLegacyRoutes(app: Express, deps: LegacyRouteDeps = {}) {
  const aiAvailable = deps.aiAvailable || envAiAvailable;

  app.get('/api/services', (_req: Request, res: Response) => {
    res.json({ success: true, data: LEGACY_SERVICES });
  });

  app.post('/api/calculate-quote', (req: Request, res: Response) => {
    const parsed = parseQuoteInput(req.body);
    if ('error' in parsed) return res.status(400).json({ success: false, error: parsed.error });
    const { serviceIds, attendees, days } = parsed.value;
    const selected = LEGACY_SERVICES.filter((service) => serviceIds.includes(service.id));
    const baseCost = selected.reduce((sum, service) => sum + service.price, 0);
    const tierMultiplier = Math.max(1, Math.ceil(attendees / GUESTS_PER_PRICE_TIER));
    const subtotal = baseCost * tierMultiplier * days;

    res.json({
      success: true,
      quote: {
        servicesCount: selected.length,
        attendees,
        days,
        subtotal,
        tax: subtotal * VAT_RATE,
        totalWithTax: subtotal * (1 + VAT_RATE),
      },
    });
  });

  // المساعد الذكي — نص ثابت، والتخطيط الحقيقي في /api/gemini/match-packages
  app.post('/api/ai-planner', (req: Request, res: Response) => {
    if (!aiAvailable()) {
      return res.status(503).json({ success: false, aiAvailable: false, error: AI_PLANNER_NOT_CONFIGURED });
    }
    const { eventType, guests } = req.body || {};
    const guestCount = guests || 100;

    res.json({
      success: true,
      plan: {
        summary: `خطة تنظيمية ذكية لفعالية (${eventType || 'رسمية'}) لعدد ${guestCount} ضيف`,
        recommendations: [
          `مساحة موصى بها: ${Math.max(120, guestCount * 1.6)} متر مربع لضمان راحة الحضور وسلاسة الاستقبال.`,
          `كادر الضيافة: ${Math.max(3, Math.ceil(guestCount / 35))} مشرفين ومقدمي ضيافة بزي سعودي موحد فاخر.`,
          `التغطية والتقنية: شاشة رئيسية P2.5 LED، إضاءة بروفايل للمنصة، ونظام صوتي لاسلكي مانع للصدى.`,
          `التوثيق الإعلامي: مصور فوتوغرافي + مصور فيديو مع تسليم مقطع ملخص (Reels) خلال 12 ساعة.`,
        ],
        estimatedTimeline:
          'تجهيز الموقع والمسرح: قبل الفعالية بـ 24 ساعة | اختبار الأنظمة والصوت: قبل البداية بـ 3 ساعات',
      },
    });
  });
}
