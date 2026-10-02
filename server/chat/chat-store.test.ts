import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  canAccess,
  createChatStore,
  MAX_CHAT_BODY,
  parseChatContext,
  sideForRole,
  validateChatBody,
  type ChatViewer,
} from './chat-store.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usil-chat-'));
}

const client: ChatViewer = { side: 'client', userId: 'usr-client' };
const otherClient: ChatViewer = { side: 'client', userId: 'usr-other' };
const vendor: ChatViewer = { side: 'vendor', userId: 'usr-vendor' };
const owner: ChatViewer = { side: 'owner', userId: 'usr-admin' };

function clientThread(store: ReturnType<typeof createChatStore>, clientId = client.userId) {
  return store.open({
    kind: 'client_vendor',
    vendorId: vendor.userId,
    vendorName: 'قهوة الضيافة',
    clientId,
    clientName: 'نواف',
  }).conversation;
}

describe('chat validation', () => {
  it('maps roles to sides and gives couriers no chat', () => {
    assert.equal(sideForRole('client'), 'client');
    assert.equal(sideForRole('vendor'), 'vendor');
    assert.equal(sideForRole('admin'), 'owner');
    assert.equal(sideForRole('accounts_manager'), 'owner');
    assert.equal(sideForRole('courier'), null);
    assert.equal(sideForRole(undefined), null);
  });

  it('trims the body, refuses an empty one, and refuses one past the cap', () => {
    assert.deepEqual(validateChatBody('  مرحبا  '), { ok: true, value: 'مرحبا' });
    assert.equal(validateChatBody('   ').ok, false);
    assert.equal(validateChatBody(undefined).ok, false);
    assert.equal(validateChatBody('م'.repeat(MAX_CHAT_BODY)).ok, true);
    assert.equal(validateChatBody('م'.repeat(MAX_CHAT_BODY + 1)).ok, false);
  });

  it('keeps a valid context and drops a malformed one', () => {
    assert.deepEqual(parseChatContext({ type: 'listing', id: 'lst-1', title: 'ضيافة' }), {
      type: 'listing',
      id: 'lst-1',
      title: 'ضيافة',
    });
    assert.equal(parseChatContext({ type: 'invoice', id: 'x' }), undefined);
    assert.equal(parseChatContext({ type: 'listing', id: '' }), undefined);
    assert.equal(parseChatContext('lst-1'), undefined);
  });
});

describe('chat store', () => {
  it('reuses one thread per client and vendor pair', () => {
    const store = createChatStore(tmpDir());
    const first = clientThread(store);
    const again = store.open({
      kind: 'client_vendor',
      vendorId: vendor.userId,
      vendorName: 'قهوة الضيافة',
      clientId: client.userId,
      clientName: 'نواف',
    });
    assert.equal(again.created, false);
    assert.equal(again.conversation.id, first.id);
    assert.notEqual(clientThread(store, otherClient.userId).id, first.id);
  });

  it('reuses one owner thread per vendor', () => {
    const store = createChatStore(tmpDir());
    const a = store.open({ kind: 'vendor_owner', vendorId: vendor.userId, vendorName: 'قهوة' });
    const b = store.open({ kind: 'vendor_owner', vendorId: vendor.userId, vendorName: 'قهوة' });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.conversation.id, b.conversation.id);
    assert.equal(store.hasPair({ kind: 'vendor_owner', vendorId: vendor.userId }), true);
    assert.equal(store.hasPair({ kind: 'vendor_owner', vendorId: 'usr-else' }), false);
  });

  it('keeps each side out of threads that are not theirs', () => {
    const store = createChatStore(tmpDir());
    const withClient = clientThread(store);
    const withOwner = store.open({ kind: 'vendor_owner', vendorId: vendor.userId, vendorName: 'قهوة' }).conversation;

    assert.equal(canAccess(withClient, client), true);
    assert.equal(canAccess(withClient, otherClient), false);
    assert.equal(canAccess(withClient, vendor), true);
    assert.equal(canAccess(withClient, owner), false);
    assert.equal(canAccess(withOwner, vendor), true);
    assert.equal(canAccess(withOwner, owner), true);
    assert.equal(canAccess(withOwner, client), false);
    assert.equal(canAccess(withOwner, { side: 'vendor', userId: 'usr-rival' }), false);

    assert.throws(() => store.get(withClient.id, otherClient), /غير موجودة/);
    assert.throws(() => store.send(withOwner.id, client, { senderName: 'x', body: 'y' }), /غير موجودة/);
    assert.deepEqual(store.list(vendor).map((row) => row.kind).sort(), ['client_vendor', 'vendor_owner']);
    assert.deepEqual(store.list(owner).map((row) => row.kind), ['vendor_owner']);
    assert.deepEqual(store.list(otherClient), []);
  });

  it('counts unread per side and clears it on read or reply', () => {
    const store = createChatStore(tmpDir());
    const thread = clientThread(store);
    store.send(thread.id, client, { senderName: 'نواف', body: 'السلام عليكم' });
    store.send(thread.id, client, { senderName: 'نواف', body: 'متاحين يوم الخميس؟' });

    assert.equal(store.unreadCount(client), 0);
    assert.equal(store.unreadCount(vendor), 2);
    assert.equal(store.list(vendor)[0].unread, 2);

    store.markRead(thread.id, vendor);
    assert.equal(store.unreadCount(vendor), 0);

    store.send(thread.id, vendor, { senderName: 'قهوة', body: 'نعم متاحين' });
    assert.equal(store.unreadCount(client), 1);
    assert.equal(store.unreadCount(vendor), 0);
  });

  it('returns only newer messages when polling with after', () => {
    const store = createChatStore(tmpDir());
    const thread = clientThread(store);
    const first = store.send(thread.id, client, { senderName: 'نواف', body: 'أولى' });
    store.send(thread.id, vendor, { senderName: 'قهوة', body: 'ثانية' });

    assert.deepEqual(store.get(thread.id, client, first.id).messages.map((m) => m.body), ['ثانية']);
    assert.equal(store.get(thread.id, client, 'msg-unknown').messages.length, 2);
    assert.equal(store.get(thread.id, client).messages.length, 2);
  });

  it('lists newest activity first with the last message, and persists', () => {
    const dir = tmpDir();
    const store = createChatStore(dir);
    const older = clientThread(store);
    const newer = clientThread(store, otherClient.userId);
    store.send(older.id, client, { senderName: 'نواف', body: 'قديمة' });
    store.send(newer.id, otherClient, { senderName: 'سارة', body: 'جديدة' });

    const rows = createChatStore(dir).list(vendor);
    assert.deepEqual(rows.map((row) => row.lastMessage?.body), ['جديدة', 'قديمة']);
    assert.equal('messages' in rows[0], false);
  });

  it('keeps the message context', () => {
    const store = createChatStore(tmpDir());
    const thread = clientThread(store);
    const context = { type: 'listing' as const, id: 'lst-1', title: 'ركن قهوة' };
    const message = store.send(thread.id, client, { senderName: 'نواف', body: 'كم السعر؟', context });
    assert.deepEqual(message.context, context);
    assert.deepEqual(store.get(thread.id, vendor).messages[0].context, context);
  });
});
