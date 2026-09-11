/**
 * Copies the frontend's built SPA into this backend's dist/ so express.static can serve it.
 * The backend bundles itself to dist/server.cjs, so that file and its map are never overwritten.
 *
 * Usage: npm run sync:web            (defaults to ../usil/dist)
 *        WEB_DIST=/path/to/dist npm run sync:web
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const from = path.resolve(root, process.env.WEB_DIST || '../usil/dist');
const to = path.join(root, 'dist');
const KEEP = new Set(['server.cjs', 'server.cjs.map']);

if (!fs.existsSync(from)) {
  console.error(`No frontend build at ${from}. Run \`npm run build\` in the frontend first.`);
  process.exit(1);
}

fs.mkdirSync(to, { recursive: true });
for (const entry of fs.readdirSync(to)) {
  if (!KEEP.has(entry)) fs.rmSync(path.join(to, entry), { recursive: true, force: true });
}
for (const entry of fs.readdirSync(from)) {
  if (KEEP.has(entry) || entry === '.DS_Store') continue;
  fs.cpSync(path.join(from, entry), path.join(to, entry), { recursive: true });
}
console.log(`Synced SPA from ${from} -> ${to}`);
