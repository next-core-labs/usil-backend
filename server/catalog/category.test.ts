import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { registerCategoryRoutes } from './category-routes.ts';
import { createCategoryStore, defaultCategories } from './category-store.ts';
import { createVendorStore } from '../vendors/vendor-store.ts';

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-categories-'));
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  for (const name of ['listing-a.jpg', 'listing-b.jpg']) fs.writeFileSync(path.join(dir, 'uploads', name), name);
  return dir;
}

function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function fakeAuth(role: 'admin' | 'vendor' | null) {
  return {
    requireRole: (roles: string[]) => (_req: Request, res: Response, next: NextFunction) => {
      if (!role) return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول.' });
      if (!roles.includes(role)) return res.status(403).json({ success: false, error: 'ليست لديك صلاحية.' });
      next();
    },
  };
}

const listing = (category: string) => ({
  title: 'قهوة سعودية',
  category,
  price: 80,
  fulfillment: ['hour'],
  images: ['/uploads/listing-a.jpg', '/uploads/listing-b.jpg'],
});

describe('category-store', () => {
  it('starts from the design categories, without «الكل»', () => {
    const store = createCategoryStore(tmpDir());
    const ids = store.list().map((row) => row.id);
    assert.equal(ids.length, 15);
    assert.ok(!ids.includes('all'));
    assert.deepEqual(store.list(), defaultCategories());
  });

  it('adds a category with a generated id and keeps it across reads', () => {
    const dir = tmpDir();
    const { category } = createCategoryStore(dir).add({ name: '  عطور  وبخور ', icon: 'Gift', nameEn: 'Perfume' });
    assert.match(category.id, /^cat-[0-9a-f]{8}$/);
    assert.equal(category.name, 'عطور وبخور');
    assert.equal(category.short, 'عطور');
    assert.equal(category.icon, 'Gift');
    const reread = createCategoryStore(dir).list();
    assert.equal(reread.length, 16);
    assert.equal(reread.at(-1)?.nameEn, 'Perfume');
  });

  it('refuses a blank or duplicate name and an unknown icon falls back', () => {
    const store = createCategoryStore(tmpDir());
    assert.throws(() => store.add({ name: ' ' }), /اسم التصنيف/);
    assert.throws(() => store.add({ name: 'ضيافة وقهوة' }), /يوجد تصنيف/);
    assert.equal(store.add({ name: 'جديد', icon: '<script>' }).category.icon, 'Sparkles');
  });

  it('edits a category in place and keeps its id', () => {
    const store = createCategoryStore(tmpDir());
    const { category, renamed } = store.update('tents', { name: 'خيام ومظلات فاخرة', icon: 'Gift' });
    assert.equal(category.id, 'tents');
    assert.equal(category.name, 'خيام ومظلات فاخرة');
    assert.equal(category.short, 'خيام', 'left-out fields keep their value');
    assert.equal(category.icon, 'Gift');
    assert.ok(renamed);
    assert.equal(store.update('tents', { icon: 'Tent' }).renamed, false);
    assert.equal(store.list().find((row) => row.id === 'tents')?.name, 'خيام ومظلات فاخرة');
    assert.throws(() => store.update('tents', { name: 'ضيافة وقهوة' }), /يوجد تصنيف/);
    assert.throws(() => store.update('tents', { name: '' }), /اسم التصنيف/);
    assert.throws(() => store.update('nope', { name: 'جديد' }), /غير موجود/);
  });

  it('removes a category but never the last one', () => {
    const store = createCategoryStore(tmpDir());
    for (const row of store.list().slice(1)) store.remove(row.id);
    assert.equal(store.list().length, 1);
    assert.throws(() => store.remove(store.list()[0].id), /آخر تصنيف/);
    assert.throws(() => store.remove('nope'), /غير موجود/);
  });
});

describe('category routes', () => {
  it('lets only the owner add and delete; anyone can read', async () => {
    const dir = tmpDir();
    const vendorApp = express().use(express.json());
    registerCategoryRoutes(vendorApp, fakeAuth('vendor'), dir);
    const vendor = await listen(vendorApp);
    const ownerApp = express().use(express.json());
    const renamed: Array<[string, string]> = [];
    registerCategoryRoutes(ownerApp, fakeAuth('admin'), dir, {
      listListingCategories: () => ['tents', 'tents', 'av'],
      onRename: (id, name) => renamed.push([id, name]),
    });
    const owner = await listen(ownerApp);
    try {
      const denied = await fetch(`${vendor.url}/api/admin/categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'عطور' }),
      });
      assert.equal(denied.status, 403);

      const created = await fetch(`${owner.url}/api/admin/categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'عطور', icon: 'Gift' }),
      });
      assert.equal(created.status, 201);
      const { data } = await created.json();
      assert.equal(data.categories.find((row: { id: string }) => row.id === 'tents').listingCount, 2);

      const publicList = await (await fetch(`${vendor.url}/api/categories`)).json();
      assert.ok(publicList.data.categories.some((row: { id: string }) => row.id === data.category.id));

      const patchAs = (url: string, body: unknown) =>
        fetch(`${url}/api/admin/categories/tents`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      assert.equal((await patchAs(vendor.url, { name: 'خيام فاخرة' })).status, 403);
      const edited = await patchAs(owner.url, { name: 'خيام فاخرة' });
      assert.equal(edited.status, 200);
      assert.equal((await edited.json()).data.category.name, 'خيام فاخرة');
      assert.deepEqual(renamed, [['tents', 'خيام فاخرة']]);

      assert.equal((await fetch(`${vendor.url}/api/admin/categories/tents`, { method: 'DELETE' })).status, 403);
      const removed = await fetch(`${owner.url}/api/admin/categories/tents`, { method: 'DELETE' });
      assert.equal(removed.status, 200);
      assert.equal((await fetch(`${owner.url}/api/admin/categories/tents`, { method: 'DELETE' })).status, 404);
    } finally {
      await vendor.close();
      await owner.close();
    }
  });
});

describe('listings follow the owner categories', () => {
  it('accepts an owner-added category and rejects a removed one for new products', () => {
    const dir = tmpDir();
    const categories = createCategoryStore(dir);
    const { category } = categories.add({ name: 'عطور وبخور' });
    const store = createVendorStore(dir);
    const added = store.addListing('v1', listing(category.id));
    assert.equal(added.category, category.id);
    assert.equal(added.categoryName, 'عطور وبخور');

    categories.remove('tents');
    assert.throws(() => store.addListing('v1', listing('tents')), /اختر قسماً/);
  });

  it('renames the category on existing products', () => {
    const dir = tmpDir();
    const store = createVendorStore(dir);
    store.addListing('v1', listing('tents'));
    store.addListing('v2', listing('tents'));
    store.addListing('v2', listing('av'));
    assert.equal(store.renameCategory('tents', 'خيام فاخرة'), 2);
    const names = createVendorStore(dir).listAllListings().map((row) => `${row.category}:${row.categoryName}`).sort();
    assert.deepEqual(names, ['av:صوت وإضاءة وشاشات', 'tents:خيام فاخرة', 'tents:خيام فاخرة']);
    assert.equal(store.renameCategory('tents', 'خيام فاخرة'), 0);
  });

  it('keeps existing products when their category is removed, and lets them be edited', () => {
    const dir = tmpDir();
    const categories = createCategoryStore(dir);
    const { category } = categories.add({ name: 'عطور وبخور' });
    const store = createVendorStore(dir);
    const added = store.addListing('v1', listing(category.id));
    categories.remove(category.id);

    const fresh = createVendorStore(dir);
    const kept = fresh.getWorkspace('v1').listings;
    assert.equal(kept.length, 1);
    assert.equal(kept[0].categoryName, 'عطور وبخور');

    const edited = fresh.updateListing('v1', added.id, { price: 95 });
    assert.equal(edited?.price, 95);
    assert.equal(edited?.category, category.id);
    assert.throws(() => fresh.updateListing('v1', added.id, { category: 'nope' }), /اختر قسماً/);
  });
});
