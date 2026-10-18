import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createWhatsAppStore, displayPhone, MESSAGES_KEPT, normalizeWhatsAppPhone } from './whatsapp-store.ts';
import { captureWhatsAppRawBody, parseWhatsAppWebhook, verifyWhatsAppSignature } from './whatsapp-webhook.ts';
import { fillTemplateBody, templatePlaceholders } from './whatsapp-graph.ts';
import { maskToken, sanitizeSecret } from './whatsapp-settings.ts';

const WA = '966501234567';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-whatsapp-store-'));
}

function inbound(wamid: string, at: string, text = 'hi') {
  return {
    kind: 'inbound' as const,
    waId: WA,
    profileName: 'نواف',
    message: {
      wamid,
      type: 'text',
      text,
      caption: '',
      mediaId: '',
      mimeType: '',
      fileName: '',
      location: null,
      reactionTo: null,
      at,
    },
  };
}

describe('normalizeWhatsAppPhone', () => {
  it('maps Saudi local and international forms to 9665XXXXXXXX', () => {
    for (const raw of ['0501234567', '501234567', '+966501234567', '00966501234567', '966501234567', '+966 050 123 4567', '٠٥٠١٢٣٤٥٦٧']) {
      assert.equal(normalizeWhatsAppPhone(raw), WA, raw);
    }
  });

  it('accepts other international numbers at 10–15 digits', () => {
    assert.equal(normalizeWhatsAppPhone('+44 7700 900123'), '447700900123');
    assert.equal(normalizeWhatsAppPhone('0097150123456'), '97150123456');
    assert.equal(normalizeWhatsAppPhone('201001234567'), '201001234567');
  });

  it('refuses everything else', () => {
    for (const raw of ['', '12345', '0401234567', '96650123', '9665012345678', '+1 (555) abc', '0123456789', null, undefined, {}]) {
      assert.equal(normalizeWhatsAppPhone(raw as never), null, String(raw));
    }
  });

  it('displays Saudi numbers locally', () => {
    assert.equal(displayPhone(WA), '0501234567');
    assert.equal(displayPhone('447700900123'), '+447700900123');
  });
});

describe('webhook helpers', () => {
  it('verifies X-Hub-Signature-256 over the raw bytes', () => {
    const raw = Buffer.from('{"a": 1}');
    const good = `sha256=${crypto.createHmac('sha256', 's3cret').update(raw).digest('hex')}`;
    assert.equal(verifyWhatsAppSignature('s3cret', raw, good), true);
    assert.equal(verifyWhatsAppSignature('s3cret', Buffer.from('{"a":1}'), good), false);
    assert.equal(verifyWhatsAppSignature('other', raw, good), false);
    assert.equal(verifyWhatsAppSignature('s3cret', raw, undefined), false);
    assert.equal(verifyWhatsAppSignature('s3cret', raw, 'sha1=abc'), false);
    assert.equal(verifyWhatsAppSignature('', raw, good), false);
  });

  it('keeps the raw body only for the webhook path', () => {
    const hook = { url: '/api/whatsapp/webhook' } as never as { rawBody?: Buffer };
    const other = { url: '/api/auth/login' } as never as { rawBody?: Buffer };
    captureWhatsAppRawBody(hook as never, null, Buffer.from('x'));
    captureWhatsAppRawBody(other as never, null, Buffer.from('y'));
    assert.equal(hook.rawBody?.toString(), 'x');
    assert.equal(other.rawBody, undefined);
  });

  it('parses statuses with failure details and skips unknown fields', () => {
    const events = parseWhatsAppWebhook(
      {
        entry: [
          {
            changes: [
              { field: 'account_update', value: { messages: [{ id: 'x', from: WA, type: 'text' }] } },
              {
                field: 'messages',
                value: {
                  statuses: [
                    { id: 'wamid.1', status: 'delivered', recipient_id: WA },
                    {
                      id: 'wamid.2',
                      status: 'failed',
                      recipient_id: WA,
                      errors: [{ title: 'Re-engagement message', error_data: { details: 'More than 24 hours' } }],
                    },
                    { id: 'wamid.3', status: 'deleted', recipient_id: WA },
                  ],
                },
              },
            ],
          },
        ],
      },
      { now: new Date() },
    );
    assert.deepEqual(events, [
      { kind: 'status', waId: WA, wamid: 'wamid.1', status: 'delivered', error: null },
      { kind: 'status', waId: WA, wamid: 'wamid.2', status: 'failed', error: 'Re-engagement message — More than 24 hours' },
    ]);
  });
});

describe('template text', () => {
  it('counts distinct placeholders and fills them', () => {
    assert.deepEqual(templatePlaceholders('{{1}} و {{2}} ثم {{1}}'), ['1', '2']);
    assert.equal(fillTemplateBody('مرحباً {{1}}، طلبك {{2}}', ['نواف', 'BK-1']), 'مرحباً نواف، طلبك BK-1');
    assert.equal(fillTemplateBody('Hi {{first_name}}, code {{code}}', ['Sara', '42']), 'Hi Sara, code 42');
    assert.equal(fillTemplateBody('Hi {{1}} {{2}}', ['Sara']), 'Hi Sara {{2}}');
  });
});

describe('settings helpers', () => {
  it('masks tokens and treats pasted masks as blank', () => {
    assert.equal(maskToken('EAAGabcdefghijklmnopx9Q4'), 'EAAG…x9Q4');
    assert.equal(maskToken('short'), '••••');
    assert.equal(maskToken(''), '');
    assert.equal(sanitizeSecret('EAAG…x9Q4'), '');
    assert.equal(sanitizeSecret('  EAAGabc  '), 'EAAGabc');
  });
});

describe('createWhatsAppStore', () => {
  it('keeps only the newest messages per conversation', () => {
    const dir = tmpDir();
    const store = createWhatsAppStore(dir, () => new Date('2026-10-19T10:00:00Z'));
    const rows = Array.from({ length: MESSAGES_KEPT + 5 }, (_, i) => ({
      id: `wam-${i}`,
      wamid: `wamid.${i}`,
      direction: 'in',
      type: 'text',
      text: String(i),
      at: new Date(Date.parse('2026-10-01T00:00:00Z') + i * 1000).toISOString(),
    }));
    fs.mkdirSync(path.join(dir, 'whatsapp', 'messages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'whatsapp', 'messages', `${WA}.json`), JSON.stringify(rows));
    store.apply(inbound('wamid.new', '2026-10-19T09:59:00.000Z'));
    const kept = store.messages(WA);
    assert.equal(kept.length, MESSAGES_KEPT);
    assert.equal(kept[0].wamid, 'wamid.6');
    assert.equal(kept.at(-1)?.wamid, 'wamid.new');
  });

  it('keeps messages in time order when a webhook arrives late', () => {
    const store = createWhatsAppStore(tmpDir(), () => new Date('2026-10-19T10:00:00Z'));
    store.apply(inbound('wamid.b', '2026-10-19T09:50:00.000Z', 'second'));
    store.apply(inbound('wamid.a', '2026-10-19T09:40:00.000Z', 'first'));
    assert.deepEqual(store.messages(WA).map((m) => m.text), ['first', 'second']);
    const chat = store.get(WA);
    assert.equal(chat?.lastMessage?.text, 'second');
    assert.equal(chat?.lastInboundAt, '2026-10-19T09:50:00.000Z');
  });

  it('applies a status that arrived before its send was stored', () => {
    const store = createWhatsAppStore(tmpDir(), () => new Date('2026-10-19T10:00:00Z'));
    store.apply(inbound('wamid.in', '2026-10-19T09:59:00.000Z'));
    assert.equal(store.apply({ kind: 'status', waId: WA, wamid: 'wamid.early', status: 'delivered', error: null }), false);
    const message = store.addOutbound(WA, { wamid: 'wamid.early', type: 'text', text: 'x', sentBy: null });
    assert.equal(message.status, 'delivered');
  });

  it('indexes media ids so only stored media can be proxied', () => {
    const store = createWhatsAppStore(tmpDir(), () => new Date('2026-10-19T10:00:00Z'));
    const event = inbound('wamid.img', '2026-10-19T09:59:00.000Z');
    event.message = { ...event.message, type: 'image', mediaId: '123456', text: '' };
    store.apply(event);
    assert.equal(store.hasMedia('123456'), true);
    assert.equal(store.hasMedia('999999'), false);
  });
});
