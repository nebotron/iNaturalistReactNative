"""Locks built from the real Vision measurements made on macOS.

Every lock is a 3x3 in data px (frames at 960 long side, top-left origin)
mapping frame i onto frame 0, same as stab.py.
"""
import json

import numpy as np

from stab import T


def load(path):
    return json.load(open(path))


def to_data(res, data_w):
    """Factor from the tool's full-frame px to data px; and from mid px."""
    k_full = data_w / res["width"]
    k_mid = data_w / res["midWidth"]
    return k_full, k_mid


def app_today(res, data_w, data_h):
    """lockPath(analysis, "background"): shiftOf(r, center) per frame."""
    k, _ = to_data(res, data_w)
    cx, cy = res["width"] / 2, res["height"] / 2
    out = []
    for f in res["frames"]:
        r = np.array(f["r"]).reshape(3, 3)
        p = r @ [cx, cy, 1]
        p = p[:2] / p[2]
        out.append(T((p[0] - cx) * k, (p[1] - cy) * k))
    return out


def tile_centers(res, k_mid):
    tw, th = res["tileWidth"], res["tileHeight"]
    return np.array([[(i + 0.5) * tw * k_mid, (j + 0.5) * th * k_mid]
                     for j in range(res["tileRows"]) for i in range(res["tileCols"])])


def readings(res, data_w):
    """Per frame: tile steps (n_tiles x 2, NaN where missing) and absolute
    tile readings of the lock translation (tc + tr), in data px."""
    _, km = to_data(res, data_w)
    n_t = res["tileRows"] * res["tileCols"]
    S, R = [], []
    for f in res["frames"]:
        s = np.full((n_t, 2), np.nan)
        r = np.full((n_t, 2), np.nan)
        if "ts" in f:
            for k, v in enumerate(f["ts"]):
                if v is not None:
                    s[k] = v
            tc = np.array(f["tc"])
            for k, v in enumerate(f["tr"]):
                if v is not None:
                    r[k] = tc + np.array(v)
        S.append(s * km)
        R.append(r * km)
    return np.array(S), np.array(R)


def homography_steps(res, data_w):
    """Vision's homographic step per frame, converted to top-left data px,
    as (roll radians, log scale) of its similarity part."""
    s = res["scale"]
    sh = res["smallHeight"]
    k, _ = to_data(res, data_w)
    # bottom-left small px -> top-left data px
    to_tl = np.diag([k / s, k / s, 1.0]) @ np.array([[1, 0, 0], [0, -1, sh], [0, 0, 1.0]])
    from_tl = np.linalg.inv(to_tl)
    out = []
    for f in res["frames"]:
        if "h" not in f:
            out.append(np.eye(3))
            continue
        h = np.array(f["h"]).reshape(3, 3)
        out.append(to_tl @ h @ from_tl)
    return out


def robust_path(steps, reads, lam=0.1, c_px=3.0, iters=8):
    """Robust least squares for the lock translation X_i:
    X_i - X_{i-1} = each tile's step,   X_i = each tile's reading (weight lam).
    Tukey weights on every equation, so tiles on the subject, on the wrong
    depth, or simply wrong drop out on their own."""
    n = len(steps)
    ws = np.where(np.isnan(steps[..., 0]), 0.0, 1.0)
    wr = np.where(np.isnan(reads[..., 0]), 0.0, lam)
    st = np.nan_to_num(steps)
    rd = np.nan_to_num(reads)
    X = np.zeros((n, 2))
    # start from medians
    for i in range(1, n):
        d = np.nanmedian(steps[i], axis=0) if ws[i].sum() else np.zeros(2)
        X[i] = X[i - 1] + np.nan_to_num(d)
    for it in range(iters):
        c = max(c_px, 48.0 / 2 ** it)
        rs = np.linalg.norm(st - (X[:, None] - np.vstack([X[:1], X[:-1]])[:, None]), axis=2)
        rr = np.linalg.norm(rd - X[:, None], axis=2)
        a = ws * np.where(rs < c, (1 - (rs / c) ** 2) ** 2, 0)
        b = wr * np.where(rr < c, (1 - (rr / c) ** 2) ** 2, 0)
        a[0] = 0
        A = np.zeros((n, n))
        B = np.zeros((n, 2))
        sa = a.sum(1)
        sb = b.sum(1)
        for i in range(n):
            A[i, i] += sb[i]
            B[i] += (b[i][:, None] * rd[i]).sum(0)
        for i in range(1, n):
            ds = (a[i][:, None] * st[i]).sum(0)
            A[i, i] += sa[i]
            A[i - 1, i - 1] += sa[i]
            A[i, i - 1] -= sa[i]
            A[i - 1, i] -= sa[i]
            B[i] += ds
            B[i - 1] -= ds
        A[0, 0] += 1e6
        X = np.linalg.solve(A + 1e-9 * np.eye(n), B)
    return [T(*x) for x in X]


def with_roll(locks, hsteps, center, guard_deg=None):
    """Adds the roll (and zoom) chained from Vision's homographic steps to
    shift-only locks, about the frame center."""
    out = []
    ang, lsc = 0.0, 0.0
    cx, cy = center
    for L, H in zip(locks, hsteps):
        a = np.arctan2(H[1, 0] - H[0, 1], H[0, 0] + H[1, 1])
        s = np.log(np.hypot(H[0, 0] + H[1, 1], H[1, 0] - H[0, 1]) / 2)
        ang += a
        lsc += s
        if guard_deg is not None:
            ang = float(np.clip(ang, -np.radians(guard_deg), np.radians(guard_deg)))
        sc = np.exp(lsc)
        R = np.array([[sc * np.cos(ang), -sc * np.sin(ang), 0], [sc * np.sin(ang), sc * np.cos(ang), 0], [0, 0, 1]])
        out.append(L @ T(cx, cy) @ R @ T(-cx, -cy))
    return out
