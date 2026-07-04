#!/usr/bin/env python3
"""
Explore brightness-prediction models from scratch against brightness_log_raw.json.

No assumptions from the current TARGET_LUMINANCE/tolerance formula are reused.
We extract a broader feature set per image (mean, percentiles, geometric mean,
shadow/highlight fractions, std/contrast) and fit several candidate models,
evaluated with leave-one-out cross-validation (LOOCV) since n=21 is tiny and
any in-sample fit will overfit.

Candidates:
  A. constant (predict global mean label) -- naive baseline
  B. current app formula (target=0.45, tol=0.15) -- for reference
  C. linear regression on single features (mean, p50, geomean, p10, p90, std)
  D. linear regression on log(label) ~ feature (multiplicative)
  E. highlight-protect gain: gain s.t. p90*gain <= HL  (physically motivated,
     from scratch: exposure metering style -- protect highlights instead of
     normalizing the mean)
  F. multivariate linear regression (mean + std)
  G. k-nearest-neighbors (k=3) on feature vector
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from evaluate_subject_detector import resolve_image

REPO_ROOT = Path(__file__).parent.parent
CACHE_DIR = Path("/tmp/inat_brightness_cache")


def features(image_path: str) -> dict:
    img = Image.open(image_path).convert("RGB").resize((64, 64), Image.BILINEAR)
    arr = np.asarray(img).astype(np.float32) / 255.0
    lum = 0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]
    flat = lum.flatten()
    eps = 1e-4
    return {
        "mean": float(flat.mean()),
        "geomean": float(np.exp(np.log(flat + eps).mean())),
        "median": float(np.median(flat)),
        "std": float(flat.std()),
        "p10": float(np.percentile(flat, 10)),
        "p25": float(np.percentile(flat, 25)),
        "p75": float(np.percentile(flat, 75)),
        "p90": float(np.percentile(flat, 90)),
        "frac_dark": float((flat < 0.2).mean()),
        "frac_bright": float((flat > 0.8).mean()),
    }


def loo_mae(predict_fn, X: np.ndarray, y: np.ndarray) -> float:
    """predict_fn(X_train, y_train, x_test) -> scalar prediction"""
    n = len(y)
    errs = []
    for i in range(n):
        mask = np.ones(n, dtype=bool)
        mask[i] = False
        pred = predict_fn(X[mask], y[mask], X[i])
        errs.append(abs(pred - y[i]))
    return float(np.mean(errs))


def linreg_1d(x_train, y_train, x_test):
    a, b = np.polyfit(x_train, y_train, 1)
    return a * x_test + b


def loglinreg_1d(x_train, y_train, x_test):
    a, b = np.polyfit(x_train, np.log(y_train), 1)
    return np.exp(a * x_test + b)


def knn(X_train, y_train, x_test, k=3):
    Xn = (X_train - X_train.mean(0)) / (X_train.std(0) + 1e-6)
    xt = (x_test - X_train.mean(0)) / (X_train.std(0) + 1e-6)
    d = np.linalg.norm(Xn - xt, axis=1)
    idx = np.argsort(d)[:k]
    return float(y_train[idx].mean())


def current_formula(lum, target=0.45, tol=0.15):
    adj = target / lum
    if abs(adj - 1.0) < tol:
        return 1.0
    return max(0.4, min(3.0, adj))


def main():
    raw = json.loads((REPO_ROOT / "brightness_log_raw.json").read_text())
    rows = []
    for e in raw:
        path = resolve_image(e["url"], None, CACHE_DIR)
        if not path:
            continue
        f = features(path)
        f["label"] = e["brightness"]
        rows.append(f)

    print(f"n={len(rows)}\n")
    y = np.array([r["label"] for r in rows])
    feat_names = ["mean", "geomean", "median", "std", "p10", "p25", "p75", "p90",
                  "frac_dark", "frac_bright"]

    print(f"{'model':<32}{'LOOCV MAE':>12}")
    print("-" * 44)

    # A. constant
    const_mae = loo_mae(lambda Xt, yt, x: yt.mean(), np.zeros((len(y), 1)), y)
    print(f"{'A: constant (mean label)':<32}{const_mae:>12.4f}")

    # B. current formula (no fitting -- just apply as-is)
    full_lum = np.array([r["mean"] for r in rows])
    cur_preds = np.array([current_formula(lm) for lm in full_lum])
    cur_mae = np.mean(np.abs(cur_preds - y))
    print(f"{'B: current app formula':<32}{cur_mae:>12.4f}")

    # C. linear regression per single feature
    best_c = None
    for name in feat_names:
        x = np.array([r[name] for r in rows])
        mae = loo_mae(linreg_1d, x, y)
        tag = f"C: linreg({name})"
        print(f"{tag:<32}{mae:>12.4f}")
        if best_c is None or mae < best_c[1]:
            best_c = (name, mae)

    # D. log-linear regression per single feature (multiplicative form,
    #    closer in spirit to the original but fit, not assumed)
    best_d = None
    for name in feat_names:
        x = np.array([r[name] for r in rows])
        mae = loo_mae(loglinreg_1d, x, y)
        tag = f"D: loglinreg({name})"
        print(f"{tag:<32}{mae:>12.4f}")
        if best_d is None or mae < best_d[1]:
            best_d = (name, mae)

    # E. highlight-protect gain: choose gain so that p90 * gain = HL, sweep HL
    best_e = None
    p90 = np.array([r["p90"] for r in rows])
    for hl in np.arange(0.5, 1.0, 0.02):
        preds = np.clip(hl / np.maximum(p90, 1e-3), 0.4, 3.0)
        mae = np.mean(np.abs(preds - y))
        if best_e is None or mae < best_e[1]:
            best_e = (hl, mae)
    print(f"{'E: highlight-protect gain (best HL)':<32}{best_e[1]:>12.4f}  (HL={best_e[0]:.2f})")

    # F. multivariate linear regression (mean + std), fit with normal equations
    def multireg(X_train, y_train, x_test):
        Xb = np.column_stack([X_train, np.ones(len(X_train))])
        coef, *_ = np.linalg.lstsq(Xb, y_train, rcond=None)
        xb = np.append(x_test, 1.0)
        return float(xb @ coef)

    X_ms = np.column_stack([[r["mean"] for r in rows], [r["std"] for r in rows]])
    mae_f = loo_mae(multireg, X_ms, y)
    print(f"{'F: multireg(mean,std)':<32}{mae_f:>12.4f}")

    X_all = np.column_stack([[r[n] for r in rows] for n in feat_names])
    mae_f2 = loo_mae(multireg, X_all, y)
    print(f"{'F2: multireg(all 10 feats)':<32}{mae_f2:>12.4f}  (overfit risk: high, 10 feats / 21 pts)")

    # G. kNN on full feature vector
    for k in [1, 3, 5]:
        mae_g = loo_mae(lambda Xt, yt, x, k=k: knn(Xt, yt, x, k), X_all, y)
        print(f"{f'G: kNN(k={k}, all feats)':<32}{mae_g:>12.4f}")

    print(f"\nBest single-feature linreg: {best_c}")
    print(f"Best single-feature loglinreg: {best_d}")


if __name__ == "__main__":
    main()
