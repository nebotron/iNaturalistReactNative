#!/usr/bin/env bash
# Builds the app for the iOS Simulator into OUT_ZIP (default: print the .app
# path). Release, so the JS bundle is inside and there's no dev menu.
#
# Signed to run locally (identity "-"), which simulators need no profile for:
# that's what puts the app's entitlements into the binary. Without them the
# app has no application identifier, every keychain call fails, and with it
# every API request. Signing afterwards can't fix that, since the simulator
# reads them from a section the linker writes.
#
#   appstore/bin/build_simulator_app.sh [OUT_ZIP]
set -euo pipefail
cd "$( dirname "$0" )/../.."
TEAM_ID="$( python3 -c 'import json; print(json.load(open("appstore/config.json"))["team_id"])' )"
set -o pipefail
xcodebuild build \
  -workspace ios/iNaturalistReactNative.xcworkspace \
  -scheme iNaturalistReactNative \
  -configuration Release \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ios/build \
  CODE_SIGN_IDENTITY=- \
  CODE_SIGN_STYLE=Manual \
  PROVISIONING_PROFILE_SPECIFIER= \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  COMPILER_INDEX_STORE_ENABLE=NO \
  | tail -n 60
APP="$PWD/ios/build/Build/Products/Release-iphonesimulator/iNaturalistReactNative.app"
if [ $# -gt 0 ]; then
  ditto -c -k --keepParent "$APP" "$1"
else
  echo "$APP"
fi
