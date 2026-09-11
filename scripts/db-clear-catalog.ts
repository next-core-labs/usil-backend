/**
 * يفرّغ كتالوج البذرة من القاعدة (خدمات التجريب ذات الـslug الثابت).
 *
 * لا يلمس الحجوزات ولا المدفوعات. أي خدمة عليها حجز تُتخطّى.
 * بلا `--apply` يعرض العدّ فقط.
 *
 * تشغيل: `npm run db:clear-catalog`
 * حذف فعلي: `npm run db:clear-catalog -- --apply`
 */

import fs from 'node:fs';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const ROOT = process.cwd();

const SEED_VENDOR_SLUGS = [
  'v1-diyafat-alasala',
  'v2-bayt-alhala',
  'v3-marah-lilalaab',
  'v4-lamsat-tanseeq',
  'v5-kosh-alrayan',
  'v6-shalihat-alnaseem',
  'v7-muassasat-alfaaliyat',
] as const;

const SEED_SERVICE_SLUGS = [
  'buffet-premium-40',
  'coffee-corner',
  'kids-bounce-castle',
  'kids-entertainment-show',
  'balloon-decoration',
  'full-venue-styling',
  'wedding-kosha-classic',
  'photo-corner',
  'family-chalet-day',
  'events-hall-medium',
  'chairs-tables-set',
  'sound-lighting-kit',
] as const;

function loadEnvFile(file: string) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function resolveDatabaseUrl(): string {
  const candidates = [
    path.join(ROOT, '.env.local'),
    path.join(ROOT, '.env'),
    path.join(ROOT, 'midyaf', '.env.local'),
    path.join(ROOT, 'midyaf', '.env'),
    path.join(ROOT, 'midyaf', '.env.production.local.save'),
  ];
  for (const file of candidates) loadEnvFile(file);
  return String(process.env.DATABASE_URL || '').trim();
}

function quoteList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ');
}

async function clearPostgres(url: string) {
  const postgres = (await import('postgres')).default;
  const sql = postgres(url, { max: 1, ssl: 'require' });
  try {
    const services = await sql<{ slug: string; bookings: number }[]>`
      select s.slug, count(b.id)::int as bookings
        from services s
        left join bookings b on b.service_id = s.id
       where s.slug in ${sql(SEED_SERVICE_SLUGS as unknown as string[])}
       group by s.id, s.slug
       order by s.slug
    `;
    const vendors = await sql<{ slug: string; services: number; bookings: number }[]>`
      select v.slug,
             count(distinct s.id)::int as services,
             count(distinct b.id)::int as bookings
        from vendors v
        left join services s on s.vendor_id = v.id
        left join bookings b on b.vendor_id = v.id
       where v.slug in ${sql(SEED_VENDOR_SLUGS as unknown as string[])}
       group by v.id, v.slug
       order by v.slug
    `;

    console.log(`خدمات البذرة في القاعدة: ${services.length}`);
    for (const row of services) {
      console.log(`  ${row.slug.padEnd(28)} ${row.bookings} حجزًا`);
    }
    console.log(`مزوّدو البذرة في القاعدة: ${vendors.length}`);
    for (const row of vendors) {
      console.log(`  ${row.slug.padEnd(28)} ${row.services} خدمة · ${row.bookings} حجزًا`);
    }

    const blocked = services.filter((row) => row.bookings > 0).map((row) => row.slug);
    const removable = services.filter((row) => row.bookings === 0).map((row) => row.slug);
    if (blocked.length) {
      console.log(`\nتُتخطّى لأنها عليها حجوزات: ${blocked.join(', ')}`);
    }

    if (!APPLY) {
      console.log('\nعرض فقط. للحذف الفعلي: npm run db:clear-catalog -- --apply');
      return;
    }

    if (removable.length === 0 && vendors.every((row) => row.bookings > 0 || row.services > 0)) {
      console.log('\nلا شيء يُحذف.');
      return;
    }

    if (removable.length) {
      await sql.unsafe(`
        delete from service_includes
         where service_id in (select id from services where slug in (${quoteList(removable)}))
      `);
      await sql.unsafe(`
        delete from service_images
         where service_id in (select id from services where slug in (${quoteList(removable)}))
      `);
      await sql.unsafe(`
        delete from service_availability
         where service_id in (select id from services where slug in (${quoteList(removable)}))
      `);
      const deletedServices = await sql.unsafe(`
        delete from services where slug in (${quoteList(removable)})
          and id not in (select service_id from bookings where service_id is not null)
      `);
      console.log(`حُذفت خدمات: ${deletedServices.count ?? removable.length}`);
    }

    const vendorGone = vendors
      .filter((row) => row.bookings === 0)
      .map((row) => row.slug);
    if (vendorGone.length) {
      const deletedVendors = await sql.unsafe(`
        delete from vendors v
         where v.slug in (${quoteList(vendorGone)})
           and not exists (select 1 from services s where s.vendor_id = v.id)
           and not exists (select 1 from bookings b where b.vendor_id = v.id)
      `);
      console.log(`حُذف مزوّدو بذرة بلا خدمات/حجوزات: ${deletedVendors.count ?? 0}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function clearJsonWorkspaces() {
  const file = path.join(ROOT, 'data', 'vendor-workspaces.json');
  if (!fs.existsSync(file)) return 0;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    workspaces?: Record<string, { listings?: unknown[] }>;
  };
  const workspaces = raw.workspaces;
  if (!workspaces) return 0;
  let removed = 0;
  for (const ws of Object.values(workspaces)) {
    const listings = Array.isArray(ws.listings) ? ws.listings : [];
    removed += listings.length;
    ws.listings = [];
  }
  if (!APPLY) return removed;
  if (removed) fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  return removed;
}

async function main() {
  const jsonCount = clearJsonWorkspaces();
  console.log(`قوائم JSON المحلية: ${jsonCount} منتجًا`);
  if (!APPLY && jsonCount) console.log('(لن تُمسح من الملف إلا بـ --apply)');

  const url = resolveDatabaseUrl();
  if (!url) {
    console.log('DATABASE_URL غير مضبوط — لا قاعدة Postgres تُمس.');
    if (!APPLY) console.log('\nللحذف الفعلي: npm run db:clear-catalog -- --apply');
    return;
  }
  await clearPostgres(url);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('فشل تفريغ الكتالوج:', message.replace(/postgres(ql)?:\/\/[^\s]+/gi, 'postgres://***'));
  process.exit(1);
});
