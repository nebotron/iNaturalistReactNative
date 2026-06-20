---
name: fixes
description: List the pure bug-fix commits in nebotron/iNaturalistReactNative that fix bugs present in the upstream inaturalist/iNaturalistReactNative repo.
---

Present the following list of pure bug fixes — commits that fix incorrect behavior in code that existed in the upstream inaturalist/iNaturalistReactNative before this fork:

None.

Every fix commit on this branch falls into one of two categories:

**A. Fixing bugs in code the fork itself added** (files created by the fork's initial `All changes` commit that don't exist upstream):
- `useSubjectDetectionForUri.ts`, `ensureLocalImageForCrop.ts`, `ImageCropEditor.tsx`, `animalCropLog.ts` — subject-detection and crop pipeline (all fork-new)
- `SuggestionsContainer.tsx`'s `interactionsDisabled` state and `tryOfflineSuggestions=true` behavior — fork modifications that caused the checkmark and race-condition bugs later fixed by separate commits
- `useNavigateWithTaxonSelected.ts` made async by the fork, then reverted

**B. Fixing bugs the fork introduced into existing upstream files**:
- The `Alert.alert()` in `logging.js` — added by the fork, then removed
- The offline-popup alerts in `Menu.tsx` and `OfflineNavigationGuard.tsx` — added by the fork, then removed
- The 50 missing translation keys and broken test mocks — omitted by the fork's own cleanup commit

The `patches/react-native-image-picker+8.2.1.patch` change (`a5fc7d57`) does fix a real iOS OOM crash on 200+ photo imports, but it replaces the upstream's patch entirely rather than adding to it, so it is not a pure upstream bug fix either.
