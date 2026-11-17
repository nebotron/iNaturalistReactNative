# Video stabilization

Menu → **Video Stabilizer** (iOS only). Import a video from Photos, hold
its background exactly where it was in the first frame by correcting shift
only (rotation and zoom are left as shot), and crop in closer. There is no
smoothed "follow the camera" mode and no subject-following mode: the
background locks to the first frame. The copy keeps the original's sound and
metadata.

## How it is split

| Layer | File | Job |
| --- | --- | --- |
| Screen | `src/components/VideoStabilizer/` | Import, start time, crop, side-by-side preview, export/save |
| Session state | `src/stores/videoStabilizer.ts` | Zustand, not persisted, so a tab switch doesn't drop a finished analysis |
| Math | `src/sharedHelpers/videoStabilization.ts` | Lock path, crop/zoom planning; unit tested |
| Bridge | `src/sharedHelpers/videoStabilizerNative.ts` | Typed wrapper, progress events, the comparison player view |
| Native | `ios/iNaturalistReactNative/VideoStabilizer.m` | Picking, frame reading, Vision registration, Core Image warping, AVAssetWriter, saving, player |

The native module runs two passes over the same upright, constant-frame-rate
`AVAssetReaderVideoCompositionOutput`. Frame *i* of the analysis is therefore
frame *i* of the render.

1. **Analyze**: the native pass measures per-frame motion. It's slow, so it
   runs once per video and start time.
2. **Plan**: JS turns the measurements into one homography per frame. This is
   instant, so zoom, crop position and
   "hide edges" can change without re-reading the video.
3. **Render**: the native pass warps each frame by its homography
   (`CIPerspectiveTransform`, or a plain affine when there's no perspective),
   crops it, and writes H.264 with the audio passed through and the
   original's QuickTime metadata (date, location, make/model) copied. A
   low-resolution preview (640 px) and the export (1920 px long side) are
   rendered separately.

### Nothing to press

The screen keys each result by the settings it was made with
(`analysisKey`, `previewKey`, `exportKey` in the store). An effect reruns the
analysis whenever its key is stale and, once it's current, re-renders the
preview, which loops below the original, each the full screen width
(`VideoStabilizerComparison`: the original from the start time the preview
was rendered with, then the stabilized preview). The pair scrolls with the
settings, below them. Both are tracks of one `AVMutableComposition` stacked by an
`AVVideoComposition`, so a single player clock keeps them frame for frame in
step, across the loop too. Native analyses and renders are numbered;
starting one cancels the one before, and progress events carry the JS job
number so a superseded job's progress is ignored. Only the export is started
by hand. A render deletes the previous file of its kind only once it has
finished, so the player never loses the file it's playing.

### The model

For each frame the lock `L_i` is the shift that maps the frame onto the first
frame. Only shifts are measured, so rotation and zoom are never corrected. A
pixel is drawn at `L_i · x − center`, then cropped by the zoom and crop
center. "Hide black edges" (off by default) binary-searches the smallest zoom
at which every frame's crop window stays inside its source frame.

**Picking the crop.** There's no zoom slider: two fingers on the stabilized
(lower) video of the comparison zoom and move the crop like a photo
(`PinchCrop`), with a dashed outline of the window that will fill the frame.
One finger scrolls the page: the overlay reads raw touches rather than taking
the responder, and the page stops scrolling only while two fingers are down.
When a preview finishes, the store keeps its `previewCrop`: the corners of
the window it shows, on the start frame, and the zoom it was rendered at
(after "hide black edges"). The window's center is mapped through those
corners to a new crop center on the start frame, and the new zoom is the
preview's zoom divided by the window's share of the width, so each pinch
zooms relative to what's on screen. Pinches are ignored while the preview is
stale. Reset Zoom returns to 1× centered. There is no still of the start
frame on the screen; the crop is only picked on the preview.

**Stabilize the background.** Chaining frame-to-frame registrations drifts, so
the analysis also shifts each frame onto the first by the chained estimate and
registers what's left against the first frame itself, giving a drift-free
shift (`r` per frame). Pans and walks show black edges by design.

**Metadata.** The render copies QuickTime metadata and user data as is and
maps other formats' common keys (creation date, ISO 6709 location, make,
model, software) to QuickTime keys. Saving goes through the native
`saveToPhotos`, which sets the Photos asset's creation date (moved on by the
start time) and location from the original, rather than leaving Photos to
date it when it was saved.

### Registration convention

Vision's registration transforms map the targeted image onto the reference,
in Core Image's bottom-left pixel space. This was measured with a per-video
vote over four readings until device logs consistently showed "as-is"; it's
now a constant.

## Approaches considered

### Background (camera shake)

| Approach | Pros | Cons |
| --- | --- | --- |
| **Vision translational registration** *(implemented, the only method)* | Built in, fast at 480 px, very robust on low-texture scenes such as water or sky | Can't remove roll or zoom wobble. A large moving subject drags the estimate |
| Vision homographic registration → similarity *(removed)* | Removes roll and breathing as well as shift | Rotation and zoom correction was taken out; only shift is corrected |
| Feature tracking + RANSAC (OpenCV `videostab`-style, or Vision optical flow with outlier rejection) | Rejects a moving subject as outliers, so it handles an animal walking through the frame best. Can mask out the subject box | Needs OpenCV (~10 MB+) or a hand-written robust estimator. Most code to maintain |
| Dense optical flow (`VNGenerateOpticalFlowRequest`) with a median over the background | Robust and separates subject from background naturally | Slow at useful resolutions. More conventions to verify |
| Gyroscope metadata | Exact, and immune to subject motion | Imported iPhone videos don't carry it (GoPro and some action cams do) |
| `AVCaptureConnection` stabilization | Best quality, done in hardware | Only at capture time, so it can't fix an imported clip |
| ffmpeg `vidstab` | Mature two-pass algorithm | ffmpeg-kit is retired. Large binary and GPL/LGPL licensing questions |

### Subject (removed)

A "Stabilize the subject" mode tracked a box around a tapped point with
`VNTrackObjectRequest` and held that point where it was in the first frame.
It was removed; only the background is stabilized.

### Rolling shutter (removed)

A switch corrected rolling-shutter shear and stretch from shift, with the
sensor's readout time measured from how differently the top and bottom 40% of
each frame moved as the camera changed speed. It roughly doubled analysis
time and was removed.

### Smoothing (removed)

A Gaussian-smoothed "follow the camera" path (σ 0.2 s–8 s on a slider) was
removed: the background now locks to the first frame.

## Known limitations

- iOS only. Android has no native module, and the menu item is hidden there.
- Only shift is corrected; camera roll and zoom wobble stay in the output.
- HDR (HLG/Dolby Vision) clips are read as 8-bit BGRA and written SDR.
- Frame rate is capped at 60 fps, so slow-motion clips lose frames.
- The export is capped at 1920 px on the long side. A deep crop is upscaled,
  and the screen shows how many source pixels the output comes from.
- Work stops if the app is backgrounded: the screen is kept awake, but there
  is no background task.
