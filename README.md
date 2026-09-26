# يوصل / Usil — Backend

Express + TypeScript API for Usil. Split out of the `usil` frontend project; it owns
the API, the JSON data store, authentication, payments, and SEO rendering, and it also
serves the built SPA so production stays a single container.

## Layout

```
server/           Express app (entrypoint: server/index.ts — composition root only)
  auth/           login, sessions, roles, email verification, avatars
  vendors/        vendor store, applications, listings, hubs, profiles, socials
  bookings/       platform booking store + routes, and courier-filed external bookings
  payments/       Moyasar invoices, webhooks, checkout verification
  couriers/       courier applications
  cities/         city requests
  support/        contact-form store + routes
  ai/             Gemini routes, AI providers, catalog matching
  seo/            server-rendered meta, JSON-LD, legal pages
  shared/         booking guards, rate limiting, refund policy, JSON file store
  legacy-routes.ts  vestigial endpoints kept only for API compatibility
core/             contracts shared with the frontend (types, catalog data, utils)
data/             runtime JSON store + uploads (gitignored, volume-mounted in prod)
public/           static assets served by express
scripts/          maintenance and Moyasar setup scripts
```

`core/` is a copy of the frontend's `src/types.ts`, `src/data/*`, and `src/utils/*`.
The two can silently drift, so verify them rather than trusting memory:

```bash
npm run check:core-sync              # advisory
npm run check:core-sync -- --strict  # exits 1 on drift (use in CI)
```

It compares every `core/**` module against its `../usil/src/**` counterpart and names
any that disagree. Point it elsewhere with `WEB_ROOT=/path/to/usil`.

## Running

```bash
npm install
npm run dev            # tsx server/index.ts, PORT from .env (43147)
```

Production:

```bash
npm run build          # bundles to build/server.cjs
npm run sync:web       # copies the frontend build from ../usil/dist into dist/
npm start
```

`dist/` is served publicly, so the server bundle is kept out of it in `build/`.
`sync:web` replaces everything in `dist/`. Point it elsewhere with
`WEB_DIST=/path/to/dist npm run sync:web`.

## Checks

```bash
npm run lint           # tsc --noEmit
npm test               # 235 tests across server/ and core/ (auto-discovered)
npm run check:core-sync # shared modules still match the frontend?
```

`npm test` globs `server/` and `core/` for `*.test.ts`, so a new test file runs as
soon as it exists — nothing to register.

## Deploy

`docker-compose.yml` builds the image and mounts `/var/www/midyaf/data` at `/app/data`.
Run `npm run sync:web` before building so the SPA is in `dist/`. Secrets come from
`.env.production.local`; `deploy/` holds the Caddy config for `hooks.usil.app`.

## Frontend

The React app lives in `../usil`. Its dev server proxies `/api` and `/uploads` to
port 43147, so run this backend alongside `npm run dev` there.
