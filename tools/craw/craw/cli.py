"""Command line interface: craw meta | measure | correct."""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Dict, Optional

import numpy as np

from .cr3 import Cr3
from .lenscorr import (CaProfile, apply_ca, apply_geometry_curve, corner_radius,
                       measure_ca, vignetting_gain)
from .rawio import decode, downsample, half_diagonal, optical_centre, write_image


# --------------------------------------------------------------------------
def _describe(cr3: Cr3) -> str:
    g, s = cr3.geometry, cr3.settings
    lines = [
        f"file            {os.path.basename(cr3.path)}",
        f"camera          {cr3.camera}",
        f"lens            {cr3.lens}",
        f"exposure        {cr3.focal_length or '?'} mm  f/{cr3.f_number or '?'}"
        f"  ISO {cr3.iso or '?'}",
        f"sensor          {g.sensor_width}x{g.sensor_height}"
        f"  active {g.active_width}x{g.active_height}"
        f" at ({g.active_left},{g.active_top})",
        f"image           {g.crop_width}x{g.crop_height}"
        f" at ({g.crop_left},{g.crop_top})",
        f"optical centre  {g.optical_centre}",
        "in-camera corrections:",
    ]
    for name, value in s.describe().items():
        lines.append(f"  {name:32s} {value}")
    if cr3.packet is None:
        lines.append("lens correction packet: not present")
        return "\n".join(lines)
    lines.append(f"lens correction packet: version {cr3.packet.version}, "
                 f"{cr3.packet.size} bytes, {len(cr3.packet.curves)} curves")
    for i, c in enumerate(cr3.packet.curves):
        span = f"{c.values[0]:.4f} -> {c.values[-1]:.4f}"
        rad = f"r 0 -> {c.radii[-1]:.3f}" if c.radii else "no knots"
        lines.append(f"  [{i}] {c.kind:9s} @0x{c.offset:04x}  "
                     f"{len(c.values):2d} pts  {span}  {rad}")
    return "\n".join(lines)


def _load_profiles(path: Optional[str]) -> Dict[str, Dict]:
    if path and os.path.exists(path):
        with open(path) as fh:
            return json.load(fh)
    return {}


def _save_profile(path: str, profile: CaProfile) -> None:
    profiles = _load_profiles(path)
    profiles[profile.key()] = profile.as_dict()
    with open(path, "w") as fh:
        json.dump(profiles, fh, indent=2, sort_keys=True)


# --------------------------------------------------------------------------
def cmd_meta(args) -> int:
    print(_describe(Cr3(args.file)))
    return 0


def cmd_measure(args) -> int:
    cr3 = Cr3(args.file)
    img, sizes = decode(args.file)
    centre = optical_centre(sizes, cr3.geometry)
    if args.downsample > 1:
        img = downsample(img, args.downsample)
        centre = (centre[0] / args.downsample, centre[1] / args.downsample)
    profile, info = measure_ca(img, centre, bins=args.bins,
                               iterations=args.iterations, lens=cr3.lens,
                               focal_length=cr3.focal_length)
    rmax = info["corner_radius"] * args.downsample
    dr, db = profile.displacement_at_corner(rmax)
    print(f"{cr3.lens} at {cr3.focal_length or '?'} mm, f/{cr3.f_number or '?'}")
    print(f"measured on {img.shape[1]}x{img.shape[0]} px, "
          f"optical centre {centre[0]:.1f},{centre[1]:.1f}")
    print(f"  red  b1={profile.red[0]:+.6f} b3={profile.red[1]:+.6f}"
          f"   corner displacement {dr:+.3f} px")
    print(f"  blue b1={profile.blue[0]:+.6f} b3={profile.blue[1]:+.6f}"
          f"   corner displacement {db:+.3f} px")
    if args.verbose:
        rows = info["iterations"][0]["rows"]
        print(f"  {'r/rmax':>7} {'red px':>9} {'blue px':>9}   (first pass)")
        for (r, d_r, _), (_, d_b, _) in zip(rows["R"], rows["B"]):
            print(f"  {r / info['corner_radius']:7.3f} {d_r:9.3f} {d_b:9.3f}")
    if args.save_profile:
        _save_profile(args.save_profile, profile)
        print(f"saved profile '{profile.key()}' to {args.save_profile}")
    return 0


def cmd_correct(args) -> int:
    cr3 = Cr3(args.file)
    img, sizes = decode(args.file, auto_bright=args.auto_bright)
    centre = optical_centre(sizes, cr3.geometry)
    hdiag = half_diagonal(cr3.geometry, sizes)
    rmax = corner_radius(img.shape[:2], centre)
    applied = []

    if not args.no_ca:
        profile = None
        if args.profile:
            stored = _load_profiles(args.profile)
            key = CaProfile(lens=cr3.lens, focal_length=cr3.focal_length).key()
            if key in stored:
                profile = CaProfile.from_dict(stored[key])
                applied.append(f"CA from profile '{key}'")
        if profile is None:
            small = downsample(img, args.downsample)
            small_centre = (centre[0] / args.downsample, centre[1] / args.downsample)
            profile, _ = measure_ca(small, small_centre, bins=args.bins,
                                    iterations=args.iterations, lens=cr3.lens,
                                    focal_length=cr3.focal_length)
            applied.append("CA measured from image")
            if args.save_profile:
                _save_profile(args.save_profile, profile)
        dr, db = profile.displacement_at_corner(rmax)
        applied[-1] += f" (corner: red {dr:+.3f} px, blue {db:+.3f} px)"
        img = apply_ca(img, centre, profile)

    if not args.no_vignetting:
        curve = cr3.packet.falloff if cr3.packet else None
        if curve is None:
            applied.append("vignetting skipped: no falloff curve in file")
        else:
            gain = vignetting_gain(img.shape[:2], centre, curve, hdiag,
                                   strength=args.vignetting_strength)
            img = np.clip(img * gain[..., None], 0.0, None)
            applied.append(f"vignetting from packet curve "
                           f"(corner gain {float(gain.max()):.3f}, "
                           f"strength {args.vignetting_strength:g})")

    if args.distortion_curve is not None:
        curves = cr3.packet.curves if cr3.packet else []
        if not 0 <= args.distortion_curve < len(curves):
            print(f"no curve {args.distortion_curve} in this file", file=sys.stderr)
            return 2
        curve = curves[args.distortion_curve]
        img = apply_geometry_curve(img, centre, curve, hdiag)
        applied.append(f"geometry curve [{args.distortion_curve}] "
                       f"({curve.values[0]:.4f} -> {curve.values[-1]:.4f})")

    write_image(args.output, img, linear=args.linear)
    for line in applied:
        print(f"  {line}")
    print(f"wrote {args.output}")
    return 0


# --------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="craw",
                                description="Read Canon C-RAW metadata and use "
                                            "it to correct the image.")
    sub = p.add_subparsers(dest="command", required=True)

    m = sub.add_parser("meta", help="print metadata and lens correction curves")
    m.add_argument("file")
    m.set_defaults(func=cmd_meta)

    s = sub.add_parser("measure", help="measure lateral chromatic aberration")
    s.add_argument("file")
    s.add_argument("--bins", type=int, default=10)
    s.add_argument("--iterations", type=int, default=3)
    s.add_argument("--downsample", type=int, default=2,
                   help="block-mean factor for the measurement (default 2)")
    s.add_argument("--save-profile", metavar="JSON")
    s.add_argument("-v", "--verbose", action="store_true")
    s.set_defaults(func=cmd_measure)

    c = sub.add_parser("correct", help="apply lens corrections")
    c.add_argument("file")
    c.add_argument("-o", "--output", required=True,
                   help=".ppm for 16-bit, .jpg/.png/.tif for 8-bit")
    c.add_argument("--no-ca", action="store_true",
                   help="skip chromatic aberration correction")
    c.add_argument("--no-vignetting", action="store_true",
                   help="skip peripheral illumination correction")
    c.add_argument("--vignetting-strength", type=float, default=1.0)
    c.add_argument("--distortion-curve", type=int, metavar="INDEX",
                   help="apply a packet geometry curve by index (see 'meta'); "
                        "these curves are not documented, so this is opt-in")
    c.add_argument("--profile", metavar="JSON",
                   help="reuse a CA profile for this lens and focal length")
    c.add_argument("--save-profile", metavar="JSON")
    c.add_argument("--bins", type=int, default=10)
    c.add_argument("--iterations", type=int, default=3)
    c.add_argument("--downsample", type=int, default=2)
    c.add_argument("--auto-bright", action="store_true")
    c.add_argument("--linear", action="store_true",
                   help="write linear values instead of sRGB")
    c.set_defaults(func=cmd_correct)
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)
