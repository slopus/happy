# Mobile marketing captures

The approved five-card story is reproducible for iPhone, Pixel 9, Android 7-inch
and 10-inch tablets, iPad landscape, and iPhone Duo inner and outer displays.
All copy, palettes, shader seeds, typography, device placement and native still
inputs live here. Nothing reads an agent workspace or `.context` directory.

Run from this directory with Node 22+, pnpm 10.11, Python 3 and FFmpeg on PATH:

```sh
pnpm install --ignore-workspace --frozen-lockfile
pnpm exec playwright install chromium
node artwork.mjs android
node artwork.mjs iphone --download
# On macOS, for the two Duo layouts:
node artwork.mjs duo --download
node render.mjs --device all --jobs 2 --out output/stills
node verify.mjs output/stills
```

Apple bezels and their generated masks stay in ignored `.cache/frames/`, under
Apple's design-resource terms. The importer verifies the pinned source hashes
and regenerates the screen masks from the enclosed alpha aperture. It also
accepts a previously downloaded PNG or DMG instead of `--download`. Duo DMG
extraction uses macOS `hdiutil`; copy `.cache/frames/` back to Linux to render
there. iPhone, iPad and Android rendering otherwise works on Linux. iPad and
Android tablets are frameless. Asset sources and licenses are in `assets/` and
`web/duo-artwork.json`. Plex fonts reuse the tracked native iOS resources;
their SIL OFL license is retained in `assets/LICENSE-IBMPlex.txt`.

`presets.json` defines export sizes and presentation. `web/cards.js` holds the
shared copy and palette for each of the five cards, `web/shader.js` holds the
GLSL, and the two templates hold phone and wide-screen layout rules. Both stills
and video backgrounds use the same shader implementation. Stills render its grain
at full size; videos disable grain in the low-resolution background pass and add
it at full size during composition, with a fixed noise seed.
Every still freezes an explicit shader time: 20 by default, with the approved
iPhone hero's later phase recorded in `presets.json`. Browser time never selects
the poster. Previous ad hoc exports let that card animate while exporting.
The recovered iPhone phase, 22.2, closely matches the approved poster; its grain
pixels are not identical to that earlier export.
SwiftShader and pinned
Playwright reduce platform variation; tiny rounding differences can remain
between Chromium builds or parallel runs. Geometry and native input pixels are
preserved, rather than promising identical PNG hashes across machines.

`inputs/` contains all 35 approved native still inputs, so recomposition needs
no devices or accounts. Its checksum manifest records the exact files. iPhone
inputs retain the approved JPEGs; the other six formats retain PNG inputs.
Native input provenance is recorded in `provenance.json`. Generated final
images, browser profiles and video intermediates are ignored. `render.mjs`
supports `--device iphone`, `--card 3`, and `--jobs 1..4`. With `--inputs DIR`,
it reads replacement native captures from the same per-device directory tree.
Every output run writes a manifest with dimensions, shader time, measured layout
and hashes. Verification also compares against the approved thumbnails in
`references/` to catch composition drift.
Use separate output directories when running independent render commands.

Fresh native capture is a separate step: see [native/README.md](native/README.md).
Those drivers install the fictional story into an isolated source copy, build
on the appropriate remote machine, capture, and clean up the owned simulator or
emulator. iOS uses Kirill's Mac Mini; Android builds and emulators use the Android
node. Do not run native builds on the agent host. Coordinate the shared machine
slot before running them. The committed still inputs make that unnecessary for
layout or background changes.

Video is composed from independent, reusable steps:

```sh
node layers.mjs --device iphone --out output/iphone-layers
node background.mjs --device iphone --out output/iphone-background.mp4
python3 compose-video.py output/iphone-layers output/iphone-background.mp4 \
  /path/to/hero-raw.mp4 output/iphone-hero.mp4
python3 native/audit-video.py /path/to/hero-raw.mp4 --motion
python3 native/audit-video.py output/iphone-hero.mp4 --motion
# Separate app-only store export:
python3 app-preview.py iphone /path/to/hero-raw.mp4 output/iphone-app-preview.mp4
```

Replace `iphone` with `android`, `ipad`, `duo-inner` or `duo-outer` for framed
hero exports. `video-presets.json` records viewport, background resolution,
output crop, trim offset and encoder level. The compositor checks the background's
dimensions and BT.709 tags to catch using another device's background. The inner
Duo video crops the last
row and column to even dimensions for H.264. FFmpeg honors native rotation
metadata. Android's approved raw has a 3.021108-second lead-in; a new recording
can override it with `compose-video.py --trim N`. Large iPad shader backgrounds
take longer to generate. Layers and backgrounds can be cached and reused.
App-only exports support iPhone 886×1920 and iPad 1600×1200; store slot acceptance
still depends on the current App Store requirements.

The compositor converts tagged native colors to BT.709, blends in RGB, then
converts once to BT.709 YUV for the final export. It resamples native timestamps
to a 30 fps output and saves its exact command as a recipe JSON. It cannot repair
missing native frames. Audit
the raw recording before export and review motion in the result; a constant
30 fps container alone proves no absence of capture stalls. Approved historical
Android motion had two gaps above 67 ms (maximum 82 ms), and iPad had a maximum
122 ms gap, so those sources do not support a literal zero-dropped-frame claim.
The framed hero is a 17.5-second clip with no audio. Its beginning and end differ;
an endless web loop needs a separate transition. No store uploads or releases
are performed by these scripts.

Verification when this pipeline was added: all 35 stills rendered and passed
size, checksum, fixed-device-position and approved-reference checks. A one-second
native iPhone composition decoded as 30 frames at 886×1920 and 30 fps, with no
motion stalls. The other four framed formats and the app-only export passed
three-frame smoke tests. Native drivers received syntax and fixture checks,
not a new native build.