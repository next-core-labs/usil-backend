import path from 'path';
import { readJsonArray, writeJsonFile } from '../shared/json-file.ts';
import type { PushPlatform } from './fcm.ts';

/** Which Usil app holds the token: the store (web + native shell) or one of the consoles. */
export const PUSH_APPS = ['store', 'vendor', 'owner'] as const;
export type PushApp = (typeof PUSH_APPS)[number];

const PUSH_PLATFORMS: readonly PushPlatform[] = ['android', 'ios', 'web'];

/** One device (or browser) that can be reached for one signed-in account. */
export type PushDevice = {
  token: string;
  userId: string;
  platform: PushPlatform;
  app: PushApp;
  createdAt: string;
  updatedAt: string;
};

export type PushRegistration = { token: string; platform: PushPlatform; app: PushApp };

/** A phone, a tablet and a few browsers is plenty; the oldest makes room. */
const MAX_DEVICES_PER_USER = 10;

/** FCM tokens are a few hundred URL-safe characters with `:` separators. */
const TOKEN_PATTERN = /^[A-Za-z0-9_:.\-]{20,4096}$/;

export function parsePushRegistration(body: unknown): PushRegistration | null {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const token = String(input.token || '').trim();
  const platform = String(input.platform || '') as PushPlatform;
  const app = String(input.app || '') as PushApp;
  if (!TOKEN_PATTERN.test(token)) return null;
  if (!PUSH_PLATFORMS.includes(platform)) return null;
  if (!(PUSH_APPS as readonly string[]).includes(app)) return null;
  return { token, platform, app };
}

export function createPushStore(dataDir: string, now: () => Date = () => new Date()) {
  const file = path.join(dataDir, 'push-devices.json');

  const load = () => readJsonArray<PushDevice>(file);
  // Tokens address someone's phone: keep the document private like the session store.
  const save = (rows: PushDevice[]) => writeJsonFile(file, rows, { mode: 0o600 });

  /**
   * A token belongs to whoever signed in on that device last: signing in as
   * someone else moves it, so the previous account stops hearing about it.
   */
  function register(userId: string, input: PushRegistration): PushDevice {
    const stamp = now().toISOString();
    const rows = load();
    const existing = rows.find((row) => row.token === input.token);
    const device: PushDevice = {
      token: input.token,
      userId,
      platform: input.platform,
      app: input.app,
      createdAt: existing?.userId === userId ? existing.createdAt : stamp,
      updatedAt: stamp,
    };
    const others = rows.filter((row) => row.token !== input.token);
    const mine = others
      .filter((row) => row.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_DEVICES_PER_USER - 1);
    save([...others.filter((row) => row.userId !== userId), ...mine, device]);
    return device;
  }

  /** Signing out: only the account that holds the token may drop it. */
  function unregister(userId: string, token: string): boolean {
    const rows = load();
    const kept = rows.filter((row) => !(row.token === token && row.userId === userId));
    if (kept.length === rows.length) return false;
    save(kept);
    return true;
  }

  /** FCM said the token is dead. */
  function forget(tokens: string[]): void {
    if (tokens.length === 0) return;
    const dead = new Set(tokens);
    const rows = load();
    const kept = rows.filter((row) => !dead.has(row.token));
    if (kept.length !== rows.length) save(kept);
  }

  function removeForUser(userId: string): void {
    const rows = load();
    const kept = rows.filter((row) => row.userId !== userId);
    if (kept.length !== rows.length) save(kept);
  }

  function forUsers(userIds: string[]): PushDevice[] {
    const wanted = new Set(userIds.filter(Boolean));
    return load().filter((row) => wanted.has(row.userId));
  }

  return { register, unregister, forget, removeForUser, forUsers, list: load };
}

export type PushStore = ReturnType<typeof createPushStore>;
