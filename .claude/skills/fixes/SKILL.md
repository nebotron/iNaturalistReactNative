---
name: fixes
description: Find pure bug-fixes
---

Look at the diff between the current branch and its upstream merge base.

"iNaturalist/main" means the `main` branch of the upstream repo
inaturalist/iNaturalistReactNative. The merge base is the most recent
upstream commit the current branch is built on top of; everything above it is
this fork's own work, and that is what you review.

Find the merge base:
- If an `iNaturalist` or `upstream` remote is configured, use
  `git merge-base HEAD iNaturalist/main`.
- Otherwise the fork does not share history with `origin/main` (it is
  periodically rebased), so `git merge-base` against it fails. The base is
  instead the newest commit in `git log HEAD` that is NOT authored by the
  fork. Fork commits are authored by bfhannel@gmail.com or by "Claude"
  <noreply@anthropic.com>; upstream commits are by iNaturalist contributors
  (e.g. jtklein, campbellabbeya, sepeterson) and typically merge PRs from
  inaturalist/* branches. That newest upstream commit is the merge base.

Diff with `git diff <merge-base>..HEAD` and judge changes on the net diff,
not on individual commit messages (the fork often breaks something and then
fixes it within its own history, which nets to zero against the base).

Make a numbered list of changes in that diff which are pure bug-fixes for bugs
or performance issues on iNaturalist/main, and do not add any completely new
functionality. Fixes to the fork's own new features do not count — only fixes
to behavior that already exists on iNaturalist/main.
