import type { Express, Request, Response } from 'express';
import { createSlidingWindowLimiter } from '../shared/booking-guards';
import { createAiRouter, type AiRouter, type AiRouterOptions } from './ai-providers';
import {
  createIntegrationsStore,
  publicIntegrationsPayload,
  sanitizeProviderId,
  type AiProviderId,
  type IntegrationsStore,
} from './integrations-store';

type AuthLike = {
  requireRole: (roles: Array<'client' | 'vendor' | 'admin'>) => (
    req: Request,
    res: Response,
    next: () => void,
  ) => void;
};

export type IntegrationsRoutesResult = {
  store: IntegrationsStore;
  ai: AiRouter;
};

export function registerIntegrationsRoutes(
  app: Express,
  auth: AuthLike,
  dataDir: string,
  options: AiRouterOptions = {},
): IntegrationsRoutesResult {
  const store = createIntegrationsStore(dataDir);
  const ai = createAiRouter(store, options);
  const requireAdmin = auth.requireRole(['admin']);
  const testLimiter = createSlidingWindowLimiter(12, 60_000);

  app.get('/api/admin/integrations', requireAdmin, (_req: Request, res: Response) => {
    res.json({ success: true, data: publicIntegrationsPayload(store.load()) });
  });

  app.put('/api/admin/integrations', requireAdmin, (req: Request, res: Response) => {
    try {
      const saved = store.save(req.body);
      res.json({ success: true, data: publicIntegrationsPayload(saved) });
    } catch {
      res.status(400).json({ success: false, error: 'تعذر حفظ مفاتيح التكاملات.' });
    }
  });

  app.post('/api/admin/integrations/test', requireAdmin, async (req: Request, res: Response) => {
    if (!testLimiter.allow('admin-integrations-test')) {
      return res.status(429).json({
        success: false,
        error: 'كثرت محاولات الاختبار. انتظر دقيقة ثم أعد المحاولة.',
      });
    }
    const raw = String(req.body?.provider || '').trim().toLowerCase();
    if (raw === 'cursor') {
      return res.status(400).json({
        success: false,
        error: 'كيرسر ما عنده API للمواقع، فما فيه شي نختبره. اختبر Claude أو OpenAI أو Gemini.',
      });
    }
    const provider: AiProviderId = sanitizeProviderId(raw);
    if (provider !== raw) {
      return res.status(400).json({ success: false, error: 'اختر مزوداً صحيحاً: Gemini أو Claude أو OpenAI.' });
    }
    const result = await ai.test(provider);
    res.status(result.success ? 200 : 400).json({
      success: result.success,
      provider,
      message: result.message,
      ...(result.success ? {} : { error: result.message }),
    });
  });

  /** حالة عامة بلا مفاتيح: تسمح للواجهة بمعرفة أن الذكاء متاح أصلاً. */
  app.get('/api/ai/status', (_req: Request, res: Response) => {
    const settings = store.load();
    const active = ai.activeProvider(settings);
    res.json({
      success: true,
      available: Boolean(active),
      provider: active,
      defaultProvider: settings.defaultProvider,
      cursor: { supported: false },
    });
  });

  return { store, ai };
}
