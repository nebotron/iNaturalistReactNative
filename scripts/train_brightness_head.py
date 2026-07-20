#!/usr/bin/env python3
"""
LOOCV evaluation of linear (ridge) brightness heads on frozen YOLO features
from extract_yolo_brightness_features.py, against the deployed stats formula.
All predictions are exp() of a linear model on log(label), clamped to the
app's [0.4, 3.0] bounds so numbers are comparable to production behavior.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

CLAMP_LO, CLAMP_HI = 0.4, 3.0

data = np.load("/tmp/brightness_yolo_features.npz", allow_pickle=True)
X_all = data["feats"].astype(np.float64)
y = data["labels"].astype(np.float64)
logy = np.log(y)
n = len(y)

SLICES = {
    "P3(64)": slice(0, 64),
    "P4(128)": slice(64, 192),
    "P5(256)": slice(192, 448),
    "SPPF(256)": slice(448, 704),
    "P3+P4+P5(448)": slice(0, 448),
    "all(704)": slice(0, 704),
}


def loocv_ridge(X: np.ndarray, alpha: float) -> tuple[float, np.ndarray]:
    """Explicit LOOCV: standardize + fit ridge on each training fold."""
    preds = np.empty(n)
    for i in range(n):
        mask = np.ones(n, dtype=bool)
        mask[i] = False
        Xtr, ytr = X[mask], logy[mask]
        mu, sd = Xtr.mean(0), Xtr.std(0) + 1e-8
        Xs = (Xtr - mu) / sd
        d = Xs.shape[1]
        A = Xs.T @ Xs + alpha * np.eye(d)
        b = Xs.T @ (ytr - ytr.mean())
        w = np.linalg.solve(A, b)
        pred_log = ((X[i] - mu) / sd) @ w + ytr.mean()
        preds[i] = np.clip(np.exp(pred_log), CLAMP_LO, CLAMP_HI)
    return float(np.mean(np.abs(preds - y))), preds


def main() -> None:
    # Reference points on the same 193 labels
    rows = json.loads(Path("/tmp/brightness_crop_features.json").read_text())
    assert len(rows) == n
    g = np.array([r["geomean"] for r in rows])
    m = np.array([r["median"] for r in rows])
    deployed = np.clip(np.exp(-4.167017 * g + 2.612363 * m + 0.827665),
                       CLAMP_LO, CLAMP_HI)
    print(f"n={n}")
    print(f"{'deployed stats formula':<28}{np.mean(np.abs(deployed - y)):>10.4f}")
    const = np.clip(np.exp(np.mean(np.log(y))), CLAMP_LO, CLAMP_HI)
    print(f"{'constant (geomean label)':<28}{np.mean(np.abs(const - y)):>10.4f}")
    print()

    print(f"{'features':<18}{'alpha':>8}{'LOOCV MAE':>12}")
    best = None
    for name, sl in SLICES.items():
        X = X_all[:, sl]
        for alpha in [1, 10, 30, 100, 300, 1000, 3000]:
            mae, preds = loocv_ridge(X, alpha)
            marker = ""
            if best is None or mae < best[0]:
                best = (mae, name, alpha, preds)
                marker = "  <-- best so far"
            print(f"{name:<18}{alpha:>8}{mae:>12.4f}{marker}")

    mae, name, alpha, preds = best
    print(f"\nBest: {name} alpha={alpha} LOOCV MAE={mae:.4f}")
    np.savez("/tmp/brightness_head_best.npz", preds=preds, mae=mae,
             feat_slice=name, alpha=alpha)


if __name__ == "__main__":
    main()
