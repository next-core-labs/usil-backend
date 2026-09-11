/**
 * Guards the one weak seam in the frontend/backend split.
 *
 * `core/` holds the modules both sides need — domain types, the Saudi place
 * list, the catalog/media rules, the SPA route table. The web project keeps its
 * own copy under `src/`, so the two can silently drift: fix a rule in one and
 * the other keeps the old behaviour, with nothing failing to tell you.
 *
 * This compares every `core/**` module against its `src/**` counterpart and
 * reports the differences. It is advisory by default and exits non-zero only
 * with --strict, so CI can enforce it without breaking a standalone checkout.
 *
 * Usage: npm run check:core-sync
 *        npm run check:core-sync -- --strict
 *        WEB_ROOT=/path/to/usil npm run check:core-sync
 */
import fs from 'node:fs';
import path from 'node:path';

const strict = process.argv.includes('--strict');
const backendRoot = process.cwd();
const coreDir = path.join(backendRoot, 'core');
const webRoot = path.resolve(backendRoot, process.env.WEB_ROOT || '../usil');
const webSrc = path.join(webRoot, 'src');

if (!fs.existsSync(webSrc)) {
  console.log(`ℹ No web project at ${webSrc} — skipping core/src sync check.`);
  console.log('  Set WEB_ROOT if the frontend lives elsewhere.');
  process.exit(0);
}

/** Every .ts/.tsx under core/, excluding tests. */
function coreModules(dir = coreDir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) coreModules(full, found);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) found.push(full);
  }
  return found;
}

const missing = [];
const diverged = [];
const matched = [];

for (const corePath of coreModules()) {
  const relative = path.relative(coreDir, corePath);
  const webPath = path.join(webSrc, relative);
  if (!fs.existsSync(webPath)) {
    missing.push(relative);
    continue;
  }
  const a = fs.readFileSync(corePath, 'utf-8');
  const b = fs.readFileSync(webPath, 'utf-8');
  (a === b ? matched : diverged).push(relative);
}

console.log(`Comparing core/ against ${path.relative(backendRoot, webSrc) || webSrc}`);
console.log(`  in sync:  ${matched.length}`);

if (missing.length) {
  console.log(`\n⚠ ${missing.length} core module(s) have no counterpart in the web project:`);
  for (const file of missing) console.log(`    core/${file}`);
}

if (diverged.length) {
  console.log(`\n✖ ${diverged.length} module(s) have DIVERGED — the two apps disagree:`);
  for (const file of diverged) {
    console.log(`    core/${file}`);
    console.log(`      vs ${path.join(webSrc, file)}`);
  }
  console.log('\n  Reconcile them, then re-run. Whichever copy is correct, both must match.');
} else if (!missing.length) {
  console.log('\n✅ core/ and the web project agree on every shared module.');
}

if (strict && (diverged.length || missing.length)) process.exit(1);
