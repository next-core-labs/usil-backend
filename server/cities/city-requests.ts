import path from 'path';
import { isSaudiPlaceName } from '../../core/data/saudiPlaces';
import { isValidSaudiMobile, normalizeSaudiMobile } from '../shared/booking-guards';
import { readJsonArray, writeJsonFile } from '../shared/json-file.ts';
import {
  type DemandOccasion,
  type DemandStatus,
  isDemandOccasion,
} from '../../core/data/cityDemand';

export {
  DEMAND_OCCASIONS,
  DEMAND_STATUSES,
  DEMAND_STATUS_AR,
  isDemandOccasion,
  isDemandStatus,
  type DemandOccasion,
  type DemandStatus,
} from '../../core/data/cityDemand';

export type CityDemandRequest = {
  id: string;
  name: string;
  phone: string;
  city: string;
  occasion: DemandOccasion;
  eventDate: string;
  notes: string;
  status: DemandStatus;
  createdAt: string;
  updatedAt: string;
};

export function validateCityDemandInput(input: {
  name?: unknown;
  phone?: unknown;
  city?: unknown;
  occasion?: unknown;
  eventDate?: unknown;
  notes?: unknown;
}): { ok: true; value: Omit<CityDemandRequest, 'id' | 'status' | 'createdAt' | 'updatedAt'> } | { ok: false; error: string } {
  const name = String(input.name || '').trim();
  const phone = normalizeSaudiMobile(String(input.phone || ''));
  const city = String(input.city || '').trim();
  const occasion = String(input.occasion || '').trim();
  const eventDate = String(input.eventDate || '').trim();
  const notes = String(input.notes || '').trim().slice(0, 500);

  if (name.length < 2) return { ok: false, error: 'اكتب اسمك.' };
  if (!phone || !isValidSaudiMobile(phone)) return { ok: false, error: 'أدخل جوالاً سعودياً بصيغة 05xxxxxxxx.' };
  if (!isSaudiPlaceName(city)) return { ok: false, error: 'اختر مدينة أو محافظة أو قرية من قائمة المملكة.' };
  if (!isDemandOccasion(occasion)) return { ok: false, error: 'اختر نوع المناسبة.' };
  if (eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return { ok: false, error: 'تاريخ المناسبة غير صحيح.' };

  return { ok: true, value: { name, phone, city, occasion, eventDate, notes } };
}

export function createCityDemandStore(dataDir: string) {
  const file = path.join(dataDir, 'city-requests.json');

  const read = (): CityDemandRequest[] => readJsonArray<CityDemandRequest>(file);

  const write = (rows: CityDemandRequest[]) => writeJsonFile(file, rows);

  return {
    list(): CityDemandRequest[] {
      return read();
    },
    add(input: Omit<CityDemandRequest, 'id' | 'status' | 'createdAt' | 'updatedAt'>): CityDemandRequest {
      const now = new Date().toISOString();
      const row: CityDemandRequest = {
        ...input,
        id: `dem-${Date.now()}`,
        status: 'new',
        createdAt: now,
        updatedAt: now,
      };
      const rows = read();
      rows.unshift(row);
      write(rows);
      return row;
    },
    setStatus(id: string, status: DemandStatus): CityDemandRequest | null {
      const rows = read();
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return null;
      rows[index] = { ...rows[index], status, updatedAt: new Date().toISOString() };
      write(rows);
      return rows[index];
    },
  };
}
