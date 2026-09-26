import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createSupportStore, isSupportStatus, validateSupportMessage } from './support-store.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-support-'));
}

describe('support message validation', () => {
  it('requires a name, a message, and at least one way to reply', () => {
    assert.equal(validateSupportMessage({ name: '', message: 'مرحبا', email: 'a@b.co' }).ok, false);
    assert.equal(validateSupportMessage({ name: 'نواف', message: '', email: 'a@b.co' }).ok, false);
    assert.equal(validateSupportMessage({ name: 'نواف', message: 'مرحبا' }).ok, false);
  });

  it('accepts either an email or a phone as the reply channel', () => {
    assert.equal(validateSupportMessage({ name: 'نواف', message: 'مرحبا', email: 'a@b.co' }).ok, true);
    assert.equal(validateSupportMessage({ name: 'نواف', message: 'مرحبا', phone: '0512345678' }).ok, true);
  });

  it('trims input and caps a very long message', () => {
    const parsed = validateSupportMessage({
      name: '  نواف  ',
      message: 'م'.repeat(5000),
      phone: ' 0512345678 ',
    });
    if (parsed.ok === false) assert.fail(`expected valid input, got: ${parsed.error}`);
    assert.equal(parsed.value.name, 'نواف');
    assert.equal(parsed.value.phone, '0512345678');
    assert.equal(parsed.value.message.length, 2000);
  });
});

describe('support store', () => {
  it('starts empty, stores newest first, and persists to disk', () => {
    const dir = tmpDir();
    const store = createSupportStore(dir);
    assert.deepEqual(store.list(), []);

    store.add({ name: 'أول', email: 'a@usil.sa', phone: '', message: 'رسالة أولى' });
    store.add({ name: 'ثاني', email: '', phone: '0512345678', message: 'رسالة ثانية' });

    assert.deepEqual(store.list().map((row) => row.name), ['ثاني', 'أول']);
    assert.deepEqual(createSupportStore(dir).list().map((row) => row.name), ['ثاني', 'أول']);
  });

  it('stamps an id and a timestamp on every row', () => {
    const store = createSupportStore(tmpDir());
    const row = store.add({ name: 'نواف', email: 'a@usil.sa', phone: '', message: 'مرحبا' });
    assert.match(row.id, /^sup-\d+$/);
    assert.ok(!Number.isNaN(Date.parse(row.createdAt)));
  });

  it('reads new rows and pre-status rows as new', () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, 'support-messages.json'),
      JSON.stringify([{ id: 'sup-1', name: 'قديم', email: 'a@usil.sa', phone: '', message: 'x', createdAt: '2026-01-01T00:00:00.000Z' }]),
    );
    const store = createSupportStore(dir);
    const row = store.add({ name: 'جديد', email: '', phone: '0512345678', message: 'y' });
    assert.equal(row.status, 'new');
    assert.deepEqual(store.list().map((item) => item.status), ['new', 'new']);
  });

  it('updates the status of one message and persists it', () => {
    const dir = tmpDir();
    const store = createSupportStore(dir);
    const first = store.add({ name: 'أول', email: 'a@usil.sa', phone: '', message: 'أ' });
    const second = store.add({ name: 'ثاني', email: '', phone: '0512345678', message: 'ب' });

    const updated = store.setStatus(first.id, 'replied');
    assert.equal(updated?.status, 'replied');
    assert.ok(updated?.updatedAt);

    const reread = createSupportStore(dir).list();
    assert.equal(reread.find((item) => item.id === first.id)?.status, 'replied');
    assert.equal(reread.find((item) => item.id === second.id)?.status, 'new');
  });

  it('returns null for an unknown id and rejects unknown statuses', () => {
    const store = createSupportStore(tmpDir());
    assert.equal(store.setStatus('sup-missing', 'closed'), null);
    assert.equal(isSupportStatus('closed'), true);
    assert.equal(isSupportStatus('deleted'), false);
    assert.equal(isSupportStatus(undefined), false);
  });
});
