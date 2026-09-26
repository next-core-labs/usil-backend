import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MoyasarError,
  createInvoice,
  createMoyasarInvoice,
  fetchMoyasarInvoice,
  fetchMoyasarPayment,
  moyasarConfigured,
  moyasarFormReady,
  moyasarPublishableKey,
  moyasarWebhookAuthorized,
  moyasarWebhookUrl,
  sarToHalalas,
  verifyMoyasarCheckout,
  verifyMoyasarSecretKey,
  ensureMoyasarWebhook,
} from './moyasar.ts';

describe('moyasar invoices', () => {
  it('converts riyals to halalas', () => {
    assert.equal(sarToHalalas(185), 18500);
    assert.equal(sarToHalalas(1), 100);
    assert.equal(sarToHalalas(0), 0);
  });

  it('refuses to mint a link without a real Moyasar secret', async () => {
    const prev = process.env.MOYASAR_SECRET_KEY;
    const prevProvider = process.env.PAYMENT_PROVIDER_SECRET_KEY;
    delete process.env.MOYASAR_SECRET_KEY;
    delete process.env.MOYASAR_API_KEY;
    delete process.env.PAYMENT_PROVIDER_SECRET_KEY;
    try {
      assert.equal(moyasarConfigured(), false);
      const out = await createMoyasarInvoice({
        amountSar: 185,
        description: 'طلب تجربة',
        bookingId: 'BK-1',
      });
      assert.equal(out.ok, false);
      if (!out.ok) assert.match(out.error, /ميسر غير مفعّل/);
    } finally {
      if (prev === undefined) delete process.env.MOYASAR_SECRET_KEY;
      else process.env.MOYASAR_SECRET_KEY = prev;
      if (prevProvider === undefined) delete process.env.PAYMENT_PROVIDER_SECRET_KEY;
      else process.env.PAYMENT_PROVIDER_SECRET_KEY = prevProvider;
    }
  });

  it('treats PAYMENT_PROVIDER_SECRET_KEY as the Moyasar secret', () => {
    const prevSecret = process.env.MOYASAR_SECRET_KEY;
    const prevApi = process.env.MOYASAR_API_KEY;
    const prevProvider = process.env.PAYMENT_PROVIDER_SECRET_KEY;
    delete process.env.MOYASAR_SECRET_KEY;
    delete process.env.MOYASAR_API_KEY;
    process.env.PAYMENT_PROVIDER_SECRET_KEY = 'sk_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    try {
      assert.equal(moyasarConfigured(), true);
    } finally {
      if (prevSecret === undefined) delete process.env.MOYASAR_SECRET_KEY;
      else process.env.MOYASAR_SECRET_KEY = prevSecret;
      if (prevApi === undefined) delete process.env.MOYASAR_API_KEY;
      else process.env.MOYASAR_API_KEY = prevApi;
      if (prevProvider === undefined) delete process.env.PAYMENT_PROVIDER_SECRET_KEY;
      else process.env.PAYMENT_PROVIDER_SECRET_KEY = prevProvider;
    }
  });

  it('only returns checkout.moyasar.com URLs from a successful API response', async () => {
    process.env.MOYASAR_SECRET_KEY = 'sk_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    try {
      let idempotency = '';
      let callbackUrl = '';
      const fake = async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        idempotency = headers.get('Idempotency-Key') || '';
        const body = JSON.parse(String(init?.body || '{}')) as { callback_url?: string };
        callbackUrl = String(body.callback_url || '');
        return new Response(
          JSON.stringify({
            id: 'inv-1',
            status: 'initiated',
            url: 'https://checkout.moyasar.com/invoices/inv-1',
            description: 'طلب يوصل',
          }),
          { status: 201 },
        );
      };
      const out = await createMoyasarInvoice({
        amountSar: 50,
        description: 'ضيافة',
        bookingId: 'BK-9',
        fetchImpl: fake as unknown as typeof fetch,
      });
      assert.match(idempotency, /^[0-9a-f-]{36}$/i);
      assert.equal(callbackUrl, 'https://usil.app/api/payments/webhook');
      assert.equal(out.ok, true);
      if (out.ok) {
        assert.equal(out.invoice.url.startsWith('https://checkout.moyasar.com/'), true);
        assert.equal(out.invoice.url.includes('example.com'), false);
      }

      const junk = await createMoyasarInvoice({
        amountSar: 50,
        description: 'ضيافة',
        bookingId: 'BK-9',
        fetchImpl: (async () =>
          new Response(JSON.stringify({ id: 'inv-2', url: 'https://evil.example/pay' }), {
            status: 201,
          })) as unknown as typeof fetch,
      });
      assert.equal(junk.ok, false);
    } finally {
      delete process.env.MOYASAR_SECRET_KEY;
    }
  });

  it('rejects a masked Secret Key ID with asterisks', () => {
    const prev = process.env.MOYASAR_SECRET_KEY;
    process.env.MOYASAR_SECRET_KEY = 'sk_live_XXXXXXXXXXXXXX/**********************';
    try {
      assert.equal(moyasarConfigured(), false);
    } finally {
      if (prev === undefined) delete process.env.MOYASAR_SECRET_KEY;
      else process.env.MOYASAR_SECRET_KEY = prev;
    }
  });

  it('ignores publishable keys and only accepts Moyasar secret prefixes', () => {
    const prev = process.env.MOYASAR_SECRET_KEY;
    process.env.MOYASAR_SECRET_KEY = 'pk_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    try {
      assert.equal(moyasarConfigured(), false);
    } finally {
      if (prev === undefined) delete process.env.MOYASAR_SECRET_KEY;
      else process.env.MOYASAR_SECRET_KEY = prev;
    }
  });

  it('confirms paid status from Moyasar instead of trusting the client', async () => {
    process.env.MOYASAR_SECRET_KEY = 'sk_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    try {
      const junk = await fetchMoyasarInvoice('not-an-id!');
      assert.equal(junk.ok, false);

      const paid = await fetchMoyasarInvoice(
        'inv_live_abc12345',
        (async () =>
          new Response(
            JSON.stringify({
              id: 'inv_live_abc12345',
              status: 'paid',
              url: 'https://checkout.moyasar.com/invoices/inv_live_abc12345',
              amount: 5000,
              currency: 'SAR',
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
      );
      assert.equal(paid.ok, true);
      if (paid.ok) assert.equal(paid.invoice.status, 'paid');
    } finally {
      delete process.env.MOYASAR_SECRET_KEY;
    }
  });
});

describe('moyasar payments', () => {
  it('only treats pk_test_/pk_live_ as a publishable form key', () => {
    const prev = process.env.MOYASAR_PUBLISHABLE_KEY;
    process.env.MOYASAR_PUBLISHABLE_KEY = 'sk_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    try {
      assert.equal(moyasarPublishableKey(), '');
      assert.equal(moyasarFormReady(), false);
    } finally {
      if (prev === undefined) delete process.env.MOYASAR_PUBLISHABLE_KEY;
      else process.env.MOYASAR_PUBLISHABLE_KEY = prev;
    }
  });

  it('fetches GET /v1/payments/:id and ignores a fake paid flag from the client', async () => {
    process.env.MOYASAR_SECRET_KEY = 'sk_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    try {
      let requested = '';
      const paid = await fetchMoyasarPayment(
        '79cced57-9deb-4c4b-8f48-59c124f79688',
        (async (url) => {
          requested = String(url);
          return new Response(
            JSON.stringify({
              id: '79cced57-9deb-4c4b-8f48-59c124f79688',
              status: 'paid',
              amount: 18500,
              currency: 'SAR',
              metadata: { bookingId: 'BK-9' },
              source: { type: 'creditcard', transaction_url: '' },
            }),
            { status: 200 },
          );
        }) as unknown as typeof fetch,
      );
      assert.match(requested, /\/v1\/payments\/79cced57-9deb-4c4b-8f48-59c124f79688/);
      assert.equal(paid.ok, true);
      if (paid.ok) {
        assert.equal(paid.payment.status, 'paid');
        assert.equal(paid.payment.bookingId, 'BK-9');
      }

      const junkUrl = await fetchMoyasarPayment(
        '79cced57-9deb-4c4b-8f48-59c124f79688',
        (async () =>
          new Response(
            JSON.stringify({
              id: '79cced57-9deb-4c4b-8f48-59c124f79688',
              status: 'initiated',
              source: { transaction_url: 'https://evil.example/3ds' },
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
      );
      assert.equal(junkUrl.ok, false);
    } finally {
      delete process.env.MOYASAR_SECRET_KEY;
    }
  });

  it('verifies a payment id before falling back to invoices', async () => {
    process.env.MOYASAR_SECRET_KEY = 'sk_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    try {
      const paths: string[] = [];
      const out = await verifyMoyasarCheckout(
        '79cced57-9deb-4c4b-8f48-59c124f79688',
        (async (url) => {
          paths.push(String(url));
          if (String(url).includes('/payments/')) {
            return new Response(JSON.stringify({ message: 'Not found' }), { status: 404 });
          }
          return new Response(
            JSON.stringify({
              id: '79cced57-9deb-4c4b-8f48-59c124f79688',
              status: 'paid',
              url: 'https://checkout.moyasar.com/invoices/79cced57-9deb-4c4b-8f48-59c124f79688',
            }),
            { status: 200 },
          );
        }) as unknown as typeof fetch,
      );
      assert.equal(paths.some((row) => row.includes('/v1/payments/')), true);
      assert.equal(out.ok, true);
      if (out.ok) assert.equal(out.kind, 'invoice');
    } finally {
      delete process.env.MOYASAR_SECRET_KEY;
    }
  });
});

describe('moyasar hosted invoice + webhook', () => {
  it('createInvoice throws without a secret key', async () => {
    const prev = process.env.MOYASAR_SECRET_KEY;
    const prevProvider = process.env.PAYMENT_PROVIDER_SECRET_KEY;
    delete process.env.MOYASAR_SECRET_KEY;
    delete process.env.MOYASAR_API_KEY;
    delete process.env.PAYMENT_PROVIDER_SECRET_KEY;
    try {
      await assert.rejects(
        () =>
          createInvoice({
            amountSar: 100,
            description: 'تجربة',
            successUrl: 'https://usil.app/payment/success',
            backUrl: 'https://usil.app/payment/cancelled',
            callbackUrl: 'https://usil.app/api/payments/webhook',
          }),
        (error: unknown) => error instanceof MoyasarError && error.code === 'not_configured' && /ميسر غير مفعّل/.test(error.message),
      );
    } finally {
      if (prev === undefined) delete process.env.MOYASAR_SECRET_KEY;
      else process.env.MOYASAR_SECRET_KEY = prev;
      if (prevProvider === undefined) delete process.env.PAYMENT_PROVIDER_SECRET_KEY;
      else process.env.PAYMENT_PROVIDER_SECRET_KEY = prevProvider;
    }
  });

  it('rejects a webhook with the wrong secret_token', () => {
    const prev = process.env.MOYASAR_WEBHOOK_SECRET;
    process.env.MOYASAR_WEBHOOK_SECRET = 'usil-webhook-test';
    try {
      assert.equal(moyasarWebhookAuthorized('wrong'), false);
      assert.equal(moyasarWebhookAuthorized('usil-webhook-test'), true);
    } finally {
      if (prev === undefined) delete process.env.MOYASAR_WEBHOOK_SECRET;
      else process.env.MOYASAR_WEBHOOK_SECRET = prev;
    }
  });

  it('uses grey-cloud hooks.usil.app when MOYASAR_WEBHOOK_URL is set', () => {
    const prevUrl = process.env.MOYASAR_WEBHOOK_URL;
    const prevSite = process.env.PUBLIC_SITE_URL;
    process.env.PUBLIC_SITE_URL = 'https://usil.app';
    try {
      delete process.env.MOYASAR_WEBHOOK_URL;
      assert.equal(moyasarWebhookUrl(), 'https://usil.app/api/payments/webhook');

      process.env.MOYASAR_WEBHOOK_URL = 'https://hooks.usil.app/api/payments/webhook';
      assert.equal(moyasarWebhookUrl(), 'https://hooks.usil.app/api/payments/webhook');

      process.env.MOYASAR_WEBHOOK_URL = 'https://hooks.usil.app';
      assert.equal(moyasarWebhookUrl(), 'https://hooks.usil.app/api/payments/webhook');

      process.env.MOYASAR_WEBHOOK_URL = 'https://evil.example/steal';
      assert.equal(moyasarWebhookUrl(), 'https://usil.app/api/payments/webhook');
    } finally {
      if (prevUrl === undefined) delete process.env.MOYASAR_WEBHOOK_URL;
      else process.env.MOYASAR_WEBHOOK_URL = prevUrl;
      if (prevSite === undefined) delete process.env.PUBLIC_SITE_URL;
      else process.env.PUBLIC_SITE_URL = prevSite;
    }
  });

  it('rejects a starred secret before calling Moyasar', async () => {
    const out = await verifyMoyasarSecretKey('sk_live_************************');
    assert.equal(out.ok, false);
  });

  it('registers a webhook when none exists', async () => {
    process.env.MOYASAR_SECRET_KEY = 'sk_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    process.env.MOYASAR_WEBHOOK_SECRET = 'shared-secret-value';
    process.env.MOYASAR_WEBHOOK_URL = 'https://hooks.usil.app/api/payments/webhook';
    try {
      const fake = async (_url: string | URL | Request, init?: RequestInit) => {
        if ((init?.method || 'GET') === 'POST') {
          return new Response(JSON.stringify({ id: 'wh-1' }), { status: 201 });
        }
        return new Response(JSON.stringify({ webhooks: [] }), { status: 200 });
      };
      const out = await ensureMoyasarWebhook(fake as typeof fetch);
      assert.equal(out.ok, true);
      if (out.ok) assert.equal(out.status, 'created');
    } finally {
      delete process.env.MOYASAR_SECRET_KEY;
      delete process.env.MOYASAR_WEBHOOK_SECRET;
      delete process.env.MOYASAR_WEBHOOK_URL;
    }
  });
});

describe('moyasar failure codes', () => {
  const ID = '79cced57-9deb-4c4b-8f48-59c124f79688';
  const answer = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('tells a missing payment apart from a provider fault, without Moyasar\'s raw text', async () => {
    process.env.MOYASAR_SECRET_KEY = 'sk_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    try {
      const missing = await fetchMoyasarPayment(ID, answer(404, { message: 'Object not found' }));
      assert.equal(missing.ok, false);
      if (!missing.ok) assert.equal(missing.code, 'not_found');

      const broken = await fetchMoyasarPayment(ID, answer(500, { message: 'internal stack trace' }));
      assert.equal(broken.ok, false);
      if (!broken.ok) {
        assert.equal(broken.code, 'upstream');
        assert.doesNotMatch(broken.error, /stack trace/);
      }

      const neither = await verifyMoyasarCheckout(ID, answer(404, { message: 'Not found' }));
      assert.equal(neither.ok, false);
      if (!neither.ok) assert.equal(neither.code, 'not_found');
    } finally {
      delete process.env.MOYASAR_SECRET_KEY;
    }
  });

  it('reports a missing key as not_configured', async () => {
    const prev = process.env.MOYASAR_SECRET_KEY;
    delete process.env.MOYASAR_SECRET_KEY;
    delete process.env.MOYASAR_API_KEY;
    delete process.env.PAYMENT_PROVIDER_SECRET_KEY;
    try {
      const out = await verifyMoyasarCheckout(ID);
      assert.equal(out.ok, false);
      if (!out.ok) assert.equal(out.code, 'not_configured');
      const invoice = await createMoyasarInvoice({ amountSar: 10, description: 'x', bookingId: 'BK-1' });
      assert.equal(invoice.ok, false);
      if (!invoice.ok) assert.equal(invoice.code, 'not_configured');
    } finally {
      if (prev !== undefined) process.env.MOYASAR_SECRET_KEY = prev;
    }
  });
});
