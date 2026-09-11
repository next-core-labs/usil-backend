export const ACCOUNT_ROLES = ['client', 'vendor', 'admin', 'accounts_manager', 'courier'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export const ROLE_LABEL_AR: Record<AccountRole, string> = {
  client: 'عميل',
  vendor: 'مورّد',
  admin: 'مدير كل الحسابات',
  accounts_manager: 'مدير الحسابات',
  courier: 'مندوب توصيل',
};

export function isAccountRole(value: string): value is AccountRole {
  return (ACCOUNT_ROLES as readonly string[]).includes(value);
}

export function isVendorSupervisor(role?: string | null): boolean {
  return role === 'admin' || role === 'accounts_manager';
}

export function isAdminDashboardRole(role?: string | null): boolean {
  return isVendorSupervisor(role);
}

export function canUseVendorHub(role?: string | null): boolean {
  return role === 'vendor' || isVendorSupervisor(role);
}

/** المندوب يسجّل حجزه الخارجي، والإدارة تسجّل نيابة عنه. */
export function canFileExternalBooking(role?: string | null): boolean {
  return role === 'courier' || isVendorSupervisor(role);
}

export function roleAllowed(userRole: string | null | undefined, roles: readonly string[]): boolean {
  if (!userRole) return false;
  if (roles.includes(userRole)) return true;
  return userRole === 'accounts_manager' && roles.includes('admin');
}

export function dashboardFor(role?: string | null): 'client' | 'vendor' | 'admin' {
  if (isAdminDashboardRole(role)) return 'admin';
  if (role === 'vendor') return 'vendor';
  return 'client';
}

export function roleLabelAr(role?: string | null): string {
  if (role && isAccountRole(role)) return ROLE_LABEL_AR[role];
  return role || '';
}
