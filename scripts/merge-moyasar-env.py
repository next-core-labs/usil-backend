#!/usr/bin/env python3
"""Merge Moyasar keys into the live env file without printing them.

Reads JSON from stdin:
  {"secret":"sk_live_...","publishable":"pk_live_..."}

Keeps an existing MOYASAR_WEBHOOK_SECRET. Writes data/moyasar.json too.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

SECRET_RE = re.compile(r"^sk_(test|live)_[A-Za-z0-9]{24,}$")
PK_RE = re.compile(r"^pk_(test|live)_[A-Za-z0-9]{24,}$")
ENV_PATH = Path(os.environ.get("USIL_ENV_PATH", "/var/www/midyaf/.env.production.local"))
DATA_PATH = Path(os.environ.get("USIL_MOYASAR_JSON", "/var/www/midyaf/data/moyasar.json"))
WEBHOOK_URL = "https://hooks.usil.app/api/payments/webhook"


def die(message: str, code: int = 1) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def parse_env(text: str) -> list[tuple[str | None, str]]:
    rows: list[tuple[str | None, str]] = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
            rows.append((None, line))
            continue
        key, value = line.split("=", 1)
        rows.append((key.strip(), value))
    return rows


def set_key(rows: list[tuple[str | None, str]], key: str, value: str) -> list[tuple[str | None, str]]:
    found = False
    out: list[tuple[str | None, str]] = []
    for name, line in rows:
        if name == key:
            out.append((key, value))
            found = True
        else:
            out.append((name, line if name is None else line))
    if not found:
        out.append((key, value))
    return out


def env_get(rows: list[tuple[str | None, str]], key: str) -> str:
    for name, value in rows:
        if name == key:
            return value
    return ""


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        die("payload json invalid")
    secret = str(payload.get("secret") or "").strip().strip('"').strip("'")
    publishable = str(payload.get("publishable") or "").strip().strip('"').strip("'")
    if not SECRET_RE.match(secret) or "*" in secret:
        die("secret must be sk_test_ or sk_live_ without stars")
    if publishable and (not PK_RE.match(publishable) or len(publishable) < 40):
        die("publishable must be pk_test_ or pk_live_")

    text = ENV_PATH.read_text(encoding="utf-8") if ENV_PATH.exists() else ""
    rows = parse_env(text)
    existing_webhook = env_get(rows, "MOYASAR_WEBHOOK_SECRET").strip()
    rows = set_key(rows, "MOYASAR_SECRET_KEY", secret)
    rows = set_key(rows, "PAYMENT_PROVIDER_SECRET_KEY", secret)
    if publishable:
        rows = set_key(rows, "MOYASAR_PUBLISHABLE_KEY", publishable)
    rows = set_key(rows, "MOYASAR_WEBHOOK_URL", WEBHOOK_URL)
    if existing_webhook:
        rows = set_key(rows, "MOYASAR_WEBHOOK_SECRET", existing_webhook)

    lines: list[str] = []
    for name, value in rows:
        if name is None:
            lines.append(value)
        else:
            lines.append(f"{name}={value}")
    ENV_PATH.parent.mkdir(parents=True, exist_ok=True)
    ENV_PATH.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    os.chmod(ENV_PATH, 0o600)

    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    DATA_PATH.write_text(
        json.dumps(
            {
                "secretKey": secret,
                "publishableKey": publishable,
                "updatedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    os.chmod(DATA_PATH, 0o600)
    print("moyasar env merged")
    print("webhook_secret", "kept" if existing_webhook else "missing")
    print("publishable", "yes" if publishable else "no")
    print("secret_kind", "live" if secret.startswith("sk_live_") else "test")


if __name__ == "__main__":
    main()
