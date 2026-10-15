/**
 * Builds .cf-assets/, the static files Cloudflare serves for usil.app: this
 * project's public/ with the SPA build from dist/ laid over it. Same precedence
 * as the Express server, which tries dist/ before public/.
 *
 * Usage: npm run cf:assets   (after `npm run sync:web`)
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
const out = path.join(root, '.cf-assets');

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('No SPA in dist/. Build the frontend, then run `npm run sync:web` first.');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
const skip = (src) => path.basename(src) !== '.DS_Store' && !/^server\.cjs(\.map)?$/.test(path.basename(src));
fs.cpSync(path.join(root, 'public'), out, { recursive: true, filter: skip });
fs.cpSync(dist, out, { recursive: true, filter: skip });
console.log(`Cloudflare assets ready in ${out}`);
