"""Correction tests: inject a known aberration, check it is recovered."""

import os
import sys

import numpy as np
import pytest
from scipy.ndimage import gaussian_filter, map_coordinates

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from craw.cr3 import Curve
from craw.lenscorr import (CaProfile, apply_ca, corner_radius, measure_ca,
                           radial_grid, vignetting_gain)

SIZE = (600, 900)
CENTRE = (449.5, 299.5)


def textured_image(seed: int = 7) -> np.ndarray:
    rng = np.random.default_rng(seed)
    base = gaussian_filter(rng.random(SIZE).astype(np.float32), 1.2)
    base = (base - base.min()) / (base.max() - base.min())
    return np.repeat(base[..., None], 3, axis=2)


def scale_channel(img: np.ndarray, idx: int, b1: float) -> np.ndarray:
    """Move a channel outward by b1 * rn * corner_radius."""
    out = img.copy()
    r, uy, ux = radial_grid(SIZE, CENTRE)
    rmax = corner_radius(SIZE, CENTRE)
    src = r - b1 * (r / rmax) * rmax
    out[..., idx] = map_coordinates(img[..., idx],
                                    [CENTRE[1] + uy * src, CENTRE[0] + ux * src],
                                    order=3, mode="nearest")
    return out


def test_corner_radius_and_grid():
    r, uy, ux = radial_grid(SIZE, CENTRE)
    assert r[300, 450] == pytest.approx(0.0, abs=1.0)
    assert corner_radius(SIZE, CENTRE) == pytest.approx(np.hypot(449.5, 299.5))
    assert np.allclose(np.hypot(uy, ux)[10:-10, 10:-10], 1.0, atol=1e-3)


@pytest.mark.parametrize("injected", [0.0008, -0.0008])
def test_measure_recovers_injected_ca(injected):
    img = scale_channel(textured_image(), 0, injected)
    profile, info = measure_ca(img, CENTRE, bins=8, iterations=3)
    recovered = profile.red[0] + profile.red[1]
    assert recovered == pytest.approx(injected, rel=0.25)
    # the untouched blue channel must not pick up a correction
    assert abs(profile.blue[0] + profile.blue[1]) < abs(injected) / 4


def test_apply_ca_removes_injected_ca():
    img = textured_image()
    injected = 0.0008
    aberrated = scale_channel(img, 0, injected)
    profile, _ = measure_ca(aberrated, CENTRE, bins=8, iterations=3)
    fixed = apply_ca(aberrated, CENTRE, profile)
    r, _, _ = radial_grid(SIZE, CENTRE)
    edge = r > 0.6 * corner_radius(SIZE, CENTRE)
    before = np.abs(aberrated[..., 0] - aberrated[..., 1])[edge].mean()
    after = np.abs(fixed[..., 0] - fixed[..., 1])[edge].mean()
    assert after < before / 2


def test_ca_profile_roundtrip():
    p = CaProfile(red=(1e-4, -2e-5), blue=(0.0, 0.0), lens="RF50", focal_length=50)
    assert CaProfile.from_dict(p.as_dict()) == p
    assert p.key() == "RF50@50mm"
    dr, _ = p.displacement_at_corner(1000.0)
    assert dr == pytest.approx(0.08)


def test_vignetting_gain():
    curve = Curve("falloff", 0, [1.0, 0.9, 0.75], [0.0, 0.5, 1.0])
    hdiag = corner_radius(SIZE, CENTRE)
    gain = vignetting_gain(SIZE, CENTRE, curve, hdiag)
    assert gain[300, 450] == pytest.approx(1.0, abs=0.02)     # centre untouched
    assert gain[0, 0] == pytest.approx(1 / 0.75, rel=0.02)    # corner lifted
    assert gain.min() >= 1.0 - 1e-6
    half = vignetting_gain(SIZE, CENTRE, curve, hdiag, strength=0.5)
    assert half[0, 0] == pytest.approx(1 + (gain[0, 0] - 1) / 2, rel=1e-3)
