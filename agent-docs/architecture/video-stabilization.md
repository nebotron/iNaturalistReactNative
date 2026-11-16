# Video stabilization

Menu → **Video Stabilizer** (iOS only). Import a video from Photos, hold its
background steady (smoothed, or completely still), optionally correct rolling
shutter, and crop in closer. The copy keeps the original's sound and metadata.

## How it is split

| Layer | File | Job |
| --- | --- | --- |
| Screen | `src/components/VideoStabilizer/` | Import, start time, method, still lock, smoothing, rolling shutter, crop, inline preview, export/save |
| Session state | `src/stores/videoStabilizer.ts` | Zustand, not persisted, so a tab switch doesn't drop a finished analysis |
| Math | `src/sharedHelpers/videoStabilization.ts` | Camera path, smoothing, rolling shutter, crop/zoom planning; unit tested |
| Bridge | `src/sharedHelpers/videoStabilizerNative.ts` | Typed wrapper, progress events, the inline player view |
| Native | `ios/iNaturalistReactNative/VideoStabilizer.m` | Picking, frame reading, Vision registration, Core Image warping, AVAssetWriter, saving, player |

The native module runs two passes over the same upright, constant-frame-rate
`AVAssetReaderVideoCompositionOutput`. Frame *i* of the analysis is therefore
frame *i* of the render.

1. **Analyze**: the native pass measures per-frame motion. It's slow, so it
   runs once per video, method, start time and still lock.
2. **Plan**: JS turns the measurements into one homography per frame. This is
   instant, so smoothing, rolling shutter, zoom, crop position and "hide
   edges" can change without re-reading the video.
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
preview, which plays inline below the settings (`VideoStabilizerPlayer`, a
looping `AVPlayerViewController`). Native analyses and renders are numbered;
starting one cancels the one before, and progress events carry the JS job
number so a superseded job's progress is ignored. Only the export is started
by hand. A render deletes the previous file of its kind only once it has
finished, so the player never loses the file it's playing.

### The model

For each frame the measured path `P_i` maps the frame into a stable space,
the camera motion accumulated back to the first frame. The virtual camera
`S_i` is `P` smoothed with a Gaussian (σ 0.2 s–8 s), or the identity when the
background is held completely still. A pixel is drawn at
`S_i⁻¹ · P_i · (R_i · x − center)`, then cropped by the zoom and crop center.
"Hide black edges" (off by default) binary-searches the smallest zoom at which
every frame's crop window stays inside its source frame.

**Completely still.** Chaining frame-to-frame registrations drifts, and a
similarity can't hold a background seen in changing perspective. With the
lock on, the analysis also warps each frame onto the first by the chained
estimate and registers what's left against the first frame itself, so `P_i`
is a drift-free full homography (`r` per frame). Pans and walks show black
edges by design.

**Rolling shutter** (`R_i`). Rows are read top to bottom over a readout time
`r` (a fraction of the frame interval, the slider). With the picture moving
at `v` px/frame (from the registration steps either side of the frame), a row
`y` is captured `r·(y − H/2)/H` frames after the middle row, so
`R_i` = shift each row back by `v` times that: a shear for sideways motion and
a stretch for vertical motion. Rotation wobble isn't modeled.

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
| **Vision translational registration** *(implemented: "Shift only")* | Built in, fast at 480 px, very robust on low-texture scenes such as water or sky | Can't remove roll or zoom wobble. A large moving subject drags the estimate |
| **Vision homographic registration → similarity** *(implemented: "Shift, rotation and zoom", default)* | Removes roll and breathing as well as shift. Perspective is discarded to avoid jello | Slightly slower. Same subject bias. Rolling-shutter skew is corrected separately |
| Feature tracking + RANSAC (OpenCV `videostab`-style, or Vision optical flow with outlier rejection) | Rejects a moving subject as outliers, so it handles an animal walking through the frame best. Can mask out the subject box | Needs OpenCV (~10 MB+) or a hand-written robust estimator. Most code to maintain |
| Dense optical flow (`VNGenerateOpticalFlowRequest`) with a median over the background | Robust and separates subject from background naturally | Slow at useful resolutions. More conventions to verify |
| Gyroscope metadata | Exact, and immune to subject motion | Imported iPhone videos don't carry it (GoPro and some action cams do) |
| `AVCaptureConnection` stabilization | Best quality, done in hardware | Only at capture time, so it can't fix an imported clip |
| ffmpeg `vidstab` | Mature two-pass algorithm | ffmpeg-kit is retired. Large binary and GPL/LGPL licensing questions |

### Smoothing

| Approach | Pros | Cons |
| --- | --- | --- |
| **Gaussian on path parameters** *(implemented)* | Simple and predictable. One slider runs from "light" to "nearly a tripod"; a full lock is a separate switch | Doesn't know about crop limits, so a strong smooth can demand a deep zoom |
| L1-optimal camera paths (Grundmann et al.) | Produces "tripod, then constant pan" paths that look professionally shot, and respects the crop window | Needs a linear-program solver |
| Kalman filter | Causal, so it suits live preview | Lags on purpose, and is worse than a two-sided filter offline |

## Known limitations

- iOS only. Android has no native module, and the menu item is hidden there.
- HDR (HLG/Dolby Vision) clips are read as 8-bit BGRA and written SDR.
- Frame rate is capped at 60 fps, so slow-motion clips lose frames.
- Rolling-shutter correction models shear and stretch from shift only, with a
  readout the user sets; rotation wobble isn't corrected.
- The export is capped at 1920 px on the long side. A deep crop is upscaled,
  and the screen shows how many source pixels the output comes from.
- Work stops if the app is backgrounded: the screen is kept awake, but there
  is no background task.
