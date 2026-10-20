import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { registerContractRoutes } from './contract-routes.ts';
import {
  canonicalJson,
  contractContentHash,
  contractsFile,
  mapLegacyContract,
  parseSignatureImage,
  SIGNATURE_MAX_CHARS,
} from './contract-store.ts';
import { roleAllowed } from '../auth/roles.ts';
import { setMailFetchForTests } from '../shared/optional-mail.ts';
import { registerSeoRoutes } from '../seo/seo-routes.ts';

const ACTORS: Record<string, { id: string; role: string; name: string; email: string }> = {
  admin: { id: 'usr-admin', role: 'admin', name: 'المالك', email: 'owner@usil.sa' },
  manager: { id: 'usr-manager', role: 'accounts_manager', name: 'مدير الحسابات', email: 'm@usil.sa' },
  vendorA: { id: 'v-a', role: 'vendor', name: 'قهوة', email: 'va@usil.sa' },
  vendorB: { id: 'v-b', role: 'vendor', name: 'خيام', email: 'vb@usil.sa' },
  client: { id: 'u-client', role: 'client', name: 'عميل', email: 'c@usil.sa' },
};

/* ── A real PNG, built by hand (no image library in the backend) ──── */

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function pngDataUrl(width = 300, height = 120, noise = false): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((width + 1) * height);
  if (noise) for (let i = 0; i < raw.length; i++) raw[i] = i % (width + 1) === 0 ? 0 : (i * 7919) % 251;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: noise ? 0 : 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/* ── Harness ───────────────────────────────────────────────────────── */

const LEGACY: Record<string, unknown[]> = {
  'v-a': [
    {
      id: 'cnt-1',
      contractNumber: 'CNT-2026-1234',
      bookingId: 'BK-77',
      clientName: 'سارة',
      clientPhone: '0500000001',
      vendorName: 'قهوة',
      vendorCrNumber: '1010',
      eventDate: '2026-09-01',
      eventLocation: 'الرياض',
      serviceTitle: 'ركن قهوة',
      totalAmount: 1000,
      depositAmount: 300,
      remainingAmount: 700,
      status: 'signed_active',
      terms: ['بند قديم'],
      clientSignature: { signedByName: 'سارة', signedAt: '2026-08-01 10:00' },
      vendorSignature: { signedByName: 'قهوة', signedAt: '2026-08-01 09:00', stampApplied: true },
      createdAt: '2026-08-01',
    },
    {
      id: 'cnt-2',
      contractNumber: 'CNT-2026-5678',
      clientName: 'نورة',
      clientPhone: '0500000002',
      eventDate: '2026-11-01',
      serviceTitle: 'ضيافة',
      totalAmount: 500,
      depositAmount: 0,
      status: 'pending_signature',
      terms: [],
      createdAt: '2026-10-01',
    },
  ],
};

function buildApp(dir: string, limits: { read?: number; sign?: number } = {}) {
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  const userOf = (req: Request) => ACTORS[String(req.headers['x-test-actor'] || '')] || null;
  const auth = {
    requireRole: (roles: string[]) => (req: Request, res: Response, next: NextFunction) => {
      const user = userOf(req);
      if (!user) return res.status(401).json({ success: false });
      if (!roleAllowed(user.role, roles)) return res.status(403).json({ success: false });
      (req as Request & { user: unknown }).user = user;
      next();
    },
    listVendorUsers: () => [ACTORS.vendorA, ACTORS.vendorB],
  };
  let legacyCalls = 0;
  registerContractRoutes(app, auth, dir, {
    legacyContracts: (vendorId) => {
      legacyCalls += 1;
      return LEGACY[vendorId] || [];
    },
    vendorBrand: (vendorId) =>
      vendorId === 'v-a'
        ? { name: 'قهوة الرياض', logoUrl: '/uploads/logo-a.png', crNumber: '1010123456' }
        : { name: 'خيام الشمال', logoUrl: 'data:image/png;base64,AAAA' },
    publicReadLimit: limits.read,
    publicSignLimit: limits.sign,
  });
  return { app, legacyCalls: () => legacyCalls };
}

function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

async function call(url: string, method: string, pathname: string, actor = '', body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(actor ? { 'x-test-actor': actor } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, json, headers: res.headers };
}

async function setup(limits: { read?: number; sign?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-contracts-'));
  const built = buildApp(dir, limits);
  const server = await listen(built.app);
  return { ...server, dir, legacyCalls: built.legacyCalls };
}

const draftBody = (extra: Record<string, unknown> = {}) => ({
  source: { kind: 'order', ref: 'BK-1001' },
  client: { name: 'فهد الدوسري', phone: '+966 50 123 4567', email: 'Fahad@Example.com', nationalId: '1012345678' },
  event: { date: '2026-12-01', time: '18:30', location: 'قاعة الندى — الرياض', service: 'ركن قهوة عربية' },
  amounts: { total: 2500, deposit: 500 },
  terms: ['يلتزم المورّد بالحضور قبل الموعد بساعة.', 'يسدد العميل المتبقي يوم المناسبة.'],
  notes: 'بدون هيل',
  ...extra,
});

function tokenOf(signUrl: string): string {
  return signUrl.split('/sign/')[1];
}

const mails: Array<{ to: string[]; subject: string }> = [];
let prevKey: string | undefined;

before(() => {
  prevKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 're_test';
  setMailFetchForTests(async (_url, init) => {
    const body = JSON.parse(String(init.body));
    mails.push({ to: body.to, subject: body.subject });
    return { ok: true, status: 200, text: async () => '' };
  });
});

after(() => {
  setMailFetchForTests(null);
  if (prevKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = prevKey;
});

const settle = () => new Promise((done) => setTimeout(done, 20));

/* ── Unit ──────────────────────────────────────────────────────────── */

describe('contract store — fingerprint and signature checks', () => {
  it('hashes canonical JSON, independent of key order', () => {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] }), '{"a":[2,{"d":1}],"b":1}');
    const base = {
      number: 'CN-2026-0001',
      vendorName: 'قهوة',
      client: { name: 'فهد', phone: '0501234567' },
      event: { date: '2026-12-01', location: 'الرياض', service: 'قهوة' },
      amounts: { total: 100, deposit: 0, remaining: 100, currency: 'SAR' as const },
      terms: ['أ'],
    };
    const shuffled = { ...base, client: { phone: '0501234567', name: 'فهد' } };
    assert.equal(contractContentHash(base), contractContentHash(shuffled));
    assert.notEqual(contractContentHash(base), contractContentHash({ ...base, terms: ['ب'] }));
    assert.match(contractContentHash(base), /^[0-9a-f]{64}$/);
  });

  it('accepts a real PNG data URL and rejects everything else', () => {
    assert.ok(parseSignatureImage(pngDataUrl()));
    assert.throws(() => parseSignatureImage('data:image/jpeg;base64,/9j/4AAQ'), /PNG/);
    assert.throws(() => parseSignatureImage('https://evil.example/sig.png'), /PNG/);
    assert.throws(() => parseSignatureImage(`data:image/png;base64,${Buffer.from('not a png at all, sorry').toString('base64')}`));
    assert.throws(() => parseSignatureImage('data:image/png;base64,<script>'));
    assert.throws(() => parseSignatureImage(pngDataUrl(10, 10)), /مقاس/);
    const huge = pngDataUrl(700, 500, true);
    assert.ok(huge.length > SIGNATURE_MAX_CHARS);
    assert.throws(() => parseSignatureImage(huge), (error: any) => error.status === 413);
  });

  it('maps an old dashboard row without ever calling it a client signature', () => {
    const row = mapLegacyContract(LEGACY['v-a'][0], 'v-a', 'قهوة', new Date('2026-10-20T10:00:00Z'));
    assert.ok(row);
    assert.equal(row!.legacy, true);
    assert.equal(row!.status, 'signed');
    assert.equal(row!.signature?.image, '');
    assert.match(row!.signature?.note || '', /المورّد/);
    assert.equal(row!.shareToken, undefined);
    assert.equal(row!.amounts.remaining, 700);
    assert.deepEqual(row!.source, { kind: 'booking', ref: 'BK-77' });
    const pending = mapLegacyContract(LEGACY['v-a'][1], 'v-a', 'قهوة', new Date());
    assert.equal(pending!.status, 'draft');
    assert.equal(pending!.signature, undefined);
  });
});

/* ── Vendor routes ─────────────────────────────────────────────────── */

describe('contract routes — vendor side', () => {
  it('creates a numbered draft, edits it, and only deletes drafts', async () => {
    const { url, close } = await setup();
    try {
      const created = await call(url, 'POST', '/api/vendor/contracts', 'vendorB', draftBody());
      assert.equal(created.status, 201);
      const row = created.json.data;
      assert.match(row.number, /^CN-\d{4}-0001$/);
      assert.equal(row.status, 'draft');
      assert.equal(row.vendorName, 'خيام الشمال');
      assert.equal(row.client.phone, '0501234567');
      assert.equal(row.client.email, 'fahad@example.com');
      assert.deepEqual(row.amounts, { total: 2500, deposit: 500, remaining: 2000, currency: 'SAR' });
      assert.equal(row.signUrl, undefined);
      assert.equal(row.shareToken, undefined);

      const second = await call(url, 'POST', '/api/vendor/contracts', 'vendorB', draftBody());
      assert.match(second.json.data.number, /-0002$/);

      const edited = await call(url, 'PATCH', `/api/vendor/contracts/${row.id}`, 'vendorB', draftBody({ notes: '' }));
      assert.equal(edited.status, 200);
      assert.equal(edited.json.data.notes, undefined);
      assert.notEqual(edited.json.data.contentHash, row.contentHash);

      const bad = await call(url, 'POST', '/api/vendor/contracts', 'vendorB', draftBody({ amounts: { total: 100, deposit: 200 } }));
      assert.equal(bad.status, 400);
      assert.equal((await call(url, 'POST', '/api/vendor/contracts', 'vendorB', draftBody({ terms: [] }))).status, 400);
      assert.equal((await call(url, 'POST', '/api/vendor/contracts', 'vendorB', draftBody({ client: { name: 'س', phone: '0501234567' } }))).status, 400);
      assert.equal((await call(url, 'POST', '/api/vendor/contracts', 'vendorB', draftBody({ event: { date: 'tomorrow', service: 'x' } }))).status, 400);

      const sent = await call(url, 'POST', `/api/vendor/contracts/${second.json.data.id}/send`, 'vendorB');
      assert.equal(sent.status, 200);
      assert.equal((await call(url, 'DELETE', `/api/vendor/contracts/${second.json.data.id}`, 'vendorB')).status, 409);
      assert.equal((await call(url, 'DELETE', `/api/vendor/contracts/${row.id}`, 'vendorB')).status, 200);
      const list = await call(url, 'GET', '/api/vendor/contracts', 'vendorB');
      assert.deepEqual(list.json.data.map((c: any) => c.id), [second.json.data.id]);
    } finally {
      await close();
    }
  });

  it('sends with a reusable secret link and the vendor «issued by» mark', async () => {
    const { url, close } = await setup();
    try {
      const { json } = await call(url, 'POST', '/api/vendor/contracts', 'vendorB', draftBody());
      const first = await call(url, 'POST', `/api/vendor/contracts/${json.data.id}/send`, 'vendorB');
      assert.equal(first.json.data.status, 'sent');
      assert.equal(first.json.data.vendorSignature.name, 'خيام الشمال');
      assert.ok(first.json.data.sentAt);
      const token = tokenOf(first.json.signUrl);
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(first.json.data.shareToken, undefined, 'raw token never travels as a field');
      assert.equal(first.json.data.signUrl, first.json.signUrl);
      const again = await call(url, 'POST', `/api/vendor/contracts/${json.data.id}/send`, 'vendorB');
      assert.equal(again.json.signUrl, first.json.signUrl);
      // Two contracts never share a token.
      const other = await call(url, 'POST', '/api/vendor/contracts', 'vendorB', draftBody());
      const otherSent = await call(url, 'POST', `/api/vendor/contracts/${other.json.data.id}/send`, 'vendorB');
      assert.notEqual(tokenOf(otherSent.json.signUrl), token);
    } finally {
      await close();
    }
  });

  it('cancels a draft or sent contract; a cancelled link is dead', async () => {
    const { url, close } = await setup();
    try {
      const { json } = await call(url, 'POST', '/api/vendor/contracts', 'vendorB', draftBody());
      const sent = await call(url, 'POST', `/api/vendor/contracts/${json.data.id}/send`, 'vendorB');
      const token = tokenOf(sent.json.signUrl);
      assert.equal((await call(url, 'GET', `/api/contracts/sign/${token}`)).status, 200);
      const cancelled = await call(url, 'POST', `/api/vendor/contracts/${json.data.id}/cancel`, 'vendorB');
      assert.equal(cancelled.json.data.status, 'cancelled');
      assert.equal((await call(url, 'GET', `/api/contracts/sign/${token}`)).status, 404);
      assert.equal((await call(url, 'POST', `/api/vendor/contracts/${json.data.id}/cancel`, 'vendorB')).status, 409);
      assert.equal((await call(url, 'POST', `/api/vendor/contracts/${json.data.id}/send`, 'vendorB')).status, 409);
      assert.equal((await call(url, 'PATCH', `/api/vendor/contracts/${json.data.id}`, 'vendorB', draftBody())).status, 409);
    } finally {
      await close();
    }
  });

  it('keeps vendors apart: B cannot read, edit, send or delete A\'s contract', async () => {
    const { url, close } = await setup();
    try {
      const { json } = await call(url, 'POST', '/api/vendor/contracts', 'vendorA', draftBody());
      const id = json.data.id;
      assert.equal((await call(url, 'GET', `/api/vendor/contracts/${id}`, 'vendorB')).status, 404);
      assert.equal((await call(url, 'PATCH', `/api/vendor/contracts/${id}`, 'vendorB', draftBody())).status, 404);
      assert.equal((await call(url, 'POST', `/api/vendor/contracts/${id}/send`, 'vendorB')).status, 404);
      assert.equal((await call(url, 'POST', `/api/vendor/contracts/${id}/cancel`, 'vendorB')).status, 404);
      assert.equal((await call(url, 'DELETE', `/api/vendor/contracts/${id}`, 'vendorB')).status, 404);
      const listB = await call(url, 'GET', '/api/vendor/contracts', 'vendorB');
      assert.equal(listB.json.data.length, 0);
      // A vendor cannot borrow ?vendorId=.
      const sneaky = await call(url, 'GET', '/api/vendor/contracts?vendorId=v-a', 'vendorB');
      assert.equal(sneaky.json.data.length, 0);
      assert.equal((await call(url, 'GET', '/api/vendor/contracts', 'client')).status, 403);
      assert.equal((await call(url, 'GET', '/api/vendor/contracts')).status, 401);
    } finally {
      await close();
    }
  });

  it('lets a supervisor act for a vendor with ?vendorId= and requires it', async () => {
    const { url, close } = await setup();
    try {
      assert.equal((await call(url, 'GET', '/api/vendor/contracts', 'admin')).status, 400);
      assert.equal((await call(url, 'GET', '/api/vendor/contracts?vendorId=nobody', 'manager')).status, 404);
      const made = await call(url, 'POST', '/api/vendor/contracts?vendorId=v-b', 'manager', draftBody());
      assert.equal(made.status, 201);
      assert.equal(made.json.data.vendorId, 'v-b');
      const mine = await call(url, 'GET', '/api/vendor/contracts', 'vendorB');
      assert.equal(mine.json.data.length, 1);
      const viaAdmin = await call(url, 'GET', `/api/vendor/contracts/${made.json.data.id}?vendorId=v-b`, 'admin');
      assert.equal(viaAdmin.status, 200);
    } finally {
      await close();
    }
  });

  it('imports the old dashboard contracts once, flagged legacy', async () => {
    const { url, close, dir } = await setup();
    try {
      const first = await call(url, 'GET', '/api/vendor/contracts', 'vendorA');
      assert.equal(first.json.data.length, 2);
      const signed = first.json.data.find((c: any) => c.number === 'CNT-2026-1234');
      assert.equal(signed.legacy, true);
      assert.equal(signed.status, 'signed');
      assert.match(signed.signature.note, /ليس توقيعاً موثّقاً/);
      assert.equal(signed.signature.image, '');
      assert.equal(signed.signUrl, undefined);
      const pending = first.json.data.find((c: any) => c.number === 'CNT-2026-5678');
      assert.equal(pending.status, 'draft');
      // Deleting an imported draft does not bring it back on the next list.
      await call(url, 'DELETE', `/api/vendor/contracts/${pending.id}`, 'vendorA');
      const second = await call(url, 'GET', '/api/vendor/contracts', 'vendorA');
      assert.equal(second.json.data.length, 1);
      const stored = JSON.parse(fs.readFileSync(contractsFile(dir), 'utf-8'));
      assert.deepEqual(stored.legacyImported, ['v-a']);
      // The imported signed record is immutable like any signed one.
      assert.equal((await call(url, 'PATCH', `/api/vendor/contracts/${signed.id}`, 'vendorA', draftBody())).status, 409);
      assert.equal((await call(url, 'POST', `/api/vendor/contracts/${signed.id}/send`, 'vendorA')).status, 409);
    } finally {
      await close();
    }
  });
});

/* ── Public signing ────────────────────────────────────────────────── */

describe('contract routes — public signing', () => {
  async function sentContract(url: string, actor = 'vendorA') {
    const { json } = await call(url, 'POST', '/api/vendor/contracts', actor, draftBody());
    const sent = await call(url, 'POST', `/api/vendor/contracts/${json.data.id}/send`, actor);
    return { id: json.data.id as string, token: tokenOf(sent.json.signUrl) };
  }

  it('shows the contract without internals', async () => {
    const { url, close } = await setup();
    try {
      const { token } = await sentContract(url);
      const view = await call(url, 'GET', `/api/contracts/sign/${token}`);
      assert.equal(view.status, 200);
      assert.equal(view.headers.get('x-robots-tag'), 'noindex, nofollow');
      assert.equal(view.headers.get('cache-control'), 'no-store');
      const data = view.json.data;
      assert.equal(data.vendor.name, 'قهوة الرياض');
      assert.equal(data.vendor.logoUrl, '/uploads/logo-a.png');
      assert.equal(data.vendor.crNumber, '1010123456');
      assert.equal(data.client.name, 'فهد الدوسري');
      assert.equal(data.client.phoneMasked.slice(-3), '567');
      assert.equal(data.status, 'sent');
      assert.equal(data.terms.length, 2);
      const raw = JSON.stringify(data);
      for (const secret of ['v-a', 'vendorId', 'shareToken', token, '1012345678', 'fahad@example.com', '0501234567', '"id"', 'BK-1001']) {
        assert.ok(!raw.includes(secret), `public view leaks ${secret}`);
      }
      assert.equal((await call(url, 'GET', '/api/contracts/sign/not-a-real-token-but-long-enough-0123456789')).status, 404);
      assert.equal((await call(url, 'GET', '/api/contracts/sign/short')).status, 404);
    } finally {
      await close();
    }
  });

  it('never shows an inline logo blob to the public', async () => {
    const { url, close } = await setup();
    try {
      const { token } = await sentContract(url, 'vendorB');
      const view = await call(url, 'GET', `/api/contracts/sign/${token}`);
      assert.equal(view.json.data.vendor.logoUrl, undefined);
    } finally {
      await close();
    }
  });

  it('signs once, records proof, and emails the vendor', async () => {
    mails.length = 0;
    const { url, close } = await setup();
    try {
      const { id, token } = await sentContract(url);
      const view = await call(url, 'GET', `/api/contracts/sign/${token}`);
      const body = { name: 'فهد بن سعد الدوسري', signature: pngDataUrl(), agree: true, contentHash: view.json.data.contentHash };
      const signed = await call(url, 'POST', `/api/contracts/sign/${token}`, '', body, { 'User-Agent': 'TestPhone/1.0' });
      assert.equal(signed.status, 200);
      assert.equal(signed.json.data.status, 'signed');
      assert.equal(signed.json.data.signature.name, 'فهد بن سعد الدوسري');
      assert.ok(signed.json.data.signedAt);

      const again = await call(url, 'POST', `/api/contracts/sign/${token}`, '', body);
      assert.equal(again.status, 409);
      assert.equal(again.json.code, 'already_signed');

      const detail = await call(url, 'GET', `/api/vendor/contracts/${id}`, 'vendorA');
      const sig = detail.json.data.signature;
      assert.equal(sig.name, 'فهد بن سعد الدوسري');
      assert.match(sig.image, /^data:image\/png;base64,/);
      assert.equal(sig.userAgent, 'TestPhone/1.0');
      assert.ok(sig.ip);
      assert.equal(sig.contentHash, view.json.data.contentHash);
      assert.equal(detail.json.data.legacy, undefined);

      // The list stays light: no image, just the fact there is one.
      const list = await call(url, 'GET', '/api/vendor/contracts', 'vendorA');
      const row = list.json.data.find((c: any) => c.id === id);
      assert.equal(row.signature.image, '');
      assert.equal(row.signature.hasImage, true);

      // Signed is final.
      assert.equal((await call(url, 'PATCH', `/api/vendor/contracts/${id}`, 'vendorA', draftBody())).status, 409);
      assert.equal((await call(url, 'POST', `/api/vendor/contracts/${id}/cancel`, 'vendorA')).status, 409);
      assert.equal((await call(url, 'DELETE', `/api/vendor/contracts/${id}`, 'vendorA')).status, 409);

      await settle();
      assert.ok(mails.some((mail) => mail.to.includes('va@usil.sa') && /وقّع العميل العقد/.test(mail.subject)));
    } finally {
      await close();
    }
  });

  it('refuses a signature on content that changed after the page was opened', async () => {
    const { url, close } = await setup();
    try {
      const { id, token } = await sentContract(url);
      const before = await call(url, 'GET', `/api/contracts/sign/${token}`);
      const edited = await call(url, 'PATCH', `/api/vendor/contracts/${id}`, 'vendorA', draftBody({ amounts: { total: 9999, deposit: 0 } }));
      assert.equal(edited.json.data.status, 'sent', 'editing keeps the link alive');
      const stale = await call(url, 'POST', `/api/contracts/sign/${token}`, '', {
        name: 'فهد الدوسري',
        signature: pngDataUrl(),
        agree: true,
        contentHash: before.json.data.contentHash,
      });
      assert.equal(stale.status, 409);
      assert.equal(stale.json.code, 'changed');
      assert.equal(stale.json.error, 'العقد تغيّر — حدّث الصفحة');
      const fresh = await call(url, 'GET', `/api/contracts/sign/${token}`);
      assert.equal(fresh.json.data.amounts.total, 9999);
      const ok = await call(url, 'POST', `/api/contracts/sign/${token}`, '', {
        name: 'فهد الدوسري',
        signature: pngDataUrl(),
        agree: true,
        contentHash: fresh.json.data.contentHash,
      });
      assert.equal(ok.status, 200);
    } finally {
      await close();
    }
  });

  it('validates the signing form', async () => {
    const { url, close } = await setup();
    try {
      const { token } = await sentContract(url);
      const { json } = await call(url, 'GET', `/api/contracts/sign/${token}`);
      const good = { name: 'فهد الدوسري', signature: pngDataUrl(), agree: true, contentHash: json.data.contentHash };
      const cases: Array<[Record<string, unknown>, number]> = [
        [{ ...good, agree: false }, 400],
        [{ ...good, agree: 'yes' }, 400],
        [{ ...good, name: 'فه' }, 400],
        [{ ...good, signature: '' }, 400],
        [{ ...good, signature: 'data:image/svg+xml;base64,PHN2Zz4=' }, 400],
        [{ ...good, signature: pngDataUrl(700, 500, true) }, 413],
        [{ ...good, contentHash: 'abc' }, 409],
      ];
      for (const [body, status] of cases) {
        const res = await call(url, 'POST', `/api/contracts/sign/${token}`, '', body);
        assert.equal(res.status, status, JSON.stringify({ ...body, signature: String(body.signature).slice(0, 30) }));
      }
      const view = await call(url, 'GET', `/api/contracts/sign/${token}`);
      assert.equal(view.json.data.status, 'sent', 'nothing was signed by a refused attempt');
    } finally {
      await close();
    }
  });

  it('rate-limits the public routes per IP', async () => {
    const { url, close } = await setup({ read: 3, sign: 2 });
    try {
      const { token } = await sentContract(url);
      for (let i = 0; i < 3; i++) assert.equal((await call(url, 'GET', `/api/contracts/sign/${token}`)).status, 200);
      assert.equal((await call(url, 'GET', `/api/contracts/sign/${token}`)).status, 429);
      const bad = { name: 'فهد', signature: '', agree: true, contentHash: 'x' };
      assert.equal((await call(url, 'POST', `/api/contracts/sign/${token}`, '', bad)).status, 400);
      assert.equal((await call(url, 'POST', `/api/contracts/sign/${token}`, '', bad)).status, 400);
      assert.equal((await call(url, 'POST', `/api/contracts/sign/${token}`, '', bad)).status, 429);
    } finally {
      await close();
    }
  });
});

describe('signing page shell', () => {
  it('is served noindex with no referrer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-contracts-seo-'));
    const indexHtmlPath = path.join(dir, 'index.html');
    fs.writeFileSync(indexHtmlPath, '<html><head><title>x</title></head><body><div id="root"></div></body></html>');
    const app = express();
    const auth = { userFromRequest: () => null, requireRole: () => (_req: Request, res: Response) => res.status(401).end() };
    const { sendSpa } = registerSeoRoutes(app, auth as any, dir, { indexHtmlPath });
    app.get('*', sendSpa);
    const { url, close } = await listen(app);
    try {
      const page = await fetch(`${url}/sign/Ab3_x-9QzLmN0pQrStUvWxYz0123456789abcdEFGH`);
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
      assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
      const home = await fetch(`${url}/`);
      assert.equal(home.headers.get('x-robots-tag'), null);
    } finally {
      await close();
    }
  });
});
