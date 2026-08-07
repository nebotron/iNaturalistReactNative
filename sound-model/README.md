# Animal sound recognition from iNaturalist data

Yes — iNaturalist has enough labeled audio to train a species classifier from
sound, and this directory is a working, self-contained pipeline that does it:
it pulls openly licensed audio from the iNaturalist API, turns it into
log-mel spectrograms, and trains a small CNN that runs on CPU.

This is a research prototype, not app code. Nothing here is imported by the
React Native app or shipped in a build.

## Why the data supports this

| Source | Scale | Use |
| --- | --- | --- |
| [iNaturalist API](https://api.inaturalist.org/v1/docs/) | ~1.23M research-grade observations with sound; ~639k of those under CC-BY-NC alone | What these scripts use. Good for targeted subsets by taxon or place. |
| [iNatSounds](https://github.com/visipedia/inat_sounds) (NeurIPS 2024) | 5,569 species / 137k train + 46k val + 50k test recordings, 22.05 kHz WAV, ~133 GB | The real training corpus. `s3://ml-inat-competition-datasets/sounds/2024/` |

iNatSounds covers Aves (3,846 species), Insecta (745), Amphibia (650),
Mammalia (296) and Reptilia (32) — so "animal sounds" here genuinely means more
than birdsong, though birds dominate.

## Quickstart

```bash
pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu

python3 fetch_dataset.py --num-species 15 --per-species 300   # downloads audio
python3 preprocess.py                                          # spectrograms + split
python3 train.py --epochs 30                                   # trains, writes runs/model.pt
python3 predict.py some-recording.m4a                          # top-5 species
```

`--taxon-id` selects the group: `3` Aves (default), `20978` Amphibia,
`47158` Insecta, `40151` Mammalia. `--place-id` restricts geographically.

Run the checks on the split logic with `python3 -m unittest test_split -v`.

## How it works

**Fetching** (`fetch_dataset.py`) picks the most-recorded species under a parent
taxon, then samples research-grade observations for each. Two details matter:

- Only `cc0`/`cc-by`/`cc-by-nc`/`cc-by-sa`/`cc-by-nc-sa` sounds are kept, so the
  resulting dataset is redistributable. All-rights-reserved audio is excluded.
- The API caps `page * per_page` at 10,000, so paging uses an `id_above` cursor.
  Cursoring from zero would return only each species' oldest uploads, so the id
  range is stratified and one page is drawn from a random point in each
  stratum. Observation ids increase with time, so this samples a species across
  its whole upload history rather than just its early years.

**Decoding** (`common.py`) tries libsndfile first, then falls back to PyAV.
The fallback is load-bearing: a large share of iNaturalist audio is AAC in an
`.m4a` container — including everything recorded in the iNaturalist iOS app —
and libsndfile cannot read it. A libsndfile-only reader silently drops those
files and biases the dataset toward desktop uploaders.

**Windowing** takes 3-second windows at 22.05 kHz and keeps the most
acoustically active ones, ranked by the energy of the signal's first
difference. Differencing acts as a crude high-pass so windows are scored on
calls rather than on wind and traffic rumble. This matters because labels are
*weak*: the species tag applies to the observation, not to any particular
moment, and plenty of recordings are mostly silence or handling noise.

**Features** are 64-bin log-mel spectrograms (`n_fft=1024`, `hop=512`),
64 × 130 per window.

**Splitting** (`preprocess.py`) is recordist-disjoint: every recording by a
given user goes entirely to train or entirely to validation. This is the single
most important choice in the pipeline. Splitting at the clip level inflates
accuracy badly, because one recordist often uploads the same individual animal
from the same spot with the same microphone many times over, and the model
learns the microphone and the background instead of the animal. After the
random assignment, whole recordists are moved across to guarantee every species
appears on both sides; species that still can't be covered are dropped and
reported.

**Model** (`train.py`) is a 4-block CNN (~0.4M parameters) with mean+max pooling
over the time-frequency plane, trained with class-balanced sampling, mixup,
SpecAugment-style masking and label smoothing.

**Metrics** are reported per window and per recording. Recording-level accuracy
— averaging softmax over a recording's windows — is the number that matters,
since that is how you'd actually classify an upload.

## Results

See `RESULTS.md` for the measured numbers from a run of this pipeline.

## Honest limitations

- **Weak labels.** A recording tagged *Cardinalis cardinalis* may contain other
  species, and the tagged one may be faint or absent from any given window.
  Multi-label training on strongly labeled data (as in the iNatSounds
  benchmarks) does better.
- **Small scale.** A few thousand recordings over a dozen common species is a
  demonstration. Species-level performance across thousands of classes needs
  the full iNatSounds archive and a GPU.
- **No geographic prior.** iNaturalist's image models weight predictions by
  where an observation was made, which helps enormously for narrowing
  candidates. Nothing here uses location.
- **Trained from scratch.** Fine-tuning an audio backbone pretrained on
  AudioSet, or a bioacoustics model such as BirdNET or Perch, would beat this
  at equal cost — iNatSounds is most valuable as pretraining or fine-tuning
  data rather than as a from-scratch corpus.

## Scaling up

For real training, skip the API and pull the archive directly:

```bash
aws s3 cp --no-sign-request s3://ml-inat-competition-datasets/sounds/2024/train.tar.gz .
```

Train (81 GB), val (25 GB) and test (27 GB) archives plus annotation JSONs are
listed with checksums at <https://github.com/visipedia/inat_sounds>. The paper
is *The iNaturalist Sounds Dataset*, Chasmai, Shepard, Maji & Van Horn,
NeurIPS 2024 Datasets & Benchmarks.

## Attribution

Audio downloaded by these scripts is contributed by iNaturalist users under
Creative Commons licenses. `data/manifest.csv` records the observation id, the
recordist's user id and the license for every file, which is what you need to
attribute the recordings if you redistribute anything derived from them.
