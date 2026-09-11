import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_CITIES_LABEL,
  CITIES,
  PLACE_NAMES,
  SAUDI_PLACES,
  SAUDI_REGIONS,
  cityFilterMatches,
  findPlace,
  isSaudiPlaceName,
  searchPlaces,
  selectionCoversPlace,
  toggleCoverage,
} from './saudiPlaces.ts';

describe('saudi places catalog', () => {
  it('covers the 13 regions plus official governorates and villages', () => {
    assert.equal(SAUDI_REGIONS.length, 13);
    assert.ok(PLACE_NAMES.length > 200);
    assert.equal(CITIES[0], ALL_CITIES_LABEL);
    for (const name of ['نجران', 'فيفا', 'الهفوف', 'الدرعية', 'تنومة', 'نيوم', 'الخرخير']) {
      assert.ok(PLACE_NAMES.includes(name), `missing ${name}`);
    }
    assert.ok(SAUDI_PLACES.some((place) => place.kind === 'region'));
    assert.ok(SAUDI_PLACES.some((place) => place.kind === 'governorate'));
    assert.ok(SAUDI_PLACES.some((place) => place.kind === 'village'));
    for (const featured of ['الرياض', 'جدة', 'الدمام', 'مكة المكرمة', 'المدينة المنورة']) {
      assert.ok(PLACE_NAMES.includes(featured), `missing featured ${featured}`);
    }
  });

  it('matches a Riyadh-region listing to الدرعية', () => {
    assert.equal(cityFilterMatches(['الرياض'], 'الدرعية'), true);
    assert.equal(cityFilterMatches(['الدرعية'], 'الرياض'), true);
    assert.equal(cityFilterMatches(['جدة'], 'الدرعية'), false);
  });

  it('keeps combined eastern and asir aliases', () => {
    assert.equal(cityFilterMatches(['الدمام والخبر'], 'الخبر'), true);
    assert.equal(cityFilterMatches(['أبها وخميس مشيط'], 'أبها'), true);
    assert.equal(findPlace('مكة')?.name, 'مكة المكرمة');
    assert.equal(isSaudiPlaceName('فيفا'), true);
    assert.equal(isSaudiPlaceName(ALL_CITIES_LABEL), false);
  });

  it('searches villages and governorates by typed name', () => {
    const fifa = searchPlaces('فيفا', 10).map((place) => place.name);
    const najran = searchPlaces('نجران', 10).map((place) => place.name);
    const hofuf = searchPlaces('الهفوف', 10).map((place) => place.name);
    assert.ok(fifa.includes('فيفا'));
    assert.ok(najran.includes('نجران'));
    assert.ok(hofuf.includes('الهفوف'));
  });

  it('collapses villages into a whole-region coverage chip', () => {
    const collapsed = toggleCoverage(['الدرعية', 'جدة'], 'الرياض');
    assert.deepEqual(collapsed, ['جدة', 'الرياض']);
    assert.equal(selectionCoversPlace(collapsed, 'الدرعية'), true);
    assert.equal(selectionCoversPlace(collapsed, 'فيفا'), false);
    assert.equal(cityFilterMatches(collapsed, 'فيفا'), false);
    assert.equal(cityFilterMatches(collapsed, 'العيينة'), true);
    const unchanged = toggleCoverage(['الرياض'], 'الدرعية');
    assert.deepEqual(unchanged, ['الرياض']);
    const removed = toggleCoverage(['الرياض', 'جازان'], 'الرياض');
    assert.deepEqual(removed, ['جازان']);
  });
});
