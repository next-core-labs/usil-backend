import { ServiceItem } from '../types';
import { enrichServices } from './saudiMarket';
import { EXPANSION_SERVICES } from './catalogExpansion';

export { CITIES, ALL_CITIES_LABEL } from './saudiPlaces';

export const CATEGORY_DEFS = [
  { id: 'all', name: 'جميع الخدمات', short: 'الكل', icon: 'Sparkles' },
  { id: 'hospitality', name: 'ضيافة وقهوة', short: 'ضيافة', icon: 'Coffee' },
  { id: 'buffet', name: 'بوفيه ومأكولات', short: 'بوفيه', icon: 'Utensils' },
  { id: 'decoration', name: 'تنسيق وديكور', short: 'تنسيق', icon: 'Palette' },
  { id: 'photography', name: 'تصوير وتوثيق', short: 'تصوير', icon: 'Camera' },
  { id: 'entertainment', name: 'ألعاب وترفيه', short: 'ألعاب', icon: 'PartyPopper' },
  { id: 'halls', name: 'قاعات واستراحات', short: 'قاعات', icon: 'Building2' },
  { id: 'rental', name: 'كراسي وطاولات وتأجير', short: 'تأجير', icon: 'Armchair' },
  { id: 'servers', name: 'صبابين وصبابات', short: 'صبابين', icon: 'Users' },
  { id: 'av', name: 'صوت وإضاءة وشاشات', short: 'صوت', icon: 'Speaker' },
  { id: 'tents', name: 'خيام ومظلات', short: 'خيام', icon: 'Tent' },
  { id: 'zaffa', name: 'زفة وفرق شعبية', short: 'زفة', icon: 'Music' },
  { id: 'cakes', name: 'كيك وحلويات المناسبات', short: 'كيك', icon: 'Cake' },
  { id: 'invitations', name: 'دعوات وهدايا تذكارية', short: 'هدايا', icon: 'Gift' },
  { id: 'parking', name: 'تنظيم مواقف وحشود', short: 'مواقف', icon: 'Car' },
  { id: 'condolence', name: 'عزاء وتجهيز مجالس', short: 'عزاء', icon: 'Flower2' },
] as const;

const RAW_SERVICES: ServiceItem[] = [];

/** سوق يوصل يعرض منتجات المورّدين المعتمدين فقط — بدون كتالوج بذرة وهمي. */
const ALL_RAW_SERVICES: ServiceItem[] = [...RAW_SERVICES, ...EXPANSION_SERVICES];

export const CATEGORIES = CATEGORY_DEFS.map((cat) => ({
  ...cat,
  count:
    cat.id === 'all'
      ? ALL_RAW_SERVICES.length
      : ALL_RAW_SERVICES.filter((s) => s.category === cat.id).length,
}));

export const SERVICES: ServiceItem[] = enrichServices(ALL_RAW_SERVICES);

export const TESTIMONIALS: Array<{
  id: string;
  name: string;
  event: string;
  rating: number;
  comment: string;
  city: string;
  service: string;
}> = [];
