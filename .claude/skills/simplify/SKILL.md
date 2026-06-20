---
name: simplify
description: Identify changes on this branch (vs inaturalist/main) that can be removed or shrunk to keep patches small and easy to rebase.
---

Goal: identify changes on this branch (vs iNaturalist/main) that can be removed or
shrunk without losing important new functionality. Small, focused patches rebase
cleanly; large noisy ones don't.

## Step 1 — Get the diff

```
git fetch inaturalist main 2>/dev/null || git fetch origin main
git diff inaturalist/main...HEAD   # or FETCH_HEAD/main if no inaturalist remote
```

If the remote is named differently, adapt. If the branch has no upstream, use
`git diff main...HEAD` or `git diff HEAD~N` as appropriate.

## Step 2 — Analyse

Read the full diff. Identify each discrete change (one file change or a tight
cluster of related lines) and ask: **does removing this shrink the patch without
losing functionality that matters?**

Look for:

1. **Whitespace / formatting only** — lines changed only in indentation, blank
   lines, trailing spaces, or quote style. Noise with no semantic value.

2. **Debug / logging leftovers** — `console.log`, `Alert.alert`, extra log
   statements, temporary `TODO` comments, or `animalCropLog`-style debug traces
   that don't belong in production.

3. **Dead / unreachable code** — variables assigned but never read, imports
   never used, branches that can never execute given the surrounding logic.

4. **Refactors unrelated to the feature** — renaming, restructuring, or
   extracting helpers in files the feature doesn't otherwise touch. These
   increase diff size and cause merge conflicts for no net gain.

5. **Over-engineering** — abstractions, helper functions, or generalisations
   added for hypothetical future callers that don't exist yet. Prefer the
   inline, concrete form.

6. **Config / dependency creep** — new packages, new build flags, or new
   environment variables whose only consumer is a feature that could be built
   without them.

7. **Defensive code for impossible cases** — error handling, fallbacks, or
   type guards for states the surrounding invariants already rule out.

8. **Reverted upstream behaviour** — places where the patch changes something
   in upstream code and then a later commit changes it back, leaving net-zero
   effect. Both commits can be dropped.

9. **Scope bleed** — changes in files that are only tangentially related to the
   core feature (e.g. touching `Menu.tsx` while adding a camera feature).

## Step 3 — Output

Produce a **numbered list**. Each item must have:

- A one-line title in bold.
- File(s) and approximate line range.
- One short paragraph explaining what the change is, why it can be removed or
  shrunk, and what (if anything) is lost.

Group items from most impactful (largest reduction in diff size or merge-conflict
risk) to least. Omit anything that is load-bearing for the feature.

End with a two-sentence summary: total approximate lines that could be removed,
and what the remaining essential diff achieves.

Do **not** apply any changes. This skill produces a list only.
