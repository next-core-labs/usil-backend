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

export function registerLegacyRoutes(app: Express) {
  app.get('/api/services', (_req: Request, res: Response) => {
    res.json({ success: true, data: LEGACY_SERVICES });
  });

  app.post('/api/calculate-quote', (req: Request, res: Response) => {
    const { serviceIds = [], attendees = 50, days = 1 } = req.body || {};
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
