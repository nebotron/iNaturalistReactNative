---
name: deploy
description: Build the iOS app on a GitHub runner and upload it to TestFlight
---

Run the `TestFlight iOS` workflow (`.github/workflows/testflight-ios.yml`) and watch
it through to the upload. No Mac needed — the runner signs with the fork's own Apple
team and the `com.benhannel.inat.dev` bundle IDs.

## Steps

1. **Pick the ref.** Default to `main`. If the user names a branch, or the work they
   want on the phone is only on the current branch, push that branch first and
   dispatch it instead.

2. **Dispatch the workflow** against that ref:
   `gh workflow run testflight-ios.yml --ref <ref>`, or `actions_run_trigger` with
   `method: run_workflow` where the GitHub MCP tools are what's available. Then find
   the new run (`gh run list --workflow testflight-ios.yml -L 1`, or
   `actions_list` / `list_workflow_runs`) and report its URL and head commit.

   The workflow takes one optional input, `prebuilt_react_native`, which links
   Meta's published React Native XCFrameworks instead of compiling that source.
   It is off by default and experimental — it trades statically linked React
   Native for two dynamic frameworks. Pass it only when the user asks to try it
   (`-f prebuilt_react_native=true`), and treat a link error naming a React or
   folly symbol as that flag's fault rather than the code's.

3. **Wait.** A full run is ~30 minutes: pods ~3, archive ~20, export ~1, upload ~2.
   Sleep in the background between checks — 15 minutes, then 10, then 5 — rather
   than polling in a tight loop. `list_workflow_jobs` shows which step is running.

4. **On success**, report it in one line with the build number (a UTC timestamp, set
   by the `Set the build number` step and echoed in the run summary), and note that
   Apple takes a few more minutes to process before the build appears in TestFlight.

5. **On failure**, read the failing step's log (`gh run view <id> --log-failed`, or
   `get_job_logs` with `failed_only`) and fix it.

   | Symptom | Fix |
   |---|---|
   | `Missing repository secrets: ...` | The named secrets aren't set on the repo. Tell the user which ones and stop — they're secrets, so only the user can add them. |
   | Compile or linker error in `Archive` | A real build break. Fix the code, commit, push, re-dispatch. |
   | `No profiles for 'com.benhannel.inat.dev...' found` | The App Store Connect key lost provisioning rights, or a new bundle ID (e.g. a new extension) needs a profile. `-allowProvisioningUpdates` should create one; if it can't, the key lacks the role and the user has to fix it in App Store Connect. |
   | `Choose a certificate to revoke. Your account has reached the maximum number of certificates` | Runs without the reusable certificate each create new ones. The user revokes the stale runner certificates at developer.apple.com and adds the `DIST_CERT_P12_BASE64` / `DIST_CERT_PASSWORD` secrets holding both an Apple Distribution and an Apple Development certificate (see the workflow header). Secrets are theirs to add, so tell them and stop. |
   | `altool` rejects the build (`ITMS-...`) | Read the code. A duplicate build number can't happen with the timestamp scheme; anything else is usually a missing Info.plist key or entitlement. |
   | Runner died / timed out with no error | Re-run the job once (`rerun_failed_jobs`). Twice failing the same way is real. |

6. **After fixing**, re-dispatch and repeat until the upload succeeds.
