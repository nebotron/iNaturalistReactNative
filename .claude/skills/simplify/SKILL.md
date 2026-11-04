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
- Features which are rarely or never used, and can be removed
- Anything else which would make the diff between this branch and upstream smaller, while keeping the app working as intended

Make a numbered list of proposed changes.
