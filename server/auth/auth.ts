import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';
import { AVATAR_MAX_BYTES, dataUrlProblem, resolveUserAvatar, saveUpload } from './avatar';
import { clientIp, createSlidingWindowLimiter } from '../shared/booking-guards';
import { FOUNDER_ADMIN_EMAIL, isDummyEmail, purgeLiveDummyData, wipeAllVendorsAndDummyMedia } from './dummy-accounts';
import { readJsonFile, writeJsonFile } from '../shared/json-file';
import {
  hasMailConfig,
  notifyPasswordChanged,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from '../shared/optional-mail';
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
  /** Password-reset code: only its scrypt hash is stored, never the code. */
  passwordResetCodeHash?: string;
  passwordResetExpiresAt?: number;
  passwordResetAttempts?: number;
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

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function cookieSecure(): boolean {
  if (process.env.COOKIE_SECURE === '0') return false;
  if (process.env.COOKIE_SECURE === '1') return true;
  return isProduction();
}

/** `usr-<timestamp>` alone collided when two accounts were created in the same millisecond. */
export function newUserId(): string {
  return `usr-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function isFounderEmail(email: string | undefined): boolean {
  return normalizeEmail(email || '') === FOUNDER_ADMIN_EMAIL;
}

/** Roles that manage other accounts. Only `admin` may grant, revoke or edit them. */
function isPrivilegedRole(role: string | undefined): boolean {
  return role === 'admin' || role === 'accounts_manager';
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
/**
 * Second guard keyed on the email alone, because rotating IPs resets the
 * IP+email budget. The ceiling is a trade-off: low enough to stop a distributed
 * guess run, high enough that a person mistyping never meets it and locking a
 * victim out takes a sustained, deliberate flood rather than a few requests.
 */
const LOGIN_ACCOUNT_LIMIT = 30;
const LOGIN_RATE_LIMIT = 'حدّ محاولات الدخول. انتظر 15 دقيقة ثم أعد المحاولة.';
/** One answer for unknown email, wrong phone and wrong password — no account probing. */
const LOGIN_INVALID = 'بيانات الدخول غير صحيحة. تحقق من البريد والجوال والرقم السري.';
/** Checked only when a password is set, so older shorter passwords still log in. */
const PASSWORD_MIN_LENGTH = 8;
const WEAK_PASSWORD = `الرقم السري ضعيف. استخدم ${PASSWORD_MIN_LENGTH} خانات على الأقل.`;
const RESET_RATE_LIMIT = 'حدّ المحاولات. انتظر 15 دقيقة ثم أعد المحاولة.';
const RESET_SUCCESS = 'تم تغيير الرقم السري. ادخل الآن.';
const RESET_CODE_TTL_MS = 15 * 60 * 1000;
const RESET_MAX_ATTEMPTS = 5;
const RESET_EMAIL_REQUIRED = 'أدخل بريداً إلكترونياً صحيحاً.';
/** Same wording whether or not the account exists. */
const RESET_REQUEST_SENT = 'إن كان البريد مسجّلاً لدينا فسيصلك رمز استعادة من 6 أرقام، صالح لمدة 15 دقيقة.';
const RESET_REQUEST_FALLBACK = 'البريد غير مفعّل على الخادم المحلي، فالرمز يظهر هنا مرة واحدة للتجربة.';
const RESET_FIELDS_REQUIRED = 'البريد الإلكتروني ورمز الاستعادة والرقم السري الجديد مطلوبة.';
const RESET_CODE_INVALID = 'رمز الاستعادة غير صحيح أو انتهت صلاحيته. اطلب رمزاً جديداً.';
const RESERVED_EMAIL = 'هذا البريد محجوز لإدارة يوصل.';
const ADMIN_CONTACT_INVALID = 'اكتب بريداً إلكترونياً صحيحاً ورقم جوال صحيحاً (9 أرقام على الأقل).';

/** Shape check for contacts an admin types in; register already requires the same. */
function isPlausibleContact(email: string, phone: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && phone.replace(/\D/g, '').length >= 9;
}

const FOUNDER_LOCKED = 'حساب الإدارة الرئيسي لا يعدّله إلا صاحبه، وبريده ثابت لا يتغيّر.';
/** Production has no on-screen fallback: the code would prove nothing about the mailbox. */
const EMAIL_UNSENT = 'تعذر إرسال رمز التأكيد إلى بريدك الآن. حاول لاحقاً أو تواصل مع الدعم.';
const PRIVILEGED_ONLY = 'إدارة حسابات المدراء متاحة لمدير كل الحسابات فقط.';
const SELF_ROLE_LOCKED = 'لا يمكنك تغيير صلاحية حسابك.';
export const APPLICANT_LOGIN_REQUIRED = 'البريد أو رقم الجوال مسجّل لحساب موجود. سجّل الدخول بذلك الحساب أولاً ثم أرسل الطلب.';

/** Thrown when a vendor application names someone else's account. */
export class ApplicantAccountConflictError extends Error {
  readonly status = 409;
  constructor() {
    super(APPLICANT_LOGIN_REQUIRED);
  }
}

let warnedNoMail = false;

export function createAuth(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
  if (isProduction() && !hasMailConfig() && !warnedNoMail) {
    warnedNoMail = true;
    console.warn(
      'SMTP is not configured: verification and password-reset codes cannot be delivered, and production never returns them in API responses.',
    );
  }
  const forgotLimiter = createSlidingWindowLimiter(FORGOT_LIMIT, FORGOT_WINDOW_MS);
  const resetLimiter = createSlidingWindowLimiter(FORGOT_LIMIT * 2, FORGOT_WINDOW_MS);
  const loginLimiter = createSlidingWindowLimiter(LOGIN_LIMIT, LOGIN_WINDOW_MS);
  const loginAccountLimiter = createSlidingWindowLimiter(LOGIN_ACCOUNT_LIMIT, LOGIN_WINDOW_MS);
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

  function clearPasswordReset(user: StoredUser) {
    delete user.passwordResetCodeHash;
    delete user.passwordResetExpiresAt;
    delete user.passwordResetAttempts;
  }

  /**
   * The on-screen code is a local-dev convenience only. In production it would
   * let anyone "verify" an email they don't own, and a verified email unlocks
   * guest orders placed with it — so production just says the mail failed.
   */
  function verificationPayload(emailSent: boolean, code: string, sentMessage: string, devMessage: string) {
    if (emailSent) return { emailSent: true as const, message: sentMessage };
    if (isProduction()) return { emailSent: false as const, message: EMAIL_UNSENT };
    return { emailSent: false as const, message: devMessage, verificationCode: code };
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
  ensureOwnerAccount();

  /**
   * The first admin, for a host with no shell to edit users.json on (Render Free).
   * With OWNER_EMAIL and OWNER_PASSWORD set, boot creates that admin — but only while
   * no admin exists, so a restart never resets a changed password, and the variables
   * go inert once a real user store with its own admins is in place.
   */
  function ensureOwnerAccount() {
    const email = normalizeEmail(env.OWNER_EMAIL || '');
    const password = String(env.OWNER_PASSWORD || '');
    if (!email && !password) return;
    const users = seedUsers();
    if (users.some((item) => item.role === 'admin')) return;
    if (!email.includes('@') || password.length < PASSWORD_MIN_LENGTH) {
      console.warn('OWNER_EMAIL / OWNER_PASSWORD ignored: needs a valid email and a password of 8+ characters.');
      return;
    }
    // A reserved or dummy address would be refused or purged on the next boot.
    if (isFounderEmail(email) || isDummyEmail(email)) {
      console.warn(`OWNER_EMAIL ignored: ${email} is a reserved address.`);
      return;
    }
    if (users.some((item) => item.email === email)) {
      console.warn(`OWNER_EMAIL ignored: ${email} already has a non-admin account.`);
      return;
    }
    users.push({
      id: newUserId(),
      name: 'مالك يوصل',
      email,
      phone: normalizePhone(env.OWNER_PHONE || ''),
      role: 'admin',
      passwordHash: hashPassword(password),
      avatarUrl: '',
      emailVerified: true,
    });
    saveUsers(users);
    console.log(`Created the owner admin ${email} from OWNER_EMAIL.`);
  }

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
    for (const user of users) {
      if (user.passwordResetCodeHash && isEmailVerificationExpired(user.passwordResetExpiresAt)) {
        clearPasswordReset(user);
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
      if (
        !loginLimiter.allow(`${clientIp(req)}:${email}`) ||
        (email && !loginAccountLimiter.allow(email))
      ) {
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
        const application = readJson<{ status?: string; email?: string; passwordHash?: string }[]>(
          path.join(dataDir, 'vendor-applications.json'),
          [],
        ).find((row) => row.email === email);
        // The application status is only revealed to someone who knows its password.
        const pending =
          application?.passwordHash && verifyPassword(password, application.passwordHash) ? application : null;
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
        return res.status(401).json({ success: false, error: LOGIN_INVALID });
      }
      const passwordOk = verifyPassword(password, user.passwordHash);
      if (!passwordOk || (phone && normalizePhone(user.phone) !== phone)) {
        return res.status(401).json({ success: false, error: LOGIN_INVALID });
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
      if (password.length < PASSWORD_MIN_LENGTH) {
        return res.status(400).json({ success: false, error: WEAK_PASSWORD });
      }

      // Public sign-up never creates an admin. The founder address is reserved:
      // registering it used to mint the platform's top admin for whoever got there first.
      if (isFounderEmail(email)) {
        return res.status(409).json({ success: false, error: RESERVED_EMAIL });
      }

      const users = loadUsers();
      if (users.some((item) => item.email === email)) {
        return res.status(409).json({ success: false, error: 'هذا البريد مسجّل مسبقاً.' });
      }
      if (users.some((item) => normalizePhone(item.phone) === phone)) {
        return res.status(409).json({ success: false, error: 'رقم الجوال مسجّل مسبقاً.' });
      }

      const user: StoredUser = {
        id: newUserId(),
        name,
        email,
        phone,
        role: 'client',
        passwordHash: hashPassword(password),
        avatarUrl: '',
        emailVerified: false,
      };
      attachAvatarFromBody(user, req.body);
      const issued = issueEmailVerification(user);
      users.push(user);
      saveUsers(users);

      const token = crypto.randomBytes(24).toString('hex');
      const sessions = loadSessions();
      sessions[token] = user.id;
      saveSessions(sessions);
      setSessionCookie(res, token);
      const emailSent = await sendVerificationEmail(user.email, issued.code, issued.token);
      res.status(201).json({
        success: true,
        user: publicUser(user),
        needsEmailVerification: true,
        ...verificationPayload(
          emailSent,
          issued.code,
          'أدخل رمز التأكيد المرسل إلى بريدك.',
          'أدخل رمز التأكيد. يظهر مرة واحدة هنا لأن البريد غير مفعّل.',
        ),
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

  /**
   * `accounts_manager` runs client/vendor/courier accounts only. Anything that
   * touches an admin/accounts_manager account — or grants one of those roles —
   * is reserved for `admin`.
   */
  function actorMayTouchRole(actor: PublicUser, role: string | undefined): boolean {
    return !isPrivilegedRole(role) || actor.role === 'admin';
  }

  function listUsersHandler(req: Request, res: Response) {
    if (!requireAdmin(req, res)) return;
    res.json({ success: true, data: loadUsers().map(publicUser) });
  }

  function createUserHandler(req: Request, res: Response) {
    const actor = requireAdmin(req, res);
    if (!actor) return;
    const email = normalizeEmail(req.body?.email);
    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.password || '');
    const name = String(req.body?.name || '').trim();
    const role = String(req.body?.role || 'client') as AccountRole;
    if (!email || !phone || !password || !name) {
      return res.status(400).json({ success: false, error: 'الاسم والبريد والجوال والرقم السري مطلوبة.' });
    }
    if (!isPlausibleContact(email, phone)) {
      return res.status(400).json({ success: false, error: ADMIN_CONTACT_INVALID });
    }
    if (!isAccountRole(role)) {
      return res.status(400).json({ success: false, error: 'نوع الحساب غير صالح.' });
    }
    if (!actorMayTouchRole(actor, role)) {
      return res.status(403).json({ success: false, error: PRIVILEGED_ONLY });
    }
    if (isFounderEmail(email)) {
      return res.status(409).json({ success: false, error: RESERVED_EMAIL });
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      return res.status(400).json({ success: false, error: WEAK_PASSWORD });
    }

    const users = loadUsers();
    if (users.some((item) => item.email === email)) {
      return res.status(409).json({ success: false, error: 'هذا البريد مسجّل مسبقاً.' });
    }
    if (users.some((item) => normalizePhone(item.phone) === phone)) {
      return res.status(409).json({ success: false, error: 'رقم الجوال مسجّل مسبقاً.' });
    }

    const user: StoredUser = {
      id: newUserId(),
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
    if (!actorMayTouchRole(actor, user.role) || !actorMayTouchRole(actor, nextRole)) {
      return res.status(403).json({ success: false, error: PRIVILEGED_ONLY });
    }
    const isSelf = user.id === actor.id;
    const founder = isFounderEmail(user.email);
    // Nobody else edits the founder at all: a field-by-field lock kept leaving
    // gaps (name, avatar, the verified flag) for another admin to deface.
    if (founder && !isSelf) {
      return res.status(403).json({ success: false, error: FOUNDER_LOCKED });
    }
    if (isSelf && nextRole !== user.role) {
      return res.status(403).json({ success: false, error: SELF_ROLE_LOCKED });
    }

    const nextEmail = req.body?.email ? normalizeEmail(req.body.email) : user.email;
    const emailChanges = nextEmail !== user.email;
    // The founder's own email is frozen too: changing it first and then
    // demoting the account was the way around the role lock.
    if (founder && emailChanges) {
      return res.status(403).json({ success: false, error: FOUNDER_LOCKED });
    }
    if (!founder && emailChanges && isFounderEmail(nextEmail)) {
      return res.status(409).json({ success: false, error: RESERVED_EMAIL });
    }

    const adminCount = users.filter((item) => item.role === 'admin').length;
    if (user.role === 'admin' && nextRole !== 'admin' && adminCount <= 1) {
      return res.status(400).json({ success: false, error: 'لا يمكن إزالة آخر مدير لكل الحسابات.' });
    }

    // Check only what changes, so legacy rows stay editable.
    const badEmail = emailChanges && !isPlausibleContact(nextEmail, '000000000');
    const badPhone = Boolean(req.body?.phone) && !isPlausibleContact('a@b.co', normalizePhone(req.body.phone));
    if (badEmail || badPhone) {
      return res.status(400).json({ success: false, error: ADMIN_CONTACT_INVALID });
    }

    let nextPhone = user.phone;
    if (req.body?.phone) {
      nextPhone = normalizePhone(req.body.phone);
      if (users.some((item) => item.id !== user.id && normalizePhone(item.phone) === nextPhone)) {
        return res.status(409).json({ success: false, error: 'رقم الجوال مسجّل مسبقاً.' });
      }
    }
    if (emailChanges && users.some((item) => item.id !== user.id && item.email === nextEmail)) {
      return res.status(409).json({ success: false, error: 'هذا البريد مسجّل مسبقاً.' });
    }
    let nextPasswordHash = user.passwordHash;
    if (req.body?.password) {
      const password = String(req.body.password);
      if (password.length < PASSWORD_MIN_LENGTH) {
        return res.status(400).json({ success: false, error: WEAK_PASSWORD });
      }
      nextPasswordHash = hashPassword(password);
    }

    // Every check has passed — only now touch the stored row.
    if (req.body?.name) user.name = String(req.body.name).trim() || user.name;
    user.phone = nextPhone;
    user.email = nextEmail;
    user.role = nextRole;
    user.passwordHash = nextPasswordHash;
    if (req.body?.avatarDataUrl || req.body?.avatarUrl) {
      attachAvatarFromBody(user, req.body);
    }
    if (req.body?.emailVerified === true) {
      clearEmailVerificationSecrets(user);
    } else if (req.body?.emailVerified === false) {
      user.emailVerified = false;
    }
    saveUsers(users);
    if (req.body?.password && !isSelf) invalidateUserSessions(user.id);
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

  /**
   * Whose account does a vendor application name? `new` when neither the email
   * nor the phone is registered, `self` when both point at the signed-in
   * requester, `conflict` otherwise — an application must never take over an
   * account the requester has not logged into.
   */
  function checkApplicantAccount(
    input: { email: string; phone: string },
    actorId: string | null | undefined,
  ): 'new' | 'self' | 'conflict' {
    const users = loadUsers();
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone);
    const matches = users.filter(
      (item) => (email && item.email === email) || (phone && normalizePhone(item.phone) === phone),
    );
    if (matches.length === 0) return 'new';
    if (actorId && matches.every((item) => item.id === actorId)) return 'self';
    return 'conflict';
  }

  function ensureApplicantUser(
    input: {
      name: string;
      email: string;
      phone: string;
      passwordHash: string;
      avatarUrl?: string;
    },
    actorId?: string | null,
  ): PublicUser {
    const ownership = checkApplicantAccount(input, actorId);
    if (ownership === 'conflict') throw new ApplicantAccountConflictError();
    const users = loadUsers();
    if (ownership === 'self') {
      // The requester's own account: an application never rewrites its
      // password, name, phone, role or verification state.
      const own = users.find((item) => item.id === actorId);
      if (own) return publicUser(own);
      throw new ApplicantAccountConflictError();
    }
    const user: StoredUser = {
      id: newUserId(),
      name: input.name,
      email: normalizeEmail(input.email),
      phone: normalizePhone(input.phone),
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
      // Approval grants the vendor role; it never rewrites the account's
      // password, name or phone from the application, and never demotes staff.
      if (!isPrivilegedRole(existing.role)) existing.role = 'vendor';
      if (input.avatarUrl) existing.avatarUrl = input.avatarUrl;
      if (input.avatarDataUrl) attachAvatarFromBody(existing, input);
      else existing.avatarUrl = resolveUserAvatar(dataDir, existing);
      if (input.socials) existing.socials = input.socials;
      saveUsers(users);
      return publicUser(existing);
    }
    const user: StoredUser = {
      id: newUserId(),
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
    if (isFounderEmail(user.email)) {
      return res.status(400).json({ success: false, error: 'لا يمكن حذف حساب الإدارة الرئيسي.' });
    }
    if (!actorMayTouchRole(actor, user.role)) {
      return res.status(403).json({ success: false, error: PRIVILEGED_ONLY });
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

  /**
   * Step 1 of the reset: mail a 6-digit code. The answer is identical whether
   * or not the email is registered, so this cannot be used to probe accounts.
   */
  async function forgotPasswordHandler(req: Request, res: Response) {
    try {
      const ip = clientIp(req);
      const email = normalizeEmail(req.body?.email);
      if (!forgotLimiter.allow(ip) || (email && !forgotLimiter.allow(`email:${email}`))) {
        return res.status(429).json({ success: false, error: RESET_RATE_LIMIT });
      }
      if (!email || !email.includes('@')) {
        return res.status(400).json({ success: false, error: RESET_EMAIL_REQUIRED });
      }

      const users = loadUsers();
      const user = users.find((item) => item.email === email);
      const code = generateSixDigitCode();
      // Hash even for unknown emails so both paths cost the same.
      const codeHash = hashPassword(`reset:${code}`);
      let resetCode: string | undefined;
      if (user) {
        user.passwordResetCodeHash = codeHash;
        user.passwordResetExpiresAt = Date.now() + RESET_CODE_TTL_MS;
        user.passwordResetAttempts = 0;
        saveUsers(users);
        if (isProduction()) {
          // Do not let SMTP latency tell registered and unknown emails apart.
          void sendPasswordResetEmail(user.email, code).catch(() => undefined);
        } else if (!(await sendPasswordResetEmail(user.email, code))) {
          // Local runs without SMTP, mirroring register's `verificationCode`.
          resetCode = code;
        }
      }
      res.json({
        success: true,
        message: resetCode ? RESET_REQUEST_FALLBACK : RESET_REQUEST_SENT,
        ...(resetCode ? { resetCode } : {}),
      });
    } catch {
      res.status(500).json({ success: false, error: 'تعذر استعادة الحساب. حاول مرة أخرى.' });
    }
  }

  /** Step 2: the mailed code plus a new password. Five wrong codes burn the code. */
  function resetPasswordHandler(req: Request, res: Response) {
    try {
      const ip = clientIp(req);
      if (!resetLimiter.allow(ip)) {
        return res.status(429).json({ success: false, error: RESET_RATE_LIMIT });
      }
      const email = normalizeEmail(req.body?.email);
      const code = String(req.body?.code || '').replace(/\D/g, '');
      const newPassword = String(req.body?.newPassword || '');
      if (!email || !code || !newPassword) {
        return res.status(400).json({ success: false, error: RESET_FIELDS_REQUIRED });
      }
      if (newPassword.length < PASSWORD_MIN_LENGTH) {
        return res.status(400).json({ success: false, error: WEAK_PASSWORD });
      }

      const users = loadUsers();
      const user = users.find((item) => item.email === email);
      if (!user?.passwordResetCodeHash) {
        return res.status(400).json({ success: false, error: RESET_CODE_INVALID });
      }
      if (
        isEmailVerificationExpired(user.passwordResetExpiresAt) ||
        (user.passwordResetAttempts || 0) >= RESET_MAX_ATTEMPTS
      ) {
        clearPasswordReset(user);
        saveUsers(users);
        return res.status(400).json({ success: false, error: RESET_CODE_INVALID });
      }
      // scrypt + timingSafeEqual: constant-time compare of the stored hash.
      if (!isSixDigitCode(code) || !verifyPassword(`reset:${code}`, user.passwordResetCodeHash)) {
        user.passwordResetAttempts = (user.passwordResetAttempts || 0) + 1;
        if (user.passwordResetAttempts >= RESET_MAX_ATTEMPTS) clearPasswordReset(user);
        saveUsers(users);
        return res.status(400).json({ success: false, error: RESET_CODE_INVALID });
      }

      user.passwordHash = hashPassword(newPassword);
      clearPasswordReset(user);
      // The code arrived by email, so the mailbox is proven.
      if (isProduction() && !isStoredEmailVerified(user)) clearEmailVerificationSecrets(user);
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
    const dataUrl = String(req.body?.avatarDataUrl || req.body?.avatarUrl || '');
    const problem = dataUrlProblem(dataUrl, AVATAR_MAX_BYTES);
    if (problem) {
      return res.status(400).json({
        success: false,
        error:
          problem === 'size'
            ? 'حجم الصورة كبير — الحد الأقصى 2 ميغابايت.'
            : 'الصيغة غير مدعومة — ارفع صورة jpg أو png أو webp.',
      });
    }
    const users = loadUsers();
    const user = users.find((item) => item.id === actor.id);
    if (!user) return res.status(404).json({ success: false, error: 'الحساب غير موجود.' });
    attachAvatarFromBody(user, req.body);
    saveUsers(users);
    res.json({ success: true, user: publicUser(user) });
  }

  /** `{ user }` only when the request's own session is that account. */
  function ownUserOnly(req: Request, user: StoredUser): { user?: PublicUser } {
    return userFromRequest(req)?.id === user.id ? { user: publicUser(user) } : {};
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
        // No code was checked here, so only the signed-in owner gets the account
        // back — otherwise any email returned that account's id, phone and role.
        return res.json({ success: true, message: EMAIL_VERIFY_ALREADY, ...ownUserOnly(req, user) });
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
      // Email + phone is not proof of ownership, so the account itself only
      // goes back to its signed-in owner.
      if (isStoredEmailVerified(user)) {
        return res.json({ success: true, emailSent: true, message: EMAIL_VERIFY_ALREADY, ...ownUserOnly(req, user) });
      }

      const issued = issueEmailVerification(user);
      saveUsers(users);
      const emailSent = await sendVerificationEmail(user.email, issued.code, issued.token);
      res.json({
        success: true,
        ...ownUserOnly(req, user),
        ...verificationPayload(emailSent, issued.code, EMAIL_RESEND_SENT, EMAIL_RESEND_FALLBACK),
      });
    } catch {
      res.status(500).json({ success: false, error: 'تعذر إعادة إرسال رمز التأكيد.' });
    }
  }

  /**
   * The emailed link. A browser lands back on the SPA with `?emailVerified=1`
   * (or `0` plus a reason); API callers asking for JSON still get JSON.
   */
  function verifyEmailTokenHandler(req: Request, res: Response) {
    const wantsHtml = req.method === 'GET' && req.accepts(['json', 'html']) === 'html';
    const done = (status: number, body: Record<string, unknown>, reason?: 'invalid' | 'expired' | 'error') => {
      if (wantsHtml) {
        return res.redirect(302, reason ? `/?emailVerified=0&reason=${reason}` : '/?emailVerified=1');
      }
      return res.status(status).json(body);
    };
    try {
      const token = String(req.query?.token || req.body?.token || '').trim();
      if (!token || token.length < 16) {
        return done(400, { success: false, error: EMAIL_VERIFY_INVALID }, 'invalid');
      }
      const users = loadUsers();
      const user = users.find(
        (item) =>
          item.emailVerifyTokenHash && verifyValueMatches(token, item.emailVerifyTokenHash, item.email),
      );
      if (!user) {
        return done(400, { success: false, error: EMAIL_VERIFY_INVALID }, 'invalid');
      }
      if (isEmailVerificationExpired(user.emailVerifyExpiresAt) && user.emailVerified === false) {
        return done(400, { success: false, error: EMAIL_VERIFY_EXPIRED }, 'expired');
      }
      const published = markVerified(user, users);
      return done(200, { success: true, user: published, message: EMAIL_VERIFY_SUCCESS });
    } catch {
      return done(500, { success: false, error: 'تعذر تأكيد البريد. حاول مرة أخرى.' }, 'error');
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
    checkApplicantAccount,
    ensureApplicantUser,
    startSession,
    saveUserSocials,
    findUserByEmail,
    listVendorUsers,
    listUsersByRole,
    avatarHandler,
    forgotPasswordHandler,
    resetPasswordHandler,
    verifyEmailHandler,
    resendVerificationHandler,
    verifyEmailTokenHandler,
  };
}

export function parseCookies(req: { headers: { cookie?: string } }): Record<string, string> {
  const header = req.headers.cookie || '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      out[part.slice(0, idx).trim()] = decodeURIComponent(raw);
    } catch {
      // A malformed value (e.g. a stray `%`) is skipped, not a 500.
    }
  }
  return out;
}
