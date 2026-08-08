#!/usr/bin/env python3
"""
Firebase email/password auth for the training-log scripts.

The Realtime Database rules allow unauthenticated reads and writes, so this
is optional — it's only useful if the project's rules are later locked down
to require auth for reads. firebase_auth_query() signs in with
FIREBASE_API_KEY / FIREBASE_EMAIL / FIREBASE_PASSWORD from the environment
(.env) and returns "?auth=<idToken>" to append to REST URLs, or "" when
credentials aren't configured.
"""
from __future__ import annotations

import json
import os
import time
import urllib.parse
import urllib.request

_cached: dict | None = None


def firebase_auth_query() -> str:
    global _cached
    # A legacy database secret works directly as the auth token — no sign-in.
    secret = os.environ.get("FIREBASE_DB_SECRET", "").strip()
    if secret:
        return f"?auth={urllib.parse.quote(secret)}"

    api_key = os.environ.get("FIREBASE_API_KEY", "").strip()
    email = os.environ.get("FIREBASE_EMAIL", "").strip()
    password = os.environ.get("FIREBASE_PASSWORD", "").strip()
    if not ( api_key and email and password ):
        return ""

    if _cached and time.time() < _cached["expires_at"]:
        return f"?auth={urllib.parse.quote(_cached['token'])}"

    req = urllib.request.Request(
        "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword"
        f"?key={urllib.parse.quote(api_key)}",
        data=json.dumps({
            "email": email,
            "password": password,
            "returnSecureToken": True,
        }).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read())
    _cached = {
        "token": data["idToken"],
        "expires_at": time.time() + int(data.get("expiresIn", 3600)) - 300,
    }
    return f"?auth={urllib.parse.quote(_cached['token'])}"
