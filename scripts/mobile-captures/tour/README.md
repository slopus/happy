# Six-beat store tour

How the assets in `packages/store-assets/` were made: the six-beat story (Happy, Your
computer and team servers, Build together, Use all your subscriptions, Call your agents,
All platforms) as a recorded iOS tour and as still cards for every store format. The
five-card pipeline in `..` stays as it was; this folder reuses its native inputs and
artwork importer.

Everything runs on Kirill's Mac in `~/happy-store-v8/tour`: the scripts use that path, the
Mac's FFmpeg at `~/happy-render/task241-ad2-r4/bin`, and Chrome headless.

## Setup

```sh
cd scripts/mobile-captures
node artwork.mjs iphone --download && node artwork.mjs duo --download   # Apple frames, not committed
bash tour/prepare.sh            # scripts, frames, fonts and native inputs into ~/happy-store-v8/tour
cd ~/happy-store-v8/tour && ./make-bgloop.sh    # the shader loop behind the videos
```

`prepare.sh` copies SF Pro from macOS for the video captions and art; it is not
redistributed. `desktop.mp4` is the landing page's desktop recording (team take 11,
fictional teammates and repos); `renderer/desktop-36.png` is its frame at 36 s.
`layers2/dmask.png` and `dshadow.png` are the desktop's rounded mask and shadow.

## Recording the tour (iOS Simulator)

The iOS tree is `~/happy-store-v8/src` at source commit
`76ed3d0abaf5586b1929df77797af8783b38d21c` with the v8 fixture installed by
`../native/ios/install.py`. `run-tour.py install` replaces the harness with
`StoryHarness.swift`, adds `StoryTour.swift` (the "Product Health" agent, its chart reply
and the personal MacBook home) and the `StoryTourUITests` UI test, then runs xcodegen.

```sh
cd ~/happy-store-v8
python3 tour/run-tour.py install
python3 tour/run-tour.py record          # iPhone 17 Pro Max simulator
python3 tour/run-tour.py record ipad     # iPad simulator, landscape
```

Each take writes `results-tour-[ipad-]HHMMSS/` with `tour-raw.mp4` (`simctl io
recordVideo`, variable frame rate) and `capture.json` with the beat times. All data is
fictional; the call is a scripted bar animation, never a real call. The takes used:

| Take | capture.json | tour-raw.mp4 sha256 |
|---|---|---|
| iPhone `results-tour-044231` | `takes/iphone-capture.json` | `0f77a5b7b359cac056e830141fc09777e4f56dbb37a24d1e9ffa53a04528fae2` |
| iPad `results-tour-ipad-132244` | `takes/ipad-capture.json` | `409b6f4b2bd4c68943dffdbdf098e1bbeb55d541ed6dddba4adfb75bfc32b224` |

The raw takes stay on the Mac and are not committed.

## Videos

All three share one cut, defined in `compose-search.py` as `CUTS` on the iPhone take:
caption, raw start, raw end, speed. Both scripts convert the take to 30 fps before
cutting, because the simulator writes only changed frames. The device then eases left and
stays partly in view, the desktop slides in from the right, and "All platforms" fades in
after it. Every take is 29.3 s, 879 frames, and its first frame is its poster
(00:00:00:00).

```sh
./layers.sh                                                  # art.html → layers2/ (3840x2560)
python3 compose-search.py ../results-tour-044231/tour-raw.mp4 search-tour-v8-2880x1920.mp4
./vlayers.sh iphone 886x1920 $PWD/vl-iphone
./vlayers.sh ipad 1600x1200 $PWD/vl-ipad
python3 compose-device.py ../results-tour-044231/tour-raw.mp4 vl-iphone out/iphone-preview-tour-886x1920.mp4 --audio
python3 compose-device.py ../results-tour-ipad-132244/tour-raw.mp4 vl-ipad out/ipad-preview-tour-1600x1200.mp4 --audio
```

`compose-device.py` moves each cut by the beat it starts in, so the iPad take is cut at
the same moments. `--audio` adds the inaudible stereo AAC track (pink noise near −88
dBFS) that the accepted preview a9000019 carries; the search video has no audio.

## Stills

```sh
./shots.sh       # iPhone 1320x2868 from renderer/index.html
./formats.sh     # iPad, Duo inner/outer, Android phone, 7" and 10" tablets, Play feature graphic
```

`make-formats.py` builds `renderer/formats.html` from the iPhone page's cards, so the
copy, palettes and order cannot drift. `chrome-shot.sh` renders into a taller window
and keeps the top rows, because headless Chrome's viewport is shorter than its window
and it repeats the top rows below the viewport. Stills are opaque RGB; video layers keep
alpha.

## Store folders

```sh
rsync -a mac:happy-store-v8/tour/ /tmp/tour/
python3 scripts/mobile-captures/tour/build-store-assets.py /tmp/tour
```

This writes each format's files in slot order, `manifest.json` (size, duration, slot
order, and which screenshot rule applied) and `SHA256SUMS`. Formats with a video slot
use the video and screenshots 2–6; the others use all six. The Play promo video is not
made: there is no Android tour take yet.
