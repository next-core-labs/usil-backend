# Deploying to Cloudflare

Everything runs on Cloudflare Workers under the one `usil.app` zone:

| Address           | Worker         | Repo          | What it serves                                   |
|-------------------|----------------|---------------|--------------------------------------------------|
| `usil.app`        | `usil-backend` | `usil-backend` | the API, the storefront (built from `../usil`), SEO pages |
| `hooks.usil.app`  | `usil-backend` | `usil-backend` | the same Worker; the Moyasar webhook address     |
| `owner.usil.app`  | `usil-owner`   | `usil-owner`  | admin console; `/api` and `/uploads` go to `usil-backend` |
| `vendor.usil.app` | `usil-vendor`  | `usil-vendor` | vendor console; same proxy                       |

## How the backend runs

The Express app runs unchanged inside one Durable Object, `UsilApp` (`worker/index.ts`).
Workers have no disk, so `data/` (the JSON stores and the uploads) lives in that
object's SQLite database (`worker/sqlite-fs.ts`). The stores keep calling `fs` through
`server/shared/data-fs.ts`, which is the real disk under Node and SQLite on Cloudflare.
One instance owns all the data, as the single Node process did before.

The Worker in front serves files (`/assets/*`, `/og/*`, `manifest.json`, …) from Workers
Assets, and sends page routes, `/api/*`, `/uploads/*`, `robots.txt` and `sitemap.xml` to
the app, so every page still gets its server-rendered SEO tags.

The consoles reach the backend over a service binding, so the browser sees one origin
per console and the HttpOnly `midyaf_sid` cookie works with no CORS setup.

## 1. One-time Cloudflare setup

1. **Plan:** use Workers Paid ($5/month). Login hashes passwords with scrypt, which
   needs more CPU time per request than the Free plan allows.
2. **Bot Fight Mode off:** Security → Bots → Bot Fight Mode → Off. It challenges Moyasar's
   webhook and the native apps' API calls, and on the Free and Pro plans it cannot be
   skipped per path. Login, signup and checkout have their own rate limits in the app.
3. **DNS:** delete the old `@`, `hooks`, `owner` and `vendor` records that point at Render.
   A Worker custom domain cannot be created over an existing record. **Keep** the MX and
   TXT records, because Resend needs them to send mail from `usil.app`.

## 2. Log in and set the secrets

```bash
cd "usil backend"
npx wrangler login
npx wrangler secret put OWNER_EMAIL        # first admin, created on first boot
npx wrangler secret put OWNER_PASSWORD
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MAIL_FROM          # e.g. يوصل <noreply@usil.app>
npx wrangler secret put MOYASAR_SECRET_KEY
npx wrangler secret put MOYASAR_PUBLISHABLE_KEY
npx wrangler secret put MOYASAR_WEBHOOK_SECRET   # the one already registered with Moyasar
npx wrangler secret put GEMINI_API_KEY     # optional
```

The non-secret settings (`NODE_ENV`, `PUBLIC_SITE_URL`, `VENDOR_CONSOLE_URL`,
`MOYASAR_WEBHOOK_URL`, …) are under `vars` in `wrangler.jsonc`.

## 3. Deploy

The backend goes first: the consoles' service binding needs `usil-backend` to exist.

```bash
cd "usil backend" && npm run deploy   # builds ../usil, copies it in, deploys
cd ../usil-owner  && npm run deploy
cd ../usil-vendor && npm run deploy
```

On the first deploy Wrangler creates the custom domains and their DNS records and
certificates. That can take a few minutes.

## 4. Verify

- `https://usil.app/api/health` returns `healthy`
- `https://usil.app` loads; view source shows the page's SEO title
- log in at `https://owner.usil.app` with `OWNER_EMAIL`, then create a vendor and log in
  at `https://vendor.usil.app`
- upload a listing photo and check it loads on the storefront
- make a small test payment and confirm the webhook marks it paid (Workers → usil-backend →
  Logs, look for `/api/payments/webhook`)

Once that works, delete the Render services (each service → Settings → Delete). Deleting a
service also deletes its disk.

## Local runs

`npm run dev` (plain Node, real `data/` folder) is still the everyday loop. To run
the Cloudflare build itself:

```bash
npm run sync:web && npm run cf:dev    # http://localhost:8787, state in .wrangler/
```

Put local secrets in `.dev.vars` (same format as `.env`, gitignored). A console's
`npm run cf:dev` connects to that running backend over the service binding.

## Notes

- **Mobile apps** call `https://usil.app` (`../usil/src/native-origin.ts`). Run
  `npm run cap:sync` and ship a new build. Installed builds older than this keep calling
  Render and stop working once Render is deleted.
- **Backups:** a SQLite-backed Durable Object keeps 30 days of point-in-time recovery.
- **Limits:** one Durable Object holds up to 10 GB, including uploaded photos. Uploads
  are capped at 5 MB each.
- `Dockerfile` and `docker-compose.yml` still build a plain Node server, for self-hosting
  if you ever need it. Nothing on Cloudflare uses them.
