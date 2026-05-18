# Dual-class saliency (true PyTorch backprop)

This folder includes a **reproducible example** of **exact** input saliency maps using the same autograd path as `inat_vision_saliency` (softmax probability for a chosen leaf class).

## Generated files

| File | Description |
|------|-------------|
| `inputs/example_waterfowl_input.jpg` | Example RGB input (resized from Wikimedia Commons; see attribution below). |
| `outputs/example_waterfowl_dual_saliency_true_backprop.png` | Three-panel figure: 299×299 input, then **two** saliency overlays. Each overlay uses **one solid color** for the magnitude of ∂(softmax class *k*)/∂pixels (normalized per map, blended over the input). |
| `outputs/example_waterfowl_dual_saliency_true_backprop.json` | `top_probability` and bbox for each target class on this input. |

## Colors and classes

- **Mallard** (`Anas platyrhynchos`, leaf index **188**): tint **RGB (29, 78, 216)** — deep blue.
- **Second map**: **Canada Goose** (`Branta canadensis`, leaf index **265**): tint **RGB (234, 88, 12)** — orange.

### Why not “Gadwall”?

The **v25.01.15** `INatVision_Small_2_fact256_8bit` head exported here has **507** leaf classes. The release `taxonomy.csv` used with this model **does not include Gadwall** (*Mareca strepera* / *Anas strepera*). The closest honest second waterbird class for a **two-map illustration** on the same photo is **Canada Goose** (265), which is a leaf in this head.

If Gadwall is added to a future vision head, re-run the generator with e.g. `--class-b <leaf_id>` once you know the leaf index.

## Regenerate

```bash
pip install -e tools/inat_vision_saliency
cd tools/inat_vision_saliency
MPLBACKEND=Agg PYTHONPATH=. python3 examples/generate_dual_class_saliency_example.py \
  --image examples/inputs/example_waterfowl_input.jpg
```

Optional: `--class-a`, `--class-b`, `--color-a R,G,B`, `--color-b R,G,B`, `--alpha`, `--out-dir`.

## Input image attribution

- **Source:** [Wikimedia Commons — *Herd of cold waterfowl on frozen Green Lake 2008*](https://commons.wikimedia.org/wiki/File:Herd_of_cold_waterfowl_on_frozen_Green_Lake_2008.jpg)  
- **Author:** [Cacophony](https://commons.wikimedia.org/wiki/User:Cacophony)  
- **License:** CC BY-SA 2.5  

The chat-attached photo in the issue was **not available as a file in this workspace**; this freely licensed substitute was used so the example can live in git. To run on your own photo, pass `--image /path/to/your.jpg`.

## Raw GitHub link

PNG (this branch):

https://raw.githubusercontent.com/nebotron/iNaturalistReactNative/cursor/dual-saliency-example-da10/tools/inat_vision_saliency/examples/outputs/example_waterfowl_dual_saliency_true_backprop.png

JSON metadata:

https://raw.githubusercontent.com/nebotron/iNaturalistReactNative/cursor/dual-saliency-example-da10/tools/inat_vision_saliency/examples/outputs/example_waterfowl_dual_saliency_true_backprop.json
