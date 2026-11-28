# App Store listing

Everything that goes into the App Store submission, as files, and the script
that turns them into screenshots and a preview.

| File | What it pins |
|---|---|
| `config.json` | App Store Connect app and version, simulator device, status bar, location, the photos put in the simulator's library (by sha256), and the scenes: the link or flow for each screenshot and its caption |
| `metadata/` | The listing text, one file per App Store Connect field, plus categories and copyright |
| `flows/` | Maestro flows: `onboarding.yaml` gets a fresh install to the tab bar, `link.yaml` shoots a screen opened by link, `cropper.yaml` imports the library photo and shoots the cropper |
| `make.sh` | Builds the app (or takes `--app`), boots a fresh simulator, runs the flows, frames the shots and writes `preview.html` |
| `bin/listing.py` | `check` the text against App Store Connect's limits, `preview` the listing, `upload` it (a dry run without `--apply`) |

Screens are reached through iNaturalist web observation-search links, which
the app opens in Explore (`src/components/hooks/exploreLink.ts`):
`user_id`, `taxon_ids`, `d1`/`d2`, `view` (`observations`, `species`,
`identify`, `hotspots`, `observers`, `identifiers`), and `route=lat,lng|lat,lng`
for the Hotspots view's stops. Pinning a user, taxa and dates keeps each
screen's results the same from run to run.

## Running it

On GitHub: the `App Store listing (iOS)` workflow runs on every push that
touches `appstore/`, or by hand. Its `appstore` artifact holds `framed/`,
`preview.html`, the raw shots and Maestro's debug output. Pass `app_run_id`
to reuse an earlier run's app and skip the build.

On a Mac with Xcode, Maestro and the iOS build's prerequisites:

```bash
appstore/make.sh
```

Then, to put the listing on App Store Connect:

```bash
python3 appstore/bin/listing.py upload appstore/build/framed --apply
```

Upload never picks a build or submits for review. The age rating and the App
Privacy answers are set in App Store Connect itself.
