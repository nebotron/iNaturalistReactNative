#!/usr/bin/env python3
"""Downloads config.json's library_photos into a directory, checking each
against its pinned sha256 so a changed photo fails the run instead of quietly
changing the screenshots.

    fetch_media.py appstore/config.json OUT_DIR
"""
import hashlib
import json
import sys
import urllib.request
from pathlib import Path


def main() -> None:
    config = json.loads(Path(sys.argv[1]).read_text())
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    for photo in config["library_photos"]:
        path = out / f"{photo['photo_id']}.jpg"
        if not path.exists():
            with urllib.request.urlopen(photo["url"], timeout=60) as response:
                path.write_bytes(response.read())
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != photo["sha256"]:
            path.unlink()
            sys.exit(f"{photo['url']}: sha256 {digest}, expected {photo['sha256']}")
        print(path)


if __name__ == "__main__":
    main()
