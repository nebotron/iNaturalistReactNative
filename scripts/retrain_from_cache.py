#!/usr/bin/env python3
"""
Fine-tune YOLOv8 subject detector using cached images and crop_training.json.

Unlike prepare_training_dataset.py (which requires Firebase), this script
uses the local crop_training.json and the image cache at /tmp/inat_eval_cache.

Usage:
    python3 scripts/retrain_from_cache.py [--epochs 100] [--base yolov8s-worldv2.pt]
"""

from __future__ import annotations

import argparse
import json
import random
import shutil
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parent))
from evaluate_subject_detector import resolve_image

REPO_ROOT = Path(__file__).parent.parent
CACHE_DIR = Path("/tmp/inat_eval_cache")
OUT_DIR = Path("/tmp/inat_finetune_local")
SEED = 42


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--epochs", type=int, default=100,
                        help="Number of training epochs (default: 100)")
    parser.add_argument("--base", default="yolov8s-worldv2.pt",
                        help="Base model to fine-tune (default: yolov8s-worldv2.pt)")
    parser.add_argument("--batch", type=int, default=8,
                        help="Batch size (default: 8)")
    parser.add_argument("--patience", type=int, default=20,
                        help="Early stopping patience (default: 20)")
    parser.add_argument("--json", default=str(REPO_ROOT / "crop_training.json"),
                        help="Path to crop_training.json")
    args = parser.parse_args()

    json_path = Path(args.json)
    raw = json.loads(json_path.read_text())
    if isinstance(raw, list):
        entries = raw
    else:
        entries = [v.get("crop", v) for v in raw.values() if v.get("crop")]

    print(f"Loaded {len(entries)} entries from {json_path}")

    resolved = []
    for entry in entries:
        if isinstance(entry, dict) and "x" in entry:
            c = entry
        elif isinstance(entry, dict) and "crop" in entry:
            c = entry["crop"]
        else:
            continue

        url = entry.get("url", "")
        img_path = resolve_image(url, None, CACHE_DIR)
        if img_path is None:
            continue

        cx = c["x"] + c["w"] / 2
        cy = c["y"] + c["h"] / 2
        w = c["w"]
        h = c["h"]
        cx = max(0.0, min(1.0, cx))
        cy = max(0.0, min(1.0, cy))
        w = max(0.01, min(1.0, w))
        h = max(0.01, min(1.0, h))
        resolved.append((img_path, cx, cy, w, h))

    print(f"Resolved {len(resolved)} images from cache.\n")

    if len(resolved) < 50:
        sys.exit(f"Too few images ({len(resolved)}). Run evaluate_subject_detector.py first "
                 "to populate the cache at /tmp/inat_eval_cache.")

    # 85/15 split
    random.seed(SEED)
    random.shuffle(resolved)
    split = int(len(resolved) * 0.85)
    train_entries = resolved[:split]
    val_entries = resolved[split:]
    print(f"Train: {len(train_entries)}, Val: {len(val_entries)}")

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

    data_yaml = {
        "path": str(OUT_DIR),
        "train": "images/train",
        "val": "images/val",
        "nc": 1,
        "names": ["subject"],
    }
    (OUT_DIR / "data.yaml").write_text(yaml.dump(data_yaml))
    print(f"Dataset written to {OUT_DIR}/\n")

    print(f"Fine-tuning {args.base} for {args.epochs} epochs …")
    from ultralytics import YOLO

    # Resolve base model path — allow local files
    base_path = REPO_ROOT / args.base
    base_model = str(base_path) if base_path.exists() else args.base
    print(f"Base model: {base_model}\n")

    model = YOLO(base_model)
    model.train(
        data=str(OUT_DIR / "data.yaml"),
        epochs=args.epochs,
        imgsz=640,
        batch=args.batch,
        lr0=1e-4,
        lrf=0.01,
        weight_decay=0.0005,
        warmup_epochs=3,
        close_mosaic=5,
        patience=args.patience,
        seed=SEED,
        verbose=True,
        project="/tmp/inat_train_local",
        name="run",
        exist_ok=True,
        single_cls=True,
    )

    best_pt = Path("/tmp/inat_train_local/run/weights/best.pt")
    if not best_pt.exists():
        sys.exit(f"Training finished but best.pt not found at {best_pt}")

    print(f"\nBest checkpoint: {best_pt}")
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

    dest = REPO_ROOT / "ios/iNaturalistReactNative/yolov8n.onnx"
    shutil.copy2(export_path, dest)
    print(f"Installed to {dest}")
    print(f"Model size: {dest.stat().st_size / 1e6:.1f} MB\n")
    print("Done! Run scripts/eval_onnx_variants.py to evaluate the new model.")


if __name__ == "__main__":
    main()
