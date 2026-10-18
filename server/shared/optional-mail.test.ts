import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasMailConfig,
  notifyBookingRejected,
  notifyVendorApplicationDecision,
  notifyVendorNewOrder,
  vendorConsoleOrdersUrl,
  sendPasswordResetEmail,
  sendVerificationEmail,
  setMailFetchForTests,
} from './optional-mail.ts';

const MAIL_VARS = ['RESEND_API_KEY', 'MAIL_FROM', 'SMTP_FROM', 'SMTP_HOST', 'MAIL_HOST', 'SMTP_URL', 'MAIL_URL', 'SMTP_SERVER'];

type Sent = { url: string; auth: string; body: { from: string; to: string[]; subject: string; text: string; html: string } };

function recorder(status = 200) {
  const sent: Sent[] = [];
  setMailFetchForTests(async (url, init) => {
    sent.push({
      url,
      auth: String((init.headers as Record<string, string>).Authorization),
      body: JSON.parse(String(init.body)),
    });
    return { ok: status < 300, status, text: async () => '{"message":"The usil.app domain is not verified"}' };
  });
  return sent;
}

describe('optional mail over Resend', () => {
  const saved = new Map<string, string | undefined>();
  const quiet = console.warn;
  let warnings: string[] = [];

  beforeEach(() => {
    for (const key of MAIL_VARS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    warnings = [];
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setMailFetchForTests(null);
    console.warn = quiet;
  });

  it('counts a Resend key as mail config', () => {
    assert.equal(hasMailConfig(), false);
    process.env.RESEND_API_KEY = 're_test';
    assert.equal(hasMailConfig(), true);
  });

  it('sends the verification code with text and RTL html bodies', async () => {
    process.env.RESEND_API_KEY = 're_test';
    const sent = recorder();
    assert.equal(await sendVerificationEmail('Client@Usil.sa', '123456', 'tok123'), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://api.resend.com/emails');
    assert.equal(sent[0].auth, 'Bearer re_test');
    assert.deepEqual(sent[0].body.to, ['client@usil.sa']);
    assert.equal(sent[0].body.from, 'يوصل <noreply@usil.app>');
    assert.match(sent[0].body.text, /123456/);
    assert.match(sent[0].body.text, /verify-email\?token=tok123/);
    assert.match(sent[0].body.html, /dir="rtl"/);
    assert.match(sent[0].body.html, />123456</);
  });

  it('uses MAIL_FROM and reports a refused send as false without logging the code', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.MAIL_FROM = 'Usil <codes@mail.usil.app>';
    const sent = recorder(403);
    assert.equal(await sendPasswordResetEmail('client@usil.sa', '654321'), false);
    assert.equal(sent[0].body.from, 'Usil <codes@mail.usil.app>');
    assert.ok(warnings.some((line) => /403/.test(line)));
    assert.equal(warnings.some((line) => line.includes('654321')), false);
  });

  it('sends nothing without config, to a bad address, or with a bad code', async () => {
    const sent = recorder();
    assert.equal(await sendVerificationEmail('client@usil.sa', '123456'), false);
    process.env.RESEND_API_KEY = 're_test';
    assert.equal(await sendVerificationEmail('not-an-email', '123456'), false);
    assert.equal(await sendPasswordResetEmail('client@usil.sa', '12ab'), false);
    assert.equal(sent.length, 0);
  });

  it('tells a vendor their application was approved or rejected', async () => {
    process.env.RESEND_API_KEY = 're_test';
    const sent = recorder();
    notifyVendorApplicationDecision('shop@usil.sa', 'متجر القهوة', 'approved');
    notifyVendorApplicationDecision('shop@usil.sa', 'متجر القهوة', 'rejected', 'الصور غير واضحة');
    await new Promise((done) => setImmediate(done));
    assert.equal(sent.length, 2);
    assert.match(sent[0].body.subject, /اعتماد/);
    assert.match(sent[0].body.text, /متجر القهوة/);
    assert.match(sent[1].body.text, /الصور غير واضحة/);
  });

  it('tells a client their order was rejected, and a vendor about new orders', async () => {
    process.env.RESEND_API_KEY = 're_test';
    const sent = recorder();
    notifyBookingRejected('client@usil.sa', 'BK-123456', 'ركن قهوة');
    notifyVendorNewOrder('shop@usil.sa', 'BK-123456', 'ركن قهوة', true);
    notifyVendorNewOrder('shop@usil.sa', 'BK-654321', 'خيمة', false);
    await new Promise((done) => setImmediate(done));
    assert.equal(sent.length, 3);
    assert.deepEqual(sent[0].body.to, ['client@usil.sa']);
    assert.match(sent[0].body.text, /BK-123456/);
    assert.match(sent[0].body.text, /\/orders/);
    assert.match(sent[1].body.subject, /موافقتك/);
    assert.match(sent[2].body.subject, /مدفوع/);
    assert.match(sent[2].body.text, /BK-654321/);
    // A vendor goes to the console's orders page, never the store.
    assert.match(sent[1].body.text, /\/#\/orders/);
    assert.match(sent[2].body.text, /\/#\/orders/);
  });

  it('links vendors to the console orders page: configured, local or live', () => {
    const saved = { console: process.env.VENDOR_CONSOLE_URL, site: process.env.PUBLIC_SITE_URL };
    try {
      process.env.VENDOR_CONSOLE_URL = 'https://vendor.usil.app/';
      assert.equal(vendorConsoleOrdersUrl(), 'https://vendor.usil.app/#/orders');
      delete process.env.VENDOR_CONSOLE_URL;
      process.env.PUBLIC_SITE_URL = 'http://localhost:3000';
      assert.equal(vendorConsoleOrdersUrl(), 'http://127.0.0.1:5190/#/orders');
      process.env.PUBLIC_SITE_URL = 'https://usil.app';
      assert.equal(vendorConsoleOrdersUrl(), 'https://vendor.usil.app/#/orders');
    } finally {
      if (saved.console === undefined) delete process.env.VENDOR_CONSOLE_URL;
      else process.env.VENDOR_CONSOLE_URL = saved.console;
      if (saved.site === undefined) delete process.env.PUBLIC_SITE_URL;
      else process.env.PUBLIC_SITE_URL = saved.site;
    }
  });

  it('booking notices are a no-op without mail config', async () => {
    const sent = recorder();
    notifyBookingRejected('client@usil.sa', 'BK-1', 'x');
    notifyVendorNewOrder('shop@usil.sa', 'BK-1', 'x', true);
    await new Promise((done) => setImmediate(done));
    assert.equal(sent.length, 0);
  });
});
