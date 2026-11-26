# TestFlight from CI (fork only)

`.github/workflows/testflight-ios.yml` builds the iOS app on a GitHub macOS
runner and uploads it to TestFlight, so a build can reach a phone with no local
Mac involved. It is dispatch-only — nothing builds on push:

```bash
gh workflow run testflight-ios.yml -R nebotron/iNaturalistReactNative
gh run watch -R nebotron/iNaturalistReactNative
```

Expect ~45–70 minutes for the build, then 5–15 minutes of App Store Connect
processing before the build shows up in TestFlight.

## How signing works

There are no certificates or provisioning profiles in the repo or in secrets.
`xcodebuild -allowProvisioningUpdates` plus an App Store Connect API key lets the
runner create a cloud-managed distribution certificate and the App Store
profiles for `com.benhannel.inat.dev` and its share extension on demand, and
renew them when they expire. Nothing has to be exported from a Mac.

That only works because the **Release** build configurations no longer pin
`CODE_SIGN_IDENTITY = "Apple Development"` (upstream pins it in both Debug and
Release). With the pin gone, automatic signing still picks a development
identity for a local `npm run ios:release` device build and a distribution
identity when archiving. **Keep that deletion when rebasing onto upstream** or
archives will come out development-signed.

## Build numbers

`CFBundleVersion` is a literal in `ios/iNaturalistReactNative/Info.plist`, while
the share extension generates its version from `CURRENT_PROJECT_VERSION`. The
workflow sets both to a UTC timestamp (`2026.0911.143005`), which is unique and
always increasing, so no version bump ever gets committed and the `fastlane tag`
lane's build numbers stay untouched.

## Required repository secrets

| Secret | What it is |
| --- | --- |
| `ASC_KEY_ID` | App Store Connect API key ID |
| `ASC_ISSUER_ID` | App Store Connect API issuer ID |
| `ASC_KEY_BASE64` | base64 of `AuthKey_<ASC_KEY_ID>.p8` |
| `DOTENV_BASE64` | base64 of the production `.env` |
| `GOOGLE_SERVICE_INFO_PRODUCTION_BASE64` | base64 of `ios/GoogleService-Info.production.plist` |

Refresh either file-backed secret after changing it locally:

```bash
base64 < .env | tr -d '\n' \
  | gh secret set DOTENV_BASE64 -R nebotron/iNaturalistReactNative
```

The API key is generated once in App Store Connect under Users and Access →
Integrations → App Store Connect API, as a Team Key with the **Admin** role
(Admin is what allows the runner to create the distribution certificate). The
`.p8` can only be downloaded once.

## One-time App Store Connect setup

1. An app record for `com.benhannel.inat.dev` must exist, or the upload fails
   with "no suitable application records were found".
2. TestFlight → Internal Testing group, with automatic distribution enabled, so
   each new build reaches the phone without any clicking.
3. Internal testing needs no Beta App Review, no App Privacy answers, and no
   screenshots. `ITSAppUsesNonExemptEncryption` is already `false` in
   `Info.plist`, so there is no per-build export compliance prompt either.
