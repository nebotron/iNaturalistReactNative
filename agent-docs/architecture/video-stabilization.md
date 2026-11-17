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
| Math | `src/sharedHelpers/videoStabilization.ts` | Robust fit of the lock path to the tile shifts, crop/zoom planning; unit tested |
| Bridge | `src/sharedHelpers/videoStabilizerNative.ts` | Typed wrapper, progress events, the comparison player view |
| Native | `ios/iNaturalistReactNative/VideoStabilizer.m` | Picking, frame reading, tile phase correlation (Accelerate FFT), Core Image warping, AVAssetWriter, saving, player |

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
(lower) video of the comparison mark opposite corners of the crop
(`PinchCrop`). The window is centered between them and keeps the frame's
aspect, spanning the larger of the fingers' horizontal and vertical spread,
with a dashed outline of the window that will fill the frame.
One finger scrolls the page: the overlay reads raw touches rather than taking
the responder, and the page stops scrolling only while two fingers are down.
When a preview finishes, the store keeps its `previewCrop`: the corners of
the window it shows, on the start frame, and the zoom it was rendered at
(after "hide black edges"). The window's center is mapped through those
corners to a new crop center on the start frame, and the new zoom is the
preview's zoom divided by the window's share of the width, so each drag
zooms relative to what's on screen. Pinches are ignored while the preview is
stale. Reset Zoom returns to 1× centered. There is no still of the start
frame on the screen; the crop is only picked on the preview.

**Stabilize the background.** Each frame is read as grayscale at 960 px on
its long side and cut into a 4×4 grid of tiles. Every tile is registered by
phase correlation (Hann window, normalized cross-power spectrum, a 5×5
centroid around the peak for the fraction), with vDSP's DFT over the middle of
the tile at the longest length it takes (f·2^k, f ∈ {1, 3, 5, 15}, so a
240×132 tile correlates 240×128). The phase-correlation shift is then refined
by up to 10 Gauss-Newton (Lucas-Kanade) steps on the pixels of that window:
phase correlation whitens the spectrum, and the spectrum of a motion-blurred
frame changes sign, so on the blurred frames of a fast pan its peak splits
and misses by pixels. Each tile is measured twice: onto the same
tile of the previous frame (`ts`), moved first by the last step, and onto the
first frame (`tr`), moved first by the running estimate of the frame's shift
onto it. Tiles with no texture (Laplacian standard deviation under 1 gray
level), with no structure once averaged over 4×4 pixels (under 2: sensor
and compression noise alone gives an out-of-focus background a Laplacian
deviation of 2–3, and such a tile reports no motion or lags the camera), or
that the move pushes more than 5% out of the frame report null. The
running estimate, chained medians corrected by the median reading, only
places the tiles; it's also sent as `m`/`r`.

JS (`fittedTilePath`) then fits the whole path to every tile at once:
iteratively reweighted least squares, where each tile's step says how far the
path moved since the previous frame and each reading (weighted 0.1) says where
it is. Tukey weights, 48 px wide on the first pass and narrowing to 3 px (in
960-px terms), drop the tiles that disagree with the path: tiles on a moving
subject, on something at another depth, or simply mismeasured. A tile's
disagreement is averaged over the frames around it (Gaussian, σ 4 frames)
before it's weighted, so the fit can't follow the bird in one frame and the
perch in the next when they move differently; that switching showed as the
picture vibrating while the camera moved. A small weight from each frame's
own residuals keeps a frame whose tiles all disagree with their neighbours
solvable. The steps
carry the frame-to-frame detail and the readings stop the drift. The normal
equations are tridiagonal, so each pass is O(n). A frame with no tile
measured falls back to its own step. Pans and walks show black edges by
design.

**Metadata.** The render copies QuickTime metadata and user data as is and
maps other formats' common keys (creation date, ISO 6709 location, make,
model, software) to QuickTime keys. Saving goes through the native
`saveToPhotos`, which sets the Photos asset's creation date (moved on by the
start time) and location from the original, rather than leaving Photos to
date it when it was saved.

### Measuring the approaches

`stabilization-eval/` on the `claude/stoic-curie-sovvo9` branch holds the
comparison that picked this method: a macOS tool that runs the analysis with
the app's own code on test clips, and a Python harness that scores each
approach with dense optical flow on the stabilized frames (hold against the
first frame, frame-to-frame shake, and drift over a second) and renders them
side by side. On its three clips the Vision whole-frame method left 44–85 px
of hold error and 10–24 px of drift a second; tiles with the robust fit left
2–4 px on the two with textured backgrounds and about 20 px on one dominated
by a large bird against a featureless wall.

## Approaches considered

### Background (camera shake)

| Approach | Pros | Cons |
| --- | --- | --- |
| **Phase correlation of 16 tiles, robust fit over all of them** *(implemented)* | Sub-pixel. Tiles on a moving subject or at another depth drop out of the fit. Accelerate only, no dependency | Can't remove roll or zoom wobble. A subject that fills most of the frame can still pull the fit |
| Vision translational registration of the whole frame *(replaced)* | Built in | Reports whole pixels at 480 px, so chained steps drift. The frame was one registration, so a big subject or two depths made it jump between matches. Registering the warped frame against the first frame matched the black border and reset the lock on the first frames |
| Vision registration of the same 16 tiles, same fit | As good as the FFT tiles on the test clips | Whole-pixel per tile; 32 Vision requests a frame |
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

### Sharp-frame fusion (removed)

A "Sharpen blurred frames" switch drew each pixel of the still parts of a
frame from the sharpest stabilized frames within 3 of it, weighted by local
sharpness and by whether their low-passed picture agreed with the frame's.
It halved the shimmer that motion blur leaves on a held background, but the
agreement test let a moving subject through and the ghosting was bad, so it
was removed.

### Smoothing (removed)

A Gaussian-smoothed "follow the camera" path (σ 0.2 s–8 s on a slider) was
removed: the background now locks to the first frame.

## Known limitations

- iOS only. Android has no native module, and the menu item is hidden there.
- Only shift is corrected; camera roll and zoom wobble stay in the output.
  (Vision's homographic registration was too noisy to correct roll: it
  added up 14–17° of roll that the test clips didn't have.)
- A subject that covers most of the frame against a featureless background
  leaves few background tiles, and the fit can follow the subject.
- HDR (HLG/Dolby Vision) clips are read as 8-bit BGRA and written SDR.
- Frame rate is capped at 60 fps, so slow-motion clips lose frames.
- The export is capped at 1920 px on the long side. A deep crop is upscaled,
  and the screen shows how many source pixels the output comes from.
- Work stops if the app is backgrounded: the screen is kept awake, but there
  is no background task.
