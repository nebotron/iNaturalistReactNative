---
name: l
description: Debug and fix the errors and hangs in the app's Firebase logs
---

Release builds POST every logger line to `{CROP_LOG_FIREBASE_URL}/app_log`
(`src/api/log/index.ts`, wired up in `react-native-logs.config.ts`). Each entry
carries `timestamp`, `level`, `extension` (the source file), `commit` (the build
the line came from), `message`, any `extra` fields, and `stack` for errors. That
log is the only view of what the app does on the user's phone — this skill turns
it into fixes.

`scripts/app_log.py` reads `CROP_LOG_FIREBASE_URL` from `.env`. Where there is
no `.env` (a fresh cloud container), export the database URL that
`scripts/evaluate_subject_detector.py` carries as its default and everything
below works — the log database serves reads and deletes without credentials.

## Steps

1. **Read the log.**

   ```
   python3 scripts/app_log.py                 # grouped summary, errors first
   python3 scripts/app_log.py --detail <n>    # full entries behind a group
   python3 scripts/app_log.py --grep ui_hang  # filter by regex
   ```

   Entries are grouped by level + source file + message shape (ids, durations
   and URLs collapsed), so the count column is how often a thing actually
   happens.

2. **Triage.** Work in this order:
   - `error` and `warn` groups, largest first.
   - hang and delay diagnostics: `ui_hang`, `ui_stall`, `slow_screen_transition`,
     `slow_ui_work` (`uiDelayTracker.ts`), `slow_query`, `query_hang`
     (`slowLoadTracker.ts`), `startup_tti` (`startupPerformanceTracker.ts`).
   - anything else that shows the app doing something it shouldn't.

   Check each group's `commits` against `git log` first: a group whose newest
   entry predates a fix is already dealt with, and re-fixing it wastes the
   session. `git show <commit>:<file>` reads the code the line was logged from.

3. **Fix the cause, not the symptom.** Deleting or downgrading the log line that
   reported a real error is not a fix. Where a stack or `extra` field doesn't say
   enough to locate the cause, add the diagnostic that would (step 4) rather than
   guessing — the next run of this skill gets the answer.

   Verify with `npm test` (and `npx eslint` on the files you touched). Add a unit
   test for anything with non-obvious timing, as `tests/unit/sharedHelpers/`
   does for the trackers.

4. **Tune the diagnostics.**

   Add one when the log couldn't answer the question you had: a stable
   `snake_case` marker as the message plus structured fields via
   `logger.infoWithExtra` / `errorWithExtra`, so it groups cleanly and stays
   greppable. Log durations and counts, not payloads — the extra fields must be
   primitives, and photo URLs, coordinates and user content don't belong in a
   shared log.

   Remove one when it is noise. Every line is a network POST from the user's
   phone and a row you have to read past next time. Delete diagnostics that:
   - fire per render, per list item, per frame, or per request in a loop;
   - restate what an adjacent line already says;
   - report a condition that is normal and always has been;
   - have never once pointed at a bug.

   Prefer summarizing a burst over logging each occurrence, and keep noisy
   detail at `debug` (release builds only ship `info` and above).

5. **Commit and push** to main, one commit per distinct fix.

6. **Optionally deploy** with the `s` skill so later entries come from the fixed
   build — a fix nobody is running produces no evidence it worked.

7. **Clear the logs last:**

   ```
   python3 scripts/app_log.py --clear
   ```

   This deletes every path in the log database except `crop_log` and
   `brightness_log`, which are training data for the `tune` skill and must
   survive. Clearing means the next session's summary is all new evidence
   against the fixed build. Only do this once the fixes are pushed.

8. **Report** what the log showed, what you fixed, which diagnostics you added
   or removed, and anything you saw but chose not to act on.
