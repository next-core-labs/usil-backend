/**
 * Register (or update) the Kapso webhook that delivers inbound WhatsApp events
 * to this backend. Run once the backend is reachable at a public HTTPS URL.
 *
 *   WHATSAPP_WEBHOOK_URL=https://hooks.usil.app tsx scripts/kapso-register-webhook.ts
 *
 * Reads KAPSO_API_KEY, KAPSO_WEBHOOK_SECRET and WHATSAPP_PHONE_NUMBER_ID from the
 * environment (.env). Registers a `kind: meta` webhook so Kapso forwards the raw
 * Meta-format payload our existing parser already understands.
 */
import 'dotenv/config';
import { whatsappWebhookUrl } from '../server/whatsapp/whatsapp-settings';

const API_BASE = (process.env.KAPSO_API_BASE || 'https://api.kapso.ai').replace(/\/+$/, '');
const apiKey = String(process.env.KAPSO_API_KEY || '').trim();
const secret = String(process.env.KAPSO_WEBHOOK_SECRET || '').trim();
const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
const deliverTo = whatsappWebhookUrl();

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (!apiKey) fail('KAPSO_API_KEY is not set.');
if (!secret) fail('KAPSO_WEBHOOK_SECRET is not set.');
if (!phoneNumberId) fail('WHATSAPP_PHONE_NUMBER_ID is not set.');
if (!/^https:\/\//i.test(deliverTo)) {
  fail(`Webhook URL must be public HTTPS, got "${deliverTo}". Set WHATSAPP_WEBHOOK_URL.`);
}

const endpoint = `${API_BASE}/platform/v1/whatsapp/phone_numbers/${phoneNumberId}/webhooks`;

async function main() {
  // Skip if one already points at this exact URL.
  const existing = await fetch(endpoint, { headers: { 'X-API-Key': apiKey } });
  if (existing.ok) {
    const body = (await existing.json().catch(() => null)) as { data?: Array<{ url?: string }> } | null;
    if (body?.data?.some((row) => row?.url === deliverTo)) {
      console.log(`✓ Webhook already registered for ${deliverTo}`);
      return;
    }
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      whatsapp_webhook: { url: deliverTo, secret_key: secret, kind: 'meta' },
    }),
  });
  const text = await res.text();
  if (!res.ok) fail(`Kapso returned HTTP ${res.status}: ${text}`);
  console.log(`✓ Webhook registered → ${deliverTo}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
