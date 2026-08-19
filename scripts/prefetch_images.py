#!/usr/bin/env python3
"""Concurrently prefetch crop_training.json images into the eval cache dir.

Fetches the `large` rendition (1024px) rather than the original: YOLO runs at
640 and the crop labels are normalized, so the original buys nothing but tens
of GB of disk and a rate limiter. Falls back through medium/original and
through both photo hosts, since static.inaturalist.org is unreachable from
some networks while the open-data S3 mirror is not.

Files land as {photo_id}.jpg, which is the first path resolve_image() checks,
so the eval scripts pick them up with no changes.

Usage:
    python3 scripts/prefetch_images.py [crop_training.json]
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
CACHE_DIR = Path("/tmp/inat_eval_cache")
CACHE_DIR.mkdir(parents=True, exist_ok=True)

PHOTO_URL_RE = re.compile(
    r"(https?://[^?]+/photos/(\d+)/)(square|small|medium|large|original)(\.\w+)", re.I)
HOSTS = ["inaturalist-open-data.s3.amazonaws.com", "static.inaturalist.org"]
SIZES = ["large", "medium", "original"]
WORKERS = 8


def candidate_urls(url: str) -> tuple[str | None, list[str]]:
    match = PHOTO_URL_RE.match(url)
    if not match:
        return None, []
    prefix, photo_id, _size, ext = match.groups()
    urls: list[str] = []
    for size in SIZES:
        for host in HOSTS:
            candidate = re.sub(r"https?://[^/]+", f"https://{host}", prefix + size + ext, count=1)
            if candidate not in urls:
                urls.append(candidate)
    return photo_id, urls


def download(url: str, dest: Path) -> bool:
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "iNat-crop-eval/1.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
            if len(data) < 1000:
                return False
            partial = dest.with_suffix(".part")
            partial.write_bytes(data)
            partial.rename(dest)
            return True
        except Exception as exc:
            if getattr(exc, "code", None) in (403, 404):
                return False  # not this host/size — try the next candidate
            time.sleep(1.5 * (attempt + 1))
    return False


def fetch_one(url: str) -> str:
    photo_id, urls = candidate_urls(url)
    if not photo_id:
        return "skip"  # file:// or other non-photo entry — nothing to fetch
    dest = CACHE_DIR / f"{photo_id}.jpg"
    if dest.is_file():
        return "cached"
    return "ok" if any(download(u, dest) for u in urls) else "fail"


def main() -> None:
    json_path = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO_ROOT / "crop_training.json"
    raw = json.loads(json_path.read_text())
    urls = list(dict.fromkeys(
        e["url"] for e in raw
        if e.get("url") and all(k in e for k in ("x", "y", "w", "h"))))
    print(f"Prefetching {len(urls)} images with {WORKERS} workers …")

    counts = {"ok": 0, "cached": 0, "fail": 0, "skip": 0}
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(fetch_one, url) for url in urls]
        for i, future in enumerate(as_completed(futures), 1):
            counts[future.result()] += 1
            if i % 500 == 0:
                print(f"  {i}/{len(urls)}  {counts}")
    print(f"Done. {counts}")


if __name__ == "__main__":
    main()
