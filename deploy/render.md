# Deploying to Render

One Render web service runs the whole app, as the VPS does: `Dockerfile.render` clones
`usil-frontend`, builds the SPA, bundles the server, and serves both from one origin.
Data lives on a persistent disk mounted at `/app/data`, the same place the VPS mounts
`/var/www/midyaf/data`.

`Dockerfile` and `docker-compose.yml` are the VPS setup and are untouched.

## 1. Create the service

1. Push this repo, including `render.yaml` and `Dockerfile.render`, to `main`.
2. Create a GitHub fine-grained token: resource owner `next-core-labs`, repository
   `usil-frontend` only, permission **Contents: Read-only**.
3. Render → **New → Blueprint** → pick `next-core-labs/usil-backend`. Render reads
   `render.yaml` and asks for the secret values:
   - `GITHUB_TOKEN`: the token from step 2
   - `MOYASAR_SECRET_KEY`, `MOYASAR_PUBLISHABLE_KEY`, `MOYASAR_WEBHOOK_SECRET`: copy them
     from `.env.production.local` on the VPS. Keep the **same** webhook secret, because
     it is already registered with Moyasar.
   - `GEMINI_API_KEY`: optional
   - SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`): add them under
     Environment if the VPS sets them.
4. Wait for the first deploy, then open `https://usil-emjc.onrender.com/api/health`. Render
   adds a suffix if `usil` is taken, so use the URL it shows, here and in step 3. The
   disk starts empty, so the site has no data yet.

The service is `https://usil-emjc.onrender.com`.

The frontend is built from the branch in `FRONTEND_REF` (default `main`). A push to
`usil-frontend` does **not** redeploy on its own. Either press **Manual Deploy → Clear
build cache & deploy**, or call the service's Deploy Hook (Settings → Deploy Hook) from a
GitHub Action in the frontend repo. Every backend deploy clones the frontend fresh; the
build log prints `frontend <sha> <subject>` so you can confirm which commit shipped.

## 2. Move the data (downtime starts here)

Add your SSH public key in Render → Account Settings → SSH Keys. The service's SSH
address is on its **Connect → SSH** tab, for example `srv-xxxx@ssh.frankfurt.render.com`.

```bash
# on the VPS: stop writes, then pack the store
docker compose stop app
tar czf /tmp/usil-data.tgz -C /var/www/midyaf/data .

# on your machine: fetch it, then push it to the Render disk
scp root@8.213.85.166:/tmp/usil-data.tgz .
scp -s usil-data.tgz srv-xxxx@ssh.frankfurt.render.com:/app/data/
ssh srv-xxxx@ssh.frankfurt.render.com \
  'cd /app/data && tar xzf usil-data.tgz && rm usil-data.tgz && ls'
```

Then Render → **Manual Deploy → Restart service** so the stores reload from disk. Check
`/api/health`: `totalBookings` should match the VPS.

## 3. Switch DNS (Cloudflare)

In the Render service → Settings → Custom Domains, `usil.app` and `hooks.usil.app` are
already listed from `render.yaml`. Point Cloudflare at the target Render shows:

| Name    | Type  | Target                | Proxy                           |
|---------|-------|-----------------------|---------------------------------|
| `@`     | CNAME | `usil-emjc.onrender.com` | Proxied (orange)             |
| `hooks` | CNAME | `usil-emjc.onrender.com` | **DNS only** (grey), as before |

`hooks` has to stay grey: Bot Fight Mode blocks Moyasar's webhook on the proxied
domain. The webhook URL doesn't change, so nothing needs re-registering with Moyasar.
Set Cloudflare SSL/TLS to **Full**, then wait until Render shows both domains as verified
with a certificate issued.

## 4. Verify

- `https://usil.app/api/health` returns `healthy` with the expected booking count
- log in as an existing user, and check that an existing upload image loads
- make a small test payment and confirm the webhook marks it paid
  (Render → Logs, look for `/api/payments/webhook`)
- rate limits key on `cf-connecting-ip` in production; confirm in the logs that
  different visitors are not sharing one limit

Keep the VPS container stopped, not deleted, until this has run cleanly for a few days.
The Caddy `hooks.usil.app` config on the VPS is no longer used after the DNS switch.

## Notes

- The disk pins the service to one instance, and each deploy has a short downtime while
  the disk moves from the old instance to the new one.
- Render takes a daily snapshot of the disk (Disks tab), which you can restore from.
