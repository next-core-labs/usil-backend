import nodeFs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import type { DataFs } from '../server/shared/data-fs.ts';

/**
 * `data/` on Cloudflare: the file calls the stores make, answered from the
 * Durable Object's SQLite database. Durable Object SQL is synchronous, so the
 * stores keep their synchronous reads and writes unchanged.
 *
 * A file is a `files` row plus its bytes split across `chunks` rows, since one
 * SQLite value is capped at 2 MB. Directories exist when something was created
 * under them, or when `mkdirSync` named them.
 */

const CHUNK = 1024 * 1024;

type Row = Record<string, SqlStorageValue>;

function fsError(code: 'ENOENT' | 'EEXIST' | 'EISDIR', syscall: string, file: string): NodeJS.ErrnoException {
  const messages = { ENOENT: 'no such file or directory', EEXIST: 'file already exists', EISDIR: 'illegal operation on a directory' };
  const error: NodeJS.ErrnoException = new Error(`${code}: ${messages[code]}, ${syscall} '${file}'`);
  error.code = code;
  error.syscall = syscall;
  error.path = file;
  return error;
}

function encodingOf(options: unknown): BufferEncoding | null {
  if (typeof options === 'string') return options as BufferEncoding;
  if (options && typeof options === 'object' && 'encoding' in options) {
    return ((options as { encoding?: BufferEncoding | null }).encoding ?? null) as BufferEncoding | null;
  }
  return null;
}

function toBytes(data: unknown, options: unknown): Buffer {
  if (typeof data === 'string') return Buffer.from(data, encodingOf(options) || 'utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('writeFileSync: unsupported data type');
}

export function createSqliteFs(storage: DurableObjectStorage): DataFs {
  const sql = storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime REAL NOT NULL, chunks INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS chunks (
    path TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (path, n))`);
  sql.exec('CREATE TABLE IF NOT EXISTS dirs (path TEXT PRIMARY KEY)');

  const norm = (file: nodeFs.PathLike) => path.posix.resolve(String(file));
  const one = (query: string, ...params: SqlStorageValue[]): Row | undefined => sql.exec(query, ...params).toArray()[0];

  const fileRow = (p: string) =>
    one('SELECT size, mtime, chunks FROM files WHERE path = ?', p) as
      | { size: number; mtime: number; chunks: number }
      | undefined;

  /** Anything stored below `dir`, or `dir` itself named by mkdirSync. '0' is the character after '/'. */
  const isDir = (p: string) =>
    p === '/' ||
    Boolean(one('SELECT 1 AS x FROM dirs WHERE path = ?', p)) ||
    Boolean(one('SELECT 1 AS x FROM files WHERE path >= ? AND path < ? LIMIT 1', `${p}/`, `${p}0`)) ||
    Boolean(one('SELECT 1 AS x FROM dirs WHERE path >= ? AND path < ? LIMIT 1', `${p}/`, `${p}0`));

  function readBytes(p: string, syscall: string): Buffer {
    const row = fileRow(p);
    if (!row) throw isDir(p) ? fsError('EISDIR', syscall, p) : fsError('ENOENT', syscall, p);
    const parts = sql
      .exec('SELECT data FROM chunks WHERE path = ? ORDER BY n', p)
      .toArray()
      .map((r) => Buffer.from(r.data as ArrayBuffer));
    return Buffer.concat(parts);
  }

  function remove(p: string) {
    sql.exec('DELETE FROM chunks WHERE path = ?', p);
    sql.exec('DELETE FROM files WHERE path = ?', p);
  }

  function writeBytes(p: string, bytes: Buffer) {
    if (isDir(p) && !fileRow(p)) throw fsError('EISDIR', 'open', p);
    storage.transactionSync(() => {
      remove(p);
      const count = Math.max(1, Math.ceil(bytes.length / CHUNK));
      for (let n = 0; n < count; n += 1) {
        sql.exec('INSERT INTO chunks (path, n, data) VALUES (?, ?, ?)', p, n, bytes.subarray(n * CHUNK, (n + 1) * CHUNK));
      }
      sql.exec('INSERT INTO files (path, size, mtime, chunks) VALUES (?, ?, ?, ?)', p, bytes.length, Date.now(), count);
    });
  }

  function stat(p: string) {
    const row = fileRow(p);
    const dir = !row && isDir(p);
    if (!row && !dir) throw fsError('ENOENT', 'stat', p);
    const mtimeMs = row ? row.mtime : 0;
    return {
      isFile: () => Boolean(row),
      isDirectory: () => dir,
      isSymbolicLink: () => false,
      size: row ? row.size : 0,
      mtimeMs,
      mtime: new Date(mtimeMs),
    };
  }

  const impl = {
    existsSync: (file: nodeFs.PathLike) => {
      const p = norm(file);
      return Boolean(fileRow(p)) || isDir(p);
    },
    readFileSync: (file: nodeFs.PathOrFileDescriptor, options?: unknown) => {
      const bytes = readBytes(norm(file as nodeFs.PathLike), 'open');
      const encoding = encodingOf(options);
      return encoding ? bytes.toString(encoding) : bytes;
    },
    writeFileSync: (file: nodeFs.PathOrFileDescriptor, data: unknown, options?: unknown) => {
      writeBytes(norm(file as nodeFs.PathLike), toBytes(data, options));
    },
    renameSync: (from: nodeFs.PathLike, to: nodeFs.PathLike) => {
      const a = norm(from);
      const b = norm(to);
      if (!fileRow(a)) throw fsError('ENOENT', 'rename', a);
      if (a === b) return;
      storage.transactionSync(() => {
        remove(b);
        sql.exec('UPDATE chunks SET path = ? WHERE path = ?', b, a);
        sql.exec('UPDATE files SET path = ? WHERE path = ?', b, a);
      });
    },
    unlinkSync: (file: nodeFs.PathLike) => {
      const p = norm(file);
      if (!fileRow(p)) throw isDir(p) ? fsError('EISDIR', 'unlink', p) : fsError('ENOENT', 'unlink', p);
      storage.transactionSync(() => remove(p));
    },
    copyFileSync: (from: nodeFs.PathLike, to: nodeFs.PathLike, mode?: number) => {
      const b = norm(to);
      if (mode && mode & nodeFs.constants.COPYFILE_EXCL && fileRow(b)) throw fsError('EEXIST', 'copyfile', b);
      writeBytes(b, readBytes(norm(from), 'copyfile'));
    },
    statSync: (file: nodeFs.PathLike) => stat(norm(file)),
    readdirSync: (dir: nodeFs.PathLike) => {
      const p = norm(dir);
      if (fileRow(p)) throw Object.assign(fsError('ENOENT', 'scandir', p), { code: 'ENOTDIR' });
      if (!isDir(p)) throw fsError('ENOENT', 'scandir', p);
      const prefix = p === '/' ? '/' : `${p}/`;
      const upper = p === '/' ? '0' : `${p}0`;
      const names = new Set<string>();
      for (const table of ['files', 'dirs']) {
        for (const row of sql.exec(`SELECT path FROM ${table} WHERE path >= ? AND path < ?`, prefix, upper)) {
          const rest = String(row.path).slice(prefix.length);
          if (rest) names.add(rest.split('/')[0]);
        }
      }
      return [...names].sort();
    },
    mkdirSync: (dir: nodeFs.PathLike) => {
      let p = norm(dir);
      while (p !== '/') {
        sql.exec('INSERT OR IGNORE INTO dirs (path) VALUES (?)', p);
        p = path.posix.dirname(p);
      }
      return undefined;
    },
    chmodSync: (file: nodeFs.PathLike) => {
      // SQLite rows have no permission bits; the whole store is private to the Worker.
      const p = norm(file);
      if (!fileRow(p) && !isDir(p)) throw fsError('ENOENT', 'chmod', p);
    },
    constants: nodeFs.constants,
  };
  return impl as unknown as DataFs;
}
