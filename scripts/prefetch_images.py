#!/usr/bin/env python3
"""Concurrently prefetch crop_training.json images into the eval cache dir."""
from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from evaluate_subject_detector import resolve_image

REPO_ROOT = Path(__file__).parent.parent
CACHE_DIR = Path("/tmp/inat_eval_cache")
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def main() -> None:
    json_path = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO_ROOT / "crop_training.json"
    raw = json.loads(json_path.read_text())
    keys = [e["url"] for e in raw if "url" in e]
    print(f"Prefetching {len(keys)} images with 8 workers …")

    ok = 0
    fail = 0
    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = {ex.submit(resolve_image, k, None, CACHE_DIR): k for k in keys}
        for i, fut in enumerate(as_completed(futures), 1):
            result = fut.result()
            if result:
                ok += 1
            else:
                fail += 1
            if i % 100 == 0:
                print(f"  {i}/{len(keys)}  ok={ok} fail={fail}")
    print(f"Done. ok={ok} fail={fail}")


if __name__ == "__main__":
    main()
