# Video stabilization

Menu → **Video Stabilizer** (iOS only). Import a video from Photos or Files,
hold either the **background** or a **subject** steady, and crop in closer.

## How it is split

| Layer | File | Job |
| --- | --- | --- |
| Screen | `src/components/VideoStabilizer/` | Import, start time, mode/method, subject box, smoothing, crop, preview/export/save |
| Session state | `src/stores/videoStabilizer.ts` | Zustand, not persisted, so a tab switch doesn't drop a finished analysis |
| Math | `src/sharedHelpers/videoStabilization.ts` | Camera path, smoothing, crop/zoom planning; unit tested |
| Bridge | `src/sharedHelpers/videoStabilizerNative.ts` | Typed wrapper and progress events |
| Native | `ios/iNaturalistReactNative/VideoStabilizer.m` | Picking, frame reading, Vision measurement, Core Image warping, AVAssetWriter |

The native module runs two passes over the same upright, constant-frame-rate
`AVAssetReaderVideoCompositionOutput`. Frame *i* of the analysis is therefore
frame *i* of the render.

1. **Analyze**: the native pass measures per-frame motion (background) or the
   subject's box (subject). It's slow, so it runs once per video, method and
   start time.
2. **Plan**: JS turns the measurements into one affine transform per frame.
   This is instant, so smoothing, zoom, crop position and "hide edges" can
   change without re-reading the video.
3. **Render**: the native pass warps each frame by its transform, crops it,
   and writes H.264 with the audio passed through. A low-resolution preview
   (640 px) and the export (1920 px long side) are rendered separately.

### The model

For each frame the measured path `P_i` maps the frame into a stable space.
For the background, that space is the camera motion accumulated back to the
first frame. For a subject, it puts the subject at the origin, optionally
rescaled to its first-frame size. The virtual camera `S_i` is `P` smoothed
with a Gaussian (σ 0.2 s–8 s), or the identity when locked. A pixel is drawn
at `S_i⁻¹ · P_i · (x − center)`, then cropped by the zoom and crop center.
"Hide black edges" binary-searches the smallest zoom at which every frame's
crop window stays inside its source frame.

### Unverified conventions

Vision's registration transforms are documented loosely: which image they map
onto which, and whether y points up. The analysis doesn't hard-code a guess.
On up to 9 frame pairs that moved, it applies each of the four readings
(as-is, inverse, y-flipped, both) and keeps the one that best lines the frame
up with the previous one. The winner is logged
(`analyzed … registration read <reading>`). Once a device log shows a
consistent winner, the vote can be replaced by that constant.

## Approaches considered

### Background (camera shake)

| Approach | Pros | Cons |
| --- | --- | --- |
| **Vision translational registration** *(implemented: "Shift only")* | Built in, fast at 480 px, very robust on low-texture scenes such as water or sky | Can't remove roll or zoom wobble. A large moving subject drags the estimate |
| **Vision homographic registration → similarity** *(implemented: "Shift, rotation and zoom", default)* | Removes roll and breathing as well as shift. Perspective is discarded to avoid jello | Slightly slower. Same subject bias. Can't fix rolling-shutter skew |
| Feature tracking + RANSAC (OpenCV `videostab`-style, or Vision optical flow with outlier rejection) | Rejects a moving subject as outliers, so it handles an animal walking through the frame best. Can mask out the subject box | Needs OpenCV (~10 MB+) or a hand-written robust estimator. Most code to maintain |
| Dense optical flow (`VNGenerateOpticalFlowRequest`) with a median over the background | Robust and separates subject from background naturally | Slow at useful resolutions. More conventions to verify |
| Gyroscope metadata | Exact, and immune to subject motion | Imported iPhone videos don't carry it (GoPro and some action cams do) |
| `AVCaptureConnection` stabilization | Best quality, done in hardware | Only at capture time, so it can't fix an imported clip |
| ffmpeg `vidstab` | Mature two-pass algorithm | ffmpeg-kit is retired. Large binary and GPL/LGPL licensing questions |

### Subject (keep the animal still)

| Approach | Pros | Cons |
| --- | --- | --- |
| **Vision object tracker from a user-drawn box** *(implemented: "Track the box I draw")* | Follows exactly what the user means, including through turns and shape changes | Drifts or loses the subject through occlusion. Box jitter needs smoothing (done in JS). Lost frames are interpolated |
| **Objectness saliency, continued by overlap** *(implemented: "Find the subject automatically")* | No box needed. Re-finds the subject after it's lost | Can jump to another prominent object. Boxes are coarser than the tracker's |
| On-device detector (the YOLOv8n model the app already ships) | Finds animals specifically, and recovers after occlusion | Class-limited, ~30 ms a frame, and box jitter. Best as a tracker re-seed |
| Person/animal segmentation masks (Vision) | Precise centroid, and could also mask the subject out of background registration | Animal segmentation needs iOS 17. Slow at every frame |
| Hybrid: lock the background, then crop to the subject | No warping artifacts on the subject | It's two analyses. The subject still drifts within the frame |

### Smoothing

| Approach | Pros | Cons |
| --- | --- | --- |
| **Gaussian on path parameters** *(implemented)* | Simple and predictable. One slider runs from "light" to "locked" | Doesn't know about crop limits, so a strong smooth can demand a deep zoom |
| L1-optimal camera paths (Grundmann et al.) | Produces "tripod, then constant pan" paths that look professionally shot, and respects the crop window | Needs a linear-program solver |
| Kalman filter | Causal, so it suits live preview | Lags on purpose, and is worse than a two-sided filter offline |

## Known limitations

- iOS only. Android has no native module, and the menu item is hidden there.
- HDR (HLG/Dolby Vision) clips are read as 8-bit BGRA and written SDR.
- Frame rate is capped at 60 fps, so slow-motion clips lose frames.
- Rolling-shutter wobble isn't corrected.
- The export is capped at 1920 px on the long side. A deep crop is upscaled,
  and the screen shows how many source pixels the output comes from.
- Work stops if the app is backgrounded: the screen is kept awake, but there
  is no background task.
