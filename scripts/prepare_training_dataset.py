#!/usr/bin/env python3
"""
Convert Firebase crop log to YOLO training format and fine-tune YOLOv8s-worldv2.

Usage:
    python3 scripts/prepare_training_dataset.py
"""

from __future__ import annotations

import os
import random
import shutil
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parent))
from evaluate_subject_detector import (
    _load_env,
    _fetch_firebase,
    resolve_image,
)

CACHE_DIR = Path("/tmp/inat_eval_cache")
OUT_DIR = Path("/tmp/inat_finetune_unpadded")
CURRENT_MODEL = str(Path(__file__).parent.parent / "ios/iNaturalistReactNative/yolov8n.onnx")
EPOCHS = 25
SEED = 42


def main() -> None:
    _load_env()
    base_url = os.environ.get("CROP_LOG_FIREBASE_URL", "").strip()
    if not base_url:
        sys.exit("CROP_LOG_FIREBASE_URL not set in .env")

    raw = _fetch_firebase(base_url)
    if isinstance(raw, dict) and any(
        isinstance(v, dict) and "url" in v for v in raw.values()
    ):
        raw = [v for v in raw.values() if isinstance(v, dict) and "url" in v]
    if isinstance(raw, list):
        entries = [(e["url"], e) for e in raw]
    else:
        entries = [(k, v) for k, v in raw.items() if v.get("crop")]

    # Resolve images from cache; skip those not available
    resolved = []
    for url, crop_data in entries:
        if isinstance(crop_data, dict) and "x" in crop_data:
            c = crop_data
        elif isinstance(crop_data, dict) and "crop" in crop_data:
            c = crop_data["crop"]
        else:
            continue

        img_path = resolve_image(url, None, CACHE_DIR)
        if img_path is None:
            continue
        cx = c["x"] + c["w"] / 2
        cy = c["y"] + c["h"] / 2
        w = c["w"]
        h = c["h"]
        # Clamp
        cx = max(0.0, min(1.0, cx))
        cy = max(0.0, min(1.0, cy))
        w = max(0.01, min(1.0, w))
        h = max(0.01, min(1.0, h))
        resolved.append((img_path, cx, cy, w, h))

    print(f"Resolved {len(resolved)} / {len(entries)} entries with cached images.\n")

    if len(resolved) < 50:
        sys.exit(f"Too few images ({len(resolved)}), need at least 50 cached. "
                 "Run eval_deployed_model.py first to populate the cache.")

    # Split train / val 85% / 15%
    random.seed(SEED)
    random.shuffle(resolved)
    split = int(len(resolved) * 0.85)
    train_entries = resolved[:split]
    val_entries = resolved[split:]
    print(f"Train: {len(train_entries)}, Val: {len(val_entries)}\n")

    # Build directory structure
    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    for split_name, items in [("train", train_entries), ("val", val_entries)]:
        (OUT_DIR / "images" / split_name).mkdir(parents=True)
        (OUT_DIR / "labels" / split_name).mkdir(parents=True)
        for i, (img_path, cx, cy, w, h) in enumerate(items):
            dst_img = OUT_DIR / "images" / split_name / f"{i:05d}.jpg"
            shutil.copy2(img_path, dst_img)
            label_path = OUT_DIR / "labels" / split_name / f"{i:05d}.txt"
            label_path.write_text(f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}\n")

    # Write data.yaml
    data_yaml = {
        "path": str(OUT_DIR),
        "train": "images/train",
        "val": "images/val",
        "nc": 1,
        "names": ["subject"],
    }
    (OUT_DIR / "data.yaml").write_text(yaml.dump(data_yaml))
    print(f"Dataset written to {OUT_DIR}/\n")

    # Fine-tune
    print("Loading base model and fine-tuning …")
    from ultralytics import YOLO
    model = YOLO("yolov8s-worldv2.pt")

    results = model.train(
        data=str(OUT_DIR / "data.yaml"),
        epochs=EPOCHS,
        imgsz=640,
        batch=8,
        lr0=1e-4,
        lrf=0.01,
        weight_decay=0.0005,
        warmup_epochs=3,
        close_mosaic=5,
        seed=SEED,
        verbose=False,
        project="/tmp/inat_train",
        name="run",
        exist_ok=True,
        single_cls=True,
    )

    best_pt = Path("/tmp/inat_train/run/weights/best.pt")
    if not best_pt.exists():
        sys.exit(f"Training finished but best.pt not found at {best_pt}")

    print(f"\nBest model: {best_pt}\n")
    print("Exporting to ONNX INT8 …")

    trained = YOLO(str(best_pt))
    trained.set_classes(["subject"])
    export_path = trained.export(
        format="onnx",
        imgsz=640,
        int8=True,
        data=str(OUT_DIR / "data.yaml"),
        dynamic=False,
    )
    print(f"Exported: {export_path}")

    # Copy to iOS bundle
    dest = Path(__file__).parent.parent / "ios/iNaturalistReactNative/yolov8n.onnx"
    shutil.copy2(export_path, dest)
    print(f"Installed to {dest}")
    print(f"Model size: {dest.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
