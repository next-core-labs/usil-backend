import nodeFs from 'fs';

/**
 * The file system behind `data/`: the JSON documents and the uploads. On Node it
 * is the real disk. On Cloudflare there is no disk, so `worker/` swaps in a
 * Durable Object's SQLite store (see `worker/sqlite-fs.ts`) before the app is
 * built. Every module that reads or writes under `data/` imports `fs` from here,
 * never from `'fs'`, or its writes would vanish on Cloudflare.
 *
 * Only the synchronous calls the stores use are part of the contract.
 */
export type DataFs = Pick<
  typeof nodeFs,
  | 'existsSync'
  | 'readFileSync'
  | 'writeFileSync'
  | 'renameSync'
  | 'unlinkSync'
  | 'copyFileSync'
  | 'statSync'
  | 'readdirSync'
  | 'mkdirSync'
  | 'chmodSync'
  | 'constants'
>;

let current: DataFs = nodeFs;

/** Replace the backing store. Call once, before any store is created. */
export function useDataFs(impl: DataFs) {
  current = impl;
}

export const fs: DataFs = {
  existsSync: (...args) => current.existsSync(...args),
  readFileSync: ((...args: Parameters<typeof nodeFs.readFileSync>) =>
    current.readFileSync(...args)) as DataFs['readFileSync'],
  writeFileSync: (...args) => current.writeFileSync(...args),
  renameSync: (...args) => current.renameSync(...args),
  unlinkSync: (...args) => current.unlinkSync(...args),
  copyFileSync: (...args) => current.copyFileSync(...args),
  statSync: ((...args: Parameters<typeof nodeFs.statSync>) => current.statSync(...args)) as DataFs['statSync'],
  readdirSync: ((...args: Parameters<typeof nodeFs.readdirSync>) =>
    current.readdirSync(...args)) as DataFs['readdirSync'],
  mkdirSync: ((...args: Parameters<typeof nodeFs.mkdirSync>) => current.mkdirSync(...args)) as DataFs['mkdirSync'],
  chmodSync: (...args) => current.chmodSync(...args),
  get constants() {
    return current.constants;
  },
};
