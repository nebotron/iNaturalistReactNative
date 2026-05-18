# Dual-class saliency (true PyTorch backprop)

This folder includes a **reproducible example** of **exact** input saliency maps using the same autograd path as `inat_vision_saliency` (softmax probability for a chosen leaf class).

## Generated files

| File | Description |
|------|-------------|
| `inputs/example_mallard_canada_goose_marina.jpg` | Example RGB input (see attribution below). Scene: **mallard(s)** and **Canada goose / geese** together — aligned with the “mallard + goose on gravel” style reference you provided (the chat attachment itself is not stored as a file in this repo). |
| `outputs/example_waterfowl_dual_saliency_true_backprop.png` | Three-panel figure: 299×299 input, then **two** saliency overlays. Each overlay uses **one solid color** for the magnitude of ∂(softmax class *k*)/∂pixels (normalized per map, blended over the input). |
| `outputs/example_waterfowl_dual_saliency_true_backprop.json` | `top_probability` and bbox for each target class on this input. |

## Colors and classes

- **Mallard** (`Anas platyrhynchos`, leaf index **188**): tint **RGB (29, 78, 216)** — deep blue.
- **Canada Goose** (`Branta canadensis`, leaf index **265**): tint **RGB (234, 88, 12)** — orange.

**Gadwall** (*Mareca strepera*) is **not** a leaf in the v25.01.15 `INatVision_Small_2` 507-class head, so this example uses **Canada Goose** as the second species (both appear in the reference photo you described).

## Regenerate

```bash
pip install -e tools/inat_vision_saliency
cd tools/inat_vision_saliency
MPLBACKEND=Agg PYTHONPATH=. python3 examples/generate_dual_class_saliency_example.py \
  --image examples/inputs/example_mallard_canada_goose_marina.jpg
```

Optional: `--class-a`, `--class-b`, `--color-a R,G,B`, `--color-b R,G,B`, `--alpha`, `--out-dir`.

## Input image attribution

- **File:** [Canada geese and mallards at Burgh Castle Marina — geograph.org.uk — 1632106.jpg](https://commons.wikimedia.org/wiki/File:Canada_geese_and_mallards_at_Burgh_Castle_Marina_-_geograph.org.uk_-_1632106.jpg)  
- **Author:** Evelyn Simak / [Geograph Britain and Ireland](https://www.geograph.org.uk/)  
- **License:** CC BY-SA 2.0  

## Raw GitHub links (this branch)

PNG:

https://raw.githubusercontent.com/nebotron/iNaturalistReactNative/cursor/dual-saliency-example-da10/tools/inat_vision_saliency/examples/outputs/example_waterfowl_dual_saliency_true_backprop.png

JSON:

https://raw.githubusercontent.com/nebotron/iNaturalistReactNative/cursor/dual-saliency-example-da10/tools/inat_vision_saliency/examples/outputs/example_waterfowl_dual_saliency_true_backprop.json
