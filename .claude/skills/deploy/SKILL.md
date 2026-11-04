---
name: deploy
description: Build the iOS app on a GitHub runner and upload it to TestFlight
---

Run the `TestFlight iOS` workflow (`.github/workflows/testflight-ios.yml`) and watch
it through to the upload.

## Steps

1. **Push local changes to `main`.** Commit any uncommitted work, then rebase onto
   `origin/main` (`git fetch origin main && git rebase origin/main`) and
   fast-forward push (`git push origin HEAD:main`). Never force push. Dispatch
   `main` unless the user names another branch.

2. **Dispatch the workflow** against that ref:
   `gh workflow run testflight-ios.yml --ref <ref>`, or `actions_run_trigger` with
   `method: run_workflow` where the GitHub MCP tools are what's available. Then find
   the new run (`gh run list --workflow testflight-ios.yml -L 1`, or
   `actions_list` / `list_workflow_runs`) and report its URL and head commit.

3. **Wait.** A full run is ~20 minutes with warm caches.
   Check the run's status every 5 minutes until it completes (`send_later` with
   `delay_minutes: 5`, or `ScheduleWakeup` / a background wait) rather than polling
   in a tight loop. `list_workflow_jobs` shows which step is running.

4. **On success**, report it in one line with the build number.

5. **On failure**, read the failing step's log (`gh run view <id> --log-failed`, or
   `get_job_logs` with `failed_only`) and fix it.

6. **After fixing**, push the fix to `main` (step 1), dispatch a new run, and keep
   checking every 5 minutes. Repeat until a run succeeds; stop only for a blocker
   only the user can fix (e.g. missing secrets).
