/**
 * Firebase Cloud Messaging over the HTTP v1 API.
 *
 * firebase-admin does not run inside the Cloudflare Durable Object, so the
 * OAuth token is minted here: a service-account JWT signed with WebCrypto,
 * which Node and Workers both have, exchanged at Google's token endpoint.
 *
 * FCM_SERVICE_ACCOUNT holds the service-account JSON from Firebase console →
 * Project settings → Service accounts — raw, or base64 if the host mangles
 * newlines. Without it every send is a quiet no-op, like mail without a key.
 */

export type ServiceAccount = { project_id: string; client_email: string; private_key: string };

/** Where the token lives decides the message shape and which link opens. */
export type PushPlatform = 'android' | 'ios' | 'web';

export type FcmMessage = {
  token: string;
  platform: PushPlatform;
  title: string;
  body: string;
  /** Path inside the receiving app (`/orders`, `/#/payouts`); opened on tap. */
  link?: string;
};

/** `unregistered`: the token is dead for good and should be forgotten. */
export type FcmResult = 'sent' | 'unregistered' | 'failed';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const SEND_TIMEOUT_MS = 8000;
/** Android channel the app creates on start; FCM falls back to «Miscellaneous» without it. */
export const ANDROID_CHANNEL_ID = 'usil-updates';

type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Tests swap the HTTP call; production uses global fetch. */
let fetchImpl: FetchLike = (url, init) => fetch(url, init);
export function setPushFetchForTests(next: FetchLike | null): void {
  fetchImpl = next || ((url, init) => fetch(url, init));
  cachedToken = null;
}

export function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
  const text = String(raw || '').trim();
  if (!text) return null;
  for (const candidate of [text, safeBase64Decode(text)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as Partial<ServiceAccount>;
      if (parsed.project_id && parsed.client_email && parsed.private_key) {
        return {
          project_id: parsed.project_id,
          client_email: parsed.client_email,
          // Env editors often keep the JSON's `\n` escapes literally.
          private_key: parsed.private_key.replace(/\\n/g, '\n'),
        };
      }
    } catch {
      /* try the next reading */
    }
  }
  return null;
}

function safeBase64Decode(text: string): string {
  try {
    return Buffer.from(text, 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

export function fcmServiceAccount(): ServiceAccount | null {
  return parseServiceAccount(process.env.FCM_SERVICE_ACCOUNT);
}

function base64Url(bytes: ArrayBuffer | Uint8Array | string): string {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : Buffer.from(bytes as ArrayBuffer);
  return buffer.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function signJwt(account: ServiceAccount, nowSeconds: number): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const pem = account.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey(
    'pkcs8',
    Buffer.from(pem, 'base64'),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, Buffer.from(`${header}.${claims}`, 'utf-8'));
  return `${header}.${claims}.${base64Url(signature)}`;
}

/** Google's tokens live an hour; one is reused until a minute before it lapses. */
let cachedToken: { value: string; account: string; expiresAt: number } | null = null;

async function accessToken(account: ServiceAccount): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.account === account.client_email && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.value;
  }
  const assertion = await signJwt(account, Math.floor(now / 1000));
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`,
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`FCM token exchange failed (${response.status}): ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!parsed.access_token) throw new Error('FCM token exchange returned no access_token');
  cachedToken = {
    value: parsed.access_token,
    account: account.client_email,
    expiresAt: now + Number(parsed.expires_in || 3600) * 1000,
  };
  return parsed.access_token;
}

/**
 * The phone shows `notification` itself, in the background or not. The
 * consoles get data only, and their service worker draws the notification,
 * so it looks the same whether or not the tab is open.
 */
export function fcmPayload(message: FcmMessage): Record<string, unknown> {
  const link = message.link || '';
  if (message.platform === 'web') {
    return {
      token: message.token,
      data: { title: message.title, body: message.body, link },
      webpush: { headers: { Urgency: 'high', TTL: '86400' } },
    };
  }
  return {
    token: message.token,
    notification: { title: message.title, body: message.body },
    data: { link },
    android: { priority: 'HIGH', notification: { channel_id: ANDROID_CHANNEL_ID, sound: 'default' } },
    apns: { payload: { aps: { sound: 'default' } } },
  };
}

/**
 * FCM's verdict on a token: UNREGISTERED (404) means the app was removed or
 * the token rotated; INVALID_ARGUMENT on a token or SENDER_ID_MISMATCH means
 * it was never ours to use. All three are worth forgetting.
 */
function isDeadToken(status: number, body: string): boolean {
  if (status === 404) return true;
  return /UNREGISTERED|SENDER_ID_MISMATCH/.test(body) || (status === 400 && /registration token/i.test(body));
}

export async function sendFcm(account: ServiceAccount, message: FcmMessage): Promise<FcmResult> {
  try {
    const bearer = await accessToken(account);
    const response = await fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: fcmPayload(message) }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      },
    );
    if (response.ok) return 'sent';
    const body = await response.text().catch(() => '');
    if (isDeadToken(response.status, body)) return 'unregistered';
    console.warn(`[push] FCM send failed (${response.status}): ${body.slice(0, 200)}`);
    return 'failed';
  } catch (error) {
    console.warn('[push] FCM send failed:', error instanceof Error ? error.message : error);
    return 'failed';
  }
}
