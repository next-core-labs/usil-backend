import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { isFakeIdentityImage } from '../../core/utils/brandedAvatar';

export const BRAND_NAVY = '#0A1A33';
export const BRAND_GOLD = '#C0A16B';

/**
 * Raster formats only. SVG is never accepted from users: served from our
 * origin it can carry script (stored XSS). The branded avatars the server
 * writes itself are the only SVGs under /uploads.
 */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/** The file's first bytes must match the declared type, not just the data-URL label. */
export function sniffImageMime(buffer: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function declaredMatchesContent(declared: string, buffer: Buffer): boolean {
  const actual = sniffImageMime(buffer);
  if (!actual) return false;
  return actual === (declared === 'image/jpg' ? 'image/jpeg' : declared);
}

/**
 * Filename prefixes by upload purpose. The caller picks a purpose; the server
 * picks the prefix — free text from the request never reaches the filename.
 */
export const UPLOAD_PREFIX_BY_PURPOSE: Readonly<Record<string, string>> = {
  listing: 'listing',
  avatar: 'avatar',
  logo: 'vendor-logo',
  'vendor-logo': 'vendor-logo',
};

export function uploadPrefixForPurpose(purpose: unknown): string {
  const key = String(purpose || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(UPLOAD_PREFIX_BY_PURPOSE, key) ? UPLOAD_PREFIX_BY_PURPOSE[key] : 'upload';
}

function safeFilePrefix(prefix: string): string {
  return String(prefix || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'upload';
}

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

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

export function brandedAvatarSvg(name: string, bg = BRAND_NAVY, fg = BRAND_GOLD): string {
  const initials = escapeXml(userInitials(name));
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="${initials}">
  <rect width="256" height="256" rx="36" fill="${bg}"/>
  <text x="128" y="150" text-anchor="middle" font-family="system-ui, Segoe UI, Tahoma, sans-serif" font-size="92" font-weight="700" fill="${fg}">${initials}</text>
</svg>`;
}

export function uploadsDir(dataDir: string): string {
  const dir = path.join(dataDir, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function parseDataUrl(dataUrl: string, maxBytes = AVATAR_MAX_BYTES): { mime: string; buffer: Buffer } | null {
  const match = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  if (!MIME_EXT[mime]) return null;
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length || buffer.length > maxBytes) return null;
  if (!declaredMatchesContent(mime, buffer)) return null;
  return { mime, buffer };
}

/** Tells apart the two rejection reasons so the API can answer in Arabic. */
export function dataUrlProblem(dataUrl: string, maxBytes = AVATAR_MAX_BYTES): 'format' | 'size' | null {
  const match = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match || !MIME_EXT[match[1].toLowerCase()]) return 'format';
  const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!bytes.length) return 'format';
  if (bytes.length > maxBytes) return 'size';
  if (!declaredMatchesContent(match[1].toLowerCase(), bytes)) return 'format';
  return null;
}

export function saveUpload(dataDir: string, prefix: string, dataUrl: string, maxBytes = AVATAR_MAX_BYTES): string | null {
  const parsed = parseDataUrl(dataUrl, maxBytes);
  if (!parsed) return null;
  const filename = `${safeFilePrefix(prefix)}-${crypto.randomBytes(8).toString('hex')}${MIME_EXT[parsed.mime]}`;
  fs.writeFileSync(path.join(uploadsDir(dataDir), filename), parsed.buffer);
  return `/uploads/${filename}`;
}

export function saveGeneratedAvatar(dataDir: string, userId: string, name: string): string {
  const filename = `avatar-${String(userId).replace(/[^a-zA-Z0-9_-]/g, '') || 'user'}.svg`;
  fs.writeFileSync(path.join(uploadsDir(dataDir), filename), brandedAvatarSvg(name), 'utf-8');
  return `/uploads/${filename}`;
}

export function resolveUserAvatar(
  dataDir: string,
  user: { id: string; name: string; avatarUrl?: string },
): string {
  if (isFakeIdentityImage(user.avatarUrl)) {
    return saveGeneratedAvatar(dataDir, user.id, user.name);
  }
  if (user.avatarUrl?.startsWith('/uploads/')) {
    const file = path.join(uploadsDir(dataDir), path.basename(user.avatarUrl));
    if (fs.existsSync(file)) return user.avatarUrl;
  }
  if (user.avatarUrl?.startsWith('data:image/')) {
    const saved = saveUpload(dataDir, `avatar-${user.id}`, user.avatarUrl);
    if (saved) return saved;
  }
  return saveGeneratedAvatar(dataDir, user.id, user.name);
}

/** CSP for the server's own SVG avatars: no script, no network, sandboxed if opened directly. */
export const UPLOADS_SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/**
 * `setHeaders` for the `/uploads` static mount. `nosniff` stops a browser from
 * second-guessing the type; any `.svg` (only the branded avatars we generate)
 * is locked down so even a planted file cannot run script on our origin.
 */
export function setUploadsHeaders(res: { setHeader: (name: string, value: string) => unknown }, filePath: string): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (path.extname(filePath).toLowerCase() === '.svg') {
    res.setHeader('Content-Security-Policy', UPLOADS_SVG_CSP);
  }
}
