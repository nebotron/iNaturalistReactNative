"""Lens corrections driven by CR3 metadata.

Three corrections, in the order a raw converter would apply them:

  lateral chromatic aberration
      Measured from the image itself: the red and blue channels are compared
      against green and the radial displacement between them is fitted as
      d(r) = b1*rn + b3*rn**3.  Metadata supplies the frame's optical centre
      (which is not the image centre when an in-camera crop is active) and the
      lens identity used to cache the fitted profile.

  peripheral illumination (vignetting)
      Taken straight from the falloff curve the camera recorded for this
      exposure in the lens correction packet.

  distortion
      Optional and off by default: the packet's geometry curves are not
      documented, so the caller has to name the curve to apply.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
from scipy.ndimage import map_coordinates, sobel, uniform_filter

from .cr3 import Curve


# --------------------------------------------------------------------------
# geometry helpers
# --------------------------------------------------------------------------
def radial_grid(shape: Tuple[int, int], centre: Tuple[float, float]):
    """Return (r, unit_y, unit_x) for every pixel, r in pixels."""
    h, w = shape
    cx, cy = centre
    y = np.arange(h, dtype=np.float32)[:, None] - cy
    x = np.arange(w, dtype=np.float32)[None, :] - cx
    r = np.hypot(y, x)
    safe = np.maximum(r, 1e-6)
    return r, y / safe, x / safe


def corner_radius(shape: Tuple[int, int], centre: Tuple[float, float]) -> float:
    h, w = shape
    cx, cy = centre
    return float(max(np.hypot(dy, dx)
                     for dy in (cy, h - 1 - cy) for dx in (cx, w - 1 - cx)))


# --------------------------------------------------------------------------
# lateral chromatic aberration
# --------------------------------------------------------------------------
@dataclass
class CaProfile:
    """Radial displacement of a channel relative to green, in pixels.

    d(r) / corner_radius = b1 * rn + b3 * rn**3, with rn = r / corner_radius.
    Coefficients are dimensionless, so a profile measured on a downsampled
    image applies unchanged at full resolution.
    """
    red: Tuple[float, float] = (0.0, 0.0)
    blue: Tuple[float, float] = (0.0, 0.0)
    lens: str = ""
    focal_length: Optional[float] = None

    def as_dict(self) -> Dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Dict) -> "CaProfile":
        return cls(red=tuple(d["red"]), blue=tuple(d["blue"]),
                   lens=d.get("lens", ""), focal_length=d.get("focal_length"))

    def key(self) -> str:
        fl = f"{self.focal_length:g}" if self.focal_length else "?"
        return f"{self.lens}@{fl}mm"

    def displacement_at_corner(self, corner_radius: float) -> Tuple[float, float]:
        """Radial displacement of R and B at the frame corner, in pixels."""
        return ((self.red[0] + self.red[1]) * corner_radius,
                (self.blue[0] + self.blue[1]) * corner_radius)


def _local_contrast(channel: np.ndarray, window: int = 25) -> np.ndarray:
    """Normalise out colour differences, keeping edge structure."""
    mean = uniform_filter(channel, window)
    dev = channel - mean
    return dev / (uniform_filter(np.abs(dev), window) + 1e-3)


def measure_ca_displacement(img: np.ndarray, centre: Tuple[float, float],
                            bins: int = 10) -> Dict[str, List[Tuple[float, float, float]]]:
    """Per-annulus radial displacement of R and B against G.

    Returns {"R": [(r_px, d_px, weight)], "B": [...]}.  The estimate is the
    least-squares solution of  X - G = -d * dG/dr  over the strongest edges in
    each annulus.
    """
    r, uy, ux = radial_grid(img.shape[:2], centre)
    rmax = corner_radius(img.shape[:2], centre)
    green = _local_contrast(img[..., 1])
    # scipy's sobel is 8x the underlying derivative
    grad = (sobel(green, axis=0) * uy + sobel(green, axis=1) * ux) / 8.0
    weight = grad ** 2
    strong = weight > np.percentile(weight, 90)

    edges = np.linspace(0.0, rmax, bins + 1)
    out: Dict[str, List[Tuple[float, float, float]]] = {}
    for idx, name in ((0, "R"), (2, "B")):
        diff = _local_contrast(img[..., idx]) - green
        rows = []
        for i in range(bins):
            m = strong & (r >= edges[i]) & (r < edges[i + 1])
            den = float(weight[m].sum())
            num = float((grad[m] * diff[m]).sum())
            d = -num / den if den > 0 else 0.0
            rows.append((float(0.5 * (edges[i] + edges[i + 1])), d, den))
        out[name] = rows
    return out


def _fit_displacement(rows: Sequence[Tuple[float, float, float]],
                      rmax: float) -> Tuple[float, float]:
    """Fit d = c + b1*rn + b3*rn^3 and return (b1, b3).

    The constant term absorbs a whole-channel offset (sensor decentring, or
    residual bias in the estimator); only the radius-dependent part is a
    chromatic aberration and only that part is returned.
    """
    rn = np.array([r / rmax for r, _, _ in rows])
    d = np.array([v for _, v, _ in rows])
    w = np.sqrt(np.array([max(x, 0.0) for _, _, x in rows]))
    A = np.stack([np.ones_like(rn), rn, rn ** 3], axis=1) * w[:, None]
    coef, *_ = np.linalg.lstsq(A, (d / rmax) * w, rcond=None)
    return float(coef[1]), float(coef[2])


def apply_ca(img: np.ndarray, centre: Tuple[float, float],
             profile: CaProfile, order: int = 3) -> np.ndarray:
    """Resample R and B radially so they line up with G."""
    out = img.copy()
    h, w = img.shape[:2]
    r, uy, ux = radial_grid((h, w), centre)
    rmax = corner_radius((h, w), centre)
    rn = r / rmax
    for idx, coef in ((0, profile.red), (2, profile.blue)):
        b1, b3 = coef
        if b1 == 0.0 and b3 == 0.0:
            continue
        shift = (b1 * rn + b3 * rn ** 3) * rmax   # where the channel actually sits
        src_r = r + shift
        ys = centre[1] + uy * src_r
        xs = centre[0] + ux * src_r
        out[..., idx] = map_coordinates(img[..., idx], [ys, xs],
                                        order=order, mode="nearest")
    return out


def measure_ca(img: np.ndarray, centre: Tuple[float, float], bins: int = 10,
               iterations: int = 3, lens: str = "",
               focal_length: Optional[float] = None) -> Tuple[CaProfile, Dict]:
    """Measure CA, refining iteratively so displacements beyond the gradient
    estimator's linear range still converge."""
    rmax = corner_radius(img.shape[:2], centre)
    profile = CaProfile(lens=lens, focal_length=focal_length)
    work = img
    history = []
    for _ in range(max(1, iterations)):
        rows = measure_ca_displacement(work, centre, bins=bins)
        dr = _fit_displacement(rows["R"], rmax)
        db = _fit_displacement(rows["B"], rmax)
        history.append({"red": dr, "blue": db, "rows": rows})
        profile = CaProfile(red=(profile.red[0] + dr[0], profile.red[1] + dr[1]),
                            blue=(profile.blue[0] + db[0], profile.blue[1] + db[1]),
                            lens=lens, focal_length=focal_length)
        work = apply_ca(img, centre, profile, order=1)
    return profile, {"corner_radius": rmax, "iterations": history}


# --------------------------------------------------------------------------
# peripheral illumination
# --------------------------------------------------------------------------
def vignetting_gain(shape: Tuple[int, int], centre: Tuple[float, float],
                    curve: Curve, corner_radius_px: float,
                    strength: float = 1.0) -> np.ndarray:
    """Gain map that undoes the falloff the camera recorded for this shot.

    Curve radii are normalised so 1.0 is the outermost knot, taken to be the
    frame corner (see Curve); values are transmission with 1.0 at the centre.
    Beyond the last knot the curve is held flat rather than extrapolated.
    """
    r, _, _ = radial_grid(shape, centre)
    rn = r / corner_radius_px
    knots = np.array(curve.radii, dtype=np.float64)
    vals = np.array(curve.values, dtype=np.float64)
    transmission = np.interp(rn, knots, vals, left=vals[0], right=vals[-1])
    gain = (vals[0] / np.maximum(transmission, 1e-3)).astype(np.float32)
    if strength != 1.0:
        gain = 1.0 + (gain - 1.0) * float(strength)
    return gain


# --------------------------------------------------------------------------
# geometric distortion (curve semantics unverified - opt in)
# --------------------------------------------------------------------------
def apply_geometry_curve(img: np.ndarray, centre: Tuple[float, float],
                         curve: Curve, corner_radius_px: float,
                         order: int = 3) -> np.ndarray:
    """Resample all channels with a packet geometry curve read as a radial
    magnification (16384 == 1.0)."""
    h, w = img.shape[:2]
    r, uy, ux = radial_grid((h, w), centre)
    rn = r / corner_radius_px
    knots = np.array(curve.radii, dtype=np.float64)
    vals = np.array(curve.values, dtype=np.float64)
    scale = np.interp(rn, knots, vals, left=vals[0], right=vals[-1])
    src_r = r / np.maximum(scale, 1e-3)
    ys = centre[1] + uy * src_r
    xs = centre[0] + ux * src_r
    out = np.empty_like(img)
    for c in range(img.shape[2]):
        out[..., c] = map_coordinates(img[..., c], [ys, xs], order=order,
                                      mode="nearest")
    return out
