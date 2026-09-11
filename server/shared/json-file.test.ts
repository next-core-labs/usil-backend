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
});
