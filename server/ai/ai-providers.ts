import {
  AI_PROVIDER_IDS,
  PROVIDER_LABEL_AR,
  effectiveKey,
  effectiveModel,
  type AiProviderId,
  type IntegrationsSettings,
  type IntegrationsStore,
} from './integrations-store';

export type AiMessage = { role: 'user' | 'assistant'; content: string };

export type AiTextRequest = {
  system?: string;
  messages: AiMessage[];
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
};

export type AiTextResult = { text: string; provider: AiProviderId; model: string };

export type FetchLike = typeof fetch;

export type AiRouterOptions = {
  fetchImpl?: FetchLike;
  /** يُمرَّر في الاختبارات لتفادي استدعاء @google/genai الحقيقي. */
  geminiText?: (args: {
    apiKey: string;
    model: string;
    request: AiTextRequest;
  }) => Promise<string>;
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';

export class AiProviderError extends Error {
  status: number;
  provider: AiProviderId;

  constructor(provider: AiProviderId, status: number, message: string) {
    super(message);
    this.name = 'AiProviderError';
    this.provider = provider;
    this.status = status;
  }
}

/** يمنع أي مفتاح من الظهور في رسالة خطأ أو سجل. */
export function redactSecrets(text: string, keys: string[] = []): string {
  let out = String(text ?? '');
  for (const key of keys) {
    if (key && key.length >= 8) out = out.split(key).join('***');
  }
  return out
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***')
    .replace(/AIza[A-Za-z0-9_-]{10,}/g, 'AIza***');
}

export function providerErrorMessageAr(provider: AiProviderId, status: number): string {
  const label = PROVIDER_LABEL_AR[provider];
  if (status === 401 || status === 403) {
    return `المفتاح مرفوض من ${label}. تأكد أنك نسخته كامل وأنه ما زال صالحاً.`;
  }
  if (status === 404) {
    return `اسم الموديل غير موجود عند ${label}. صحّح اسم الموديل ثم أعد الاختبار.`;
  }
  if (status === 429) {
    return `${label} رفض الطلب لتجاوز حد الاستخدام أو نفاد الرصيد. راجع الفاتورة عند المزود.`;
  }
  if (status === 0) {
    return `تعذر وصول الخادم إلى ${label}. تحقق من الشبكة أو الجدار الناري على السيرفر.`;
  }
  if (status >= 500) {
    return `${label} يرد بخطأ من جهته الآن. أعد المحاولة بعد قليل.`;
  }
  return `${label} رفض الطلب (رمز ${status}). راجع اسم الموديل وصلاحيات المفتاح.`;
}

function systemAndTurns(request: AiTextRequest) {
  const turns = request.messages.filter((message) => String(message.content || '').trim());
  return {
    system: String(request.system || '').trim(),
    turns: turns.length ? turns : [{ role: 'user' as const, content: 'مرحبا' }],
  };
}

async function readErrorStatus(response: Response): Promise<number> {
  try {
    await response.text();
  } catch {
    /* الجسم غير مهم — نعتمد على الرمز فقط حتى لا نطبع أي شيء من المزود */
  }
  return response.status;
}

async function callAnthropic(
  apiKey: string,
  model: string,
  request: AiTextRequest,
  fetchImpl: FetchLike,
): Promise<string> {
  const { system, turns } = systemAndTurns(request);
  const jsonHint = request.json
    ? '\n\nأرجع JSON صالحاً فقط بدون أي شرح أو أسوار كود.'
    : '';
  let response: Response;
  try {
    response = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: request.maxTokens ?? 1600,
        temperature: request.temperature ?? 0.7,
        ...(system || jsonHint ? { system: `${system}${jsonHint}`.trim() } : {}),
        messages: turns.map((message) => ({
          role: message.role,
          content: [{ type: 'text', text: message.content }],
        })),
      }),
    });
  } catch {
    throw new AiProviderError('anthropic', 0, providerErrorMessageAr('anthropic', 0));
  }
  if (!response.ok) {
    const status = await readErrorStatus(response);
    throw new AiProviderError('anthropic', status, providerErrorMessageAr('anthropic', status));
  }
  const data = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
  return (data.content || [])
    .filter((part) => !part.type || part.type === 'text')
    .map((part) => part.text || '')
    .join('')
    .trim();
}

async function callOpenai(
  apiKey: string,
  model: string,
  request: AiTextRequest,
  fetchImpl: FetchLike,
): Promise<string> {
  const { system, turns } = systemAndTurns(request);
  const messages = [
    ...(system ? [{ role: 'system' as const, content: system }] : []),
    ...turns.map((message) => ({ role: message.role, content: message.content })),
  ];
  let response: Response;
  try {
    response = await fetchImpl(OPENAI_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: request.json
          ? [
              ...messages.slice(0, -1),
              {
                ...messages[messages.length - 1],
                content: `${messages[messages.length - 1].content}\n\nأرجع JSON صالحاً فقط.`,
              },
            ]
          : messages,
        temperature: request.temperature ?? 0.7,
        max_completion_tokens: request.maxTokens ?? 1600,
        ...(request.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
  } catch {
    throw new AiProviderError('openai', 0, providerErrorMessageAr('openai', 0));
  }
  if (!response.ok) {
    const status = await readErrorStatus(response);
    throw new AiProviderError('openai', status, providerErrorMessageAr('openai', status));
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return String(data.choices?.[0]?.message?.content || '').trim();
}

async function callGemini(apiKey: string, model: string, request: AiTextRequest): Promise<string> {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
  });
  const { system, turns } = systemAndTurns(request);
  try {
    const response = await ai.models.generateContent({
      model: model || DEFAULT_GEMINI_MODEL,
      contents: turns.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      })),
      config: {
        ...(system ? { systemInstruction: system } : {}),
        ...(request.json ? { responseMimeType: 'application/json' } : {}),
        temperature: request.temperature ?? 0.7,
      },
    });
    return String(response.text || '').trim();
  } catch (error) {
    const status = Number((error as { status?: number })?.status) || 0;
    throw new AiProviderError('gemini', status, providerErrorMessageAr('gemini', status));
  }
}

export function createAiRouter(store: IntegrationsStore, options: AiRouterOptions = {}) {
  const fetchImpl = options.fetchImpl || fetch;

  function settings(): IntegrationsSettings {
    return store.load();
  }

  function isConfigured(provider: AiProviderId, current = settings()): boolean {
    return Boolean(effectiveKey(current, provider));
  }

  /** المزود الافتراضي أولاً، ثم أي مزود آخر عنده مفتاح، وإلا لا شيء. */
  function activeProvider(current = settings()): AiProviderId | null {
    if (isConfigured(current.defaultProvider, current)) return current.defaultProvider;
    return AI_PROVIDER_IDS.find((provider) => isConfigured(provider, current)) || null;
  }

  async function generateWith(
    provider: AiProviderId,
    request: AiTextRequest,
    current = settings(),
  ): Promise<AiTextResult> {
    const apiKey = effectiveKey(current, provider);
    if (!apiKey) {
      throw new AiProviderError(
        provider,
        0,
        `ما فيه مفتاح محفوظ لـ ${PROVIDER_LABEL_AR[provider]}. أضفه من لوحة الإدارة › تكاملات ومفاتيح API.`,
      );
    }
    const model = effectiveModel(current, provider);
    if (provider === 'anthropic') {
      return { text: await callAnthropic(apiKey, model, request, fetchImpl), provider, model };
    }
    if (provider === 'openai') {
      return { text: await callOpenai(apiKey, model, request, fetchImpl), provider, model };
    }
    const text = options.geminiText
      ? await options.geminiText({ apiKey, model, request })
      : await callGemini(apiKey, model, request);
    return { text, provider, model: model || DEFAULT_GEMINI_MODEL };
  }

  /** يستخدم المزود الافتراضي؛ يرجع null حين لا يوجد أي مفتاح مُعد. */
  async function generateText(request: AiTextRequest): Promise<AiTextResult | null> {
    const current = settings();
    const provider = activeProvider(current);
    if (!provider) return null;
    return generateWith(provider, request, current);
  }

  async function test(providerInput: AiProviderId): Promise<{ success: boolean; message: string }> {
    const current = settings();
    const provider = providerInput;
    const label = PROVIDER_LABEL_AR[provider];
    if (!effectiveKey(current, provider)) {
      return { success: false, message: `الصق مفتاح ${label} واحفظه أولاً ثم اختبر الاتصال.` };
    }
    try {
      const result = await generateWith(
        provider,
        {
          system: 'أجب بكلمة واحدة فقط.',
          messages: [{ role: 'user', content: 'قل: جاهز' }],
          maxTokens: 16,
          temperature: 0,
        },
        current,
      );
      if (!result.text) {
        return {
          success: false,
          message: `${label} رد بدون نص. جرّب موديلاً آخر ثم أعد الاختبار.`,
        };
      }
      return {
        success: true,
        message: `الاتصال ناجح مع ${label} على الموديل ${result.model}.`,
      };
    } catch (error) {
      const keys = AI_PROVIDER_IDS.map((id) => effectiveKey(current, id));
      const message =
        error instanceof AiProviderError
          ? error.message
          : `تعذر الاتصال بـ ${label}. راجع المفتاح واسم الموديل.`;
      return { success: false, message: redactSecrets(message, keys) };
    }
  }

  /**
   * غلاف بشكل عميل @google/genai حتى تستدعيه المسارات الحالية بلا تغيير في نمطها،
   * لكن التنفيذ يمر على المزود الافتراضي (Claude أو OpenAI أو Gemini).
   */
  function textClient() {
    const current = settings();
    const provider = activeProvider(current);
    if (!provider) return null;
    return {
      provider,
      models: {
        generateContent: async (args: {
          model?: string;
          contents: unknown;
          config?: { systemInstruction?: string; responseMimeType?: string; temperature?: number };
        }) => {
          const messages: AiMessage[] = [];
          if (typeof args.contents === 'string') {
            messages.push({ role: 'user', content: args.contents });
          } else if (Array.isArray(args.contents)) {
            for (const entry of args.contents as Array<{
              role?: string;
              parts?: Array<{ text?: string }>;
            }>) {
              const text = (entry.parts || []).map((part) => part.text || '').join('\n');
              messages.push({ role: entry.role === 'model' ? 'assistant' : 'user', content: text });
            }
          }
          const routeModel = provider === 'gemini' ? args.model || '' : '';
          const request: AiTextRequest = {
            system: args.config?.systemInstruction,
            messages,
            json: args.config?.responseMimeType === 'application/json',
            temperature: args.config?.temperature,
          };
          const scoped: IntegrationsSettings = routeModel && !current.gemini.model
            ? { ...current, gemini: { ...current.gemini, model: routeModel } }
            : current;
          const result = await generateWith(provider, request, scoped);
          return { text: result.text, provider: result.provider, model: result.model };
        },
      },
    };
  }

  return { activeProvider, isConfigured, generateText, generateWith, test, textClient, settings };
}

export type AiRouter = ReturnType<typeof createAiRouter>;
