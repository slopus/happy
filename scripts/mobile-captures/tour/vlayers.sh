#!/bin/bash
# Renders one format's video layers from renderer/formats.html with Chrome on the Mac.
# usage: vlayers.sh DEVICE WxH OUTDIR
cd ~/happy-store-v8/tour/renderer
dev=$1; size=$2; out=$3; mkdir -p $out
shot() { FMT=rgba ../chrome-shot.sh $size $out/$1.png "file://$PWD/formats.html?device=$dev&export=$2&layer=$3"; }
for c in 1 2 3 4 5 6; do shot copy$((c-1)) $c copy; done
shot under 1 under; shot frame 1 frame; shot mask 1 mask; shot desk 6 desk; shot dmask 6 dmask
C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; rm -rf /tmp/vq03-chrome
"$C" --headless=new --user-data-dir=/tmp/vq03-chrome --allow-file-access-from-files --window-size=${size/x/,} --virtual-time-budget=6000 \
  --dump-dom "file://$PWD/formats.html?device=$dev&export=1&layer=frame" 2>/dev/null | grep -o '<title>[^<]*' | sed 's/<title>//' > $out/rects.json
cat $out/rects.json
