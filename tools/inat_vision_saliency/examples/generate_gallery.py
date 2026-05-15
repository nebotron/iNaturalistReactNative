#!/usr/bin/env python3
"""Download fixed-URL example images, run saliency.py, and write EXAMPLES.md."""

from __future__ import annotations

import csv
import subprocess
import sys
from pathlib import Path

import urllib.request

REPO_ROOT = Path(__file__).resolve().parents[3]
EX_DIR = Path(__file__).resolve().parent
INPUTS = EX_DIR / "inputs"
OUTPUTS = EX_DIR / "outputs"
SALIENCY = REPO_ROOT / "tools" / "inat_vision_saliency" / "saliency.py"
TFLITE = REPO_ROOT / "tools" / "inat_vision_saliency" / ".cache" / "INatVision_Small_2_fact256_8bit.tflite"

# (stem, url, credit line)
SOURCES: list[tuple[str, str, str]] = [
    ("bear", "https://placebear.com/800/600", "[PlaceBear](https://placebear.com)"),
    (
        "picsum_28",
        "https://picsum.photos/id/28/600/600.jpg",
        "[Lorem Picsum](https://picsum.photos) id 28",
    ),
    (
        "picsum_40",
        "https://picsum.photos/id/40/600/600.jpg",
        "[Lorem Picsum](https://picsum.photos) id 40",
    ),
    (
        "picsum_52",
        "https://picsum.photos/id/52/600/600.jpg",
        "[Lorem Picsum](https://picsum.photos) id 52",
    ),
    (
        "picsum_65",
        "https://picsum.photos/id/65/600/600.jpg",
        "[Lorem Picsum](https://picsum.photos) id 65",
    ),
    (
        "picsum_76",
        "https://picsum.photos/id/76/600/600.jpg",
        "[Lorem Picsum](https://picsum.photos) id 76",
    ),
    (
        "picsum_101",
        "https://picsum.photos/id/101/600/600.jpg",
        "[Lorem Picsum](https://picsum.photos) id 101",
    ),
    (
        "picsum_119",
        "https://picsum.photos/id/119/600/600.jpg",
        "[Lorem Picsum](https://picsum.photos) id 119",
    ),
    (
        "picsum_160",
        "https://picsum.photos/id/160/600/600.jpg",
        "[Lorem Picsum](https://picsum.photos) id 160",
    ),
    (
        "picsum_237",
        "https://picsum.photos/id/237/600/600.jpg",
        "[Lorem Picsum](https://picsum.photos) id 237",
    ),
    (
        "picsum_338",
        "https://picsum.photos/id/338/600/600.jpg",
        "[Lorem Picsum](https://picsum.photos) id 338",
    ),
    (
        "picsum_433",
        "https://picsum.photos/id/433/600/600.jpg",
        "[Lorem Picsum](https://picsum.photos) id 433",
    ),
    (
        "picsum_582",
        "https://picsum.photos/id/582/600/600.jpg",
        "[Lorem Picsum](https://picsum.photos) id 582",
    ),
    (
        "picsum_659",
        "https://picsum.photos/id/659/600/600.jpg",
        "[Lorem Picsum](https://picsum.photos) id 659",
    ),
    (
        "picsum_718",
        "https://picsum.photos/id/718/600/600.jpg",
        "[Lorem Picsum](https://picsum.photos) id 718",
    ),
    (
        "picsum_824",
        "https://picsum.photos/id/824/600/600.jpg",
        "[Lorem Picsum](https://picsum.photos) id 824",
    ),
    (
        "picsum_957",
        "https://picsum.photos/id/957/600/600.jpg",
        "[Lorem Picsum](https://picsum.photos) id 957",
    ),
    (
        "picsum_1025",
        "https://picsum.photos/id/1025/600/600.jpg",
        "[Lorem Picsum](https://picsum.photos) id 1025",
    ),
    (
        "picsum_219",
        "https://picsum.photos/id/219/600/600.jpg",
        "[Lorem Picsum](https://picsum.photos) id 219",
    ),
    (
        "picsum_292",
        "https://picsum.photos/id/292/600/600.jpg",
        "[Lorem Picsum](https://picsum.photos) id 292",
    ),
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
            "Place INatVision_Small_2_fact256_8bit.tflite in .cache/ "
            "or run saliency.py once with --download-model.",
        )

    INPUTS.mkdir(parents=True, exist_ok=True)
    OUTPUTS.mkdir(parents=True, exist_ok=True)
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
                str(SALIENCY),
                str(dest),
                "--tflite",
                str(TFLITE),
                "-o",
                str(outp),
            ],
            cwd=str(REPO_ROOT),
            text=True,
        )
        cls = prob = None
        for line in log.splitlines():
            if line.startswith("target_class="):
                rest = line[len("target_class=") :]
                cls_s, p_s = rest.split(" p=", 1)
                cls = int(cls_s)
                prob = float(p_s)
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
            },
        )

    lines: list[str] = []
    lines.append("# iNat vision model: example saliency maps\n")
    lines.append(
        "This page lists **multiple example photos** (different subjects and scenes) run through "
        "[`../saliency.py`](../saliency.py). For each image we show the model input (299×299 resize), "
        "the **gradient saliency** overlay for the **top-1 softmax class**, and the scientific name "
        "for that class. Class indices match the `leaf_class_id` column in the release "
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
        lines.append(
            "| Input (resized in tool) | Saliency overlay |\n"
            "|---------------------------|------------------|\n"
            f"| ![](inputs/{r['stem']}.jpg) | ![](outputs/{r['stem']}_saliency.png) |\n"
        )

    lines.append("## Earlier samples\n")
    lines.append(
        "Smaller JPEGs committed before this gallery (`sample_a.jpg`, `sample_b.jpg`, `sample_c.jpg`) "
        "and their overlays remain in [`inputs/`](inputs/) and [`outputs/`](outputs/).\n"
    )
    lines.append("## Regenerating this file\n")
    lines.append(
        "From the repository root, with the vision `.tflite` cached under "
        "`tools/inat_vision_saliency/.cache/`:\n\n"
        "```bash\n"
        "python3 tools/inat_vision_saliency/examples/generate_gallery.py\n"
        "```\n"
    )

    (EX_DIR / "EXAMPLES.md").write_text("\n".join(lines), encoding="utf-8")
    print("Wrote", EX_DIR / "EXAMPLES.md")


if __name__ == "__main__":
    main()
