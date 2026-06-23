---
name: dpl
description: Deploy the iNaturalistReactNative app to a connected iPhone. Run dpl, stream the full output, and debug any failures until the app successfully installs. Use when the user says /dpl, "deploy", "run dpl", or "install on phone".
---

# Pull

Pull the latest changes from nebotron/iNaturalistReactNative/main.

# Deploy

Run `dpl` and debug failures until the app installs on the connected iPhone.

## Steps

1. **Check for a connected device first.** If `dpl` fails immediately with "No iOS devices connected", stop and tell the user to plug in their iPhone. Do not retry in a loop.

2. **Run dpl.** Never silence output — always capture and show the full log:
   ```sh
   dpl 2>&1
   ```
   Use a 10-minute timeout.

3. **On success** (exit 0, app launched on device): report done in one line.

4. **On failure**, diagnose from the output and fix:

   | Symptom | Fix |
   |---|---|
   | `No iOS devices connected` | Ask user to plug in phone, then stop. |
   | `No profiles for '...' found` | Add `CODE_SIGN_STYLE = Automatic;` to both Debug and Release build configs in `ios/iNaturalistReactNative.xcodeproj/project.pbxproj`; ensure `--extra-params "-allowProvisioningUpdates"` is in `deploy.sh`. |
   | `remote contains work that you do not have` (push rejected) | Run `git pull fork main --rebase && git push fork main`, then re-run `dpl`. |
   | `invalid code signature` / `profile has not been explicitly trusted` | Tell user to go to Settings → VPN & Device Management on their iPhone and trust the developer profile, then re-run `dpl`. |
   | npm/pod install errors | Run `npm install && npx pod-install`, then retry `dpl`. |
   | Xcode build error (compiler/linker) | Read the error, fix the code, commit, then retry `dpl`. |
   | Any other build error | Read the full error output, fix the root cause, then retry `dpl`. |

5. **After fixing**, re-run `dpl` and repeat until success or until the failure requires user action (phone not connected, trust prompt, etc.).

## Rules

- Never use `--no-verify` or bypass signing.
- Never silence `dpl` output — the full log is required for debugging.
- Do not loop-retry on "no device connected" — always ask the user first.
- After a successful deploy, report done. Do not push or commit unless separately asked.
