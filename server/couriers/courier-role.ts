import path from 'path';
import { readJsonArray, writeJsonFile } from '../shared/json-file.ts';

/**
 * What happened to the applicant's account when their courier application was
 * approved. The approval itself always stands; this only reports the role side.
 */
export type CourierAccountOutcome =
  | { status: 'promoted'; userId: string; previousRole: 'client' }
  | { status: 'already_courier'; userId: string }
  | { status: 'protected_role'; userId: string; role: string }
  | { status: 'not_found'; userId: string }
  | { status: 'not_linked' };

type StoredUserRow = { id: string; email?: string; phone?: string; role?: string } & Record<string, unknown>;

/** Roles an approval must never overwrite — staff and vendors keep their access. */
const PROTECTED_ROLES = new Set(['admin', 'accounts_manager', 'vendor']);

export function usersFilePath(dataDir: string) {
  return path.join(dataDir, 'users.json');
}

/**
 * Give the applicant's account the courier role. Only the account that was
 * signed in when the application was filed is linked — an email or phone typed
 * into an anonymous form proves nothing, so it never selects an account.
 * Only client accounts are changed.
 */
export function grantCourierRole(dataDir: string, applicantUserId?: string): CourierAccountOutcome {
  if (!applicantUserId) return { status: 'not_linked' };

  const file = usersFilePath(dataDir);
  const users = readJsonArray<StoredUserRow>(file);
  const user = users.find((row) => row.id === applicantUserId);
  if (!user) return { status: 'not_found', userId: applicantUserId };

  const role = String(user.role || 'client');
  if (role === 'courier') return { status: 'already_courier', userId: user.id };
  if (PROTECTED_ROLES.has(role) || role !== 'client') {
    // Unknown roles are left alone too: only a plain client is promoted.
    return { status: 'protected_role', userId: user.id, role };
  }
  user.role = 'courier';
  writeJsonFile(file, users);
  return { status: 'promoted', userId: user.id, previousRole: 'client' };
}

/** Arabic note for the admin who approved the application. */
export function courierAccountNote(outcome: CourierAccountOutcome): string {
  switch (outcome.status) {
    case 'promoted':
      return 'تم اعتماد الطلب وتحويل حساب المتقدّم إلى مندوب توصيل.';
    case 'already_courier':
      return 'تم اعتماد الطلب — حساب المتقدّم مندوب توصيل من قبل.';
    case 'protected_role':
      return 'تم اعتماد الطلب، لكن الحساب المطابق له صلاحية أخرى (مدير أو مورّد) فلم نغيّر دوره. أنشئ للمندوب حساباً مستقلاً.';
    case 'not_found':
      return 'تم اعتماد الطلب، لكن حساب المتقدّم لم يعد موجوداً. يلزم إنشاء حساب للمندوب من إدارة الحسابات بدور «مندوب توصيل».';
    case 'not_linked':
    default:
      return 'تم اعتماد الطلب، لكنه أُرسل دون تسجيل دخول فلم نربطه بحساب. يلزم إنشاء حساب للمندوب من إدارة الحسابات بدور «مندوب توصيل».';
  }
}
