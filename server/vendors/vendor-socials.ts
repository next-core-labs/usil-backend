export const SOCIAL_NETWORKS = ['instagram', 'tiktok', 'snapchat', 'x', 'youtube', 'whatsapp'] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];
export type SocialLinkStatus = 'pending' | 'linked' | 'verified';

export const SOCIAL_LABELS: Record<SocialNetwork, string> = {
  instagram: 'إنستغرام',
  tiktok: 'تيك توك',
  snapchat: 'سناب شات',
  x: 'إكس (تويتر)',
  youtube: 'يوتيوب',
  whatsapp: 'واتساب أعمال',
};

export const SOCIAL_PLACEHOLDERS: Record<SocialNetwork, string> = {
  instagram: '@yourbrand أو instagram.com/yourbrand',
  tiktok: '@yourbrand أو tiktok.com/@yourbrand',
  snapchat: 'اسم المستخدم أو snapchat.com/add/yourbrand',
  x: '@yourbrand أو x.com/yourbrand',
  youtube: '@yourbrand أو youtube.com/@yourbrand',
  whatsapp: '05xxxxxxxx',
};

const HOSTS: Record<SocialNetwork, string[]> = {
  instagram: ['instagram.com'],
  tiktok: ['tiktok.com', 'vm.tiktok.com'],
  snapchat: ['snapchat.com'],
  x: ['x.com', 'twitter.com'],
  youtube: ['youtube.com', 'youtu.be', 'm.youtube.com'],
  whatsapp: ['wa.me', 'api.whatsapp.com', 'whatsapp.com'],
};

const HANDLE_RE = /^[A-Za-z0-9._]{2,30}$/;
const YT_HANDLE_RE = /^[A-Za-z0-9._-]{2,60}$/;

export type VendorSocialLink = {
  network: SocialNetwork;
  handle: string;
  url: string;
  status: SocialLinkStatus;
  confirmedOwn: boolean;
  updatedAt: string;
  verifiedAt?: string;
  verifiedBy?: string;
};

export type VendorSocials = {
  confirmedOwn: boolean;
  links: VendorSocialLink[];
};

export type VendorSocialsInput = Partial<Record<SocialNetwork, string>> & {
  confirmedOwn?: boolean;
  socials?: unknown;
  links?: unknown;
};

export function emptyVendorSocials(): VendorSocials {
  return { confirmedOwn: false, links: [] };
}

/** True only for an http(s) URL whose host belongs to that network — never `javascript:` or a look-alike. */
export function isSafeSocialUrl(network: SocialNetwork, raw: unknown): boolean {
  const url = asUrl(String(raw || '').trim());
  if (!url) return false;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  return isAllowedHost(network, hostOf(url));
}

/**
 * Repairs stored socials before they leave the server: drops unknown networks
 * and unsafe URLs, and only keeps «verified» when an admin stamp is present.
 */
export function sanitizeSocials(socials?: VendorSocials | null): VendorSocials {
  if (!socials || !Array.isArray(socials.links)) return emptyVendorSocials();
  const seen = new Set<SocialNetwork>();
  const links: VendorSocialLink[] = [];
  for (const raw of socials.links) {
    const link = raw as Partial<VendorSocialLink> | null;
    if (!link || !SOCIAL_NETWORKS.includes(link.network as SocialNetwork)) continue;
    const network = link.network as SocialNetwork;
    if (seen.has(network) || !isSafeSocialUrl(network, link.url)) continue;
    seen.add(network);
    const confirmedOwn = Boolean(link.confirmedOwn);
    const adminStamped = link.status === 'verified' && Boolean(link.verifiedAt) && Boolean(link.verifiedBy);
    links.push({
      network,
      handle: String(link.handle || ''),
      url: String(link.url).trim(),
      status: adminStamped ? 'verified' : confirmedOwn ? 'linked' : 'pending',
      confirmedOwn,
      updatedAt: String(link.updatedAt || ''),
      verifiedAt: adminStamped ? String(link.verifiedAt) : undefined,
      verifiedBy: adminStamped ? String(link.verifiedBy) : undefined,
    });
  }
  return { confirmedOwn: Boolean(socials.confirmedOwn), links };
}

export function publicSocials(socials?: VendorSocials | null): VendorSocialLink[] {
  return sanitizeSocials(socials).links;
}

export function hasLinkedSocials(socials?: VendorSocials | null): boolean {
  return publicSocials(socials).length > 0;
}

function stripDiacritics(value: string): string {
  return String(value || '').trim();
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^www\./i, '').toLowerCase();
}

function isAllowedHost(network: SocialNetwork, host: string): boolean {
  return HOSTS[network].some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function asUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function normalizeHandle(raw: string): string {
  return stripDiacritics(raw).replace(/^@+/, '').replace(/\/+$/, '');
}

export function normalizeSaudiWhatsApp(raw: string): { handle: string; url: string } | null {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  let local = digits;
  if (digits.startsWith('966') && digits.length >= 12) local = `0${digits.slice(3)}`;
  else if (digits.startsWith('5') && digits.length === 9) local = `0${digits}`;
  if (!/^05\d{8}$/.test(local)) return null;
  const intl = `966${local.slice(1)}`;
  return { handle: local, url: `https://wa.me/${intl}` };
}

function parseProfile(network: SocialNetwork, raw: string): { handle: string; url: string } | null {
  const value = stripDiacritics(raw);
  if (!value) return null;

  if (network === 'whatsapp') {
    const fromPhone = normalizeSaudiWhatsApp(value);
    if (fromPhone) return fromPhone;
    const url = asUrl(value.startsWith('http') ? value : `https://${value}`);
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || !isAllowedHost('whatsapp', hostOf(url))) {
      throw new Error('واتساب الأعمال لازم يكون رقم 05xxxxxxxx أو رابط wa.me');
    }
    const parsed = normalizeSaudiWhatsApp(url.pathname);
    if (!parsed) throw new Error('واتساب الأعمال لازم يكون رقم سعودي 05xxxxxxxx');
    return parsed;
  }

  const maybeUrl = !value.startsWith('@') && (value.startsWith('http') || value.includes('/'));
  if (maybeUrl) {
    const url = asUrl(value.startsWith('http') ? value : `https://${value.replace(/^\/+/, '')}`);
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      throw new Error(`رابط ${SOCIAL_LABELS[network]} غير صالح`);
    }
    if (!isAllowedHost(network, hostOf(url))) {
      throw new Error(`رابط ${SOCIAL_LABELS[network]} لازم يكون من موقع ${HOSTS[network][0]}`);
    }
    const parts = url.pathname.split('/').filter(Boolean);
    let handle = '';
    if (network === 'tiktok') {
      handle = normalizeHandle(parts.find((part) => part.startsWith('@')) || parts[0] || '');
    } else if (network === 'snapchat') {
      handle = normalizeHandle(parts[0] === 'add' ? parts[1] || '' : parts[0] || '');
    } else if (network === 'youtube') {
      const tagged = parts.find((part) => part.startsWith('@'));
      handle = normalizeHandle(tagged || parts[parts.length - 1] || '');
    } else {
      handle = normalizeHandle(parts[0] || '');
    }
    if (!handle) throw new Error(`اكتب معرف ${SOCIAL_LABELS[network]} أو الرابط الكامل`);
    return { handle, url: canonicalUrl(network, handle, url.toString()) };
  }

  const handle = normalizeHandle(value);
  const pattern = network === 'youtube' ? YT_HANDLE_RE : HANDLE_RE;
  if (!pattern.test(handle)) {
    throw new Error(`معرف ${SOCIAL_LABELS[network]} غير صالح`);
  }
  return { handle, url: canonicalUrl(network, handle) };
}

function canonicalUrl(network: SocialNetwork, handle: string, fallback?: string): string {
  switch (network) {
    case 'instagram':
      return `https://www.instagram.com/${handle}`;
    case 'tiktok':
      return `https://www.tiktok.com/@${handle}`;
    case 'snapchat':
      return `https://www.snapchat.com/add/${handle}`;
    case 'x':
      return `https://x.com/${handle}`;
    case 'youtube':
      return handle.startsWith('UC') && handle.length > 16
        ? `https://www.youtube.com/channel/${handle}`
        : `https://www.youtube.com/@${handle}`;
    case 'whatsapp':
      return normalizeSaudiWhatsApp(handle)?.url || fallback || '';
    default:
      return fallback || '';
  }
}

function asInputMap(raw: unknown): Partial<Record<SocialNetwork, string>> {
  const map: Partial<Record<SocialNetwork, string>> = {};
  if (!raw || typeof raw !== 'object') return map;
  const obj = raw as Record<string, unknown>;
  const source =
    obj.socials && typeof obj.socials === 'object' && !Array.isArray(obj.socials)
      ? (obj.socials as Record<string, unknown>)
      : obj;
  for (const network of SOCIAL_NETWORKS) {
    if (typeof source[network] === 'string') map[network] = source[network] as string;
  }
  if (Array.isArray(obj.links)) {
    for (const row of obj.links) {
      const item = row as { network?: string; handle?: string; url?: string; input?: string };
      if (item?.network && SOCIAL_NETWORKS.includes(item.network as SocialNetwork)) {
        map[item.network as SocialNetwork] = String(item.input || item.url || item.handle || '');
      }
    }
  }
  if (Array.isArray(source.links)) {
    for (const row of source.links as Array<{ network?: string; handle?: string; url?: string }>) {
      if (row?.network && SOCIAL_NETWORKS.includes(row.network as SocialNetwork)) {
        map[row.network as SocialNetwork] = String(row.url || row.handle || '');
      }
    }
  }
  return map;
}

export function isNormalizedSocials(raw: unknown): raw is VendorSocials {
  if (!raw || typeof raw !== 'object') return false;
  const links = (raw as VendorSocials).links;
  return (
    Array.isArray(links) &&
    links.every(
      (link) =>
        link &&
        SOCIAL_NETWORKS.includes(link.network) &&
        Boolean(link.url) &&
        (link.status === 'pending' || link.status === 'linked' || link.status === 'verified'),
    )
  );
}

export function parseVendorSocials(
  raw: unknown,
  options: { requireAtLeastOne?: boolean; previous?: VendorSocials | null } = {},
): VendorSocials {
  const obj = raw && typeof raw === 'object' ? (raw as VendorSocialsInput) : {};
  const nested = obj.socials && typeof obj.socials === 'object' ? (obj.socials as VendorSocialsInput) : obj;
  const confirmedOwn = Boolean(nested.confirmedOwn ?? obj.confirmedOwn);
  const map = asInputMap(raw);
  const previous = options.previous || emptyVendorSocials();
  const previousByNetwork = new Map(previous.links.map((link) => [link.network, link]));
  const now = new Date().toISOString();
  const links: VendorSocialLink[] = [];

  for (const network of SOCIAL_NETWORKS) {
    const value = String(map[network] || '').trim();
    if (!value) continue;
    const parsed = parseProfile(network, value);
    if (!parsed) continue;
    const prior = previousByNetwork.get(network);
    const sameUrl = prior?.url === parsed.url;
    let status: SocialLinkStatus = confirmedOwn ? 'linked' : 'pending';
    let verifiedAt = sameUrl ? prior?.verifiedAt : undefined;
    let verifiedBy = sameUrl ? prior?.verifiedBy : undefined;
    if (sameUrl && prior?.status === 'verified') {
      status = 'verified';
    }
    links.push({
      network,
      handle: parsed.handle,
      url: parsed.url,
      status,
      confirmedOwn,
      updatedAt: sameUrl && prior ? prior.updatedAt : now,
      verifiedAt,
      verifiedBy,
    });
  }

  if (options.requireAtLeastOne && !links.length) {
    throw new Error('اربط حساب تواصل واحد على الأقل عشان العميل يشوفه في ملف المورد');
  }

  return { confirmedOwn, links };
}

export function setSocialVerification(
  socials: VendorSocials | null | undefined,
  network: SocialNetwork,
  verified: boolean,
  actorName: string,
): VendorSocials {
  const current = socials || emptyVendorSocials();
  const link = current.links.find((item) => item.network === network);
  if (!link) throw new Error('هذا الحساب غير مربوط بعد');
  const now = new Date().toISOString();
  return {
    ...current,
    links: current.links.map((item) => {
      if (item.network !== network) return item;
      if (verified) {
        return {
          ...item,
          status: 'verified',
          verifiedAt: now,
          verifiedBy: actorName,
          updatedAt: now,
        };
      }
      return {
        ...item,
        status: item.confirmedOwn ? 'linked' : 'pending',
        verifiedAt: undefined,
        verifiedBy: undefined,
        updatedAt: now,
      };
    }),
  };
}

export function socialsFormValues(socials?: VendorSocials | null): Record<SocialNetwork, string> {
  const values = {
    instagram: '',
    tiktok: '',
    snapchat: '',
    x: '',
    youtube: '',
    whatsapp: '',
  } as Record<SocialNetwork, string>;
  for (const link of socials?.links || []) {
    values[link.network] = link.network === 'whatsapp' ? link.handle : link.url;
  }
  return values;
}

export function statusLabel(status: SocialLinkStatus): string {
  if (status === 'verified') return 'موثّق';
  if (status === 'linked') return 'مربوط';
  return 'بانتظار التوثيق';
}
