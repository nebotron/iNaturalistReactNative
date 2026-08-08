# Can we train a model to recognize animal sounds from iNaturalist data?

Yes. This branch contains a working pipeline that does it, the measured
results, and the manifest defining the exact dataset used.

## Short answer

Trained a 7-species bird call classifier from iNaturalist audio in about
22 minutes on 4 CPU cores, no GPU:

| Metric | Value |
| --- | ---: |
| Recording-level top-1 | **0.774** |
| Recording-level top-3 | **0.912** |
| Macro F1 | 0.756 |
| Chance | 0.143 |

That is a demonstration that the data supports the task — not a usable species
classifier. See [Limits](#limits).

## The data

| Source | Scale | Role |
| --- | --- | --- |
| [iNaturalist API](https://api.inaturalist.org/v1/docs/) | ~1.23M research-grade observations with sound; ~639k CC-BY-NC | What this pipeline uses |
| [iNatSounds](https://github.com/visipedia/inat_sounds) (NeurIPS 2024) | 5,569 species, 233k recordings, ~133 GB | The real corpus for serious training |

iNatSounds spans Aves (3,846 species), Insecta (745), Amphibia (650),
Mammalia (296) and Reptilia (32), so "animal sounds" genuinely means more than
birdsong — though birds dominate.

## What was actually run

2,100 CC-licensed recordings fetched from the API across 7 species, 2,096 of
which decoded, contributed by **932 distinct recordists**.

| Species | Common name | Train | Val |
| --- | --- | ---: | ---: |
| *Cardinalis cardinalis* | Northern Cardinal | 230 | 70 |
| *Erithacus rubecula* | European Robin | 206 | 94 |
| *Fringilla coelebs* | Common Chaffinch | 264 | 35 |
| *Parus major* | Great Tit | 261 | 36 |
| *Thryothorus ludovicianus* | Carolina Wren | 235 | 65 |
| *Turdus merula* | Eurasian Blackbird | 253 | 47 |
| *Turdus migratorius* | American Robin | 227 | 73 |

The two *Turdus* congeners make this fine-grained rather than a test of whether
the model can tell a bird from a frog.

Pipeline: 3 s windows at 22.05 kHz → 64-bin log-mel (64 × 130) → 0.39M-parameter
CNN, class-balanced sampling, mixup, SpecAugment-style masking, 30 epochs.

## Three findings worth keeping

**A lot of iNaturalist audio is AAC in an `.m4a` container, and libsndfile
cannot read it.** This is exactly what the iNaturalist iOS app records. The
first decode pass silently dropped 19 of 36 files. A PyAV fallback fixed it;
without one, the dataset quietly skews toward desktop uploaders.

**The train/validation split rule is the load-bearing choice.** One recordist
often uploads the same individual animal, same spot, same microphone, many
times. Splitting by recording rather than by recordist lets the model score
points for recognising the microphone and background instead of the animal.
Measured by training the identical model both ways:

| Split | Recording top-1 | Top-3 | Macro F1 |
| --- | ---: | ---: | ---: |
| Recordist-disjoint (honest) | 0.774 | 0.912 | 0.756 |
| Random by recording (leaks, 147 shared recordists) | 0.816 | 0.955 | 0.815 |

4.2 points of inflation — real but modest here, because 932 recordists across
2,096 recordings leaves little to exploit. A more concentrated contributor set
would be worse, which is why disjoint is the default.

**Paging observations from `id_above=0` returns only a species' oldest
uploads**, biasing toward early adopters and dated recording gear. The fetcher
stratifies the observation-id range and samples a page from each stratum.

## Limits

- **Weak labels.** The species tag applies to the observation, not to any
  moment in it. Other species may be audible; the tagged one may be faint or
  absent from a given window.
- **Small scale.** 7 common, well-recorded species says nothing about
  performance across thousands of species or on rare taxa.
- **No geographic prior.** iNaturalist's image models weight predictions by
  where an observation was made, which helps enormously. Nothing here uses
  location.
- **Trained from scratch.** Fine-tuning an AudioSet-pretrained backbone, or a
  bioacoustics model such as BirdNET or Perch, would beat this at equal cost.
  iNatSounds is most valuable as pretraining/fine-tuning data.
- **Partial fetch.** 15 species were requested; download throughput collapsed
  partway through, so training used the 7 that had completed. `fetch_dataset.py`
  is resumable and picks up the rest from cache.

## Reproducing this

No audio is committed — it is 2.0 GB of third-party CC-licensed recordings.
`data/manifest.csv` is the dataset definition: every observation id, recordist
id, sound URL and license for all 2,096 recordings. To rebuild it exactly:

```bash
pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu

python3 fetch_dataset.py --num-species 15 --per-species 300   # re-downloads audio
python3 preprocess.py                                          # spectrograms + split
python3 train.py --epochs 30 --threads 4
python3 predict.py some-recording.m4a
```

Sampling is seeded, so the same species and observations are selected. Use
`--split random` on `preprocess.py` to reproduce the leakage comparison, and
`python3 -m unittest test_split -v` to check the split logic.

## Files

| Path | What |
| --- | --- |
| `README.md` | Pipeline design and rationale |
| `RESULTS.md` | Full measured results and per-class counts |
| `common.py` | Config, decoding, windowing, log-mel features |
| `fetch_dataset.py` | iNaturalist API dataset builder |
| `preprocess.py` | Feature cache and recordist-disjoint split |
| `train.py` | AudioCNN and training loop |
| `predict.py` | Inference on a single audio file |
| `test_split.py` | Checks on the split logic |
| `data/manifest.csv` | The dataset definition (2,100 rows) |

## Attribution

Every recording is contributed by an iNaturalist user under a Creative Commons
license. `data/manifest.csv` carries the observation id, recordist user id and
license code for each one — what you need to attribute them if you redistribute
anything derived from this data.
