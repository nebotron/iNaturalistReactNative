---
name: rebase
description: Rebase over origin/main
---

Run `scripts/squash.sh origin --no-push` to squash all commits on the current branch since the merge base with origin/main into a single commit (the full original commit history is preserved in the commit body). Then rebase onto the latest origin/main with `git pull --rebase origin main`, resolving any merge conflicts. Verify your changes with `npm test`. Push with a fast-forward push to origin/main — never force push.
