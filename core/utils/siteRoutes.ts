export const KNOWN_SPA_PATHS = [
  '/',
  '/about',
  '/privacy',
  '/terms',
  '/refund',
  '/cancellation',
  '/support',
  '/hospitality',
  '/courier',
  '/offline',
  '/payment/success',
  '/payment/cancelled',
  '/catalog',
  '/services',
  '/compare',
  '/cart',
  '/checkout',
  '/orders',
  '/account',
  '/chat',
  '/login',
  '/request',
  '/providers',
] as const;

/** Storefront screens from the redesign. `null` is the home page. */
export type StorefrontScreen =
  | 'catalog'
  | 'compare'
  | 'product'
  | 'cart'
  | 'checkout'
  | 'orders'
  | 'account'
  | 'chat'
  | 'login'
  | 'request'
  | 'providers';

export type SitePage =
  | 'privacy'
  | 'terms'
  | 'refund'
  | 'support'
  | 'about'
  | 'payment-success'
  | 'payment-cancelled'
  | 'vendor-file'
  | 'notfound'
  | StorefrontScreen
  | null;

export type LocationIntent = {
  sitePage: SitePage;
  hospitality: boolean;
  courier: boolean;
  vendorPublicId: string | null;
  /** The listing id in `/service/:id`. */
  productId: string | null;
};

function normalizePath(pathname: string): string {
  const path = String(pathname || '/').replace(/\/$/, '') || '/';
  const prefixed = path.startsWith('/') ? path : `/${path}`;
  return prefixed.toLowerCase();
}

export function isKnownSpaPath(pathname: string): boolean {
  const path = normalizePath(pathname);
  if ((KNOWN_SPA_PATHS as readonly string[]).includes(path)) return true;
  if (path.startsWith('/service/')) return true;
  if (path.startsWith('/vendor/')) return true;
  if (path.startsWith('/api/')) return false;
  if (path.startsWith('/uploads/')) return true;
  return false;
}

export function parseLocation(pathname: string, hash = ''): LocationIntent {
  const path = normalizePath(pathname);
  const h = String(hash || '').replace(/^#/, '').toLowerCase();
  const base = {
    hospitality: false,
    courier: false,
    vendorPublicId: null as string | null,
    productId: null as string | null,
  };

  if (path === '/privacy' || h === 'privacy') {
    return { ...base, sitePage: 'privacy' };
  }
  if (path === '/terms' || h === 'terms') {
    return { ...base, sitePage: 'terms' };
  }
  if (path === '/refund' || path === '/cancellation' || h === 'refund' || h === 'cancellation') {
    return { ...base, sitePage: 'refund' };
  }
  if (path === '/support' || h === 'support') {
    return { ...base, sitePage: 'support' };
  }
  if (path === '/about' || h === 'about') {
    return { ...base, sitePage: 'about' };
  }
  if (path === '/payment/success') {
    return { ...base, sitePage: 'payment-success' };
  }
  if (path === '/payment/cancelled') {
    return { ...base, sitePage: 'payment-cancelled' };
  }
  if (path.startsWith('/vendor/')) {
    const id = decodeURIComponent(pathname.replace(/\/$/, '').slice('/vendor/'.length).split('/')[0] || '').trim();
    if (!id) return { ...base, sitePage: 'notfound' };
    return { ...base, sitePage: 'vendor-file', vendorPublicId: id };
  }
  if (path === '/service') return { ...base, sitePage: 'catalog' };
  if (path.startsWith('/service/')) {
    // Keep the id's original casing: listing ids are case-sensitive.
    const raw = String(pathname || '').replace(/\/$/, '');
    const id = decodeURIComponent(raw.slice(raw.toLowerCase().indexOf('/service/') + '/service/'.length).split('/')[0] || '').trim();
    if (!id) return { ...base, sitePage: 'catalog' };
    return { ...base, sitePage: 'product', productId: id };
  }
  if (path === '/hospitality' || h === 'hospitality') {
    return { ...base, sitePage: 'catalog', hospitality: true };
  }
  if (path === '/catalog' || path === '/services') {
    return { ...base, sitePage: 'catalog' };
  }
  if (path === '/compare') return { ...base, sitePage: 'compare' };
  if (path === '/cart') return { ...base, sitePage: 'cart' };
  if (path === '/checkout') return { ...base, sitePage: 'checkout' };
  if (path === '/orders') return { ...base, sitePage: 'orders' };
  if (path === '/account') return { ...base, sitePage: 'account' };
  if (path === '/chat') return { ...base, sitePage: 'chat' };
  if (path === '/login') return { ...base, sitePage: 'login' };
  if (path === '/request') return { ...base, sitePage: 'request' };
  if (path === '/providers') return { ...base, sitePage: 'providers' };
  if (path === '/courier' || h === 'courier') {
    return { ...base, sitePage: null, courier: true };
  }
  if (path === '/' || path === '/offline') {
    return { ...base, sitePage: null };
  }
  return { ...base, sitePage: 'notfound' };
}

export function pathForSitePage(page: Exclude<SitePage, 'notfound' | 'vendor-file' | 'product' | null>): string {
  if (page === 'payment-success') return '/payment/success';
  if (page === 'payment-cancelled') return '/payment/cancelled';
  return `/${page}`;
}

export function pathForProduct(id: string): string {
  return `/service/${encodeURIComponent(String(id || '').trim())}`;
}

export function pathForVendor(id: string): string {
  return `/vendor/${encodeURIComponent(String(id || '').trim())}`;
}
