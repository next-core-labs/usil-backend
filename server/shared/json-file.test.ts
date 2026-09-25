import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readJsonFile, writeJsonFile } from './json-file.ts';

describe('json-file atomic write', () => {
  it('replaces the file in one rename so a crash cannot leave empty JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-json-'));
    const file = path.join(dir, 'sessions.json');
    writeJsonFile(file, { token: 'usr-1' });
    assert.equal(readJsonFile<{ token?: string }>(file, {}).token, 'usr-1');
    writeJsonFile(file, { token: 'usr-1', token2: 'usr-2' });
    assert.deepEqual(readJsonFile(file, {}), { token: 'usr-1', token2: 'usr-2' });
    assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
  });

  it('returns fallback when the file is corrupt instead of throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-json-'));
    const file = path.join(dir, 'users.json');
    fs.writeFileSync(file, '{not-json', 'utf-8');
    assert.deepEqual(readJsonFile(file, []), []);
  });

  it('copies a corrupt file aside before returning the fallback, once per version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-json-'));
    const file = path.join(dir, 'bookings.json');
    fs.writeFileSync(file, '[{"id":"bk-1"', 'utf-8');
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
    try {
      assert.deepEqual(readJsonFile(file, []), []);
      assert.deepEqual(readJsonFile(file, []), []);
    } finally {
      console.warn = warn;
    }
    const backups = fs.readdirSync(dir).filter((name) => name.startsWith('bookings.json.corrupt-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf-8'), '[{"id":"bk-1"');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /corrupt-/);

    // The next write replaces the live file, but the corrupt copy survives.
    writeJsonFile(file, [{ id: 'bk-2' }]);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf-8'), '[{"id":"bk-1"');
  });

  it('returns the fallback quietly for a missing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usil-json-'));
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
    try {
      assert.deepEqual(readJsonFile(path.join(dir, 'missing.json'), { ok: true }), { ok: true });
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 0);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});
