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
   python3 scripts/app_log.py                     # grouped summary, errors first
   python3 scripts/app_log.py --detail <n>        # full entries behind a group
   python3 scripts/app_log.py --grep ui_hang      # filter by regex
   python3 scripts/app_log.py --limit 0 --dump /tmp/…/app_log.json
   ```

   Entries are grouped by level + source file + message shape (ids, durations
   and URLs collapsed), so the count column is how often a thing actually
   happens. The summary answers "what repeats"; almost every real question
   ("what was the app doing when this hung?") needs the dump instead — load the
   JSON in Python, sort by timestamp, and read the minutes around an event.

2. **Work out which build is live.** The `commit` field is the whole triage.

   ```
   git log --oneline | grep -nE "^(<commit>|<commit>)"   # how far back each build is
   git log --oneline <commit>..HEAD -- <file>            # fixed since that build?
   git show <commit>:<file>                              # the code that logged it
   ```

   Only groups carrying the newest commit are live. A group that stops at an
   older build is usually already fixed — last run, two of the four biggest
   error groups were, and checking took a minute where fixing them again would
   have taken the session.

3. **Triage what's left**, in this order:
   - `error` and `warn` groups, largest first;
   - hang and delay diagnostics: `ui_hang`, `ui_stall`, `slow_screen_transition`,
     `slow_ui_work` (`uiDelayTracker.ts`), `slow_query`, `query_hang`
     (`slowLoadTracker.ts`), `startup_tti` (`startupPerformanceTracker.ts`),
     `photo_delete_pending_20s`, `photo_delete_failed`
     (`promptDeleteOriginalDevicePhotos.ts`);
   - anything else that shows the app doing something it shouldn't.

   Run `npm test` before changing anything. A failing test for a diagnostic
   means that diagnostic may be lying to you about what it measures — three
   tracker tests were red last run, and one was red because the tracker was
   writing photo paths into the log.

4. **Test a theory against every occurrence before acting on it.** A cause that
   looks obvious in one instance ("the delete hung because a modal opened") is
   worth nothing until counted across all of them, successes included. Script it
   over the dump: for each occurrence, extract the candidate signal and the
   outcome, and print both columns. If the successes show the same pattern at
   the same rate, the theory is dead — say so and move to the next one rather
   than shipping a fix built on it.

5. **Fix the cause, not the symptom.** Deleting or downgrading the log line that
   reported a real error is not a fix. When every theory dies for want of
   evidence, that is the signal to add the measurement that would settle it
   (step 6) and leave the bug for next session, not to guess.

   Verify with `npm test` and `npx eslint` on the files you touched. Add a unit
   test for anything with non-obvious timing, as `tests/unit/sharedHelpers/`
   does for the trackers — writing one for a new diagnostic last run caught it
   reporting a bogus `appState` and a false "the app left the foreground".

6. **Tune the diagnostics.**

   Add one when the log couldn't answer the question you had: a stable
   `snake_case` marker as the message plus structured fields via
   `logger.infoWithExtra` / `errorWithExtra`, so it groups cleanly and stays
   greppable. Log durations and counts, not payloads — the extra fields must be
   primitives, and photo URLs, coordinates and user content don't belong in a
   shared log. Sweep for those before finishing:

   ```
   python3 scripts/app_log.py --limit 0 --grep "ph://|file://|https?://|-?\d{2}\.\d{5,}"
   ```

   Remove one when it is noise, and quantify it — the count column is the
   argument. Every line is a network POST from the user's phone and a row you
   have to read past next time. Delete diagnostics that:
   - fire per render, per list item, per frame, or per request in a loop;
   - restate what an adjacent line already says;
   - report a condition that is normal and always has been;
   - have never once pointed at a bug.

   Prefer a summary of a burst over a line per occurrence, gate a
   whole-population line on the slow tail (p90+ of what the log shows), and keep
   noisy detail at `debug` (release builds only ship `info` and above). Leave
   lines marked as upstream metrics in place; make them fire on change instead.

7. **Commit and push** to main, one commit per distinct fix.

8. **Optionally deploy** with the `s` skill so later entries come from the fixed
   build — a fix nobody is running produces no evidence it worked. Not possible
   from a cloud container, where no phone is reachable; say so in the report.

9. **Clear the logs last:**

   ```
   python3 scripts/app_log.py --clear
   ```

   This deletes every path in the log database except `crop_log` and
   `brightness_log`, which are training data for the `tune` skill and must
   survive. Clearing means the next session's summary is all new evidence
   against the fixed build. Only do this once the fixes are pushed, and keep the
   `--dump` from step 1 until then.

10. **Report** what the log showed, what you fixed, which diagnostics you added
    or removed, which theories you killed, and anything you saw but chose not to
    act on. Then add anything durable to the notes below.

---

## Notes from /l sessions

### Photos-library deletions hang, cause still unproven

18 of 49 deletions in the Jul 29 – Aug 3 log never came back, arriving in
day-long blocks between blocks of clean successes — the shape of a device-wide
wedge that clears on restart (Apple Developer Forums 806349, referenced in
`promptDeleteOriginalDevicePhotos.ts`). Ruled out by counting across all 49:
concurrent uploads, taps that open a modal during the delete, batch size, and
the native presentation context, all of which appear as often in the successes.

**Losing the foreground is ruled out too** (Aug 3–4 log, 4 hangs, 0 successes).
Two of the three hangs carrying the new fields had `leftForeground=false`,
`appStateChanges=0`, `appState=active`, `sceneState=0`, `fgActiveScenes=1`,
`authStatus=3`, `fetched==requested` and no modal in `vcChain`. The app is
squarely in the foreground with every precondition met and the confirmation
still never presents.

What that log did show is that **the app almost never survives the hang** — each
one is followed by a `pickup` with no `photo_delete_failed` in between, so the
120s timeout never ran and never armed the cooldown, and the next launch fired
the same doomed delete again (101 photos at 01:45:35, then 101 again at
01:49:23). The cooldown is now armed at the 20s hang instead.

Next thing to check: `photo_delete_hang_context`, added this session. It
re-reads the presentation context *at* the hang and reports
`mainQueueResponsive`. If the main queue doesn't answer within 5s, the hang is a
wedged main thread and not a Photos-library problem at all — a completely
different bug. If it answers with the same clean context, that's another theory
dead and the remaining candidates are all inside Photos itself.

**When the hangs started, from git rather than the log.** The first commit
reporting "the deletion shows no iOS confirmation and deletes nothing" is
`8f1fd32f` (Jul 23). The day before, `16285bcd` (Jul 22) extended the
tracked-location write-back from the group-photos import to *every* save path,
so every observation saved without GPS now writes location into its Photos
assets. That write is a `PHPhotoLibrary.performChanges` per photo, and the
import fires the whole burst — up to one per imported photo — in the seconds
before the deletion of those same assets. Nothing proves the burst wedges the
confirmation machinery, but it is the only app-side change adjacent to the
onset, and it means the deletion that hangs is always preceded by ~N library
transactions that didn't exist before Jul 22.

Two mitigations follow from that and are now in place: assets already queued
for deletion are skipped entirely (writing GPS into a photo about to be
deleted was pure waste), and the writes that remain are coalesced into a single
`updateAssetLocations` transaction. Together a 101-photo import goes from ~101
library transactions before the delete to zero. **If the hangs stop, that was
the mechanism; if they continue at the same rate, the burst was a bystander and
the cause is inside Photos.**

### Photo imports can wedge on one asset

Three imports in the Aug 3–4 log logged `Done tapped: importing N selected
photo(s)` and no `settled` line at all, then a relaunch; a fourth took 237s for
20 photos where a local batch of 34 takes ~300ms. `handleGalleryDone` catches
everything and never rethrows, so a missing `settled` line means the promise is
genuinely still pending, not a swallowed error. Cause: `exportPHAsset` awaited
`writeDataForAssetResource` with no bound — its retry ladder only fires on an
*error*, so a call that never calls back hung `Promise.all` and the whole import
forever. Now bounded by a no-progress watchdog (`EXPORT_STALLED`, 60s without a
`progressHandler` tick); a slow-but-advancing iCloud download is still left
alone however long it takes. `photo_import_stalled` reports the progress counts
at 30s. **Check whether either fires next session.**

### Known, not worth acting on yet

- **Keychain `-25308` (`errSecInteractionNotAllowed`) with 401s around it.**
  `react-native-sensitive-info` hardcodes
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` with no JS option, so a token
  write while the phone is locked cannot succeed. Fixing it means a
  `patch-package` patch that would only take effect for newly-added keychain
  items. Once in five days; revisit if it recurs.
- **Places autocomplete failures** are a Google Cloud config issue (API not
  enabled for the key), not app code.

### Volume, for calibration

3,443 lines over five days, of which ~2,550 were six diagnostics repeating
themselves; the removals in that session should hold the next log near 900.
If a fresh log is much bigger than that, something new is looping.

The Aug 3–4 log came in at 124 lines over six hours — roughly 500/day, so the
removals held. At that volume nothing is noise-dominated any more, and the
grouped summary is small enough that the dump is worth loading every time.
