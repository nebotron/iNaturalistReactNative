#!/usr/bin/env python3
"""Download fixed-URL example images, run saliency.py, and write EXAMPLES.md."""

from __future__ import annotations

import csv
import os
import subprocess
import sys
from pathlib import Path

import urllib.request

TOOL_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]
EX_DIR = Path(__file__).resolve().parent
INPUTS = EX_DIR / "inputs"
OUTPUTS = EX_DIR / "outputs"
TFLITE = TOOL_ROOT / ".cache" / "INatVision_Small_2_fact256_8bit.tflite"

# Curated Lorem Picsum IDs where the model's top-1 class is an animal (insect / vertebrate),
# plus PlaceBear (wild mammal photos). See gallery generator for selection criteria.
ANIMAL_PICSUM_IDS = (1, 2, 3, 5, 6, 8, 9, 11, 14, 17, 20, 21, 23, 24, 25)

SOURCES: list[tuple[str, str, str]] = [
    ("bear", "https://placebear.com/800/600", "[PlaceBear](https://placebear.com) (wild bears)"),
    *[
        (
            f"picsum_{pid}",
            f"https://picsum.photos/id/{pid}/600/600.jpg",
            f"[Lorem Picsum](https://picsum.photos) id {pid} (wildlife-oriented pick; top-1 is an animal species)",
        )
        for pid in ANIMAL_PICSUM_IDS
    ],
]


def load_leaf_labels() -> dict[int, dict[str, str]]:
    tax_path = Path("/tmp/taxonomy.csv")
    if not tax_path.is_file():
        urllib.request.urlretrieve(
            "https://github.com/inaturalist/model-files/releases/download/v25.01.15/taxonomy.csv",
            tax_path,
        )
    by_leaf: dict[int, dict[str, str]] = {}
    with tax_path.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            lid = (row.get("leaf_class_id") or "").strip()
            if not lid:
                continue
            idx = int(lid)
            by_leaf[idx] = {"taxon_id": row["taxon_id"], "name": row["name"]}
    return by_leaf


def main() -> None:
    if not TFLITE.is_file():
        print("Expected TFLite at", TFLITE, file=sys.stderr)
        sys.exit(
            "Place INatVision_Small_2_fact256_8bit.tflite in tools/inat_vision_saliency/.cache/ "
            "or run: npm run vision-saliency -- any.jpg --download-model",
        )

    INPUTS.mkdir(parents=True, exist_ok=True)
    OUTPUTS.mkdir(parents=True, exist_ok=True)
    for folder in (INPUTS, OUTPUTS):
        for p in folder.iterdir():
            if p.suffix.lower() in {".jpg", ".jpeg", ".png"}:
                p.unlink()

    by_leaf = load_leaf_labels()

    rows: list[dict[str, object]] = []
    for stem, url, credit in SOURCES:
        dest = INPUTS / f"{stem}.jpg"
        print("fetch", stem, flush=True)
        subprocess.check_call(["curl", "-fsSL", "-o", str(dest), url])
        outp = OUTPUTS / f"{stem}_saliency.png"
        log = subprocess.check_output(
            [
                sys.executable,
                "-m",
                "inat_vision_saliency",
                str(dest),
                "--tflite",
                str(TFLITE),
                "-o",
                str(outp),
            ],
            cwd=str(REPO_ROOT),
            env={**os.environ, "PYTHONPATH": str(TOOL_ROOT)},
            text=True,
        )
        cls = prob = None
        bbox: tuple[int, int, int, int] | None = None
        for line in log.splitlines():
            if line.startswith("target_class="):
                rest = line[len("target_class=") :]
                cls_s, p_s = rest.split(" p=", 1)
                cls = int(cls_s)
                prob = float(p_s)
            elif line.startswith("bbox_square="):
                rest = line.split("=", 1)[1].strip()
                if rest:
                    parts = [int(x) for x in rest.split(",")]
                    if len(parts) == 4:
                        bbox = (parts[0], parts[1], parts[2], parts[3])
        tax = by_leaf.get(int(cls), {}) if cls is not None else {}
        rows.append(
            {
                "stem": stem,
                "credit": credit,
                "url": url,
                "class_index": cls,
                "prob": prob,
                "taxon_id": tax.get("taxon_id", ""),
                "name": tax.get("name", "(unknown)"),
                "bbox": bbox,
            },
        )

    lines: list[str] = []
    lines.append("# iNat vision model: example saliency maps (wild animals)\n")
    lines.append(
        "> **On GitHub:** from the repo home page, open `tools/inat_vision_saliency/examples/EXAMPLES.md` on your branch.\n"
    )
    lines.append(
        "This gallery uses **only wild-animal-oriented examples**: PlaceBear (bears) plus fixed "
        "[Lorem Picsum](https://picsum.photos) photo IDs that were screened so the model’s **top-1** "
        "prediction is an **animal** species (insects, birds, mammals, etc.), not plants or scenery-only taxa. "
        "Each row shows the 299×299 input, a turbo saliency blend for the predicted class, and the **smallest square** "
        "bounding high-saliency pixels (lime outline) computed in [`saliency_map.py`](../inat_vision_saliency/saliency_map.py). "
        "See also [`../INTEGRATION.md`](../INTEGRATION.md).\n"
    )
    lines.append(
        "Class indices match the `leaf_class_id` column in the release "
        "[`taxonomy.csv`](https://github.com/inaturalist/model-files/releases/download/v25.01.15/taxonomy.csv) "
        "(same mapping as the mobile `Taxonomy` loader in "
        "[vision-camera-plugin-inatvision](https://github.com/inaturalist/vision-camera-plugin-inatvision)).\n"
    )
    lines.append("## Examples\n")
    for i, r in enumerate(rows, start=1):
        name = str(r["name"]).replace("\n", " ")
        lines.append(f"### {i}. `{r['stem']}`\n")
        lines.append(f"**Photo:** {r['credit']}  \n")
        lines.append(f"**Top-1 prediction:** *{name}* — iNat taxon `{r['taxon_id']}` — model leaf index `{r['class_index']}` — p = `{r['prob']:.4f}`\n")
        bb = r.get("bbox")
        if bb:
            lines.append(f"**Salient square (inclusive x0,y0,x1,y1):** `{bb[0]}, {bb[1]}, {bb[2]}, {bb[3]}`  \n")
        lines.append(
            "| Input (resized in tool) | Saliency + salient square |\n"
            "|---------------------------|-----------------------------|\n"
            f"| ![](inputs/{r['stem']}.jpg) | ![](outputs/{r['stem']}_saliency.png) |\n"
        )

    lines.append("## Regenerating this file\n")
    lines.append(
        "From the repository root, with the vision `.tflite` cached under "
        "`tools/inat_vision_saliency/.cache/` and Python deps installed "
        "(`pip install -e tools/inat_vision_saliency`):\n\n"
        "```bash\n"
        "python3 tools/inat_vision_saliency/examples/generate_gallery.py\n"
        "```\n\n"
        "Alternatively, saliency for a single image: `npm run vision-saliency -- path/to/photo.jpg --tflite "
        "tools/inat_vision_saliency/.cache/INatVision_Small_2_fact256_8bit.tflite -o out.png`.\n"
    )

    (EX_DIR / "EXAMPLES.md").write_text("\n".join(lines), encoding="utf-8")
    print("Wrote", EX_DIR / "EXAMPLES.md")


if __name__ == "__main__":
    main()
