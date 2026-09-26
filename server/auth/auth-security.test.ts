import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createAuth, hashPassword, newUserId, parseCookies } from './auth.ts';
import { registerAuthRoutes } from './auth-routes.ts';
import { hashVerifyValue } from './email-verification.ts';
import { FOUNDER_ADMIN_EMAIL } from './dummy-accounts.ts';
import {
  parseDataUrl,
  saveUpload,
  setUploadsHeaders,
  sniffImageMime,
  uploadPrefixForPurpose,
  UPLOADS_SVG_CSP,
} from './avatar.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-authsec-'));
}

function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

const PASSWORD = 'secret123';

type SeedUser = { id: string; email: string; phone: string; role: string; name?: string };

const FOUNDER: SeedUser = { id: 'usr-nawaf-admin', email: FOUNDER_ADMIN_EMAIL, phone: '0500000001', role: 'admin' };
const ADMIN: SeedUser = { id: 'usr-admin-2', email: 'admin2@usil.sa', phone: '0500000002', role: 'admin' };
const MANAGER: SeedUser = { id: 'usr-manager', email: 'manager@usil.sa', phone: '0500000003', role: 'accounts_manager' };
const MANAGER2: SeedUser = { id: 'usr-manager-2', email: 'manager2@usil.sa', phone: '0500000004', role: 'accounts_manager' };
const CLIENT: SeedUser = { id: 'usr-client-1', email: 'client@usil.sa', phone: '0500000005', role: 'client' };

function seed(dir: string, users: SeedUser[]) {
  fs.writeFileSync(
    path.join(dir, 'users.json'),
    JSON.stringify(
      users.map((user) => ({
        name: user.name || user.id,
        avatarUrl: '',
        emailVerified: true,
        passwordHash: hashPassword(PASSWORD),
        ...user,
      })),
    ),
  );
}

function readUsers(dir: string): Array<SeedUser & { passwordHash: string }> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf-8'));
}

async function mount(users: SeedUser[] = [FOUNDER, ADMIN, MANAGER, MANAGER2, CLIENT]) {
  const dir = tmpDir();
  seed(dir, users);
  const auth = createAuth(dir);
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  registerAuthRoutes(app, auth, dir);
  app.use('/uploads', express.static(path.join(dir, 'uploads'), { fallthrough: false, setHeaders: setUploadsHeaders }));
  const server = await listen(app);
  return { dir, ...server };
}

async function call(url: string, method: string, body?: unknown, cookie = '') {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { res, json };
}

async function loginAs(url: string, user: SeedUser): Promise<string> {
  const { res } = await call(`${url}/api/auth/login`, 'POST', { email: user.email, phone: user.phone, password: PASSWORD });
  assert.equal(res.status, 200, `login ${user.email}`);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SVG_XSS = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`;
const HTML_AS_PNG = `data:image/png;base64,${Buffer.from('<html><script>alert(1)</script></html>').toString('base64')}`;

describe('admin user management — role rules', () => {
  it('accounts_manager cannot create, promote to or edit admin/accounts_manager accounts', async () => {
    const { url, close, dir } = await mount();
    const cookie = await loginAs(url, MANAGER);

    for (const role of ['admin', 'accounts_manager']) {
      const created = await call(`${url}/api/admin/users`, 'POST', { name: 'x', email: `new-${role}@usil.sa`, phone: role === 'admin' ? '0511111111' : '0511111112', password: PASSWORD, role }, cookie);
      assert.equal(created.res.status, 403, `create ${role}`);
    }
    const promote = await call(`${url}/api/admin/users/${CLIENT.id}`, 'PATCH', { role: 'admin' }, cookie);
    assert.equal(promote.res.status, 403);
    const promoteMgr = await call(`${url}/api/admin/users/${CLIENT.id}`, 'PATCH', { role: 'accounts_manager' }, cookie);
    assert.equal(promoteMgr.res.status, 403);
    const editAdmin = await call(`${url}/api/admin/users/${ADMIN.id}`, 'PATCH', { password: 'hijacked-9' }, cookie);
    assert.equal(editAdmin.res.status, 403);
    const editPeer = await call(`${url}/api/admin/users/${MANAGER2.id}`, 'PATCH', { name: 'renamed' }, cookie);
    assert.equal(editPeer.res.status, 403);
    const deleteAdmin = await call(`${url}/api/admin/users/${ADMIN.id}`, 'DELETE', undefined, cookie);
    assert.equal(deleteAdmin.res.status, 403);
    const deletePeer = await call(`${url}/api/admin/users/${MANAGER2.id}`, 'DELETE', undefined, cookie);
    assert.equal(deletePeer.res.status, 403);

    const users = readUsers(dir);
    assert.equal(users.find((u) => u.id === CLIENT.id)?.role, 'client');
    assert.ok(users.find((u) => u.id === ADMIN.id));
    assert.ok(users.find((u) => u.id === MANAGER2.id));
    await close();
  });

  it('accounts_manager still manages client, vendor and courier accounts', async () => {
    const { url, close } = await mount();
    const cookie = await loginAs(url, MANAGER);
    const created = await call(`${url}/api/admin/users`, 'POST', { name: 'مندوب', email: 'courier@usil.sa', phone: '0522222222', password: PASSWORD, role: 'courier' }, cookie);
    assert.equal(created.res.status, 201);
    assert.match(String((created.json.user as { id: string }).id), /^usr-\d+-[0-9a-f]{8}$/);
    const toVendor = await call(`${url}/api/admin/users/${CLIENT.id}`, 'PATCH', { role: 'vendor' }, cookie);
    assert.equal(toVendor.res.status, 200);
    const rename = await call(`${url}/api/admin/users/${CLIENT.id}`, 'PATCH', { name: 'مورد جديد' }, cookie);
    assert.equal(rename.res.status, 200);
    const courierId = (created.json.user as { id: string }).id;
    const removed = await call(`${url}/api/admin/users/${courierId}`, 'DELETE', undefined, cookie);
    assert.equal(removed.res.status, 200);
    await close();
  });

  it('admin can grant and revoke accounts_manager', async () => {
    const { url, close } = await mount();
    const cookie = await loginAs(url, ADMIN);
    const promote = await call(`${url}/api/admin/users/${CLIENT.id}`, 'PATCH', { role: 'accounts_manager' }, cookie);
    assert.equal(promote.res.status, 200);
    const demote = await call(`${url}/api/admin/users/${MANAGER2.id}`, 'PATCH', { role: 'client' }, cookie);
    assert.equal(demote.res.status, 200);
    await close();
  });

  it('nobody can change their own role', async () => {
    const { url, close } = await mount();
    const manager = await loginAs(url, MANAGER);
    const selfUp = await call(`${url}/api/admin/users/${MANAGER.id}`, 'PATCH', { role: 'admin' }, manager);
    assert.equal(selfUp.res.status, 403);
    const admin = await loginAs(url, ADMIN);
    const selfDown = await call(`${url}/api/admin/users/${ADMIN.id}`, 'PATCH', { role: 'client' }, admin);
    assert.equal(selfDown.res.status, 403);
    const selfSame = await call(`${url}/api/admin/users/${ADMIN.id}`, 'PATCH', { role: 'admin', name: 'اسم جديد' }, admin);
    assert.equal(selfSame.res.status, 200);
    await close();
  });
});

describe('admin user management — contact validation', () => {
  it('refuses malformed emails and phones on create and edit', async () => {
    const { url, close, dir } = await mount();
    const cookie = await loginAs(url, ADMIN);
    for (const body of [
      { name: 'x', email: 'not-an-email', phone: '0533333399', password: PASSWORD, role: 'client' },
      { name: 'x', email: 'ok@usil.sa', phone: '12', password: PASSWORD, role: 'client' },
    ]) {
      const { res } = await call(`${url}/api/admin/users`, 'POST', body, cookie);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    for (const patch of [{ email: 'nope' }, { phone: '12' }]) {
      const { res } = await call(`${url}/api/admin/users/${CLIENT.id}`, 'PATCH', patch, cookie);
      assert.equal(res.status, 400, JSON.stringify(patch));
    }
    assert.equal(readUsers(dir).find((u) => u.id === CLIENT.id)?.email, CLIENT.email);
    await close();
  });
});

describe('admin user management — founder protection', () => {
  it('another admin cannot change the founder email, role or password, or delete it', async () => {
    const { url, close, dir } = await mount();
    const cookie = await loginAs(url, ADMIN);
    const before = readUsers(dir).find((u) => u.id === FOUNDER.id)!;
    for (const patch of [{ email: 'takeover@usil.sa' }, { role: 'client' }, { password: 'hijacked-99' }, { phone: '0590000001' }]) {
      const { res } = await call(`${url}/api/admin/users/${FOUNDER.id}`, 'PATCH', patch, cookie);
      assert.equal(res.status, 403, JSON.stringify(patch));
    }
    const del = await call(`${url}/api/admin/users/${FOUNDER.id}`, 'DELETE', undefined, cookie);
    assert.equal(del.res.status, 400);
    const after = readUsers(dir).find((u) => u.id === FOUNDER.id)!;
    assert.equal(after.email, FOUNDER_ADMIN_EMAIL);
    assert.equal(after.role, 'admin');
    assert.equal(after.passwordHash, before.passwordHash);
    await close();
  });

  it('the founder can change their own password but not their email', async () => {
    const { url, close } = await mount();
    const cookie = await loginAs(url, FOUNDER);
    const pw = await call(`${url}/api/admin/users/${FOUNDER.id}`, 'PATCH', { password: 'founder-new-9' }, cookie);
    assert.equal(pw.res.status, 200);
    const email = await call(`${url}/api/admin/users/${FOUNDER.id}`, 'PATCH', { email: 'other@usil.sa' }, cookie);
    assert.equal(email.res.status, 403);
    await close();
  });

  it('no account can take the founder email, by create or by edit', async () => {
    const { url, close, dir } = await mount();
    const cookie = await loginAs(url, ADMIN);
    const created = await call(`${url}/api/admin/users`, 'POST', { name: 'x', email: FOUNDER_ADMIN_EMAIL.toUpperCase(), phone: '0533333333', password: PASSWORD, role: 'client' }, cookie);
    assert.equal(created.res.status, 409);
    const edited = await call(`${url}/api/admin/users/${CLIENT.id}`, 'PATCH', { email: FOUNDER_ADMIN_EMAIL }, cookie);
    assert.equal(edited.res.status, 409);
    assert.equal(readUsers(dir).find((u) => u.id === CLIENT.id)?.email, CLIENT.email);
    await close();
  });

  it('public sign-up with the founder email is refused even when no founder account exists', async () => {
    const { url, close, dir } = await mount([CLIENT]);
    const { res } = await call(`${url}/api/auth/register`, 'POST', { name: 'x', email: FOUNDER_ADMIN_EMAIL, phone: '0544444444', password: PASSWORD });
    assert.equal(res.status, 409);
    assert.equal(readUsers(dir).some((u) => u.role === 'admin'), false);
    await close();
  });
});

describe('login and cookies', () => {
  it('uses one generic error for unknown email, wrong phone and wrong password', async () => {
    const { url, close } = await mount([CLIENT]);
    const unknown = await call(`${url}/api/auth/login`, 'POST', { email: 'ghost@usil.sa', phone: CLIENT.phone, password: PASSWORD });
    const wrongPhone = await call(`${url}/api/auth/login`, 'POST', { email: CLIENT.email, phone: '0599999999', password: PASSWORD });
    const wrongPassword = await call(`${url}/api/auth/login`, 'POST', { email: CLIENT.email, phone: CLIENT.phone, password: 'nope-nope' });
    for (const attempt of [unknown, wrongPhone, wrongPassword]) assert.equal(attempt.res.status, 401);
    assert.equal(unknown.json.error, wrongPhone.json.error);
    assert.equal(unknown.json.error, wrongPassword.json.error);
    await close();
  });

  it('skips a malformed cookie value instead of failing with 500', async () => {
    assert.deepEqual(parseCookies({ headers: { cookie: 'bad=%E0%A4%A; good=ok%20value' } }), { good: 'ok value' });
    const { url, close } = await mount([CLIENT]);
    const session = await loginAs(url, CLIENT);
    const res = await fetch(`${url}/api/auth/me`, { headers: { cookie: `junk=%zz; ${session}` } });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { user: { id: string } }).user.id, CLIENT.id);
    await close();
  });

  it('user ids keep the usr- prefix and do not collide', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newUserId()));
    assert.equal(ids.size, 500);
    for (const id of ids) assert.match(id, /^usr-\d+-[0-9a-f]{8}$/);
  });
});

describe('uploads and avatars', () => {
  it('accepts real png only when the bytes match; rejects svg and disguised files', () => {
    assert.ok(parseDataUrl(PNG_1PX));
    assert.equal(parseDataUrl(SVG_XSS), null);
    assert.equal(parseDataUrl(HTML_AS_PNG), null);
    const pngBytes = PNG_1PX.split(',')[1];
    assert.equal(parseDataUrl(`data:image/jpeg;base64,${pngBytes}`), null);
    assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.equal(sniffImageMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'image/webp');
    assert.equal(sniffImageMime(Buffer.from('<svg/>')), null);
  });

  it('picks the filename prefix from an allowlist, never from caller text', () => {
    assert.equal(uploadPrefixForPurpose('listing'), 'listing');
    assert.equal(uploadPrefixForPurpose('logo'), 'vendor-logo');
    assert.equal(uploadPrefixForPurpose('../../evil'), 'upload');
    assert.equal(uploadPrefixForPurpose('avatar-usr-nawaf-admin'), 'upload');
    assert.equal(uploadPrefixForPurpose('constructor'), 'upload');
    const dir = tmpDir();
    assert.match(String(saveUpload(dir, '../x', PNG_1PX)), /^\/uploads\/x-[0-9a-f]{16}\.png$/);
  });

  it('POST /api/uploads rejects svg and spoofed types and ignores free-text prefixes', async () => {
    const { url, close } = await mount([CLIENT]);
    const cookie = await loginAs(url, CLIENT);
    const svg = await call(`${url}/api/uploads`, 'POST', { dataUrl: SVG_XSS, prefix: 'listing' }, cookie);
    assert.equal(svg.res.status, 400);
    const spoofed = await call(`${url}/api/uploads`, 'POST', { dataUrl: HTML_AS_PNG }, cookie);
    assert.equal(spoofed.res.status, 400);
    const ok = await call(`${url}/api/uploads`, 'POST', { dataUrl: PNG_1PX, prefix: 'avatar-usr-nawaf-admin' }, cookie);
    assert.equal(ok.res.status, 201);
    assert.match(String(ok.json.url), /^\/uploads\/upload-[0-9a-f]{16}\.png$/);
    const listing = await call(`${url}/api/uploads`, 'POST', { dataUrl: PNG_1PX, purpose: 'listing' }, cookie);
    assert.match(String(listing.json.url), /^\/uploads\/listing-/);

    const served = await fetch(`${url}${ok.json.url}`);
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    await close();
  });

  it('serves generated svg avatars with nosniff and a sandboxing CSP', async () => {
    const { url, close } = await mount([CLIENT]);
    const cookie = await loginAs(url, CLIENT);
    const me = await call(`${url}/api/auth/me`, 'GET', undefined, cookie);
    const avatarUrl = String((me.json.user as { avatarUrl: string }).avatarUrl);
    assert.match(avatarUrl, /\.svg$/);
    const res = await fetch(`${url}${avatarUrl}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-security-policy'), UPLOADS_SVG_CSP);
    await close();
  });

  it('avatar upload with invalid data answers 400 and leaves the avatar alone', async () => {
    const { url, close } = await mount([CLIENT]);
    const cookie = await loginAs(url, CLIENT);
    const before = (await call(`${url}/api/auth/me`, 'GET', undefined, cookie)).json.user as { avatarUrl: string };
    for (const avatarDataUrl of [SVG_XSS, HTML_AS_PNG, 'not-a-data-url']) {
      const { res } = await call(`${url}/api/auth/avatar`, 'POST', { avatarDataUrl }, cookie);
      assert.equal(res.status, 400);
    }
    const after = (await call(`${url}/api/auth/me`, 'GET', undefined, cookie)).json.user as { avatarUrl: string };
    assert.equal(after.avatarUrl, before.avatarUrl);
    const ok = await call(`${url}/api/auth/avatar`, 'POST', { avatarDataUrl: PNG_1PX }, cookie);
    assert.equal(ok.res.status, 200);
    assert.match(String((ok.json.user as { avatarUrl: string }).avatarUrl), /\.png$/);
    await close();
  });
});

describe('email verification link', () => {
  it('redirects a browser back to the SPA with a success or failure flag', async () => {
    const token = 'a'.repeat(48);
    const { url, close, dir } = await mount([CLIENT]);
    const users = readUsers(dir) as Array<Record<string, unknown>>;
    Object.assign(users[0], {
      emailVerified: false,
      emailVerifyTokenHash: hashVerifyValue(token, CLIENT.email),
      emailVerifyExpiresAt: Date.now() + 60_000,
    });
    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(users));

    const bad = await fetch(`${url}/api/auth/verify-email?token=${'b'.repeat(48)}`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    assert.equal(bad.status, 302);
    assert.equal(bad.headers.get('location'), '/?emailVerified=0&reason=invalid');

    const good = await fetch(`${url}/api/auth/verify-email?token=${token}`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    assert.equal(good.status, 302);
    assert.equal(good.headers.get('location'), '/?emailVerified=1');
    assert.equal((readUsers(dir)[0] as { emailVerified?: boolean }).emailVerified, true);

    const api = await fetch(`${url}/api/auth/verify-email?token=${'b'.repeat(48)}`, { headers: { accept: 'application/json' } });
    assert.equal(api.status, 400);
    assert.equal(((await api.json()) as { success: boolean }).success, false);
    await close();
  });
});
