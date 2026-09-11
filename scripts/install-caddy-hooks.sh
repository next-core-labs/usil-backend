#!/usr/bin/env bash
# Append hooks.usil.app to the live Caddyfile without replacing the usil.app block.
set -euo pipefail

CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
SNIPPET="${1:-}"

if [[ ! -f "$CADDYFILE" ]]; then
  echo "Caddyfile not found: $CADDYFILE" >&2
  exit 1
fi

if grep -q 'hooks.usil.app' "$CADDYFILE"; then
  echo "hooks.usil.app already in Caddyfile"
  exit 0
fi

if [[ -z "$SNIPPET" ]]; then
  SNIPPET="$(cd "$(dirname "$0")/.." && pwd)/deploy/caddy-hooks.usil.app.caddy"
fi

if [[ ! -f "$SNIPPET" ]]; then
  echo "snippet not found: $SNIPPET" >&2
  exit 1
fi

backup="${CADDYFILE}.bak.usil.$(date +%s)"
cp "$CADDYFILE" "$backup"
printf '\n' >> "$CADDYFILE"
cat "$SNIPPET" >> "$CADDYFILE"

if command -v caddy >/dev/null 2>&1; then
  if ! caddy validate --config "$CADDYFILE" >/dev/null; then
    mv "$backup" "$CADDYFILE"
    echo "caddy validate failed; restored $backup" >&2
    exit 1
  fi
  caddy reload --config "$CADDYFILE" >/dev/null
fi

echo "appended hooks.usil.app (backup $backup)"
