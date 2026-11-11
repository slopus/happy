#!/bin/bash
# Sets up ~/happy-store-v8/tour on Kirill's Mac from this folder: the scripts, plus the
# inputs that are not committed here (Apple artwork, SF Pro, the shader loop).
# Run on the Mac from a checkout: bash scripts/mobile-captures/tour/prepare.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); mc=$(dirname "$here"); repo=$(cd "$mc/../.." && pwd)
dst=$HOME/happy-store-v8/tour; R=$dst/renderer
mkdir -p "$dst"
rsync -a "$here/" "$dst/"
# Apple frames and their screen masks: node artwork.mjs iphone --download && node artwork.mjs duo --download
F=$mc/.cache/frames
mkdir -p "$R/frames" "$R/fonts" "$dst/fonts" "$R/img-v8n"
cp "$F/iphone-16-pro-black.png" "$F/screen-alpha.png" "$F/duo-inner-marketing.png" "$F/duo-outer-marketing.png" "$R/frames/"
cp "$F/duo-inner-screen-mask.png" "$R/frames/inner-screen-mask.png"
cp "$F/duo-outer-screen-mask.png" "$R/frames/outer-screen-mask.png"
cp "$mc/assets/pixel9/pixel9-back.webp" "$mc/assets/pixel9/pixel9-mask.webp" "$R/frames/"
printf 'P3\n1 1\n255\n255 255 255\n' > /tmp/white.ppm && sips -s format png /tmp/white.ppm --out "$R/frames/white.png" >/dev/null
# The search video's art.html and its layers.
cp "$F/iphone-16-pro-black.png" "$dst/"
cp "$F/screen-alpha.png" "$dst/layers2/mask.png"
# Fonts: IBM Plex from the iOS app (SIL OFL), SF Pro from macOS (not redistributed).
cp "$repo"/packages/happy-ios/Sources/HappyUI/Resources/Fonts/IBMPlex{Sans-Regular,Sans-SemiBold,Mono-Regular}.ttf "$R/fonts/"
cp /System/Library/Fonts/SFNS.ttf "$dst/fonts/"
# Native captures: the same approved inputs as the five-card pipeline.
I=$mc/inputs
for f in 01-home 02-feed 03-model-accounts 04-servers 05-voice; do
  cp "$I/iphone/$f.jpg" "$R/img-v8n/iphone-$f.jpg"
  for pair in ipad:ipad duo-inner:duo-inner duo-outer:duo-outer android:android tablet-7:android-7 tablet-10:android-10; do
    mkdir -p "$R/img-formats/${pair%%:*}"; cp "$I/${pair#*:}/$f.png" "$R/img-formats/${pair%%:*}/$f.png"
  done
done
(cd "$dst" && python3 make-formats.py)
[ -f "$dst/bgloop.mp4" ] || echo "bgloop.mp4 missing: run make-bgloop.sh"
echo "prepared $dst"
