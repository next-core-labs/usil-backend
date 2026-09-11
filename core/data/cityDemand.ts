export const DEMAND_OCCASIONS = [
  'عرس',
  'ملكة',
  'تخرج',
  'مؤتمر / إطلاق',
  'استقبال رمضاني',
  'عزاء',
  'ضيافة وقهوة',
  'بوفيه ومأكولات',
  'تصوير وتوثيق',
  'قاعة أو استراحة',
  'أخرى',
] as const;

export type DemandOccasion = (typeof DEMAND_OCCASIONS)[number];

export const DEMAND_STATUSES = ['new', 'contacted', 'matched', 'closed'] as const;
export type DemandStatus = (typeof DEMAND_STATUSES)[number];

export const DEMAND_STATUS_AR: Record<DemandStatus, string> = {
  new: 'جديد',
  contacted: 'تم التواصل',
  matched: 'تمت المطابقة',
  closed: 'مغلق',
};

export function isDemandOccasion(value: string): value is DemandOccasion {
  return (DEMAND_OCCASIONS as readonly string[]).includes(value);
}

export function isDemandStatus(value: string): value is DemandStatus {
  return (DEMAND_STATUSES as readonly string[]).includes(value);
}
