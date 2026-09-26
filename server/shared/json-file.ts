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

/** Corrupt versions already copied aside this process, keyed by path + mtime + size. */
const preservedCorrupt = new Set<string>();

/**
 * Copy a document that exists but fails to parse to `<file>.corrupt-<timestamp>`
 * before its caller gets the fallback, so the caller's next write cannot silently
 * destroy whatever was in it. Each distinct corrupt version is copied once.
 */
function preserveCorruptFile(file: string, raw: string, error: unknown): string | null {
  let key = file;
  try {
    const stat = fs.statSync(file);
    key = `${file}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    /* fall back to the path alone */
  }
  if (preservedCorrupt.has(key)) return null;
  preservedCorrupt.add(key);
  const reason = error instanceof Error ? error.message : String(error);
  if (!raw.trim()) {
    console.warn(`[json-file] ${file} is empty; using the fallback value.`);
    return null;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let backup = `${file}.corrupt-${stamp}`;
  for (let n = 1; fs.existsSync(backup); n += 1) backup = `${file}.corrupt-${stamp}-${n}`;
  try {
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    console.warn(`[json-file] ${file} could not be parsed (${reason}); copied it to ${backup} and using the fallback value.`);
    return backup;
  } catch (copyError) {
    const copyReason = copyError instanceof Error ? copyError.message : String(copyError);
    console.warn(`[json-file] ${file} could not be parsed (${reason}) and could not be backed up (${copyReason}); using the fallback value.`);
    return null;
  }
}

export function readJsonFile<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[json-file] ${file} could not be read (${reason}); using the fallback value.`);
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    preserveCorruptFile(file, raw, error);
    return fallback;
  }
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
