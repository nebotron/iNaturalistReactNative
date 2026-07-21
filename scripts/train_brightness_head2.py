#!/usr/bin/env python3
"""
Grouped-LOOCV ridge search over the augmented YOLO feature set from
extract_yolo_brightness_features2.py. Each fold holds out ALL exposure
variants of one image and predicts its f=1.0 row; training uses every
row of the remaining images (augmented or not, per variant).

Uses sufficient statistics (X'X, X'y minus the held-out group's rows) so
LOOCV over 1300+ training rows stays fast. Predictions are exp(linear on
log-label), clamped to [0.4, 3.0].
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

CLAMP_LO, CLAMP_HI = 0.4, 3.0

d = np.load("/tmp/brightness_yolo_features2.npz")
X_all = d["feats"].astype(np.float64)
y_all = d["labels"].astype(np.float64)
groups = d["groups"]
factors = d["factors"]
logy_all = np.log(y_all)

orig_mask = factors == 1.0
uniq_groups = np.unique(groups)
n_img = len(uniq_groups)

BLOCKS = {
    "mean704": slice(0, 704),
    "wpool448": slice(704, 1152),
    "photo12": slice(1152, 1164),
}
COMBOS = {
    "photo12": ["photo12"],
    "wpool448": ["wpool448"],
    "wpool+photo": ["wpool448", "photo12"],
    "mean704": ["mean704"],
    "mean+photo": ["mean704", "photo12"],
    "sppf+photo": [slice(448, 704), "photo12"],
    "all1164": ["mean704", "wpool448", "photo12"],
}


def cols_for(combo) -> np.ndarray:
    idx = []
    for b in combo:
        sl = BLOCKS[b] if isinstance(b, str) else b
        idx.extend(range(sl.start, sl.stop))
    return np.array(idx)


def grouped_loocv(X, logy, use_aug: bool, alpha: float):
    train_mask = np.ones(len(logy), bool) if use_aug else orig_mask.copy()
    Xt, yt, gt = X[train_mask], logy[train_mask], groups[train_mask]

    XtX = Xt.T @ Xt
    Xty = Xt.T @ yt
    sum_x = Xt.sum(0)
    sum_y = yt.sum()
    n_tot = len(yt)

    preds = np.empty(n_img)
    truth = np.empty(n_img)
    for j, gid in enumerate(uniq_groups):
        gm = gt == gid
        Xg, yg = Xt[gm], yt[gm]
        n_f = n_tot - gm.sum()
        sx = sum_x - Xg.sum(0)
        sy = sum_y - yg.sum()
        mu = sx / n_f
        ybar = sy / n_f
        C = XtX - Xg.T @ Xg - n_f * np.outer(mu, mu)
        var = np.maximum(np.diag(C) / n_f, 1e-12)
        sd = np.sqrt(var)
        Cs = C / np.outer(sd, sd)
        b = (Xty - Xg.T @ yg - sx * ybar) / sd
        w = np.linalg.solve(Cs + alpha * np.eye(len(sd)), b)

        row = X[(groups == gid) & orig_mask][0]
        pred_log = ((row - mu) / sd) @ w + ybar
        preds[j] = np.clip(np.exp(pred_log), CLAMP_LO, CLAMP_HI)
        truth[j] = np.exp(logy_all[(groups == gid) & orig_mask][0])
    return float(np.mean(np.abs(preds - truth))), preds, truth


def main() -> None:
    print(f"{n_img} images, {len(y_all)} rows")
    alphas = [10, 30, 100, 300, 1000]
    best = None
    print(f"{'combo':<14}{'aug':>5}{'alpha':>7}{'LOOCV MAE':>11}")
    for cname, combo in COMBOS.items():
        cols = cols_for(combo)
        X = X_all[:, cols]
        for use_aug in (False, True):
            for alpha in alphas:
                mae, preds, truth = grouped_loocv(X, logy_all, use_aug, alpha)
                mark = ""
                if best is None or mae < best[0]:
                    best = (mae, cname, use_aug, alpha, preds, truth, cols)
                    mark = "  <-- best"
                print(f"{cname:<14}{str(use_aug):>5}{alpha:>7}{mae:>11.4f}{mark}")
    mae, cname, use_aug, alpha, preds, truth, cols = best
    print(f"\nBest: {cname} aug={use_aug} alpha={alpha} MAE={mae:.4f}")
    np.savez("/tmp/brightness_head2_best.npz", preds=preds, truth=truth,
             mae=mae, combo=cname, aug=use_aug, alpha=alpha, cols=cols)


if __name__ == "__main__":
    main()
