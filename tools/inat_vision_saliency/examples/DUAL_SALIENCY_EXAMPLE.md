# Dual-class saliency (true PyTorch backprop)

This folder includes a **reproducible example** of **exact** input saliency maps using the same autograd path as `inat_vision_saliency` (softmax probability for a chosen leaf class).

## Generated files

| File | Description |
|------|-------------|
| `inputs/example_mallard_drake_with_canada_geese.jpg` | Example RGB input — **male mallard with Canada geese** (USFWS / Wikimedia; see attribution). This matches the usual “mallard in front, goose behind, gravel bank” composition; the chat attachment you send is **not** stored as a file in this repository, so regenerate locally with `--image` to use your own pixels. |
| `outputs/example_waterfowl_dual_saliency_true_backprop.png` | Three-panel figure: 299×299 input, then **two** saliency overlays. Each overlay uses **one solid color** for the magnitude of ∂(softmax class *k*)/∂pixels (normalized per map, blended over the input). |
| `outputs/example_waterfowl_dual_saliency_true_backprop.json` | `top_probability` and bbox for each target class on this input. |

## Colors and classes

- **Mallard** (`Anas platyrhynchos`, leaf index **188**): tint **RGB (29, 78, 216)** — deep blue.
- **Canada Goose** (`Branta canadensis`, leaf index **265**): tint **RGB (234, 88, 12)** — orange.

**Gadwall** (*Mareca strepera*) is **not** a leaf in the v25.01.15 `INatVision_Small_2` 507-class head, so this example uses **Canada Goose** as the second species.

## Regenerate

```bash
pip install -e tools/inat_vision_saliency
cd tools/inat_vision_saliency
MPLBACKEND=Agg PYTHONPATH=. python3 examples/generate_dual_class_saliency_example.py \
  --image examples/inputs/example_mallard_drake_with_canada_geese.jpg
```

Optional: `--class-a`, `--class-b`, `--color-a R,G,B`, `--color-b R,G,B`, `--alpha`, `--out-dir`.

## Input image attribution

- **Commons:** [Male Mallard with Geese (52777635745).jpg](https://commons.wikimedia.org/wiki/File:Male_Mallard_with_Geese_(52777635745).jpg)  
- **Source:** [USFWS Mountain Prairie on Flickr](https://www.flickr.com/photos/usfwsmtnprairie/52777635745)  
- **License:** **Public domain** (per Wikimedia Commons file page)

## Raw GitHub links (this branch)

PNG:

https://raw.githubusercontent.com/nebotron/iNaturalistReactNative/cursor/dual-saliency-example-da10/tools/inat_vision_saliency/examples/outputs/example_waterfowl_dual_saliency_true_backprop.png

JSON:

https://raw.githubusercontent.com/nebotron/iNaturalistReactNative/cursor/dual-saliency-example-da10/tools/inat_vision_saliency/examples/outputs/example_waterfowl_dual_saliency_true_backprop.json
