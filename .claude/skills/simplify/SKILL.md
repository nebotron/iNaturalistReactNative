---
name: simplify
description: Remove unnecessary changes
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
not on individual commit messages.

Make a numbered list of changes in that diff which are unnecessary, outdated,
or can be simplified.

Do not flag personal local-dev configuration as unnecessary — e.g. personal Apple `DEVELOPMENT_TEAM`/`PRODUCT_BUNDLE_IDENTIFIER` in `project.pbxproj`, personal entitlements/associated-domains, or the app display name. These are intentionally kept even though they'll never be upstreamed.
