---
name: diff
description: List the differences between this fork's main and upstream iNaturalist main
---

Compare `origin/main` (nebotron fork) with `main` of upstream
inaturalist/iNaturalistReactNative and give a numbered list of the
differences: new features, bug fixes, improvements, refactors, tooling, etc.

1. Fetch both with full history (the clone is often shallow, and without the
   history `git merge-base` finds nothing):
   ```bash
   git remote add upstream https://github.com/inaturalist/iNaturalistReactNative.git 2>/dev/null
   git fetch --unshallow origin main 2>/dev/null || git fetch origin main
   git fetch upstream main
   git merge-base origin/main upstream/main
   git rev-list --left-right --count origin/main...upstream/main
   ```
2. List the commits on each side:
   ```bash
   git log --no-merges --format='%h %s' upstream/main..origin/main
   git log --no-merges --format='%h %s' origin/main..upstream/main
   ```
3. The fork's oldest commit is usually "Squashed changes", and the original
   commit subjects are in its body (`git show -s --format=%B <sha>`). That body
   can start with an earlier "Squashed changes" whose messages are lost. Recover
   those features from:
   - files added or deleted: `git diff --name-status upstream/main origin/main -- src ios scripts tools .claude .github | grep -v '^M'`
   - new UI strings: `git diff upstream/main origin/main -- src/i18n/strings.ftl | grep '^+'`
   - menu entries in `src/components/Menu/Menu.tsx` and the `package.json` diff
4. Write the answer as two sections: "In this fork, not upstream", grouped by
   area (Audio ID, Explore, photo import/cropping, identification, new screens,
   performance/reliability, branding/tooling), and "In upstream, not this
   fork". Number the items continuously across sections and merge related
   commits into one item. Open with the two SHAs, the merge base, the
   ahead/behind counts and the `git diff --stat` total. Say which items were
   inferred from code rather than commit messages. End by noting that
   `/rebase` brings in the upstream commits.
