import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fcmPayload, parseServiceAccount, sendFcm, setPushFetchForTests } from './fcm.ts';
import { createPushStore, parsePushRegistration } from './push-store.ts';
import { configurePush, deliverPush } from './push.ts';
import { webPushConfig } from './push-routes.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-push-'));
}

const TOKEN_A = 'fcm-token-aaaaaaaaaaaaaaaaaaaaaaaa:APA91b';
const TOKEN_B = 'fcm-token-bbbbbbbbbbbbbbbbbbbbbbbb:APA91b';

function serviceAccount() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    account: {
      project_id: 'usil-test',
      client_email: 'push@usil-test.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    },
    publicKey,
  };
}

type Call = { url: string; init: RequestInit };

function fakeGoogle(sendStatus: (token: string) => { status: number; body?: string }) {
  const calls: Call[] = [];
  setPushFetchForTests(async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith('https://oauth2.googleapis.com/')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }) };
    }
    const token = JSON.parse(String(init.body)).message.token as string;
    const { status, body = '{}' } = sendStatus(token);
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  });
  return calls;
}

afterEach(() => {
  setPushFetchForTests(null);
  delete process.env.FCM_SERVICE_ACCOUNT;
});

describe('push registration input', () => {
  it('accepts a token from a known app and platform', () => {
    assert.deepEqual(parsePushRegistration({ token: TOKEN_A, platform: 'ios', app: 'store' }), {
      token: TOKEN_A,
      platform: 'ios',
      app: 'store',
    });
  });

  it('rejects junk tokens, platforms and apps', () => {
    assert.equal(parsePushRegistration({ token: 'short', platform: 'ios', app: 'store' }), null);
    assert.equal(parsePushRegistration({ token: `${TOKEN_A} <script>`, platform: 'ios', app: 'store' }), null);
    assert.equal(parsePushRegistration({ token: TOKEN_A, platform: 'windows', app: 'store' }), null);
    assert.equal(parsePushRegistration({ token: TOKEN_A, platform: 'web', app: 'admin' }), null);
    assert.equal(parsePushRegistration(null), null);
  });
});

describe('push store', () => {
  it('moves a token to whoever signed in on the device last', () => {
    const store = createPushStore(tmpDir());
    store.register('u-1', { token: TOKEN_A, platform: 'android', app: 'store' });
    store.register('u-2', { token: TOKEN_A, platform: 'android', app: 'store' });
    assert.deepEqual(store.forUsers(['u-1']), []);
    assert.equal(store.forUsers(['u-2']).length, 1);
  });

  it('lets only the owning account unregister a token', () => {
    const store = createPushStore(tmpDir());
    store.register('u-1', { token: TOKEN_A, platform: 'web', app: 'vendor' });
    assert.equal(store.unregister('u-2', TOKEN_A), false);
    assert.equal(store.unregister('u-1', TOKEN_A), true);
    assert.deepEqual(store.list(), []);
  });

  it('keeps the ten most recent devices per account', () => {
    let tick = 0;
    const store = createPushStore(tmpDir(), () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
    for (let n = 0; n < 12; n += 1) {
      store.register('u-1', { token: `${TOKEN_A}${n}`, platform: 'web', app: 'owner' });
    }
    const tokens = store.forUsers(['u-1']).map((row) => row.token);
    assert.equal(tokens.length, 10);
    assert.ok(!tokens.includes(`${TOKEN_A}0`) && !tokens.includes(`${TOKEN_A}1`));
  });

  it('persists to disk', () => {
    const dir = tmpDir();
    createPushStore(dir).register('u-1', { token: TOKEN_A, platform: 'ios', app: 'store' });
    assert.equal(createPushStore(dir).forUsers(['u-1'])[0]?.platform, 'ios');
  });
});

describe('FCM messages', () => {
  it('reads the service account raw, base64, or with escaped newlines', () => {
    const { account } = serviceAccount();
    const raw = JSON.stringify(account);
    assert.equal(parseServiceAccount(raw)?.project_id, 'usil-test');
    assert.equal(parseServiceAccount(Buffer.from(raw).toString('base64'))?.client_email, account.client_email);
    const escaped = JSON.stringify({ ...account, private_key: account.private_key.replace(/\n/g, '\\n') });
    assert.ok(parseServiceAccount(escaped)?.private_key.includes('\n'));
    assert.equal(parseServiceAccount(''), null);
    assert.equal(parseServiceAccount('{"project_id":"x"}'), null);
  });

  it('lets the phone draw native notifications and the console worker draw web ones', () => {
    const native = fcmPayload({ token: TOKEN_A, platform: 'android', title: 'T', body: 'B', link: '/orders' });
    assert.deepEqual(native.notification, { title: 'T', body: 'B' });
    assert.deepEqual(native.data, { link: '/orders' });
    const web = fcmPayload({ token: TOKEN_A, platform: 'web', title: 'T', body: 'B', link: '/#/payouts' });
    assert.equal(web.notification, undefined);
    assert.deepEqual(web.data, { title: 'T', body: 'B', link: '/#/payouts' });
  });

  it('signs a JWT Google can verify and reuses the access token', async () => {
    const { account, publicKey } = serviceAccount();
    const calls = fakeGoogle(() => ({ status: 200 }));
    assert.equal(await sendFcm(account, { token: TOKEN_A, platform: 'ios', title: 'T', body: 'B' }), 'sent');
    assert.equal(await sendFcm(account, { token: TOKEN_B, platform: 'ios', title: 'T', body: 'B' }), 'sent');

    const exchanges = calls.filter((call) => call.url.startsWith('https://oauth2.googleapis.com/'));
    assert.equal(exchanges.length, 1);
    const assertion = new URLSearchParams(String(exchanges[0].init.body)).get('assertion') || '';
    const [header, claims, signature] = assertion.split('.');
    const valid = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${claims}`),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
    assert.ok(valid, 'JWT signature verifies with the service account key');
    const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString());
    assert.equal(decoded.iss, account.client_email);
    assert.equal(decoded.scope, 'https://www.googleapis.com/auth/firebase.messaging');

    const send = calls.find((call) => call.url.includes('/messages:send'));
    assert.equal(send?.url, 'https://fcm.googleapis.com/v1/projects/usil-test/messages:send');
    assert.equal((send?.init.headers as Record<string, string>).Authorization, 'Bearer ya29.test');
  });

  it('reports dead tokens apart from passing failures', async () => {
    const { account } = serviceAccount();
    fakeGoogle((token) =>
      token === TOKEN_A
        ? { status: 404, body: '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}' }
        : { status: 503, body: '{"error":{"status":"UNAVAILABLE"}}' },
    );
    assert.equal(await sendFcm(account, { token: TOKEN_A, platform: 'web', title: 'T', body: 'B' }), 'unregistered');
    assert.equal(await sendFcm(account, { token: TOKEN_B, platform: 'web', title: 'T', body: 'B' }), 'failed');
  });
});

describe('push delivery', () => {
  it('reaches only the apps a notice targets and forgets dead tokens', async () => {
    const { account } = serviceAccount();
    process.env.FCM_SERVICE_ACCOUNT = JSON.stringify(account);
    const dir = tmpDir();
    const store = configurePush(dir, { userIdForEmail: () => null, staffUserIds: () => [] });
    store.register('vendor-1', { token: TOKEN_A, platform: 'web', app: 'vendor' });
    store.register('vendor-1', { token: TOKEN_B, platform: 'web', app: 'owner' });
    const calls = fakeGoogle(() => ({ status: 404, body: '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}' }));

    await deliverPush(['vendor-1'], { title: 'طلب جديد', body: 'B-1', links: { vendor: '/#/orders' } });

    const sent = calls.filter((call) => call.url.includes('/messages:send')).map((call) => JSON.parse(String(call.init.body)).message);
    assert.deepEqual(sent.map((message) => message.token), [TOKEN_A]);
    assert.equal(sent[0].data.link, '/#/orders');
    assert.deepEqual(store.list().map((row) => row.token), [TOKEN_B]);
  });

  it('does nothing without a service account', async () => {
    const store = configurePush(tmpDir(), { userIdForEmail: () => null, staffUserIds: () => [] });
    store.register('u-1', { token: TOKEN_A, platform: 'ios', app: 'store' });
    const calls = fakeGoogle(() => ({ status: 200 }));
    await deliverPush(['u-1'], { title: 'T', body: 'B', links: { store: '/orders' } });
    assert.equal(calls.length, 0);
  });
});

describe('web push config', () => {
  it('needs the Firebase web app and the VAPID key together', () => {
    const firebase = JSON.stringify({ apiKey: 'k', authDomain: 'd', projectId: 'p', messagingSenderId: '1', appId: 'a' });
    assert.equal(webPushConfig({ FIREBASE_WEB_CONFIG: firebase } as NodeJS.ProcessEnv), null);
    assert.equal(webPushConfig({ FIREBASE_VAPID_KEY: 'v' } as NodeJS.ProcessEnv), null);
    assert.deepEqual(webPushConfig({ FIREBASE_WEB_CONFIG: firebase, FIREBASE_VAPID_KEY: 'v' } as NodeJS.ProcessEnv), {
      firebase: { apiKey: 'k', authDomain: 'd', projectId: 'p', messagingSenderId: '1', appId: 'a' },
      vapidKey: 'v',
    });
  });
});
