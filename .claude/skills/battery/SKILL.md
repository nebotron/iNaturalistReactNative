---
name: battery
description: Find and fix what drains the battery, from the app's MetricKit data, without lowering image quality or AI model accuracy.
---

Find the app's biggest remaining battery costs, trace each one to the code that
causes it, and fix it. **Never trade away image quality, AI model accuracy
(the CV model, Audio ID, the geomodel, subject detection) or observation
location accuracy** to save power: the fixes wanted are work the app does
for nothing, does twice, or does on more power-hungry hardware than it needs.

Only concrete findings count. "Reduce CPU on screen X" is not a finding.
"`file.ts:123` rewrites Y on every Z, which shows as W MB/min on screen X"
is a finding.

## 1. Measure

```bash
python3 scripts/power_report.py               # everything
python3 scripts/power_report.py --days 7      # recent builds only
```

No `.env` is needed. It reads the shipped app's MetricKit entries (iOS, once a
day per device) from the app log and prints three tables:

- **Daily totals** per device: foreground/background hours, CPU and GPU hours,
  time at each location accuracy, disk writes, Wi-Fi/cellular traffic, memory
  kills. `cpu%`/`gpu%` are of foreground time.
- **By screen and activity**: the same split by `PowerProfile` signposts
  (`ios/iNaturalistReactNative/PowerProfile.h`, `src/sharedHelpers/powerProfile.ts`).
  `cpu%` and `MB/min` are the costs *while that screen was open*, so they rank
  screens fairly even when visit time differs. Activities (e.g. `AudioIdListening`)
  overlap screens.
- **CPU and disk-write exceptions**: iOS's own reports of a minute or more of
  heavy CPU, or over 1 GB written in a day, each with a stack.

Rank candidates by **total** cost (hours × rate), then by rate. Note the build
column: compare against the commit that shipped (`git log`), and don't chase a
cost a later build already removed.

### Naming the app's own stack frames

The app binary is stripped, so its frames print as `iNaturalistReactNative+0x…`
or as a wrong, nearby exported symbol (a `realm::` or `facebook::react::`
name in code that has nothing to do with Realm is the giveaway). Each
TestFlight build uploads its symbol table as the workflow artifact
`symbols-<build number>` (`.github/workflows/testflight-ios-build.yml`).
Download the one for the exception's build (GitHub MCP `actions_list` /
`actions_get` on the "TestFlight iOS" run for that build, or the run's page),
unzip it into `scripts/.symbols/`, and rerun the report: the frames get
function names. Builds before that step existed have no table; say so rather
than guessing from offsets.

## 2. Corroborate with the app log

```bash
python3 scripts/app_log.py --grep "<screen or feature>"
python3 scripts/app_log.py --grep "model provider|slow_ui_work|slow_screen_transition"
```

The log says what the app actually did: which model provider Audio ID chose
and why (`model provider cpu: …`, with CoreML's open errors), inference times,
upload sizes, crop timings, UI stalls. Never run `--clear`.

## 3. Trace to code

For each top cost, find the mechanism in code, not just the screen. What to
look for, by symptom:

- **Disk writes (MB/min) on a screen**: Realm writes of unchanged data (upserts
  that always set a timestamp, or replace embedded lists wholesale — see
  `Observation.upsertRemoteObservations`), one transaction per item instead of
  one per batch, persisted Zustand fields rewritten on every gesture
  (`src/stores/useStore.ts` `partialize`; `fieldPersistStorage` rewrites a
  whole field whenever it changes), image re-encodes (`copyAssetsFileIOS`,
  `resizeImage`, anything writing a full-size JPEG when the source bytes would do),
  and files rewritten in full instead of appended.
- **CPU % on a screen**: models on the CPU that could run on the Neural Engine
  (check the provider choice and `MLComputeUnits`), work repeated per render or
  per frame, polling timers (`setInterval`, `CADisplayLink`, `NSTimer`) that
  outlive their screen, decode/encode of full-size images where a smaller one
  is shown, JSON stringify/parse of large objects on every change.
- **GPU %**: animations that keep running off screen or behind a modal,
  views redrawn at 60 fps that change a few times a second, blur and shadow
  layers, maps left mounted on hidden tabs.
- **Location hours above foreground hours**, or time at 10 m/best accuracy:
  who holds a location request and with what options
  (`src/sharedHelpers/androidWatchOptions.ts` merges Android watches;
  `ios/iNaturalistReactNative/LocationRelaunch.m` tracks history on iOS).
  Precise fixes are only needed while the camera geotags.
- **Background hours/CPU/disk**: what runs after `AppState` leaves `active` —
  sync, uploads, Audio ID, the logger, the Android background service.
- **Network**: refetches of unchanged data (React Query `staleTime`,
  `refetchOnWindowFocus`, `ttl: -1`), images downloaded twice (placeholder and
  full size for the same view), duplicate API calls on mount.

Read `agent-docs/` for the subsystem first (upload system, Realm/Zustand,
media lifecycle). Third-party behavior is in `node_modules` and `patches/`;
check a library's native code before assuming what an option does.

## 4. Fix

- Apply fixes that keep output identical (skip a write whose result equals
  what's there, export bytes instead of re-encoding them, use the Neural
  Engine only when its scores match the CPU's within the existing tolerance).
- Native iOS changes can't be built here. Keep them small, mirror nearby code,
  and log what the change decided (e.g. which provider, why it fell back) so
  the next run of this skill can confirm it from the app log.
- Add a test for every JS change. Run the affected suites, and compare any
  failures against `main` before calling them yours.
- Library changes go through `patch-package` (edit `node_modules`, then
  `npx patch-package <pkg>`).
- Commit each fix separately with the measurement that motivated it in the
  message (screen, MB/min or CPU %, build).

## 5. Report

A numbered list, most savings first: the measurement, the cause at
`file:line`, the fix, and how to confirm it in the next builds' MetricKit data
(which column on which screen should drop). Say which findings are inferred
from one data point. Then add a dated entry to the notes below.

---

## Notes

### 2026-11-12

Data: Oct 25 – Nov 10, builds 1025–1111.

- **Audio ID ran on the CPU** (26% CPU while listening, the largest CPU total).
  The one CoreML check per build logged `CoreML failed to open` with no reason;
  `openSession` dropped ORT's error. It now logs it, tries three CoreML
  configurations (MLProgram, MLProgram with static shapes, NeuralNetwork), and
  keeps CoreML whenever a run fits `AB_COREML_MAX_RUN_MS` (1.25 s of the 2.5 s
  step) rather than only when it beats the CPU — the score check
  (`AB_COREML_MAX_SCORE_DIFF`) is unchanged. Confirm: the `model provider` line
  in the app log, then `AudioIdListening` cpu%.
- **My Observations wrote ~400 MB/min**: every page fetch rewrote every
  observation (`_synced_at`, plus embedded photo/sound/field/project lists
  recreated). `upsertRemoteObservations` now skips a payload identical to the
  last one written. Confirm: `MyObservationsResults` MB/min.
- **Crop editor 168 MB/min at 97% CPU**: `ph://` crop sources were decoded and
  re-encoded as max-quality JPEGs by `copyAssetsFileIOS`. Now exported as their
  own bytes (`ImageCropper.exportPHAssetCurrentVersion`, the edited rendition
  when there is one). Group Photos' imports are already `file://`, so this
  mostly hits other entry points; if `ImageCropEditor` MB/min stays high, look
  at `prepareCropSource`'s display JPEG and `Photo.resizeImageForUpload`.
- **Android location**: the library applied only the first watch's options to
  every watch; `androidWatchOptions` now merges them. History tracking uses
  balanced power (~100 m; a patched `balancedPowerAccuracy` option, since the
  library's non-high-accuracy mode is ~10 km).
- **Crop resume** persisted both URI lists on every drag; framing now saves
  after a 1 s pause, on backgrounding, and on close.
- **CPU exceptions** (90 s on the main queue, builds 1108 and 1111) and the
  ~1 GB/day disk-write exceptions couldn't be attributed: no symbols. The
  symbol-table artifact exists from the next TestFlight build on.
- Ruled out: FasterImage pipelines are already shared (patched); the Audio ID
  spectrogram already draws at 30 fps and only while on screen.
