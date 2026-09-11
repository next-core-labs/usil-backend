import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';
import { resolveUserAvatar, saveUpload } from './avatar';
import { clientIp, createSlidingWindowLimiter } from '../shared/booking-guards';
import { FOUNDER_ADMIN_EMAIL, purgeLiveDummyData, wipeAllVendorsAndDummyMedia } from './dummy-accounts';
import { readJsonFile, writeJsonFile } from '../shared/json-file';
import { notifyPasswordChanged, sendVerificationEmail } from '../shared/optional-mail';
import { emptyVendorSocials, type VendorSocials } from '../vendors/vendor-socials';
import { isAccountRole, isVendorSupervisor, roleAllowed, type AccountRole } from './roles';
export type { AccountRole } from './roles';
import {
  EMAIL_RESEND_FALLBACK,
  EMAIL_RESEND_LIMIT,
  EMAIL_RESEND_SENT,
  EMAIL_RESEND_WINDOW_MS,
  EMAIL_VERIFY_ALREADY,
  EMAIL_VERIFY_ATTEMPT_LIMIT,
  EMAIL_VERIFY_ATTEMPT_RATE,
  EMAIL_VERIFY_ATTEMPT_WINDOW_MS,
  EMAIL_VERIFY_EMPTY,
  EMAIL_VERIFY_EXPIRED,
  EMAIL_VERIFY_INVALID,
  EMAIL_VERIFY_NOT_FOUND,
  EMAIL_VERIFY_RATE,
  EMAIL_VERIFY_SUCCESS,
  EMAIL_VERIFY_TTL_MS,
  generateEmailVerifyToken,
  generateSixDigitCode,
  hashVerifyValue,
  isEmailVerificationExpired,
  isSixDigitCode,
  isStoredEmailVerified,
  needsEmailVerification,
  verifyValueMatches,
} from './email-verification';

export type PublicUser = {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: AccountRole;
  avatarUrl: string;
  emailVerified: boolean;
  socials?: VendorSocials;
};

type StoredUser = Omit<PublicUser, 'emailVerified'> & {
  passwordHash: string;
  avatarUrl?: string;
  socials?: VendorSocials;
  emailVerified?: boolean;
  emailVerifyCodeHash?: string;
  emailVerifyExpiresAt?: number;
  emailVerifyTokenHash?: string;
};

const COOKIE = 'midyaf_sid';

function usersFile(dataDir: string) {
  return path.join(dataDir, 'users.json');
}

function sessionsFile(dataDir: string) {
  return path.join(dataDir, 'sessions.json');
}

export function normalizePhone(raw: string): string {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  if (digits.startsWith('966') && digits.length >= 12) return `0${digits.slice(3)}`;
  if (digits.startsWith('5') && digits.length === 9) return `0${digits}`;
  return digits;
}

export function normalizeEmail(raw: string): string {
  return String(raw || '').trim().toLowerCase();
}

export function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')): string {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const next = crypto.scryptSync(password, salt, 64).toString('hex');
  if (next.length !== hash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(next, 'hex'));
}

function readJson<T>(file: string, fallback: T): T {
  return readJsonFile(file, fallback);
}

function writeJson(file: string, value: unknown) {
  writeJsonFile(file, value);
}

function cookieSecure(): boolean {
  if (process.env.COOKIE_SECURE === '0') return false;
  if (process.env.COOKIE_SECURE === '1') return true;
  return process.env.NODE_ENV === 'production';
}

function cookieDomain(): string | undefined {
  const explicit = String(process.env.COOKIE_DOMAIN || '').trim();
  if (explicit === '0' || explicit.toLowerCase() === 'none') return undefined;
  if (explicit) return explicit;
  const site = String(process.env.PUBLIC_SITE_URL || process.env.APP_URL || '');
  try {
    const host = site ? new URL(site).hostname : '';
    if (host === 'usil.app' || host.endsWith('.usil.app')) return '.usil.app';
  } catch {
    /* ignore */
  }
  return undefined;
}

const COOKIE_DAY_SEC = 60 * 60 * 24;
const COOKIE_REMEMBER_MAX_AGE = COOKIE_DAY_SEC * 30;
const COOKIE_SHORT_MAX_AGE = COOKIE_DAY_SEC;
const COOKIE_DEFAULT_MAX_AGE = COOKIE_DAY_SEC * 7;

function parseRemember(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function setSessionCookie(res: Response, token: string, remember?: boolean) {
  const maxAge =
    remember === true ? COOKIE_REMEMBER_MAX_AGE : remember === false ? COOKIE_SHORT_MAX_AGE : COOKIE_DEFAULT_MAX_AGE;
  const parts = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  const domain = cookieDomain();
  if (domain) parts.push(`Domain=${domain}`);
  if (cookieSecure()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res: Response) {
  const parts = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  const domain = cookieDomain();
  if (domain) parts.push(`Domain=${domain}`);
  if (cookieSecure()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

const FORGOT_LIMIT = 5;
const FORGOT_WINDOW_MS = 15 * 60 * 1000;
/**
 * Password guessing guard. Keyed per IP+email so one attacker cannot lock a
 * victim out of their own account by burning the shared IP budget, and set well
 * above what a person mistyping their own password would ever hit.
 */
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT = 'حدّ محاولات الدخول. انتظر 15 دقيقة ثم أعد المحاولة.';
const GENERIC_RESET_MISMATCH = 'حساب غير موجود أو الجوال لا يطابق البريد.';
const WEAK_PASSWORD = 'الرقم السري ضعيف. استخدم 8 خانات على الأقل.';
const RESET_RATE_LIMIT = 'حدّ المحاولات. انتظر 15 دقيقة ثم أعد المحاولة.';
const RESET_SUCCESS = 'تم تغيير الرقم السري. ادخل الآن.';

export function createAuth(dataDir: string) {
  const forgotLimiter = createSlidingWindowLimiter(FORGOT_LIMIT, FORGOT_WINDOW_MS);
  const loginLimiter = createSlidingWindowLimiter(LOGIN_LIMIT, LOGIN_WINDOW_MS);
  const resendLimiter = createSlidingWindowLimiter(EMAIL_RESEND_LIMIT, EMAIL_RESEND_WINDOW_MS);
  const verifyAttemptLimiter = createSlidingWindowLimiter(EMAIL_VERIFY_ATTEMPT_LIMIT, EMAIL_VERIFY_ATTEMPT_WINDOW_MS);

  function publicUser(user: StoredUser): PublicUser {
    const avatarUrl = resolveUserAvatar(dataDir, user);
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      avatarUrl,
      emailVerified: isStoredEmailVerified(user),
      socials: user.role === 'vendor' ? user.socials || emptyVendorSocials() : undefined,
    };
  }

  function issueEmailVerification(user: StoredUser): { code: string; token: string } {
    const code = generateSixDigitCode();
    const token = generateEmailVerifyToken();
    user.emailVerified = false;
    user.emailVerifyCodeHash = hashVerifyValue(code, user.email);
    user.emailVerifyExpiresAt = Date.now() + EMAIL_VERIFY_TTL_MS;
    user.emailVerifyTokenHash = hashVerifyValue(token, user.email);
    return { code, token };
  }

  function clearEmailVerificationSecrets(user: StoredUser) {
    user.emailVerified = true;
    delete user.emailVerifyCodeHash;
    delete user.emailVerifyExpiresAt;
    delete user.emailVerifyTokenHash;
  }

  function verificationPayload(emailSent: boolean, code: string) {
    return emailSent ? { emailSent: true as const } : { emailSent: false as const, verificationCode: code };
  }

  let dummyPurged = false;
  function seedUsers(): StoredUser[] {
    if (!dummyPurged) {
      purgeLiveDummyData(dataDir);
      wipeAllVendorsAndDummyMedia(dataDir, { once: true });
      dummyPurged = true;
    }
    const file = usersFile(dataDir);
    const existing = readJson<StoredUser[]>(file, []);
    let changed = false;
    for (const user of existing) {
      const avatarUrl = resolveUserAvatar(dataDir, user);
      if (user.avatarUrl !== avatarUrl) {
        user.avatarUrl = avatarUrl;
        changed = true;
      }
    }
    if (changed) writeJson(file, existing);
    return existing;
  }

  seedUsers();

  function loadUsers(): StoredUser[] {
    return seedUsers();
  }

  function saveUsers(users: StoredUser[]) {
    writeJson(usersFile(dataDir), users);
  }

  function loadSessions(): Record<string, string> {
    return readJson<Record<string, string>>(sessionsFile(dataDir), {});
  }

  function saveSessions(sessions: Record<string, string>) {
    writeJson(sessionsFile(dataDir), sessions);
  }

  function pruneDeadAuthArtifacts() {
    const users = readJson<StoredUser[]>(usersFile(dataDir), []);
    const ids = new Set(users.map((user) => user.id));
    let usersChanged = false;
    for (const user of users) {
      const staleVerify =
        isStoredEmailVerified(user) || isEmailVerificationExpired(user.emailVerifyExpiresAt);
      if (
        staleVerify &&
        (user.emailVerifyCodeHash || user.emailVerifyTokenHash || user.emailVerifyExpiresAt)
      ) {
        delete user.emailVerifyCodeHash;
        delete user.emailVerifyTokenHash;
        delete user.emailVerifyExpiresAt;
        usersChanged = true;
      }
    }
    if (usersChanged) writeJson(usersFile(dataDir), users);

    const sessions = loadSessions();
    let removed = 0;
    for (const [token, userId] of Object.entries(sessions)) {
      const dead =
        !token ||
        token.startsWith('diag') ||
        token.length < 16 ||
        !ids.has(userId);
      if (dead) {
        delete sessions[token];
        removed += 1;
      }
    }
    if (removed) saveSessions(sessions);
  }

  pruneDeadAuthArtifacts();

  function attachAvatarFromBody(user: StoredUser, body: any): void {
    const dataUrl = String(body?.avatarDataUrl || body?.avatarUrl || '');
    if (dataUrl.startsWith('data:image/')) {
      const saved = saveUpload(dataDir, `avatar-${user.id}`, dataUrl);
      if (saved) {
        user.avatarUrl = saved;
        return;
      }
    }
    user.avatarUrl = resolveUserAvatar(dataDir, user);
  }

  function userFromRequest(req: Request): PublicUser | null {
    const token = parseCookies(req)[COOKIE];
    if (!token) return null;
    const userId = loadSessions()[token];
    if (!userId) return null;
    const user = loadUsers().find((item) => item.id === userId);
    return user ? publicUser(user) : null;
  }

  function requireRole(roles: AccountRole[]) {
    return (req: Request, res: Response, next: NextFunction) => {
      const user = userFromRequest(req);
      if (!user) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
      if (!roleAllowed(user.role, roles)) {
        return res.status(403).json({ success: false, error: 'ليست لديك صلاحية هذا الإجراء.' });
      }
      (req as Request & { user: PublicUser }).user = user;
      next();
    };
  }

  function loginHandler(req: Request, res: Response) {
    try {
      const email = normalizeEmail(req.body?.email || req.body?.identifier);
      const phone = normalizePhone(req.body?.phone || '');
      const password = String(req.body?.password || '');
      if (!loginLimiter.allow(`${clientIp(req)}:${email}`)) {
        return res.status(429).json({ success: false, error: LOGIN_RATE_LIMIT });
      }
      if (!email || !password) {
        return res.status(400).json({ success: false, error: 'البريد والجوال والرقم السري مطلوبة.' });
      }
      if (!phone && !String(req.body?.identifier || '').includes('@')) {
        return res.status(400).json({ success: false, error: 'البريد والجوال والرقم السري مطلوبة.' });
      }

      const user = loadUsers().find((item) => item.email === email);
      if (!user) {
        const pending = readJson<{ status?: string; email?: string }[]>(
          path.join(dataDir, 'vendor-applications.json'),
          [],
        ).find((row) => row.email === email);
        if (pending?.status === 'pending') {
          return res.status(403).json({
            success: false,
            error: 'طلب انضمامك كمورّد وصل لإدارة يوصل، وتقدر تدخل بعد الموافقة.',
          });
        }
        if (pending?.status === 'rejected') {
          return res.status(403).json({
            success: false,
            error: 'طلب انضمامك كمورّد رُفض. تواصل مع إدارة يوصل.',
          });
        }
        return res.status(401).json({ success: false, error: 'لا يوجد حساب بهذا البريد الإلكتروني.' });
      }
      if (phone && normalizePhone(user.phone) !== phone) {
        return res.status(401).json({ success: false, error: 'رقم الجوال لا يطابق هذا البريد.' });
      }
      if (!verifyPassword(password, user.passwordHash)) {
        return res.status(401).json({ success: false, error: 'الرقم السري غير صحيح.' });
      }

      startSession(res, user.id, parseRemember(req.body?.remember));
      const published = publicUser(user);
      res.json({
        success: true,
        user: published,
        needsEmailVerification: needsEmailVerification(published),
      });
    } catch {
      res.status(500).json({ success: false, error: 'تعذر تسجيل الدخول. حاول مرة أخرى.' });
    }
  }

  async function registerHandler(req: Request, res: Response) {
    try {
      const email = normalizeEmail(req.body?.email || req.body?.identifier);
      const phone = normalizePhone(req.body?.phone || req.body?.identifier);
      const password = String(req.body?.password || '');
      const name = String(req.body?.name || '').trim();
      if (!email || !phone || !password || !name) {
        return res.status(400).json({ success: false, error: 'الاسم والبريد والجوال والرقم السري مطلوبة.' });
      }
      if (!email.includes('@')) {
        return res.status(400).json({ success: false, error: 'أدخل بريداً إلكترونياً صحيحاً.' });
      }
      if (password.length < 6) {
        return res.status(400).json({ success: false, error: 'الرقم السري يجب ألا يقل عن 6 خانات.' });
      }

      const users = loadUsers();
      if (users.some((item) => item.email === email)) {
        return res.status(409).json({ success: false, error: 'هذا البريد مسجّل مسبقاً.' });
      }
      if (users.some((item) => normalizePhone(item.phone) === phone)) {
        return res.status(409).json({ success: false, error: 'رقم الجوال مسجّل مسبقاً.' });
      }

      const isFounder = email === FOUNDER_ADMIN_EMAIL;
      const user: StoredUser = {
        id: isFounder ? 'usr-nawaf-admin' : `usr-${Date.now()}`,
        name,
        email,
        phone,
        role: isFounder ? 'admin' : 'client',
        passwordHash: hashPassword(password),
        avatarUrl: '',
        emailVerified: isFounder,
      };
      attachAvatarFromBody(user, req.body);
      const issued = isFounder ? null : issueEmailVerification(user);
      users.push(user);
      saveUsers(users);

      const token = crypto.randomBytes(24).toString('hex');
      const sessions = loadSessions();
      sessions[token] = user.id;
      saveSessions(sessions);
      setSessionCookie(res, token);
      if (!issued) {
        return res.status(201).json({
          success: true,
          user: publicUser(user),
          needsEmailVerification: false,
          message: 'تم إنشاء حساب الإدارة.',
        });
      }
      const emailSent = await sendVerificationEmail(user.email, issued.code, issued.token);
      res.status(201).json({
        success: true,
        user: publicUser(user),
        needsEmailVerification: true,
        message: emailSent
          ? 'أدخل رمز التأكيد المرسل إلى بريدك.'
          : 'أدخل رمز التأكيد. يظهر مرة واحدة هنا لأن البريد غير مفعّل.',
        ...verificationPayload(emailSent, issued.code),
      });
    } catch {
      res.status(500).json({ success: false, error: 'تعذر إنشاء الحساب. حاول مرة أخرى.' });
    }
  }

  function meHandler(req: Request, res: Response) {
    const user = userFromRequest(req);
    res.json({ success: true, user });
  }

  function logoutHandler(req: Request, res: Response) {
    const token = parseCookies(req)[COOKIE];
    if (token) {
      const sessions = loadSessions();
      delete sessions[token];
      saveSessions(sessions);
    }
    clearSessionCookie(res);
    res.json({ success: true });
  }

  function requireAdmin(req: Request, res: Response): PublicUser | null {
    const actor = userFromRequest(req);
    if (!actor) {
      res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
      return null;
    }
    if (!isVendorSupervisor(actor.role)) {
      res.status(403).json({ success: false, error: 'إدارة الحسابات متاحة لمدير المنصة فقط.' });
      return null;
    }
    return actor;
  }

  function listUsersHandler(req: Request, res: Response) {
    if (!requireAdmin(req, res)) return;
    res.json({ success: true, data: loadUsers().map(publicUser) });
  }

  function createUserHandler(req: Request, res: Response) {
    if (!requireAdmin(req, res)) return;
    const email = normalizeEmail(req.body?.email);
    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.password || '');
    const name = String(req.body?.name || '').trim();
    const role = String(req.body?.role || 'client') as AccountRole;
    if (!email || !phone || !password || !name) {
      return res.status(400).json({ success: false, error: 'الاسم والبريد والجوال والرقم السري مطلوبة.' });
    }
    if (!isAccountRole(role)) {
      return res.status(400).json({ success: false, error: 'نوع الحساب غير صالح.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'الرقم السري يجب ألا يقل عن 6 خانات.' });
    }

    const users = loadUsers();
    if (users.some((item) => item.email === email)) {
      return res.status(409).json({ success: false, error: 'هذا البريد مسجّل مسبقاً.' });
    }
    if (users.some((item) => normalizePhone(item.phone) === phone)) {
      return res.status(409).json({ success: false, error: 'رقم الجوال مسجّل مسبقاً.' });
    }

    const user: StoredUser = {
      id: `usr-${Date.now()}`,
      name,
      email,
      phone,
      role,
      passwordHash: hashPassword(password),
      avatarUrl: '',
      emailVerified: true,
    };
    attachAvatarFromBody(user, req.body);
    users.push(user);
    saveUsers(users);
    res.status(201).json({ success: true, user: publicUser(user) });
  }

  function updateUserHandler(req: Request, res: Response) {
    const actor = requireAdmin(req, res);
    if (!actor) return;
    const { id } = req.params as { id: string };
    const users = loadUsers();
    const user = users.find((item) => item.id === id);
    if (!user) return res.status(404).json({ success: false, error: 'الحساب غير موجود.' });

    const nextRole = req.body?.role ? (String(req.body.role) as AccountRole) : user.role;
    if (req.body?.role && !isAccountRole(nextRole)) {
      return res.status(400).json({ success: false, error: 'نوع الحساب غير صالح.' });
    }

    const adminCount = users.filter((item) => item.role === 'admin').length;
    if (user.role === 'admin' && nextRole !== 'admin' && adminCount <= 1) {
      return res.status(400).json({ success: false, error: 'لا يمكن إزالة آخر مدير لكل الحسابات.' });
    }
    if (normalizeEmail(user.email) === FOUNDER_ADMIN_EMAIL && nextRole !== 'admin') {
      return res.status(400).json({ success: false, error: 'لا يمكن تغيير صلاحية حساب الإدارة الرئيسي.' });
    }

    if (req.body?.name) user.name = String(req.body.name).trim() || user.name;
    if (req.body?.phone) {
      const phone = normalizePhone(req.body.phone);
      if (users.some((item) => item.id !== user.id && normalizePhone(item.phone) === phone)) {
        return res.status(409).json({ success: false, error: 'رقم الجوال مسجّل مسبقاً.' });
      }
      user.phone = phone;
    }
    if (req.body?.email) {
      const email = normalizeEmail(req.body.email);
      if (users.some((item) => item.id !== user.id && item.email === email)) {
        return res.status(409).json({ success: false, error: 'هذا البريد مسجّل مسبقاً.' });
      }
      user.email = email;
    }
    user.role = nextRole;
    if (req.body?.password) {
      const password = String(req.body.password);
      if (password.length < 6) {
        return res.status(400).json({ success: false, error: 'الرقم السري يجب ألا يقل عن 6 خانات.' });
      }
      user.passwordHash = hashPassword(password);
    }
    if (req.body?.avatarDataUrl || req.body?.avatarUrl) {
      attachAvatarFromBody(user, req.body);
    }
    if (req.body?.emailVerified === true) {
      clearEmailVerificationSecrets(user);
    } else if (req.body?.emailVerified === false) {
      user.emailVerified = false;
    }
    saveUsers(users);
    res.json({ success: true, user: publicUser(user) });
  }

  function startSession(res: Response, userId: string, remember?: boolean) {
    const token = crypto.randomBytes(24).toString('hex');
    const sessions = loadSessions();
    sessions[token] = userId;
    saveSessions(sessions);
    setSessionCookie(res, token, remember);
    return token;
  }

  function ensureApplicantUser(input: {
    name: string;
    email: string;
    phone: string;
    passwordHash: string;
    avatarUrl?: string;
  }): PublicUser {
    const users = loadUsers();
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone);
    const existing = users.find((item) => item.email === email);
    if (existing) {
      if (existing.email === FOUNDER_ADMIN_EMAIL || existing.role === 'admin') {
        return publicUser(existing);
      }
      existing.name = input.name || existing.name;
      existing.phone = phone || existing.phone;
      existing.passwordHash = input.passwordHash || existing.passwordHash;
      if (input.avatarUrl) existing.avatarUrl = input.avatarUrl;
      else existing.avatarUrl = resolveUserAvatar(dataDir, existing);
      if (existing.role !== 'vendor') existing.role = 'client';
      existing.emailVerified = true;
      saveUsers(users);
      return publicUser(existing);
    }
    const user: StoredUser = {
      id: `usr-${Date.now()}`,
      name: input.name,
      email,
      phone,
      role: 'client',
      passwordHash: input.passwordHash,
      avatarUrl: input.avatarUrl || '',
      emailVerified: true,
    };
    user.avatarUrl = input.avatarUrl || resolveUserAvatar(dataDir, user);
    users.push(user);
    saveUsers(users);
    return publicUser(user);
  }

  function addVendorUser(input: {
    name: string;
    email: string;
    phone: string;
    passwordHash: string;
    avatarUrl?: string;
    avatarDataUrl?: string;
    socials?: VendorSocials;
  }): PublicUser {
    const users = loadUsers();
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone);
    const existing = users.find((item) => item.email === email);
    if (existing) {
      existing.role = 'vendor';
      existing.name = input.name || existing.name;
      existing.phone = phone || existing.phone;
      existing.passwordHash = input.passwordHash || existing.passwordHash;
      if (input.avatarUrl) existing.avatarUrl = input.avatarUrl;
      if (input.avatarDataUrl) attachAvatarFromBody(existing, input);
      else existing.avatarUrl = resolveUserAvatar(dataDir, existing);
      if (input.socials) existing.socials = input.socials;
      saveUsers(users);
      return publicUser(existing);
    }
    const user: StoredUser = {
      id: `usr-${Date.now()}`,
      name: input.name,
      email,
      phone,
      role: 'vendor',
      passwordHash: input.passwordHash,
      avatarUrl: input.avatarUrl || '',
      socials: input.socials || emptyVendorSocials(),
      emailVerified: true,
    };
    if (input.avatarDataUrl) attachAvatarFromBody(user, input);
    else user.avatarUrl = resolveUserAvatar(dataDir, user);
    users.push(user);
    saveUsers(users);
    return publicUser(user);
  }

  function saveUserSocials(userId: string, socials: VendorSocials): PublicUser | null {
    const users = loadUsers();
    const user = users.find((item) => item.id === userId);
    if (!user) return null;
    user.socials = socials;
    saveUsers(users);
    return publicUser(user);
  }

  function findUserByEmail(email: string): StoredUser | null {
    return loadUsers().find((item) => item.email === normalizeEmail(email)) || null;
  }

  function listVendorUsers(): PublicUser[] {
    return listUsersByRole('vendor');
  }

  function listUsersByRole(role: AccountRole): PublicUser[] {
    return loadUsers().filter((item) => item.role === role).map(publicUser);
  }

  function deleteUserHandler(req: Request, res: Response) {
    const actor = requireAdmin(req, res);
    if (!actor) return;
    const { id } = req.params as { id: string };
    if (id === actor.id) {
      return res.status(400).json({ success: false, error: 'لا يمكنك حذف حسابك وأنت داخل اللوحة.' });
    }
    const users = loadUsers();
    const user = users.find((item) => item.id === id);
    if (!user) return res.status(404).json({ success: false, error: 'الحساب غير موجود.' });
    if (normalizeEmail(user.email) === FOUNDER_ADMIN_EMAIL) {
      return res.status(400).json({ success: false, error: 'لا يمكن حذف حساب الإدارة الرئيسي.' });
    }
    if (user.role === 'admin' && users.filter((item) => item.role === 'admin').length <= 1) {
      return res.status(400).json({ success: false, error: 'لا يمكن حذف آخر مدير لكل الحسابات.' });
    }
    saveUsers(users.filter((item) => item.id !== id));
    const sessions = loadSessions();
    for (const [token, userId] of Object.entries(sessions)) {
      if (userId === id) delete sessions[token];
    }
    saveSessions(sessions);
    res.json({ success: true });
  }

  function invalidateUserSessions(userId: string) {
    const file = sessionsFile(dataDir);
    if (!fs.existsSync(file)) return;
    const sessions = loadSessions();
    let changed = false;
    for (const [token, id] of Object.entries(sessions)) {
      if (id === userId) {
        delete sessions[token];
        changed = true;
      }
    }
    if (changed) saveSessions(sessions);
  }

  function forgotPasswordHandler(req: Request, res: Response) {
    try {
      const ip = clientIp(req);
      if (!forgotLimiter.allow(ip)) {
        return res.status(429).json({ success: false, error: RESET_RATE_LIMIT });
      }

      const email = normalizeEmail(req.body?.email);
      const phone = normalizePhone(req.body?.phone);
      const newPassword = String(req.body?.newPassword || '');

      if (!email || !phone || !newPassword) {
        return res.status(400).json({
          success: false,
          error: 'البريد الإلكتروني ورقم الجوال والرقم السري الجديد مطلوبة.',
        });
      }
      if (!email.includes('@')) {
        return res.status(400).json({ success: false, error: GENERIC_RESET_MISMATCH });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ success: false, error: WEAK_PASSWORD });
      }

      const users = loadUsers();
      const user = users.find(
        (item) => item.email === email && normalizePhone(item.phone) === phone,
      );
      if (!user) {
        return res.status(400).json({ success: false, error: GENERIC_RESET_MISMATCH });
      }

      user.passwordHash = hashPassword(newPassword);
      saveUsers(users);
      invalidateUserSessions(user.id);
      notifyPasswordChanged(user.email);

      res.json({ success: true, message: RESET_SUCCESS });
    } catch {
      res.status(500).json({ success: false, error: 'تعذر استعادة الحساب. حاول مرة أخرى.' });
    }
  }

  function avatarHandler(req: Request, res: Response) {
    const actor = userFromRequest(req);
    if (!actor) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
    const users = loadUsers();
    const user = users.find((item) => item.id === actor.id);
    if (!user) return res.status(404).json({ success: false, error: 'الحساب غير موجود.' });
    attachAvatarFromBody(user, req.body);
    saveUsers(users);
    res.json({ success: true, user: publicUser(user) });
  }

  function markVerified(user: StoredUser, users: StoredUser[]) {
    clearEmailVerificationSecrets(user);
    saveUsers(users);
    return publicUser(user);
  }

  async function verifyEmailHandler(req: Request, res: Response) {
    try {
      const email = normalizeEmail(req.body?.email);
      const phone = normalizePhone(req.body?.phone);
      const code = String(req.body?.code || '').replace(/\D/g, '');
      if (!email || !email.includes('@')) {
        return res.status(400).json({ success: false, error: EMAIL_VERIFY_NOT_FOUND });
      }
      if (!isSixDigitCode(code)) {
        return res.status(400).json({ success: false, error: EMAIL_VERIFY_EMPTY });
      }

      const ip = clientIp(req);
      if (!verifyAttemptLimiter.allow(`${ip}:${email}`)) {
        return res.status(429).json({ success: false, error: EMAIL_VERIFY_ATTEMPT_RATE });
      }

      const users = loadUsers();
      const user = users.find(
        (item) => item.email === email && (!phone || normalizePhone(item.phone) === phone),
      );
      if (!user) {
        return res.status(400).json({ success: false, error: EMAIL_VERIFY_NOT_FOUND });
      }
      if (isStoredEmailVerified(user)) {
        return res.json({ success: true, user: publicUser(user), message: EMAIL_VERIFY_ALREADY });
      }
      if (isEmailVerificationExpired(user.emailVerifyExpiresAt)) {
        return res.status(400).json({ success: false, error: EMAIL_VERIFY_EXPIRED });
      }
      if (!user.emailVerifyCodeHash || !verifyValueMatches(code, user.emailVerifyCodeHash, user.email)) {
        return res.status(400).json({ success: false, error: EMAIL_VERIFY_INVALID });
      }

      const published = markVerified(user, users);
      res.json({ success: true, user: published, message: EMAIL_VERIFY_SUCCESS });
    } catch {
      res.status(500).json({ success: false, error: 'تعذر تأكيد البريد. حاول مرة أخرى.' });
    }
  }

  async function resendVerificationHandler(req: Request, res: Response) {
    try {
      const email = normalizeEmail(req.body?.email);
      const phone = normalizePhone(req.body?.phone);
      if (!email || !phone) {
        return res.status(400).json({ success: false, error: 'البريد الإلكتروني ورقم الجوال مطلوبان.' });
      }
      const ip = clientIp(req);
      if (!resendLimiter.allow(`${ip}:${email}`)) {
        return res.status(429).json({ success: false, error: EMAIL_VERIFY_RATE });
      }

      const users = loadUsers();
      const user = users.find(
        (item) => item.email === email && normalizePhone(item.phone) === phone,
      );
      if (!user) {
        return res.status(400).json({ success: false, error: EMAIL_VERIFY_NOT_FOUND });
      }
      if (isStoredEmailVerified(user)) {
        return res.json({ success: true, user: publicUser(user), emailSent: true, message: EMAIL_VERIFY_ALREADY });
      }

      const issued = issueEmailVerification(user);
      saveUsers(users);
      const emailSent = await sendVerificationEmail(user.email, issued.code, issued.token);
      res.json({
        success: true,
        user: publicUser(user),
        message: emailSent ? EMAIL_RESEND_SENT : EMAIL_RESEND_FALLBACK,
        ...verificationPayload(emailSent, issued.code),
      });
    } catch {
      res.status(500).json({ success: false, error: 'تعذر إعادة إرسال رمز التأكيد.' });
    }
  }

  function verifyEmailTokenHandler(req: Request, res: Response) {
    try {
      const token = String(req.query?.token || req.body?.token || '').trim();
      if (!token || token.length < 16) {
        return res.status(400).json({ success: false, error: EMAIL_VERIFY_INVALID });
      }
      const users = loadUsers();
      const user = users.find(
        (item) =>
          item.emailVerifyTokenHash && verifyValueMatches(token, item.emailVerifyTokenHash, item.email),
      );
      if (!user) {
        return res.status(400).json({ success: false, error: EMAIL_VERIFY_INVALID });
      }
      if (isEmailVerificationExpired(user.emailVerifyExpiresAt) && user.emailVerified === false) {
        return res.status(400).json({ success: false, error: EMAIL_VERIFY_EXPIRED });
      }
      const published = markVerified(user, users);
      res.json({ success: true, user: published, message: EMAIL_VERIFY_SUCCESS });
    } catch {
      res.status(500).json({ success: false, error: 'تعذر تأكيد البريد. حاول مرة أخرى.' });
    }
  }

  return {
    userFromRequest,
    requireRole,
    loginHandler,
    registerHandler,
    meHandler,
    logoutHandler,
    listUsersHandler,
    createUserHandler,
    updateUserHandler,
    deleteUserHandler,
    addVendorUser,
    ensureApplicantUser,
    startSession,
    saveUserSocials,
    findUserByEmail,
    listVendorUsers,
    listUsersByRole,
    avatarHandler,
    forgotPasswordHandler,
    verifyEmailHandler,
    resendVerificationHandler,
    verifyEmailTokenHandler,
  };
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie || '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
