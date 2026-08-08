# Results

A run of this pipeline, end to end, on a 4-core CPU container with no GPU.

## Dataset

Built with `fetch_dataset.py --num-species 15 --per-species 300`, stopped after
7 species had completed (the download is resumable, and 7 classes was enough to
answer the question):

| Species | Common name | Train | Val |
| --- | --- | ---: | ---: |
| *Cardinalis cardinalis* | Northern Cardinal | 230 | 70 |
| *Erithacus rubecula* | European Robin | 206 | 94 |
| *Fringilla coelebs* | Common Chaffinch | 264 | 35 |
| *Parus major* | Great Tit | 261 | 36 |
| *Thryothorus ludovicianus* | Carolina Wren | 235 | 65 |
| *Turdus merula* | Eurasian Blackbird | 253 | 47 |
| *Turdus migratorius* | American Robin | 227 | 73 |

- 2,100 recordings downloaded, **2,096 decoded** (4 corrupt uploads), from
  **932 distinct recordists**.
- 5,286 train / 1,394 validation windows of 64 × 130.
- 703 train vs 228 validation recordists, **disjoint**.
- The two *Turdus* congeners make this genuinely fine-grained rather than a
  test of whether the model can tell a bird from a frog.

## Training

`train.py --epochs 30 --threads 4`. AudioCNN, 0.39M parameters, ~42 s/epoch,
about 22 minutes total.

| Metric | Value |
| --- | ---: |
| Recording-level top-1 | **0.774** |
| Recording-level top-3 | **0.912** |
| Window-level top-1 | 0.671 |
| Macro F1 | 0.756 |
| Chance | 0.143 |

Progress by epoch (recording-level top-1): 0.262 → 0.633 (ep 10) → 0.740
(ep 15) → 0.736 (ep 25) → 0.774 (ep 30). Still improving at 30 epochs.

Spot-checking `predict.py` on three held-out validation recordings — two of
them M4A, the format the iOS app produces — gave the correct species at top-1
for all three.

## How much does the recordist-disjoint split matter?

Same data, same model, same hyperparameters, only the split rule changed
(`preprocess.py --split random` assigns whole recordings at random, which puts
147 recordists on both sides):

| Split | Recording top-1 | Top-3 | Macro F1 |
| --- | ---: | ---: | ---: |
| Recordist-disjoint (honest) | 0.774 | 0.912 | 0.756 |
| Random by recording (leaks) | 0.816 | 0.955 | 0.815 |

The naive split overstates top-1 by **4.2 points** and macro F1 by 5.9. That is
smaller than the gap often seen on bioacoustic datasets, most likely because
932 recordists across 2,096 recordings means few recordists contribute many
clips to any one species — the leak is real but there is not much of it to
exploit here. On a smaller or more concentrated set of contributors the gap
would widen, which is why the disjoint split is the default.

## Reading these numbers

77% on 7 common, well-recorded species is a demonstration that the data
supports the task, not a usable species classifier. It says nothing about
performance across thousands of species, on rare taxa, or on recordings where
the labeled animal is faint or absent. For that, see the scaling notes in the
README: the full iNatSounds archive, a pretrained audio backbone, and a GPU.
