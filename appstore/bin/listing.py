#!/usr/bin/env python3
"""The App Store listing in appstore/: checks it, previews it, uploads it.

    listing.py check
    listing.py preview SCREENSHOT_DIR OUT.html
    listing.py upload SCREENSHOT_DIR [--apply]

check validates the text in appstore/metadata against App Store Connect's
limits and lists what submission still needs. preview writes a single HTML
page of the listing as it would read on the store, screenshots included.
upload sets the listing's text, categories and screenshots on the version in
config.json; without --apply it only prints what it would change. It never
selects a build or submits for review.

upload reads the App Store Connect API key the same way
scripts/testflight_crashes.py does.
"""
import base64
import hashlib
import html
import io
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

APPSTORE = Path(__file__).resolve().parents[1]
REPO = APPSTORE.parent
CONFIG = json.loads((APPSTORE / "config.json").read_text())
API = "https://api.appstoreconnect.apple.com"

LIMITS = {
    "name": 30,
    "subtitle": 30,
    "keywords": 100,
    "promotional_text": 170,
    "description": 4000,
    "release_notes": 4000,
}
REQUIRED = ["name", "description", "keywords", "support_url", "privacy_url"]
FIELDS = [
    "name", "subtitle", "promotional_text", "description", "keywords",
    "release_notes", "support_url", "marketing_url", "privacy_url",
]


def read(path: Path) -> str:
    return path.read_text().strip() if path.exists() else ""


def listing() -> dict:
    meta = APPSTORE / "metadata"
    locale = meta / CONFIG["locale"]
    data = {field: read(locale / f"{field}.txt") for field in FIELDS}
    for field in ("primary_category", "secondary_category", "copyright"):
        data[field] = read(meta / f"{field}.txt")
    return data


def problems(data: dict) -> list[str]:
    found = []
    for field, limit in LIMITS.items():
        if len(data[field]) > limit:
            found.append(f"{field} is {len(data[field])} characters; the limit is {limit}")
    for field in REQUIRED + ["copyright", "primary_category"]:
        if not data[field]:
            found.append(f"{field} is empty")
    if any(len(k.strip()) == 0 for k in data["keywords"].split(",")):
        found.append("keywords has an empty entry")
    return found


def screenshots(directory: Path) -> list[tuple[dict, Path]]:
    return [
        (scene, directory / f"{scene['id']}.png")
        for scene in CONFIG["scenes"]
        if (directory / f"{scene['id']}.png").exists()
    ]


# preview

def data_uri(path: Path, width: int) -> str:
    from PIL import Image
    image = Image.open(path).convert("RGB")
    image = image.resize((width, round(image.height * width / image.width)), Image.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()


def preview(shot_dir: Path, out: Path) -> None:
    data = listing()
    shots = screenshots(shot_dir)
    issues = problems(data)
    if len(shots) < len(CONFIG["scenes"]):
        have = {scene["id"] for scene, _ in shots}
        issues.append("missing screenshots: " + ", ".join(
            s["id"] for s in CONFIG["scenes"] if s["id"] not in have))
    icon = data_uri(
        REPO / "ios/iNaturalistReactNative/Images.xcassets/AppIcon.appiconset/Icon-1024@1x.png",
        240,
    )
    e = html.escape
    shot_html = "\n".join(
        f'<figure><img src="{data_uri(path, 440)}" alt="{e(scene["caption"])}">'
        f'<figcaption>{e(scene["id"])}</figcaption></figure>'
        for scene, path in shots
    )
    counts = "".join(
        f"<tr><th>{e(field)}</th><td>{len(data[field])} / {limit}</td></tr>"
        for field, limit in LIMITS.items()
    )
    issue_html = (
        "<ul>" + "".join(f"<li>{e(i)}</li>" for i in issues) + "</ul>"
        if issues else "<p>Nothing missing from the listing text.</p>"
    )
    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Store Listing Preview</title>
<style>
:root {{ --bg:#fff; --fg:#1d1d1f; --muted:#6e6e73; --line:#d2d2d7; --accent:#0a7d32; --warn:#b3261e; }}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{ --bg:#111; --fg:#f5f5f7; --muted:#a1a1a6; --line:#3a3a3c; --accent:#5cc97b; --warn:#ff8a80; }}
}}
:root[data-theme="dark"] {{ --bg:#111; --fg:#f5f5f7; --muted:#a1a1a6; --line:#3a3a3c; --accent:#5cc97b; --warn:#ff8a80; }}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--fg);
  font:16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
main {{ max-width:900px; margin:0 auto; padding:32px 16px 64px; }}
header {{ display:flex; gap:20px; align-items:center; }}
header img {{ width:120px; height:120px; border-radius:27px; border:1px solid var(--line); }}
h1 {{ margin:0; font-size:28px; }}
.sub {{ color:var(--muted); margin:2px 0 10px; }}
.get {{ display:inline-block; background:var(--accent); color:#fff; border-radius:999px;
  padding:4px 20px; font-weight:600; font-size:14px; }}
.shots {{ display:flex; gap:12px; overflow-x:auto; padding:24px 0 8px; scroll-snap-type:x mandatory; }}
figure {{ margin:0; flex:0 0 220px; scroll-snap-align:start; }}
figure img {{ width:100%; border-radius:18px; border:1px solid var(--line); display:block; }}
figcaption {{ color:var(--muted); font-size:12px; text-align:center; margin-top:4px; }}
section {{ border-top:1px solid var(--line); padding:20px 0; }}
h2 {{ font-size:20px; margin:0 0 8px; }}
.desc {{ white-space:pre-wrap; }}
table {{ border-collapse:collapse; }}
th {{ text-align:left; padding:2px 16px 2px 0; color:var(--muted); font-weight:500; }}
.issues li {{ color:var(--warn); }}
a {{ color:var(--accent); }}
</style></head><body><main>
<header><img src="{icon}" alt="App icon">
<div><h1>{e(data["name"])}</h1><p class="sub">{e(data["subtitle"])}</p>
<span class="get">GET</span></div></header>
<div class="shots">{shot_html}</div>
<section><p>{e(data["promotional_text"])}</p>
<div class="desc">{e(data["description"])}</div></section>
<section><h2>What's New</h2><p class="desc">{e(data["release_notes"])}</p></section>
<section><h2>Information</h2><table>
<tr><th>Category</th><td>{e(data["primary_category"].title())}, {e(data["secondary_category"].title())}</td></tr>
<tr><th>Keywords</th><td>{e(data["keywords"])}</td></tr>
<tr><th>Copyright</th><td>{e(data["copyright"]) or "&mdash;"}</td></tr>
<tr><th>Support URL</th><td>{e(data["support_url"]) or "&mdash;"}</td></tr>
<tr><th>Privacy policy</th><td>{e(data["privacy_url"]) or "&mdash;"}</td></tr>
<tr><th>Version</th><td>{e(CONFIG["version"])}</td></tr>
</table></section>
<section><h2>Character counts</h2><table>{counts}</table></section>
<section class="issues"><h2>Before submitting</h2>{issue_html}
<p>Not covered by this page: choosing the build, the age rating and the
App Privacy answers, which are set in App Store Connect.</p></section>
</main></body></html>
"""
    out.write_text(page)
    print(out)


# upload

def asc():
    sys.path.insert(0, str(REPO / "scripts"))
    import testflight_crashes  # noqa: PLC0415
    return testflight_crashes


def request(method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        path if path.startswith("http") else API + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {asc().token()}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        sys.exit(f"{method} {path}: {error.code} {error.read().decode()[:2000]}")


def upload(shot_dir: Path, apply: bool) -> None:
    data = listing()
    issues = problems(data)
    for issue in issues:
        print(f"warning: {issue}")
    shots = screenshots(shot_dir)
    if len(shots) != len(CONFIG["scenes"]):
        sys.exit(f"{len(shots)} of {len(CONFIG['scenes'])} screenshots in {shot_dir}")

    app = CONFIG["app_store_app_id"]
    locale = CONFIG["locale"]
    version = next(
        v for v in request("GET", f"/v1/apps/{app}/appStoreVersions?filter[platform]=IOS")["data"]
        if v["attributes"]["versionString"] == CONFIG["version"]
    )
    info = next(
        i for i in request("GET", f"/v1/apps/{app}/appInfos")["data"]
        if i["attributes"]["state"] != "READY_FOR_DISTRIBUTION"
    )
    info_loc = next(
        l for l in request("GET", f"/v1/appInfos/{info['id']}/appInfoLocalizations")["data"]
        if l["attributes"]["locale"] == locale
    )
    version_loc = next(
        l for l in request(
            "GET", f"/v1/appStoreVersions/{version['id']}/appStoreVersionLocalizations")["data"]
        if l["attributes"]["locale"] == locale
    )
    # A first version has no "what's new"; App Store Connect refuses one
    first_release = not any(
        v["attributes"]["appStoreState"] == "READY_FOR_SALE"
        for v in request("GET", f"/v1/apps/{app}/appStoreVersions")["data"]
    )

    def nonempty(attributes: dict) -> dict:
        return {k: v for k, v in attributes.items() if v}

    changes = [
        ("PATCH", f"/v1/appInfoLocalizations/{info_loc['id']}", {"data": {
            "type": "appInfoLocalizations", "id": info_loc["id"],
            "attributes": nonempty({
                "name": data["name"],
                "subtitle": data["subtitle"],
                "privacyPolicyUrl": data["privacy_url"],
            }),
        }}),
        ("PATCH", f"/v1/appInfos/{info['id']}", {"data": {
            "type": "appInfos", "id": info["id"],
            "relationships": {
                key: {"data": {"type": "appCategories", "id": data[field]}}
                for key, field in (
                    ("primaryCategory", "primary_category"),
                    ("secondaryCategory", "secondary_category"),
                )
                if data[field]
            },
        }}),
        ("PATCH", f"/v1/appStoreVersionLocalizations/{version_loc['id']}", {"data": {
            "type": "appStoreVersionLocalizations", "id": version_loc["id"],
            "attributes": nonempty({
                "description": data["description"],
                "keywords": data["keywords"],
                "promotionalText": data["promotional_text"],
                "supportUrl": data["support_url"],
                "marketingUrl": data["marketing_url"],
                "whatsNew": None if first_release else data["release_notes"],
            }),
        }}),
    ]
    if data["copyright"]:
        changes.append(("PATCH", f"/v1/appStoreVersions/{version['id']}", {"data": {
            "type": "appStoreVersions", "id": version["id"],
            "attributes": {"copyright": data["copyright"]},
        }}))

    for method, path, body in changes:
        print(method, path, json.dumps(body["data"].get("attributes")
                                       or body["data"].get("relationships")))
        if apply:
            request(method, path, body)

    display_type = CONFIG["display_type"]
    sets = request(
        "GET", f"/v1/appStoreVersionLocalizations/{version_loc['id']}/appScreenshotSets",
    )["data"]
    shot_set = next(
        (s for s in sets if s["attributes"]["screenshotDisplayType"] == display_type), None)
    print(f"replace {display_type} screenshots with: "
          + ", ".join(path.name for _, path in shots))
    if not apply:
        print("Dry run; pass --apply to make these changes.")
        return

    if shot_set:
        for old in request("GET", f"/v1/appScreenshotSets/{shot_set['id']}/appScreenshots")["data"]:
            request("DELETE", f"/v1/appScreenshots/{old['id']}")
    else:
        shot_set = request("POST", "/v1/appScreenshotSets", {"data": {
            "type": "appScreenshotSets",
            "attributes": {"screenshotDisplayType": display_type},
            "relationships": {"appStoreVersionLocalization": {"data": {
                "type": "appStoreVersionLocalizations", "id": version_loc["id"]}}},
        }})["data"]

    for _, path in shots:
        content = path.read_bytes()
        created = request("POST", "/v1/appScreenshots", {"data": {
            "type": "appScreenshots",
            "attributes": {"fileName": path.name, "fileSize": len(content)},
            "relationships": {"appScreenshotSet": {"data": {
                "type": "appScreenshotSets", "id": shot_set["id"]}}},
        }})["data"]
        for op in created["attributes"]["uploadOperations"]:
            part = content[op["offset"]:op["offset"] + op["length"]]
            req = urllib.request.Request(op["url"], method=op["method"], data=part, headers={
                h["name"]: h["value"] for h in op["requestHeaders"]})
            urllib.request.urlopen(req, timeout=120).read()
        request("PATCH", f"/v1/appScreenshots/{created['id']}", {"data": {
            "type": "appScreenshots", "id": created["id"],
            "attributes": {
                "uploaded": True,
                "sourceFileChecksum": hashlib.md5(content).hexdigest(),
            },
        }})
        print(f"uploaded {path.name}")


def main() -> None:
    args = sys.argv[1:]
    if args[:1] == ["check"]:
        issues = problems(listing())
        for issue in issues:
            print(issue)
        sys.exit(1 if issues else 0)
    if args[:1] == ["preview"] and len(args) == 3:
        preview(Path(args[1]), Path(args[2]))
        return
    if args[:1] == ["upload"] and len(args) in (2, 3):
        upload(Path(args[1]), "--apply" in args)
        return
    sys.exit(__doc__)


if __name__ == "__main__":
    main()
