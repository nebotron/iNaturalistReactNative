# craw — Canon C-RAW metadata and lens corrections

Reads the metadata in a Canon compressed-raw file (`.CR3`, C-RAW or full RAW —
same container) and uses it to correct the image: lateral chromatic aberration,
peripheral illumination, and optionally a geometry curve.

This is a standalone Python tool. It is not wired into the React Native app,
which captures JPEG through `react-native-vision-camera` and has no raw path.

## Install

```bash
cd tools/craw
pip install -r requirements.txt     # numpy, scipy, rawpy (LibRaw), Pillow
```

LibRaw 0.21+ is needed for CR3; `rawpy` wheels ship with it.

## Use

```bash
python -m craw meta    IMG_1234.CR3
python -m craw measure IMG_1234.CR3 -v --save-profile lenses.json
python -m craw correct IMG_1234.CR3 -o out.jpg --profile lenses.json
```

`correct` writes 16-bit when the output name ends in `.ppm`, 8-bit sRGB for
`.jpg`/`.png`/`.tif`. Useful flags: `--no-ca`, `--no-vignetting`,
`--vignetting-strength 0.5`, `--linear`, `--downsample 1` (slower, more exact
CA measurement), `--distortion-curve N`.

`meta` prints camera, lens, exposure, sensor and crop geometry, the optical
centre, the in-camera correction switches, and every curve found in the lens
correction packet:

```
lens            EF24-105mm f/4L IS II USM
exposure        42.0 mm  f/16.0  ISO 200
sensor          6188x4120  active 6000x4000 at (168,108)
optical centre  (3000.0, 2000.0)
in-camera corrections:
  peripheral_lighting              On
  chromatic_aberration             On
  distortion                       Off
lens correction packet: version 0, 1500 bytes, 7 curves
  [0] falloff   @0x008a  15 pts  1.0000 -> 0.7180  r 0 -> 1.000
  [1] gain      @0x0256  15 pts  1.0000 -> 1.0002  r 0 -> 1.000
  ...
```

## Where the metadata lives

CR3 is an ISO-BMFF container:

- `moov/uuid(85c0b687-…)/CMT1..CMT4` — four TIFF blocks: IFD0, Exif IFD, Canon
  MakerNote, GPS. Lens model, focal length, aperture, sensor borders, crop
  geometry and the correction switches (`0x4016`, `0x4018`) come from here.
- the **CTMD** track in `mdat` — per-exposure records. Record 9 wraps a small
  TIFF whose MakerNote holds tag `0x4015`, the correction packet the camera
  read out of the lens for that frame. This is where the curves are.

Binary-block field offsets follow ExifTool's `Canon.pm`; `meta` output was
checked field by field against `exiftool` on the sample files.

## What is decoded vs. what is inferred

**Decoded** (verified against ExifTool): camera, lens, focal length, aperture,
ISO, sensor size and active area, in-camera crop, the four correction switches,
and the packet's version/length header.

**Inferred** (Canon does not document the packet body, and its field offsets
move between bodies — an R6 packet and an R8 packet differ by 4 bytes): the
curves themselves. They are found by shape, not by fixed offset:

- a **falloff** curve starts at 8191 (= 1.0) and decays — peripheral
  illumination,
- a **gain** curve starts at 16384 (= 1.0) and stays near it — geometry,
- a **knot table** is a rising radius list; 4095 is taken to be the frame's
  half-diagonal.

The falloff reading is supported by the samples: a 24-105 at f/16 records a
28% corner falloff, a 70-200 at f/25 records 6.3% — the right order and the
right direction for those two exposures.

The gain curves are **not** identified. Each file has several (0.5%, 1%, 3%
peak) and nothing in the file labels them, so `correct` never applies one on
its own; `--distortion-curve N` applies one by index if you want to experiment.

None of the gain curves is lateral CA: measured CA in the samples is 0.4–0.9 px
at the corner (≈0.02%), two orders of magnitude below the smallest curve.

## How the CA correction works

Metadata gives the frame geometry — in particular the optical centre, which is
*not* the image centre when an in-camera aspect or APS-C crop is active, and
which sits a few pixels off LibRaw's output centre because Canon's active area
and LibRaw's margins differ.

The displacement itself is measured from the image: red and blue are compared
against green over the strongest edges in each annulus, solving
`X - G = -d · dG/dr`, and `d(r)/rmax = b1·rn + b3·rn³` is fitted. A constant
term absorbs whole-channel offsets so only the radius-dependent part — the
aberration — is corrected. The fit is iterated three times, since the gradient
estimator underestimates displacements beyond a pixel. Coefficients are
dimensionless, so a profile measured on a downsampled image applies at full
resolution, and profiles cache per lens and focal length in a JSON file.

## Validation

On `Canon EOS R8` + `EF24-105mm f/4L IS II USM`, 42 mm f/16 (raw.pixls.us),
measured with an independent estimator (scanning radial scale for peak
normalised cross-correlation against green, over the 0.75–0.98 r annulus):

| channel | before | after |
| --- | --- | --- |
| red | +0.431 px | +0.039 px |
| blue | +0.157 px | −0.157 px |

Red drops by 91%. Blue is overcorrected by about 0.15 px — the gradient fit and
the correlation scan disagree at that level, which is the accuracy floor here.

`tests/test_lenscorr.py` injects a known radial scale into a synthetic image and
checks it is recovered within 25% and that edge fringing at least halves;
`tests/test_cr3.py` builds a synthetic CR3 and parses it back.

```bash
python -m pytest tests -q                       # no sample file needed
CRAW_SAMPLE=/path/to/IMG.CR3 python -m pytest tests -q   # also parse a real one
```

## Limitations

- Corrections are applied after demosaic. Doing CA before demosaic would be
  slightly cleaner.
- The CA fit is global and radial: it does not model decentring or tangential
  components, and it needs a frame with edges away from the centre.
- Only the first CTMD sample is read; that is the still frame.
- Vignetting uses the packet curve as recorded — it is not aperture-interpolated
  by this tool, since the camera already recorded the curve for this exposure.
