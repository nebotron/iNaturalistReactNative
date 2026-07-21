#!/usr/bin/env python3
"""
Same LOOCV model search as explore_brightness_models.py, but features are
computed over the DETECTED SUBJECT CROP (matching how the app will actually
apply brightness), not the full image. Reads precomputed features from
/tmp/brightness_crop_features.json (see inline generation command).
"""
from __future__ import annotations

import json
import numpy as np
from pathlib import Path

rows = json.loads(Path("/tmp/brightness_crop_features.json").read_text())
y = np.array([r["label"] for r in rows])
feat_names = ["mean", "geomean", "median", "std", "p10", "p25", "p75", "p90",
              "frac_dark", "frac_bright"]


def loo_mae(predict_fn, X, y):
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


def multireg(X_train, y_train, x_test):
    Xb = np.column_stack([X_train, np.ones(len(X_train))])
    coef, *_ = np.linalg.lstsq(Xb, y_train, rcond=None)
    xb = np.append(x_test, 1.0)
    return float(xb @ coef)


def multiloreg(X_train, y_train, x_test):
    Xb = np.column_stack([X_train, np.ones(len(X_train))])
    coef, *_ = np.linalg.lstsq(Xb, np.log(y_train), rcond=None)
    xb = np.append(x_test, 1.0)
    return float(np.exp(xb @ coef))


def knn(X_train, y_train, x_test, k=3):
    Xn = (X_train - X_train.mean(0)) / (X_train.std(0) + 1e-6)
    xt = (x_test - X_train.mean(0)) / (X_train.std(0) + 1e-6)
    d = np.linalg.norm(Xn - xt, axis=1)
    idx = np.argsort(d)[:k]
    return float(y_train[idx].mean())


print(f"n={len(rows)}\n")
print(f"{'model':<34}{'LOOCV MAE':>12}")
print("-" * 46)

const_mae = np.mean(np.abs(y - y.mean()))
print(f"{'A: constant (mean label)':<34}{const_mae:>12.4f}")

best_c = None
for name in feat_names:
    x = np.array([r[name] for r in rows])
    mae = loo_mae(linreg_1d, x, y)
    print(f"{'C: linreg(' + name + ')':<34}{mae:>12.4f}")
    if best_c is None or mae < best_c[1]:
        best_c = (name, mae)

best_d = None
for name in feat_names:
    x = np.array([r[name] for r in rows])
    mae = loo_mae(loglinreg_1d, x, y)
    print(f"{'D: loglinreg(' + name + ')':<34}{mae:>12.4f}")
    if best_d is None or mae < best_d[1]:
        best_d = (name, mae)

X_ps = np.column_stack([[r["p10"] for r in rows], [r["std"] for r in rows]])
print(f"{'F: multireg(p10,std)':<34}{loo_mae(multireg, X_ps, y):>12.4f}")
print(f"{'F2: multiloreg(p10,std)':<34}{loo_mae(multiloreg, X_ps, y):>12.4f}")

X_all = np.column_stack([[r[n] for r in rows] for n in feat_names])
for k in [1, 3, 5]:
    mae_g = loo_mae(lambda Xt, yt, x, k=k: knn(Xt, yt, x, k), X_all, y)
    print(f"{f'G: kNN(k={k}, all feats)':<34}{mae_g:>12.4f}")

print(f"\nBest single-feature linreg: {best_c}")
print(f"Best single-feature loglinreg: {best_d}")
