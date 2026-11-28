---
name: simplify
description: Remove unnecessary changes
---

Find the merge base of this repo and the upstream repo:
```
git remote add upstream https://github.com/inaturalist/iNaturalistReactNative.git
git fetch upstream main
git merge-base origin/main upstream/main
```

Compare the current state to the merge base. Identify ways that this diff
can be simplified, to keep this repo closer to upstream. Look for:

- Unused or dead code
- Duplicated code
- Unnecessary changes to upstream code
- Overly complicated implementations which can be simplified
- Features which are rarely or never used, and can be removed (see below)
- Anything else which would make the diff between this branch and upstream smaller, while keeping the app working as intended

## Check how often fork-only paths actually run

Reachable code isn't necessarily used code. Reading the code can't show that a
fallback, alternate path or setting never runs in practice; only the field
data can. Example: the Vision saliency fallback in `ImageCropper.m` was
reachable, documented as deliberate, and ran 0 times in 3,400 detections once
an earlier change made YOLO almost always return a box.

For each fallback, alternate path or setting that exists only in this fork
(search the fork-only files for `fallback`, `stands in`, `when nothing`,
`otherwise`, flags in log lines, tunables):

1. Find the log line that counts it, then see how often it fires in the
   shipped app's log (no `.env` needed; never run `--clear`):
   ```
   python3 scripts/app_log.py --grep '<event name>'
   python3 scripts/app_log.py --dump <scratchpad>/log.json
   ```
2. Look for an offline evaluation of it in the skill notes
   (`.claude/skills/*/SKILL.md`) and `agent-docs/`.
3. Propose removing it when it almost never runs, or when an evaluation
   calls it a wash against the simpler choice. A wash is a reason to remove
   it, not to keep it: equal results with less code keeps the fork closer to
   upstream. Say what callers get instead.
4. Where no log line counts it, propose one (a counter on an existing
   summary line is best) rather than guessing, as `/optimize` does.

Re-check a path when the thing it backs up changes: a fallback that was
worth keeping before a threshold or model change may never run after it.

Make a numbered list of proposed changes. Give the evidence for each removal:
how often it ran and over how many events, or the evaluation that showed it
made no difference.
