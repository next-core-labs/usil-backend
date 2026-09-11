import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, SERVICES } from './services.ts';

describe('store catalog', () => {
  it('keeps Saudi event departments but ships no dummy SKUs', () => {
    const departments = CATEGORIES.filter((c) => c.id !== 'all');
    assert.equal(departments.length, 15);
    assert.equal(SERVICES.length, 0);
    assert.equal(CATEGORIES.find((cat) => cat.id === 'all')?.count, 0);
    for (const cat of departments) {
      assert.equal(cat.count, 0);
      assert.equal(SERVICES.filter((s) => s.category === cat.id).length, 0);
    }
  });
});
