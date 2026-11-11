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

3. **Wait.** A full run is ~20 minutes with warm caches on Arm; an Intel
   (`macos-26-intel`) build is slower.
   Check the run's status every 5 minutes until it completes (`send_later` with
   `delay_minutes: 5`, or `ScheduleWakeup` / a background wait) rather than polling
   in a tight loop. `list_workflow_jobs` shows which step is running.

4. **On success**, report it in one line with the build number.

5. **If GitHub can't acquire a runner** — a job stays `queued` ~15 minutes and ends
   `cancelled` with no steps ("not acquired by Runner of type hosted"). The repo
   is public, so this is free-runner capacity, not billing; it clusters in US
   working hours (15:00–22:00 UTC). The workflow handles it itself: jobs
   `attempt-1`…`attempt-3` try the requested image, `macos-26-intel`, then
   `macos-15`, each only if the previous one never started. Judge the run by
   the attempt that started — the run as a whole can read `failure` from an
   unacquired attempt even though a later one uploaded the build. Only if all
   three go unacquired, dispatch a fresh run once per hour (`send_later` with
   `delay_minutes: 60`) until one gets a runner, then continue from step 3.
   Tell the user once that you're retrying hourly.

6. **On failure**, read the failing step's log (`gh run view <id> --log-failed`, or
   `get_job_logs` with `failed_only`) and fix it.

7. **After fixing**, push the fix to `main` (step 1), dispatch a new run, and keep
   checking every 5 minutes. Repeat until a run succeeds; stop only for a blocker
   only the user can fix (e.g. missing secrets).
