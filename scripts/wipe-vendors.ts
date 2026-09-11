/**
 * يفرّغ كل الموردين والصور الوهمية من ملفات JSON المحلية.
 * تشغيل: npx tsx scripts/wipe-vendors.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wipeAllVendorsAndDummyMedia } from '../server/auth/dummy-accounts.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', 'data');
const result = wipeAllVendorsAndDummyMedia(dataDir);
console.log(JSON.stringify(result, null, 2));
