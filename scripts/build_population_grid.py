#!/usr/bin/env python3
"""Builds ios/iNaturalistReactNative/population_10km.bin (bundled in the app), the population within 10 km of every point.

Source: GPW v4 rev 11 2020 population density at 30 arc-seconds (census based),
https://geodata.ucdavis.edu/geodata/pop/gpw_v4_population_density_rev11_2020_30s.tif

Output: uint8 grid, row-major, north to south, cell centres every STEP degrees
from LAT_MAX - STEP / 2 and LNG_MIN + STEP / 2. Each byte q encodes
population = (1 + MAX_POPULATION) ** (q / 255) - 1. Keep these constants in sync
with src/sharedHelpers/populationDensity.ts.

Usage: pip install numpy tifffile imagecodecs
       python3 scripts/build_population_grid.py gpw.tif \
       ios/iNaturalistReactNative/population_10km.bin
"""
import math
import sys

import numpy as np
import tifffile

STEP = 0.05
LAT_MAX = 80.0
LAT_MIN = -56.0
LNG_MIN = -180.0
RADIUS_KM = 10.0
MAX_POPULATION = 5e7
KM_PER_DEG = 6371.0088 * math.pi / 180
SRC_STEP = 1 / 120  # 30 arc-seconds


def main(src, dst):
    density = tifffile.imread(src)
    density[~np.isfinite(density) | (density < 0)] = 0
    src_rows, src_cols = density.shape
    src_lat = 90 - (np.arange(src_rows) + 0.5) * SRC_STEP
    cell_km2 = (SRC_STEP * KM_PER_DEG) ** 2 * np.cos(np.radians(src_lat))
    # Cumulative population along each row, padded so windows can wrap around
    # the antimeridian
    pad = src_cols // 2
    rows_out = round((LAT_MAX - LAT_MIN) / STEP)
    cols_out = round(360 / STEP)
    out_lng = LNG_MIN + (np.arange(cols_out) + 0.5) * STEP
    out_col = (out_lng + 180) / SRC_STEP
    grid = np.zeros((rows_out, cols_out), dtype=np.float64)
    dlat_rows = math.ceil(RADIUS_KM / KM_PER_DEG / SRC_STEP)
    cumsums = {}
    for r in range(rows_out):
        lat = LAT_MAX - (r + 0.5) * STEP
        centre = (90 - lat) / SRC_STEP - 0.5
        total = np.zeros(cols_out)
        for sr in range(round(centre) - dlat_rows, round(centre) + dlat_rows + 1):
            if sr < 0 or sr >= src_rows:
                continue
            dy_km = (src_lat[sr] - lat) * KM_PER_DEG
            if abs(dy_km) > RADIUS_KM:
                continue
            if sr not in cumsums:
                row = density[sr].astype(np.float64) * cell_km2[sr]
                padded = np.concatenate([row[-pad:], row, row[:pad]])
                cumsums[sr] = np.concatenate([[0], np.cumsum(padded)])
            half = math.sqrt(RADIUS_KM ** 2 - dy_km ** 2) / (
                KM_PER_DEG * math.cos(math.radians(src_lat[sr])) * SRC_STEP)
            half = min(half, pad - 1)
            lo = np.clip(np.round(out_col - half).astype(int) + pad, 0, len(cumsums[sr]) - 1)
            hi = np.clip(np.round(out_col + half).astype(int) + pad, 0, len(cumsums[sr]) - 1)
            total += cumsums[sr][hi] - cumsums[sr][lo]
        grid[r] = total
        for sr in [k for k in cumsums if k < round(centre) - dlat_rows]:
            del cumsums[sr]
    q = np.round(255 * np.log1p(np.maximum(grid, 0)) / math.log1p(MAX_POPULATION))
    np.clip(q, 0, 255).astype(np.uint8).tofile(dst)
    print(f"{rows_out}x{cols_out}, max population {grid.max():.0f}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
