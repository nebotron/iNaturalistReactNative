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

### One upload's timeout used to abort every other upload in flight

The Aug 5 19:08–20:22 log is a wall of `Media upload failed: Aborted`, and
duplicate attempts do not explain it — no uuid overlaps itself in that log.
The uploads share **one** `AbortController` (the store's, per upload session)
while the 5-minute `MS_BEFORE_UPLOAD_TIMES_OUT` timer is per observation, so
whoever expired first killed everyone.

The way it shows up is *two aborts at the same instant with different
durations*, and three of them are in that log:

- 19:51:36.04/.09 — `6cddaca3` at 300004ms (its own deadline) and `18dd15b2`
  at **290811ms**, 9.2s short of its. One timer, two victims. This pair is the
  proof; nothing else produces it.
- 20:08:35.83/.84 — `047d78db` at 287217ms and `4ad5ecaf` at **24102ms**, and
  no upload in the log reached its deadline at that instant.
- 19:47:05.05/.67 — `047d78db` at 9091ms and `85633fa2` at 12811ms.

Six of the ten foreground aborts were uploads killed before their own
deadline. Sort by `timestamp - durationMs` and group the *end* times: siblings
dying together within ~100ms with unlike ages is the signature.

Second half of the same bug: `clearTimeout` sat after the `await` **inside the
try**, so it only ran when the upload succeeded. A failed upload left a live
timer that fired five minutes later at whatever was running then — and since
`resetUploadObservationsSlice` and `stopAllUploads` both *preserve* the
session controller (only `setStartUploadObservations` makes a new one), that
reached across batches. That is what the 20:08:35 and 19:47:05 aborts are:
timers outliving the uploads that armed them.

Third consequence, worth knowing because it is the user-visible one: once the
shared signal was aborted the effect's `abortController.signal.aborted` guard
refused to start **anything** until the user tapped upload again. The log
shows exactly that gap — nothing new starts between 19:51:36 and 20:03:41.

Fixed by `createUploadAbortController` (`src/uploaders/utils/uploadAbort.ts`):
one controller per attempt, linked to the session signal so `stopAllUploads`
still reaches everything, and a `release( )` in the `finally` that clears the
timer however the attempt ends. `upload_timed_out` now says when an upload
spent its own budget, which the `Aborted` line alone never could.

**Watch the timeout value in the next log.** `29637320` legitimately took
294384ms and succeeded — 5.6 seconds inside the 300s budget — and several
media stages ran past 280s. On a bad network 5 minutes is marginal. Left at
300s deliberately: with per-upload controllers a slow upload now only risks
itself, and raising it means a genuinely stuck upload holds one of the three
concurrency slots for longer. If `upload_timed_out` starts appearing next to
uploads that were still making progress, that is the signal to raise it.

### USB `saveImageToPhotos` timeouts, cause still unproven

Three 30s save timeouts across two runs on Aug 5 (16:05:23, 16:08:48,
16:09:18), then 68/68 saved cleanly at 16:10:58. Contention doesn't explain
them: run 1's *first* save timed out with nothing else touching the library.
Both bad runs ended with the app being killed before the outcome line, so
neither says how it finished. Not acted on.

**It happened twice more in the Aug 5 19:08–20:22 log, and the log still
can't say why.** 19:08:24 "saving 80 photos" → cold `pickup` 44s later →
19:09:08 "saving 80 photos" again, `alreadyImported=0` → cold `pickup` 20s
later. Not one file saved in 44 seconds, no per-file error line, no outcome
line. Two cold launches in 64 seconds during an offload is a crash or a
jetsam, and the loop is strictly sequential (`await` per file, `markUsb
ImagesImported` per success) so flat memory is not obviously the cause.
Every log line is a network POST, so a run that dies takes its last lines
with it — absence of an error line is not evidence there wasn't one.

That is the third session in a row to end at "the app was killed before the
outcome line", so this session added the measurement instead of another
theory: `markUsbOffloadStarted` / `updateUsbOffloadProgress` /
`takeUnfinishedUsbOffload` in `usbStorage.ts` keep an **MMKV** breadcrumb
(total, saved, failed, startedAt) that survives the process, and the next
offload reports any survivor as `usb_offload_never_finished`. MMKV, not a log
line, precisely because the thing being measured is the death that eats log
lines. It fires only after a run that vanished, so a healthy device never
logs it. Read it as: `saved` near 0 with a large `msRunning` means the app
died without PhotoKit ever completing a save; `saved` climbing means it died
partway and the crash is a function of how much it did.

Note also that the card went away underneath both runs — 19:09:28 lists 0
files where 19:09:08 listed 80, and 19:18:47 says `no-folder-saved`. Whether
that is cause, consequence, or the user unplugging is exactly what the
breadcrumb should disambiguate.

### The consent alert is not what wedges the library

The Aug 6 (23:38–00:18) log has the controlled case every previous session was
missing. At 00:15:00 the app deleted **17 photos, 17 of them app-created** —
`theirAssets.count == 0` in `deletePhotoAssets`, so the only PhotoKit
transaction issued was `deleteAssets:ourAssets`, the one that presents no
confirmation. It hung: `photo_delete_pending` at 5s, timeout at 10s, and the
concurrent probe reporting `probeOk=false`. Two deletions minutes earlier, same
build, same device, same assets (the 00:02:47 offload of 47), both entirely
app-created, came back in **1145ms and 1191ms**.

So every theory resting on the alert is dead, including the one this session
was supposed to test: *"a consent alert requested by an app that then leaves the
foreground wedges photolibraryd"*. There was no alert.

**`leftForeground` was never measuring what its name says, and this is the log
that proves it.** It counted `"inactive"` as away, and it was seeded from
`AppState.currentState` *before* the delete began. All three of the log's
**successful** deletions report `sceneState:1` (foregroundInactive) in the
native context captured before them — these deletes are issued straight after a
navigation or a modal dismissal, so foreground-inactive is the normal state to
start one in. The hang's `leftForeground=true, appStateChanges=1,
appState="active"` is the signature of starting inactive and going active once,
not of a trip to the background. Replaced by `backgrounded` (background only)
and `wentInactive`; the Aug 5 05:09 hang's `leftForeground=true` should be
re-read as "nothing", not as evidence.

**The settling-delay theory is dead too**, killed by counting rather than by
one instance. Gap from the `applyTrackedLocationToPhotos` line to the delete:
6.4s, 2.7s, 2.6s (all successes) and 2.6s (the hang). Identical.

`photo_delete_pending` / `photo_delete_failed` now carry `appCreated` and
`prompted`, so the next hang says which transaction was outstanding without
loading the dump. The split is decided before the timers are armed for this.

**The preflight worked, and it is not the story.** All three
`photo_delete_preflight` lines in this log are `probeOk=true` at **error**
level — that is `eb9c8d8`, already fixed, and the three biggest error groups in
the summary were therefore already dead on arrival. The `commit` check took a
minute again. The probe itself is healthy on the one-transaction build:
`probeMs` 4849 / 1180 / 1001, `probeCleaned` 5 then 1 then 1 (the 5 were stale
albums from the two-transaction era, cleaned once and gone).

**`appCreatedMs` vs the prompted half, one mixed batch, and it inverts.** At
00:07: 1 app-created asset took **3364ms**, and the 2 prompted ones took
~1375ms by subtraction — the *unprompted* transaction was slower, per asset by
5×. Then 8 app-created in 1145ms and 7 in 1191ms. Duration plainly doesn't
scale with count, and the first library transaction after a launch looks
expensive. Consequence worth watching: 3364 > `NO_CONFIRMATION_MAX_MS` (2s), so
that one sample flipped the exemption verdict to "no" and the next two flipped
it back. The verdict flaps on a single cold-start sample. Not retuned on one
log; get `promptedMs` (shipped in `a524314`, not in this build) from a mixed
batch first.

### A full phone is a failure mode, and nothing in the app was watching for it

The Aug 6 (01:00–14:13) log is 1,237 lines and **1,084 of them are one error**:
`"3S1A5693.CR3" couldn't be copied to "tmp" because there isn't enough space`,
one per file, 157 files, seven rounds, 74 seconds. At 14:11:22 an offload of 208
saved 51 and the disk filled; every scan after that re-listed the remaining 157
and failed all of them in ~1.5s, ten seconds apart, forever.

The guard that should have caught it counted **consecutive timeouts**, and a
full disk fails instantly — so `consecutiveTimeouts` reset on every failure and
never reached 3. Now any consecutive failures abandon the run, and out-of-space
abandons on the *first* one (it is a property of the device, not the file). New
markers: `usb_offload_out_of_space` and `usb_offload_saves_failing` beside the
existing `usb_offload_library_wedged`. The generalisation worth remembering:
**a guard keyed to one failure mode is no guard at all** — the next outage
arrives as a different error and walks straight past it.

`storage_metrics` now carries `freeDiskBytes`/`totalDiskBytes`. Read it first
next session: the old line said 5MB of MMKV and 8MB of Realm on a phone with no
room to copy a single file, and nothing else in the log could name the
condition. **Note it is a per-launch line, so a disk that fills mid-session
still won't show** — the offload's own marker is what reports that.

### The one-transaction probe's healthy timings, at last

Four `photo_delete_preflight` lines, three of them `probeOk=true` at **error**
level — `eb9c8d8`, already fixed, and again the summary's largest error groups
were dead on arrival. Their `probeMs` on a build that *does* carry the
one-transaction probe (`7cdaf13` is an ancestor of `3a6dedd7e`): **4186, 2942,
1522**. So a healthy probe takes up to 4.2s, 42% of `PREFLIGHT_TIMEOUT_MS`.
That answers the question the Aug 5 21:50 notes left open, and the answer is
**don't tighten the timeout**.

The one genuine failure (01:00:42, `probeOk=false, probeMs=-1`) armed the
cooldown and skipped four deletions; a probe 11 minutes later passed and deleted
25 of 25.

### The 03:13 hang says nothing new, and that is worth knowing

86 photos, 85 app-created, preflight `probeOk=true` in 4186ms, a real library
write completed 10.4s earlier, `mainQueueResponsive=true` with `msToRespond=6`,
one window, no modal — and the deletion still never came back. No
`photo_delete_app_created` line, so the transaction that hung is the
**unprompted** one, matching the Aug 6 00:15 controlled case. Every established
theory stays dead and no new one is testable from this log.

Read its `leftForeground=true` as nothing: `appStateChanges=1`, `appState`
active, context `sceneState=1` — the start-inactive-then-go-active signature
that `4987949` (`HEAD`) already fixed. This build predates both that and
`a524314`, so the hang carries neither `appCreated`/`prompted` on the timers nor
`promptedMs`. **The mixed-batch comparison is still unanswered after three
sessions**; it needs a log from `a524314` or later.

### Gallery imports still vanish, and now there's a marker for it

01:13:32, 48 photos: the tap logged, `photo_import_stalled` at 30s with 9 of 48
settled and 0 failed, six `export_stalled` rejections at 134s (`progress=0.00`,
the watchdog working), then **nothing** — no `settled` line, no second stall, a
cold pickup twelve minutes later. `photo_import_stalled` fires once and cannot
say what happened next.

So this session added the MMKV breadcrumb rather than another theory:
`markPhotoImportStarted` / `updatePhotoImportProgress` /
`takeUnfinishedPhotoImport` (`photoImportMarker.ts`), reported by the next
launch as `photo_import_never_finished` with `selected`, `settled`, `failed`,
`msRunning`. Same shape as the USB one, which worked. Read it as: a large
`msRunning` with `settled` frozen at the 30s figure means the import was still
wedged when the process died; `settled` near `selected` means it finished and
only the POST was lost.

### Upload aborts: looked like the old bug, isn't

Six `Media upload failed: Aborted` in one minute, including three uploads killed
at 03:25:17–18 after only 5.5–7.7s — the exact "siblings dying together with
unlike ages" signature the per-attempt controllers were written to remove. It
is not that bug. `59f4cbb` **is** in this build, and the sequence explains
itself: the app was suspended 03:16→03:25 (nothing at all in the log between),
so three 300s timers fired late on resume at 03:25:05 and correctly aborted
their own uploads, then the queue restarted at ~03:25:18 and the session
controller's abort took the three young attempts with it. All three restarted
uploads completed. `upload_timed_out` firing at 535–539s rather than 300s is the
suspension, not a broken timer.

Worth carrying forward: **`upload_timed_out` cannot distinguish a real 300s
overrun from a backgrounded app whose timer fired late**, and the log has to be
read for a gap to tell. If that ambiguity ever costs a session, the fix is to
record elapsed wall time against the deadline on the line itself.

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

### The library can be perfectly healthy, and the Aug 5 21:50 log is what that
### looks like

Two deletions, both complete: 463 of 463 at 22:04 (5.3s door to door) and 9 of
9 at 22:11 (3.0s). No hang, no timeout, no cooldown, no skipped delete. After
four sessions of logs in which essentially every library write failed, this is
the first with successes to compare against — and it is worth remembering that
the wedge is a *state*, not a constant. A log without hangs does not mean a
build fixed them.

**`appCreatedMs` finally has data, and it is not conclusive.** 99 app-created
assets in 3073ms, and 2 in 1477ms — both well under the 10s that would rule the
exemption out, so the split stayed on and nobody got asked to confirm twice.
But the *prompted* remainder was just as quick (364 assets in roughly 2.2s,
7 in roughly 1.5s, by subtraction from the prose lines), and a prompted
transaction that fast is either an alert nobody had to answer or a user tapping
immediately. The log cannot separate those, which is why `promptedMs` now rides
on `photo_delete_app_created`. Read the next one as: `promptedMs` well above
`appCreatedMs` per asset means the alert is real and the exemption is buying
something; the two alike means either both prompt or neither does.

**A healthy probe can take 5.8s.** `probeOk=true, probeMs=5807` on a library
that then deleted 463 photos without complaint. That is 58% of
`PREFLIGHT_TIMEOUT_MS`, which would make the preflight itself the thing that
skips a working deletion — but note the build was `3ef9032d1`, which still had
the *two-transaction* probe that `7cdaf13` replaced. Do not retune the timeout
off that number; get a `probeMs` from a build carrying the one-transaction
probe first.

**Check the build first — this is the second log in a row that predated every
fix from the session before it.** All 25 lines carry `3ef9032d1`, now `HEAD~15`.
The per-attempt upload abort controllers, the one-transaction probe, the USB
offload on the write chain, the 10s deletion timeout and the duplicate-upload
guard are all still undeployed. Nothing in this log tests any of them. Until a
deploy happens, expect each new log to re-raise questions already answered in
these notes; the `commit` check is the only thing standing between that and a
wasted session.

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

The fifth Aug 5 log (21:50–22:12) was 25 lines in 22 minutes, and it is the
first log in the series with no failure to chase: one backgrounded upload
(known, listed above), two `slow_query_burst` and a `slow_query` riding out a
network stall, and two clean deletions. At this size the summary is pointless —
read the dump.

The fourth Aug 5 log (19:08–20:22) was 122 lines in 74 minutes (~2,400/day),
again a burst window: an 80-photo card offload, a 45-minute network outage,
and a 480-photo cleanup. 23 of the 122 were `slow_query*` riding out the
outage, which is the coalescing working, not a leak.

**Check the build before anything else — this whole log predated every fix
from the session before it.** All 122 lines carry `3ef9032d1`, which is
`HEAD~11`, so the two-transaction probe, the off-chain USB offload and the
duplicate uploads were all still live in it. The three `photo_delete_preflight`
failures (`probeMs=-1`, the exact ambiguous signature `7cdaf13` was written to
remove) and the 19:11 one landing on top of an 80-photo off-chain offload are
therefore *already answered*, and re-deriving them would have cost the
session. Between them those three failures armed the cooldown often enough to
skip six deletions covering 517 photos and three location writes. The `commit`
check took a minute; do it first, every time.

What that leaves genuinely new is the upload abort bug above — which is
visible only in the interleaving, from `timestamp - durationMs`, and not at
all in the grouped summary.

The Aug 6 log (23:38–00:18) was 60 lines in 40 minutes, and 53 of them carry
`3a6dedd7e` — for the first time in three sessions the log is mostly from a
recent build (`HEAD~4`), which is why it could finally settle something. Read
the dump; at this size the summary's errors-first ordering actively misleads,
since its top three groups were the already-fixed preflight-at-error.

Not chased, for the record: two cold `pickup`s 26 seconds apart (00:02:21,
00:02:47) with a `slow_query` between them, i.e. the app died ~25s into a
launch and left nothing behind. That is the fourth session with a death that
ate its own evidence. `usb_offload_never_finished` did *not* fire, so the
preceding offload had finished cleanly — the MMKV breadcrumb is working and
says this death wasn't during one. If it recurs, the generalisation of that
breadcrumb (a launch-scoped "previous run ended without a clean background
transition" marker) is the measurement to add.

The second Aug 6 log (01:00–14:13) was **1,237 lines over 13 hours**, and 1,084
of them were the out-of-space burst above. Strip that and it is 153 lines in 13
hours — ~280/day, in line with every log since the coalescing. So the volume
rule held and the exception proves its own point: **when a log is suddenly an
order of magnitude bigger, one diagnostic has found a new way to loop**, and the
top of the grouped summary names it in one line. That is the one situation where
the summary beats the dump; everything else this session came out of the
interleaving.

Every line carried `3a6dedd7e` (`HEAD~6`), so `eb9c8d8`, `a524314`, `d94d72c`,
`9e68ad1` and `4987949` were all still undeployed in it. Third session running
where the `commit` check saved re-deriving a fixed bug — this time the three
biggest error groups after the burst were the preflight-at-error again.
