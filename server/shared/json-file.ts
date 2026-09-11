import fs from 'fs';
import path from 'path';

/**
 * The JSON documents under `data/` are this application's entire database, so
 * every read and write goes through here. Use these helpers rather than `fs`
 * directly — a plain `fs.writeFileSync` can be interrupted part-way and leave a
 * truncated file, which for these files means losing the data outright.
 */

export type WriteJsonOptions = {
  /** File mode, e.g. `0o600` for documents holding credentials. */
  mode?: number;
};

export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    /* corrupt or unreadable — keep the previous good copy if any */
  }
  return fallback;
}

/**
 * Read a JSON array, falling back to `[]` for a missing, corrupt, or
 * non-array document. Most stores hold a top-level array.
 */
export function readJsonArray<T>(file: string): T[] {
  const parsed = readJsonFile<unknown>(file, []);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

/**
 * Write JSON by replacing the file atomically, so an interrupted write cannot
 * leave a half-written document behind. The temp file is created with the final
 * mode, so a `0o600` document is never briefly world-readable.
 */
export function writeJsonFile(file: string, value: unknown, options: WriteJsonOptions = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const writeOptions: fs.WriteFileOptions =
    options.mode === undefined ? 'utf-8' : { encoding: 'utf-8', mode: options.mode };
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), writeOptions);
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    // Never leave the temp file behind if the swap itself failed.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw error;
  }
}
