export const BRAND_NAVY = '#0A1A33';
export const BRAND_GOLD = '#C0A16B';

const FAKE_FACE_MARKERS = [
  'pravatar',
  'randomuser.me',
  'uifaces',
  'i.pravatar',
  'photo-1534528741775',
  'photo-1507003211169',
  'photo-1492562080023',
  'photo-1544005313',
  'photo-1500648767791',
  'photo-1494790108377',
  'photo-1506794778202',
  'photo-1472099645785',
  'photo-1438761681033',
  'photo-1577219491135',
];

export function userInitials(name: string): string {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return 'ي';
  if (parts.length === 1) return Array.from(parts[0]).slice(0, 2).join('');
  const first = Array.from(parts[0])[0] || 'ي';
  const last = Array.from(parts[parts.length - 1])[0] || '';
  return `${first}${last}`;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === '&') return '&amp;';
    if (char === '<') return '&lt;';
    if (char === '>') return '&gt;';
    if (char === '"') return '&quot;';
    return '&apos;';
  });
}

export function isFakeIdentityImage(url?: string): boolean {
  const value = String(url || '').toLowerCase();
  if (!value) return false;
  if (FAKE_FACE_MARKERS.some((marker) => value.includes(marker))) return true;
  if (value.includes('unsplash.com') && /[?&]w=150(?:&|$)/.test(value)) return true;
  return false;
}

export function initialsAvatarDataUrl(name: string, bg = BRAND_NAVY, fg = BRAND_GOLD): string {
  const initials = escapeXml(userInitials(name));
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="${initials}">
  <rect width="256" height="256" rx="36" fill="${bg}"/>
  <text x="128" y="150" text-anchor="middle" font-family="system-ui, Segoe UI, Tahoma, sans-serif" font-size="92" font-weight="700" fill="${fg}">${initials}</text>
</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export function resolveCatalogAvatar(name: string, url?: string): string {
  if (url && !isFakeIdentityImage(url) && (url.startsWith('/uploads/') || url.startsWith('data:image/'))) {
    return url;
  }
  return initialsAvatarDataUrl(name);
}
