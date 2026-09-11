#!/usr/bin/env python3
"""Register https://hooks.usil.app/api/payments/webhook on the Moyasar account.

Needs MOYASAR_SECRET_KEY (sk_test_ / sk_live_) and MOYASAR_WEBHOOK_SECRET.
Never prints the secret key.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from base64 import b64encode
from pathlib import Path

API = "https://api.moyasar.com/v1"
DEFAULT_URL = "https://hooks.usil.app/api/payments/webhook"
EVENTS = [
    "payment_paid",
    "payment_failed",
    "payment_refunded",
    "payment_voided",
]


def die(message: str, code: int = 1) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def load_env_file(path: str) -> None:
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return
    for line in text.splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = value


def secret_key() -> str:
    key = (
        os.environ.get("MOYASAR_SECRET_KEY")
        or os.environ.get("MOYASAR_API_KEY")
        or os.environ.get("PAYMENT_PROVIDER_SECRET_KEY")
        or ""
    ).strip()
    if not (key.startswith("sk_test_") or key.startswith("sk_live_")):
        die("MOYASAR_SECRET_KEY غير مضبوط. الصق sk_test_ أو sk_live_ في .env.local")
    return key


def webhook_url() -> str:
    return (os.environ.get("MOYASAR_WEBHOOK_URL") or DEFAULT_URL).strip().rstrip("/")


def shared_secret() -> str:
    value = (os.environ.get("MOYASAR_WEBHOOK_SECRET") or "").strip()
    if not value:
        die("MOYASAR_WEBHOOK_SECRET غير مضبوط على الخادم.")
    return value


def moyasar(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    auth = b64encode(f"{secret_key()}:".encode("utf-8")).decode("ascii")
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        API + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"message": raw[:400]}
        return err.code, payload


def listed_webhooks(payload: dict) -> list[dict]:
    if isinstance(payload.get("webhooks"), list):
        return payload["webhooks"]
    if isinstance(payload.get("data"), list):
        return payload["data"]
    if isinstance(payload, list):
        return payload
    return []


def main() -> None:
    load_env_file(os.environ.get("USIL_ENV_PATH", "/var/www/midyaf/.env.production.local"))
    url = webhook_url()
    status, payload = moyasar("GET", "/webhooks")
    if status == 401:
        die("ميسر رفض المفتاح. تحقق أن MOYASAR_SECRET_KEY من لوحة ميسر وليس بريد الدخول.")
    if status >= 400:
        die(f"تعذر جلب الويبهوكات من ميسر (HTTP {status}): {payload.get('message', payload)}")

    existing = listed_webhooks(payload)
    if any(str(row.get("url") or "").rstrip("/") == url for row in existing):
        print(f"ويبهوك ميسر مسجّل مسبقاً على {url}")
        return

    status, created = moyasar(
        "POST",
        "/webhooks",
        {
            "http_method": "post",
            "url": url,
            "shared_secret": shared_secret(),
            "events": EVENTS,
        },
    )
    if status >= 400:
        die(f"ميسر رفض تسجيل الويبهوك (HTTP {status}): {created.get('message', created)}")
    print(f"سُجّل ويبهوك ميسر: {created.get('id', '')} → {url}")


if __name__ == "__main__":
    main()
