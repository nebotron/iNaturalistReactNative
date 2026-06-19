---
name: fixes
description: List the pure bug-fix commits in nebotron/iNaturalistReactNative that are not part of the upstream inaturalist/iNaturalistReactNative repo.
---

Present the following numbered list of pure bug fixes (commits in this fork that fix incorrect behavior, not new features or improvements):

1. **Fix crop region on live update to match page-refresh path** (`8cec1a2`)
   On a live crop-log write the detection hook was reusing stale cached `imageWidth`/`imageHeight` from AI inference rather than re-fetching via `getImageSize(toLargeUri(uri))`, so the applied crop was calculated from wrong dimensions. The fix deletes the stale cache entry so both paths (live update and page-refresh) run the same async size-fetch. (`src/sharedHelpers/useSubjectDetectionForUri.ts`)

2. **Fix test failures and missing translation keys after cleanup** (`b67a1fe`)
   The cleanup commit (`a779a8a`) broke several things: deleted `extractAudioFromVideo.ts` while it was still imported, stripped `saveAsset`/`deletePhotos`/iOS-permission helpers from the CameraRoll mock (needed by camera tests), introduced a circular import that caused Jest to capture real module references before mocks applied, removed a named `ScreenShell` export needed by `ExploreTaxonSearch` tests, and omitted 50 translation keys used by new features. This commit restores all of them.

3. **Eliminate crop view loading spinner when opening from Identify page** (`39efb1f`)
   Three related cache/download bugs: (a) `ensureLocalImageForCrop` used a non-deterministic temp path so the same remote image was downloaded again even though the Identify page had already cached it — fixed by using a stable, URL-derived filename; (b) `useSubjectDetectionForUri` keyed its cache on whatever URL it was handed (medium or large), so detections stored under the medium URL were not found when the crop editor looked up the large URL — fixed by normalising to the large-URL form; (c) `ImageCropEditor` always ran full AI inference even when a detection was already in cache — fixed by checking the cache before calling `getCropForUri`.

4. **Remove blocking Alert.alert calls during network retries** (`526f4f0`)
   `reactQueryRetry` in `src/sharedHelpers/logging.js` called `Alert.alert()` on every retry attempt, popping a modal dialog over the UI each time a query failed on a flaky connection. This blocked all user interaction until the alert was dismissed and made the app appear broken during ordinary network hiccups. The alert was removed; the retry logic itself is unchanged.
