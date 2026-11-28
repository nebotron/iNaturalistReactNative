#!/usr/bin/env bash
# Makes the App Store listing's screenshots and preview, from scratch, on a
# Mac with Xcode. Everything it uses is pinned in appstore/: the device,
# status bar and location in config.json, the photos it imports (checked by
# sha256), the screens it visits (flows/ and config.json's scenes), the
# captions and the listing text (metadata/).
#
#   appstore/make.sh [--app PATH] [--out DIR]
#
# --app    a simulator build of the app to use instead of building one. A
#          build needs what the iOS build always does: node_modules, Pods,
#          .env and the model files (npm ci, pod install, npm run
#          add-example-model).
# --out    where to write (default appstore/build):
#            raw/       the simulator's screenshots
#            framed/    the App Store images: these are what gets uploaded
#            debug/     Maestro's output per scene, for a step that missed
#            preview.html
#
# Needs Maestro (https://maestro.mobile.dev) and Java on the PATH. Uploading
# is separate: appstore/bin/listing.py upload OUT/framed [--apply]
set -euo pipefail

REPO="$( cd "$( dirname "$0" )/.." && pwd )"
cd "$REPO"
OUT="$REPO/appstore/build"
APP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$( cd "$( dirname "$2" )" && pwd )/$( basename "$2" )"; shift 2 ;;
    --out) mkdir -p "$2"; OUT="$( cd "$2" && pwd )"; shift 2 ;;
    *) sed -n '2,25p' "$0"; exit 2 ;;
  esac
done
CONFIG="$REPO/appstore/config.json"
conf() { python3 -c "import json,sys; c=json.load(open('$CONFIG')); print(eval(sys.argv[1]))" "$1"; }

rm -rf "$OUT/raw" "$OUT/framed" "$OUT/debug" "$OUT/preview.html"
mkdir -p "$OUT/raw" "$OUT/framed" "$OUT/debug" "$OUT/media"

echo "== Python dependencies"
python3 -m venv "$OUT/venv"
"$OUT/venv/bin/pip" install --quiet -r appstore/requirements.txt
PY="$OUT/venv/bin/python"

"$PY" appstore/bin/listing.py check || echo "(listing text has gaps; see above)"

if [ -z "$APP" ]; then
  echo "== Building the app for the simulator"
  xcodebuild build \
    -workspace ios/iNaturalistReactNative.xcworkspace \
    -scheme iNaturalistReactNative \
    -configuration Release \
    -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath ios/build \
    CODE_SIGNING_ALLOWED=NO \
    COMPILER_INDEX_STORE_ENABLE=NO \
    | tail -n 40
  APP="$REPO/ios/build/Build/Products/Release-iphonesimulator/iNaturalistReactNative.app"
fi
APP_ID="$( /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist" )"
echo "App $APP_ID at $APP"

echo "== Photos for the library"
"$PY" appstore/bin/fetch_media.py "$CONFIG" "$OUT/media"

echo "== Simulator"
DEVICE="$( conf 'c["device"]' )"
RUNTIME="$( xcrun simctl list runtimes -j | python3 -c '
import json, sys
runtimes = [r for r in json.load(sys.stdin)["runtimes"] if r["platform"] == "iOS" and r["isAvailable"]]
print(sorted(runtimes, key=lambda r: [int(p) for p in r["version"].split(".")])[-1]["identifier"])' )"
UDID="$( xcrun simctl create "appstore-$$" "$DEVICE" "$RUNTIME" )"
trap 'xcrun simctl shutdown "$UDID" >/dev/null 2>&1 || true; xcrun simctl delete "$UDID" >/dev/null 2>&1 || true' EXIT
echo "$DEVICE ($RUNTIME) $UDID" | tee "$OUT/debug/device.txt"

xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b >/dev/null
# Language and region take a reboot to apply
LOCALE="$( conf 'c["locale"]' )"
xcrun simctl spawn "$UDID" defaults write "Apple Global Domain" AppleLanguages -array "${LOCALE%%-*}"
xcrun simctl spawn "$UDID" defaults write "Apple Global Domain" AppleLocale -string "${LOCALE/-/_}"
xcrun simctl shutdown "$UDID"
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b >/dev/null
xcrun simctl ui "$UDID" appearance light
# shellcheck disable=SC2046
xcrun simctl status_bar "$UDID" override $( conf '" ".join(f"--{k} {v}" for k, v in c["status_bar"].items())' )
xcrun simctl location "$UDID" set "$( conf '",".join(map(str, c["location"]))' )"
xcrun simctl install "$UDID" "$APP"
for service in location-always photos camera microphone; do
  xcrun simctl privacy "$UDID" grant "$service" "$APP_ID"
done
xcrun simctl addmedia "$UDID" "$OUT"/media/*.jpg

run_flow() {
  local name="$1" flow="$2"; shift 2
  ( cd "$OUT/raw" && maestro --device "$UDID" test \
      -e APP_ID="$APP_ID" "$@" \
      --debug-output "$OUT/debug/$name" \
      "$REPO/appstore/flows/$flow" )
}
failed=()

echo "== Onboarding"
run_flow onboarding onboarding.yaml || failed+=( onboarding )

"$PY" - "$CONFIG" > "$OUT/debug/scenes.tsv" <<'EOF'
import json, sys
for s in json.load(open(sys.argv[1]))["scenes"]:
    print("\t".join([s["id"], s["flow"], s.get("link", ""), s.get("wait_id", ""), s.get("tap_id", "")]))
EOF
while IFS=$'\t' read -r id flow link wait_id tap_id; do
  echo "== $id"
  run_flow "$id" "$flow" -e SHOT="$id" -e LINK="$link" -e WAIT_ID="$wait_id" -e TAP_ID="$tap_id" \
    < /dev/null || failed+=( "$id" )
  xcrun simctl io "$UDID" screenshot "$OUT/debug/$id/final.png" >/dev/null 2>&1 || true
done < "$OUT/debug/scenes.tsv"

echo "== Framing"
"$PY" appstore/bin/frame.py "$CONFIG" "$OUT/raw" "$OUT/framed" || failed+=( framing )
"$PY" appstore/bin/listing.py preview "$OUT/framed" "$OUT/preview.html"

if [ ${#failed[@]} -gt 0 ]; then
  echo "Failed: ${failed[*]} (see $OUT/debug)" >&2
  exit 1
fi
echo "Done: $OUT/framed and $OUT/preview.html"
