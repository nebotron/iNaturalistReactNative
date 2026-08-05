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
     `photo_delete_pending`, `photo_delete_failed`
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

**A wedged main thread is ruled out** (Aug 4 log, 5 hangs, 2 successes).
`photo_delete_hang_context` came back on all five with `mainQueueResponsive=true`
— `msToRespond` was 8, 8, 7, 8 and 1435ms — reporting the same clean context as
before the delete: `appState=0 sceneState=0 fgActiveScenes=1 authStatus=3
fetched==requested vcChain=UIViewController`. The main thread is answering in
8ms and the confirmation still never presents.

**The GPS write-burst mechanism is ruled out too.** Two of the five hangs were
on `e0da994f7`, the build that cut a 101-photo import from ~101
library transactions before the delete to zero. Same hangs, same rate. The
burst was a bystander; keep the coalescing (it was right on its own terms) but
stop treating it as the explanation.

**Batch size and time since launch are ruled out.** 178 photos deleted fine at
15:29:55; 4 photos hung at 15:16:22. A hang came 36s after a fresh launch
(13:57) and a success came 1.8 min after one (15:29).

**Escalating the cooldown is a bad idea, and the log says so.** The obvious
mitigation — back the 10-minute cooldown off further on each consecutive hang —
would have blocked the 15:29:55 success, which landed 13 minutes after the
15:16 hang and after the cooldown had already lapsed twice. Deletes do recover
without a restart.

**The concurrent probe came back, and it hung** (Aug 5 log, one sighting,
04:30): `probeOk=false`, "consent-free library write did not settle in
10000ms". So it isn't only the consent-alert path — but as predicted that
single result is ambiguous between a wedged `photolibraryd` and the album
transaction simply queueing behind the dead deletion beside it.

**The Aug 5 log resolves which way to read that, and it is the second one.**
`msSinceLastSuccess` on the two hangs that carried it was 21259ms and 21251ms
— i.e. a real `updateAssetLocations` transaction *completed* 1.3s and 1.2s
before each `Deleting` line (`clearPhotoLibraryWriteFailure` is only called on
a genuine success). The library was demonstrably servicing writes a second
before the delete that hung. It is not wedged when the app asks; it wedges
*on* the ask.

Which is why the probe now also runs **before** the deletion, with nothing in
flight (`preflightPhotoLibraryWrite`). The earlier objection to that — an album
write before every delete is the library traffic we just removed — is worth
much less than it looked: that was ~101 transactions per import, this is one,
and it is the only thing that can separate "wedged before we asked" from
"wedged by asking". Expect it to *succeed* and the delete to hang anyway; the
skip it triggers only helps in the minority case where the wedge predates the
request (00:36, `msSinceLastSuccess=-1`). Note also that the native probe now
resolves only after its own cleanup transaction finishes — resolving early left
a stray write overlapping whatever ran next.

**The preflight shipped and earned its place on its first sighting** (Aug 5
15:02, build `3ef9032d1`): the probe never settled, the delete of 9 photos was
skipped in 10s instead of hanging for 120, and the cooldown was armed. Note the
reporting convention it implies — a *passing* preflight logs nothing, so the
absence of a `photo_delete_preflight` line before a hang is itself the evidence
that the library was healthy a second earlier. Because a lost POST looks the
same as an absent one, the measurement now also rides on the hang report itself
as `preflightMs` (`-1` = the probe wasn't available; a failed probe can't reach
that line at all).

**The deletion timeout is 10s as of this session, down from 120.** No hang on
record has ever recovered, so the two minutes only ever bought a held write
chain and a user stranded on a screen they asked to leave. `photo_delete_pending_20s`
is renamed `photo_delete_pending` with the same fields — it now fires at 5s,
half the budget, and `ms` says when. Grouping across the rename breaks at build
`ebbbda1`; older entries keep the old name. The cost to watch for: a user who
takes longer than 10s to answer the iOS confirmation now gets a reported
failure and an armed cooldown for a deletion iOS may still carry out. If
`photo_delete_pending` starts appearing with a *successful* delete right after
it, that is what it looks like, and 10s was too tight.

**The wedge survives an app relaunch.** That 15:02 preflight failed in a process
launched at 15:01:43, nine hours after the morning's hang. Whatever is stuck is
in `photolibraryd`, not in this app's address space, which is consistent with
the reboot-only recovery in Apple Developer Forums 806349.

**The one hang in the Aug 5 (05:09–15:02) log is the first with
`leftForeground=true`**: `appStateChanges=2` and JS `AppState` "background" at
the 20s mark, native `appState=2 sceneState=2 fgActiveScenes=0` at 30s, back to
"active" by the 120s timeout. The app was active when the delete was issued
(the pre-delete context says `appState=0 fgActiveScenes=1`) and went away
during it — a phone locking at 5am fits. That build (`4049dc5fb`) predates the
preflight, so nothing says whether the library was already stuck.

Which opens a theory worth the next log's attention, **untested and not
shipped**: a consent alert requested by an app that then leaves the foreground
is what wedges `photolibraryd` device-wide. It would explain the wedge
outliving the process, consent-free writes hanging afterwards, and the earlier
`leftForeground=false` hangs as later hangs on an already-wedged library rather
than as counter-evidence. It is not testable against the old logs (cleared),
and `preflightMs` is the measurement that decides it: a hang with a fast
preflight and `leftForeground=true` is the smoking gun, the same hang with
`leftForeground=false` kills it.

**Don't "fix" the cooldown for backgrounded deletes.** Arming the
library-wedged cooldown off a delete the user backgrounded looks like
mis-attribution — blaming the library for a self-inflicted failure — and the
obvious change is to skip it when `leftForeground` is true. Under the theory
above that hang is precisely the event that wedges the device, so the cooldown
is right either way. Left alone deliberately.

Next theory, untested and not shipped: a second transaction landing ~1s after
one completes races PhotoKit's alert presentation, and a settling delay before
the delete would fix it. Two occurrences fit, one (00:36, no preceding write)
does not, and the log has no successful deletes to compare against — nowhere
near the bar. `msSinceLastSuccess` on `photo_delete_pending` is already the
measurement; it needs a log with successes in it.

**Every Photos-library write in the Aug 5 log failed** — 3 deletes, 2 USB card
saves, 2 location updates, zero successes of any kind except the two location
writes noted above. A log with no successes cannot kill a theory by comparison,
which is most of why this session ended with a measurement rather than a fix.

**The one documented way to delete without a prompt** is that PhotoKit deletes
assets the app itself created without presenting its confirmation. It does not
cover the hangs — those are camera-roll originals the user shot and the app
merely imported — but it does cover the USB card offload
(`UsbStorage.m saveImageToPhotos`), which is the only place this app adds
assets to the library. PhotoKit can't be asked after the fact whether an asset
was ours (`PHAsset.sourceType` only separates user library from shared and
synced), so the identifier is now recorded at creation in
`appCreatedPhotoAssets.ts`, and `deletePhotoAssets` deletes those in a
transaction of their own, ahead of the prompted one.

That gives the controlled comparison the probe above can't: `appCreatedMs` on
`photo_delete_app_created`, measured on a transaction that should never prompt,
sitting beside a prompted remainder that may hang. **It also rests on
behaviour nothing in the log has confirmed yet** — if the exemption doesn't
hold, a mixed batch would ask the user to confirm twice, so a transaction that
takes ≥10s is taken as evidence it prompted and the split switches itself off
for good on that device (`isAppCreatedDeleteExemptionRuledOut`). Check
`appCreatedMs` first thing next session: sub-second means the exemption is
real and a slice of deletions now needs no prompt at all. Still unanswered
after Aug 5 — the one delete in that log carried no app-created assets (the
`Deleting N device photo(s)` line says so: no ", N of them app-created"
suffix), so the split never ran. It needs a USB card offload followed by a
deletion of those same photos.

Also new on that line: `windowList`, every window on the foreground scene by
class, level, hidden and alpha. iOS presents its confirmation in its own
window, not in the key window's chain, so `vcChain` structurally cannot tell
"the alert was built and never shown" from "it was never built". The window
*count* varied across the Aug 4 hangs (1 in the morning, 2 in the evening) with
nothing to say what the second one was.

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
library transactions before the delete to zero. They continued at the same
rate — see above. The burst was a bystander.

**Location writes hang the same way.** `updateAssetLocations for 2 photo(s)
timed out after 45000ms` at 20:41 on Aug 4, and from that minute on every
delete in the session hung, where one had succeeded at 20:22. Editing an asset
the app didn't create needs the same user-consent alert a deletion does, so
this is the same wedge reached by a second route — and useful, because it says
the trigger isn't anything specific to `deleteAssets`.

**So does the USB card offload — but only the first two saves are evidence of
it.** `saveImageToPhotos` is asset *creation*, the one library write that
indisputably needs no consent alert, and on Aug 5 at 02:42 two consecutive
saves each burned the full 30s timeout. Everything after those two is
explained by the app's own code, so don't count it as corroboration:
`UsbStorage.m` gated saves behind a semaphore of capacity 2 whose permit was
returned **only** from `performChanges`' completion handler. The JS loop
abandons a save at 30s, but the native call keeps its permit — so two hung
saves exhausted the semaphore permanently, and every later save blocked on
`dispatch_semaphore_wait(…, DISPATCH_TIME_FOREVER)` without ever reaching
PhotoKit. One bad card killed the offload for the life of the process, and a
10-minute retry would have started with zero permits and died the same way.

The permit now comes back from whichever fires first, the completion handler
or a 45s watchdog, and the run abandons after 3 consecutive timeouts and waits
10 minutes before touching that card again (`usb_offload_library_wedged`).

The general shape is worth remembering: **anything that holds a resource until
a PhotoKit completion handler fires is a permanent leak on this device**,
because that handler demonstrably never fires. Look for the same pattern
wherever a lock, permit, or queue slot is released only from a completion
block.

`deletePhotoAssets` was the next instance of it, found by reading rather than
from the log: the `PHPhotoLibraryChangeObserver` registration and the pending
identifier list were released only from `finish`, so a hung delete left the
observer registered for the life of the process, running a main-queue
`fetchAssetsWithLocalIdentifiers` over a batch JS abandoned two minutes earlier
on every subsequent library change. Worse, that abandoned call is still live
natively: when its completion handler finally fired it set the shared
`_pendingDeleteSettled` flag and unregistered the observer belonging to the
*next* deletion, whose own callback then returned early and never resolved — a
wedged delete wedging the delete after it. Both are now generation-scoped, with
a 150s native watchdog (just past JS's 120s) as the release path.

Also fixed: the `saved N, failed M` summary sat inside `if (savedPaths.length
> 0)`, so a run where *nothing* saved logged no outcome at all — which is why
the Aug 5 log can't say whether that offload finished or the app died holding
it. It is now unconditional (skipped only when `usb_offload_library_wedged`
already carries the same counts).

**"A location write immediately before the delete causes the hang" is dead as
a necessary cause.** Two of the three Aug 5 hangs had one 1–2s earlier; the
00:36 hang had none in its session at all.

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
at 30s.

Neither fired in the Aug 4 log, and 16 of 17 imports settled (the slowest of
them in 753ms). The one exception — 42 photos at 15:30:16, no `settled` line,
relaunch 42s later — did *not* trip `photo_import_stalled` at the 30s mark it
would have reached, so the import had already finished and the `settled` POST
was lost with the process. Watch for it again, but the wedge itself looks
fixed.

### The preflight's premise was false, and the probe couldn't say so anyway

Two things went wrong at once in the Aug 5 16:04–16:40 log, and between them
they skipped **five deletions (150 photos) and eleven location writes on a
library that was working**: at 16:10:58 the USB offload created 68 assets with
zero failures, minutes after the probe had reported the library unable to
service a consent-free write.

1. **The USB card offload was never on `enqueuePhotoLibraryWrite`** — the one
   native library write in the app that wasn't, and the largest, one
   `performChanges` per file, 114 in a run. The 16:08 preflight therefore ran on
   top of a live `saveImageToPhotos`, which is exactly the "queueing behind
   another transaction" ambiguity the preflight exists to remove. It is on the
   chain now, enqueued per file so a deletion waits one photo, not a card. **If
   a new native library write is ever added off the chain, the probe silently
   goes back to being unreadable.**
2. **`photoLibraryWriteProbe` spanned two transactions** — create an album, then
   delete it again, resolving only after the cleanup. A promise that never
   settled could be either one, and JS reported both as `probeOk=false,
   probeMs=-1`. Both preflight failures in this log have that signature, so
   *neither says whether the write landed*. Now one `performChanges` that
   deletes the previous probe's album and creates a fresh one; `probeCleaned`
   above 1 means probes have been landing their write and being called failures.

Consequence for reading the next log: `probeOk=false` finally means the
library did not complete a transaction the app owns outright. If preflight
failures survive both fixes, that is the first solid evidence of a wedge that
isn't self-inflicted. **The 16:23 failure is the one to beat** — an
`updateAssetLocations` (a *consent-requiring* write on user assets) completed
inside 2.5s, and 2.9s later the consent-free album write didn't settle in 10s,
with nothing else on the chain. Note also that the whole cascade came from one
bad probe: each failure arms the 10-minute cooldown, which skips everything
after it, so the log shows 5 skips from 2 probe failures.

### The app uploads one observation two or three times at once

Four of nine observations in the Aug 5 16:04–16:40 log had genuinely
overlapping upload attempts — `5912d135` had three, starting 16:30:59,
16:32:51 and 16:33:51, the first still running seven minutes later. Extract
start times as `timestamp - durationMs` from the `Upload: Failed` / `Upload:
Slow completion` lines and interval-overlap them per uuid; that is how it
shows up, and it explains both the wall of `Aborted` and the lone `Media
attachment failed: Accessing object which has been invalidated or deleted`
(two attempts mutating one observation's photos).

`useUploadObservationWorker` does intend to skip in-flight uuids, but it reads
`activeUploads`, and `resetUploadObservationsSlice` and `stopAllUploads` both
empty that map wholesale while the promises it was tracking keep running. A
module-level map of unsettled attempts now survives those resets.
**Which reset is doing it is still unproven** — `upload_duplicate_attempt`
carries `uploadStatus`, `queueLength` and `activeUploads` at the moment it
fires, which should name it in the next log.

### USB `saveImageToPhotos` timeouts, cause still unproven

Three 30s save timeouts across two runs on Aug 5 (16:05:23, 16:08:48,
16:09:18), then 68/68 saved cleanly at 16:10:58. Contention doesn't explain
them: run 1's *first* save timed out with nothing else touching the library.
Both bad runs ended with the app being killed before the outcome line, so
neither says how it finished. Not acted on.

### Known, not worth acting on yet

- **Keychain `-25308` (`errSecInteractionNotAllowed`) with 401s around it.**
  `react-native-sensitive-info` hardcodes
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` with no JS option, so a token
  write while the phone is locked cannot succeed. Fixing it means a
  `patch-package` patch that would only take effect for newly-added keychain
  items. Once in five days; revisit if it recurs.
- **Places autocomplete failures** are a Google Cloud config issue (API not
  enabled for the key), not app code.
- **Uploads aborted while backgrounded.** Five `Upload: Failed … stage:
  media_upload, app backgrounded (background)` in the Aug 4 log, three of them
  at ~400s — an iOS background task expiring mid-upload, which is what is
  supposed to happen. One of the five was the keychain bug above (`without API
  token!`). Only worth revisiting if it starts happening in the foreground.
- **`isAdvancedUser`** is an upstream metric marked do-not-remove and is
  already gated on change; one line per launch is the floor. Leave it.

### Volume, for calibration

3,443 lines over five days, of which ~2,550 were six diagnostics repeating
themselves; the removals in that session should hold the next log near 900.
If a fresh log is much bigger than that, something new is looping.

The Aug 3–4 log came in at 124 lines over six hours — roughly 500/day, so the
removals held. At that volume nothing is noise-dominated any more, and the
grouped summary is small enough that the dump is worth loading every time.

The Aug 4 log was 281 lines over 20 hours (~340/day), but 100 of them were
`slow_query`/`query_hang` inside 19 minutes: one network stall, one line per
in-flight query. Those are now coalesced into `slow_query_burst` (a lone slow
fetch still gets its own line), which would have made those 100 about 20. The
lesson generalises — any per-occurrence diagnostic on something the network can
stall will arrive N-at-a-time, so summarise the burst from the start.

The Aug 5 log was 75 lines over 4 hours (~450/day), with no single diagnostic
dominating — the coalescing held. `Failed to open about:blank` (4 lines, a
WebView navigating its own blank frame into `Linking.openURL`) is gone as of
this session, and a wedged delete now costs one `photo_delete_preflight`
instead of three lines and 120 seconds whenever the library is already stuck.

The second Aug 5 log (05:09–15:02) was 25 lines over 10 hours — ~60/day, the
quietest yet, and 6 of the 25 were the single deletion hang. Nothing repeats
any more, so at this volume read the whole dump and skip the summary. The prose
warn beside `photo_delete_preflight` is gone as of this session: two POSTs for
one event, and the structured line already carries the count and the reason.

The third Aug 5 log (16:04–16:40) was 92 lines in 36 minutes — a rate of
~3,700/day, but it is a pure burst window (a 114-photo card offload, then a
network outage that failed every upload), not a new leak. Nine of the 92 were
byte-identical `[diag]` repeats, now suppressed. At this size, read the whole
dump; the grouped summary hides the interleaving that all three of this
session's findings came out of.
