---
name: rebase
description: Squash main and rebase it over inaturalist/iNaturalistReactNative main
---

Squash everything on `main` into one commit, rebase it over the upstream iNaturalist
repo, and force push it back.

1. Resolve remotes by URL rather than assuming names:
   - `UPSTREAM` is the remote whose URL is `inaturalist/iNaturalistReactNative`. If
     there isn't one, add it:
     `git remote add upstream https://github.com/inaturalist/iNaturalistReactNative`.
   - `FORK` is the remote whose URL is this user's own fork — the one `main` pushes to.
2. `git checkout main`. Stash or commit anything uncommitted first; the working tree
   must be clean.
3. `git fetch UPSTREAM main`, then report how `main` compares with `UPSTREAM/main`:
   how many local commits are being squashed and how many upstream commits are being
   rebased over (`git rev-list --left-right --count UPSTREAM/main...main`).
4. Squash every local commit since the merge base with `UPSTREAM/main` into a single
   commit, keeping the original history in the commit body:
   `scripts/squash.sh UPSTREAM --no-push`. If it reports nothing to squash, `main` is
   already at the merge base and there's nothing to do but the rebase.
5. `git pull --rebase UPSTREAM main`, resolving any merge conflicts.
6. Verify with `npm test`.
7. `git push --force-with-lease FORK main`.
