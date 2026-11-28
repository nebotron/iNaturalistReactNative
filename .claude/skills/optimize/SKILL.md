---
name: optimize
description: Find data-backed ways to cut the app's CPU, memory, battery, latency, disk and network use, proposing diagnostics where the data is missing. Proposes changes as a numbered list; makes none of them.
---

Find where the shipped app spends the most resources for the least benefit,
and propose changes that would make it lighter. **This skill only proposes:
it doesn't edit code, commit or push.** Areas:

- **CPU** and **battery** (overlaps `/battery`; use its notes, don't redo it)
- **Memory** (peak footprint, memory kills, leaks across screens)
- **Latency** (cold start, screen transitions, taps that stall, slow uploads)
- **Disk** (bytes written, files left behind, cache/database growth)
- **Network** (bytes and requests, refetches, oversized images)
- **App size** (bundle, assets, native libraries, models)

**Every suggestion must rest on data.** A measurement from the field (app
log, MetricKit, TestFlight), or one taken here (bundle size, a benchmark, a
test that counts calls). "X looks expensive" from reading code is a
hypothesis, not a finding. When the data for a likely cost doesn't exist,
the proposal is a **new diagnostic** that would produce it.

Never trade away image quality, AI model accuracy, observation location
accuracy, or user data to save resources.

## 1. Gather the data

Run these first and keep the output (scratchpad). None need `.env` except
TestFlight.

```bash
python3 scripts/app_log.py                                   # summary groups
python3 scripts/app_log.py --dump <scratchpad>/log.json       # everything, for analysis
python3 scripts/power_report.py                               # MetricKit: CPU, GPU, disk, net, memory kills, by screen
python3 scripts/app_log.py --grep 'js_cpu|cpu_prof'           # hot JS functions
python3 scripts/app_log.py --grep 'slow_screen_transition|slow_ui_work|button_stuck'
python3 scripts/testflight_crashes.py                         # if credentials exist; jetsam/OOM crashes
```

Analyze the dump with a script rather than by eye: group by message prefix,
build, and screen; compute counts, rates, medians and p90s. Note which
`commit`/build each entry came from and check `git log` so you don't chase a
cost already fixed. Read the dated notes at the bottom of this file and of
`.claude/skills/battery/SKILL.md` for what earlier runs found and changed, and
check whether those changes show up in the newer builds' numbers.

Measurements you can take in this container:

- **JS bundle size and composition**: `npx react-native bundle --platform ios
  --dev false --entry-file index.js --bundle-output <scratchpad>/main.jsbundle
  --sourcemap-output <scratchpad>/main.map`, then attribute bytes to modules
  from the source map (biggest `node_modules` packages, duplicates,
  dev-only code that ships).
- **Assets**: sizes of `src/images`, fonts, Lottie/JSON, anything bundled
  into `ios/` or `android/app/src/main/assets`.
- **Dependencies**: unused packages (`package.json` entries with no import),
  multiple copies of one package in `node_modules`.
- **Call counts in tests**: a jest test that renders a screen and counts
  API calls, Realm writes, or renders shows repeat work deterministically.

## 2. Find candidates

Rank by total cost (rate × how often/how long), and look for work done for
nothing, done twice, or done bigger than needed:

- **CPU/battery**: see `/battery` step 3. Plus: re-renders from unstable
  Zustand selectors (selecting objects/arrays without `useShallow`),
  `useEffect` loops, Realm queries re-run per render, listeners not removed.
- **Memory**: full-size images decoded for thumbnails, lists without
  virtualization or with huge `windowSize`, caches without bounds (module-level
  `Map`s, React Query `gcTime: Infinity`), Realm results held open, memory
  kills by screen in MetricKit (`memory kills` column).
- **Latency**: `slow_screen_transition` by screen (median/p90), work on mount
  that could wait (`InteractionManager`, lazy imports), sequential awaits
  that could run in parallel, synchronous MMKV/JSON parsing of large values at
  startup, cold start (top-level imports of heavy modules).
- **Disk**: MB/min by screen, files never cleaned (see
  `agent-docs/architecture/media-filesystem-lifecycle.md`), log files and
  sentinel files that grow, Realm file growth without compaction.
- **Network**: React Query `staleTime` 0 on data that rarely changes,
  duplicate queries with different keys for the same data, `per_page` larger
  than what's shown, full-size photo URLs where `square`/`small` would do,
  uploads of images larger than the server keeps.
- **App size**: large packages imported for one function, moment-style
  locale bundles, unused fonts/icons, assets duplicated across platforms.

Trace each candidate to `file:line` and read the subsystem's `agent-docs/`
first.

## 3. Propose diagnostics where data is missing

For each likely cost with no measurement, propose the smallest logging that
would measure it on the next build: where it goes (`file:line`), what it logs,
and what question it answers. Follow existing patterns:

- `logger` from `sharedHelpers/logger` (lines go to the Firebase log in
  non-dev builds). Log summaries (counts, durations, bytes), not per-item
  lines, and throttle anything that could fire often — a diagnostic must not
  become a cost of its own.
- `sharedHelpers/uiDelayTracker.ts` for latency, `sharedHelpers/powerProfile.ts`
  signposts for per-screen MetricKit attribution.
- Give each new line a stable, greppable prefix (e.g. `perf_startup`,
  `perf_mem`, `perf_net`) so the next run can grep it.

## 4. Shape each proposal

- Say what the change is concretely enough to implement: the file and
  function, what it would do instead, and why its output stays identical.
- Say how risky it is and how it would be tested (which suite, what the
  test asserts). Flag native iOS changes, which can't be built here.
- Don't make the changes. Measurements taken here (bundle builds, scratch
  scripts, a throwaway test run) are fine; leave the working tree clean.

## 5. Report

One **numbered list** holding every suggested change, diagnostics included,
biggest expected savings first (a diagnostic ranks by the size of the cost it
would attribute). Each item:

1. **Area** (CPU / memory / battery / latency / disk / network / size), and
   **Diagnostic** for new logging — the measurement (number, source, builds),
   the cause at `file:line`, the proposed change (for a diagnostic: what it
   logs and the question it answers), its risk, and how to confirm it once
   shipped (which log prefix or MetricKit column should move).

Mark items that rest on a single data point. Leave out anything that isn't a
change someone could make now: costs waiting on a diagnostic that already
ships, findings with no proposed change, and "nothing to do" observations.
Ask which items to implement, by number; the notes below record earlier runs
and are updated only when asked.

---

## Notes

### 2026-11-28

Data: app log Nov 25 – 27 (3,000 entries, dev builds `9333eda`–`27d06ee` plus
builds 1124–1126), MetricKit Nov 21 – 26 (builds 1112–1126).

- **My Observations scroll ran the whole store per frame**: `setMyObsOffset`
  was a Zustand `set( )` per scroll event (280 of ~7,000 JS samples, plus
  `checkIfSnapshotChanged`/`memoizedSelector` in every subscriber) for a value
  nothing renders. Now a plain variable that `setMyObsOffsetToRestore` reads.
  Confirm: `setMyObsOffset` gone from `js_cpu_summary`/`cpu_profile`.
- **Stale life list caches**: `exploreLifeList-v2-*` keys (2.1 MB) stayed in
  MMKV after the v3 bump until ten newer queries aged them out. Removed on the
  next sync. Confirm: `storage_metrics` `largestMmkvKeysKB`, `mmkvBytes`.
- **iCloud backup**: 1.6M chars against an 800K budget, because of
  `removedGroupPhotoUris` (1.1 MB and growing about 30 KB a day). The overflow
  check left out every key after the first that didn't fit, small ones
  included. Now only oversized keys are left out, and the warning names them.
- **New diagnostic `realm_write_summary`** (`sharedHelpers/realmWriteStats.ts`):
  commits, total and max ms per `safeRealmWrite` description, every 10 min and
  on backgrounding. Meant to attribute Suggestions (272 MB/min, 70% CPU),
  PhotoLibrary (262 MB/min, 87%) and ImageCropEditor (151 MB/min) disk writes.
  Writes made outside `safeRealmWrite` (bare `realm.write`) aren't counted.
- Already fixed: 510 `fetchTaxon` 429s (AudioId/AudioIdClip, dev build
  `a17ee7f`) predate the batched taxon fetch in `9d76198`.
- Not changed: Nuke's disk cache grew from 3.5 to 5.0 GB in two days, but
  it's unbounded by design (`patches/@candlefinance+faster-image+1.7.2.patch`).
  USB staging (7.7 GB) is draining on its retention timer. The 512 MB image
  memory cache is Nuke's default cap, and grid cells already decode at tile
  size.
- Open: three launches ended at about 3.1 GB footprint with about 200 MB free
  (`previous_launch_ended_high_memory`), mostly `malloc_small` on Explore and
  TaxonDetails, not yet attributed. PhotoLibrary → ImageCropEditor takes a
  median of 1.05 s (n=9).
