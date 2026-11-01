/**
 * Push notifications to the accounts' own devices: the store's native app and
 * the vendor and owner consoles in the browser. Like mail, push is optional and
 * best-effort — without FCM_SERVICE_ACCOUNT nothing is sent, and a failed send
 * never fails the request that caused it.
 */
import { fcmServiceAccount, sendFcm } from './fcm.ts';
import { createPushStore, type PushApp, type PushStore } from './push-store.ts';

export type PushNotice = {
  title: string;
  body: string;
  /**
   * The apps that should hear about it, each with what a tap opens there: a
   * path inside that app, or a full URL the app hands to the browser.
   */
  links: Partial<Record<PushApp, string>>;
};

/** Who the stores' emails and the staff roles belong to — the auth module knows. */
export type PushDirectory = {
  userIdForEmail: (email: string) => string | null;
  staffUserIds: () => string[];
};

let store: PushStore | null = null;
let directory: PushDirectory | null = null;

export function configurePush(dataDir: string, dir: PushDirectory): PushStore {
  store = createPushStore(dataDir);
  directory = dir;
  return store;
}

export function hasPushConfig(): boolean {
  return fcmServiceAccount() !== null;
}

/** Sends to every device the accounts registered from an app the notice targets. */
export async function deliverPush(userIds: string[], notice: PushNotice): Promise<void> {
  const account = fcmServiceAccount();
  if (!store || !account || userIds.length === 0) return;
  const devices = store.forUsers(userIds).filter((device) => device.app in notice.links);
  const dead: string[] = [];
  await Promise.all(
    devices.map(async (device) => {
      const result = await sendFcm(account, {
        token: device.token,
        platform: device.platform,
        title: notice.title,
        body: notice.body,
        link: notice.links[device.app],
      });
      if (result === 'unregistered') dead.push(device.token);
    }),
  );
  store.forget(dead);
}

function fireAndForget(userIds: string[], notice: PushNotice): void {
  void deliverPush(userIds, notice).catch(() => undefined);
}

export function pushToUser(userId: string | undefined | null, notice: PushNotice): void {
  if (userId) fireAndForget([userId], notice);
}

export function pushToEmail(email: string | undefined | null, notice: PushNotice): void {
  const address = String(email || '').trim();
  if (!address) return;
  pushToUser(directory?.userIdForEmail(address), notice);
}

/** Everyone who runs the owner console: admins and accounts managers. */
export function pushToStaff(notice: PushNotice): void {
  fireAndForget(directory?.staffUserIds() || [], notice);
}
