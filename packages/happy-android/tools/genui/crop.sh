#!/bin/bash
# Crops each raw 1080-wide capture to the component plus 16 dp (42 px at
# 420 dpi) of chat ground, clamped to the screen.
set -e
# Usage: crop.sh <raw-dir> <out-dir>
RAW=${1:?raw dir}; OUT=${2:?out dir}

mkdir -p $OUT
PAD=42
for f in "$RAW"/*.png; do
  name=$(basename $f)
  W=$(identify -format "%w" $f); H=$(identify -format "%h" $f)
  box=$(convert $f -fuzz 1% -format "%@" info:)   # WxH+X+Y
  bw=${box%%x*}; rest=${box#*x}; bh=${rest%%+*}; rest=${rest#*+}; bx=${rest%%+*}; by=${rest#*+}
  x0=$(( bx - PAD < 0 ? 0 : bx - PAD )); y0=$(( by - PAD < 0 ? 0 : by - PAD ))
  x1=$(( bx + bw + PAD > W ? W : bx + bw + PAD )); y1=$(( by + bh + PAD > H ? H : by + bh + PAD ))
  convert $f -crop $((x1 - x0))x$((y1 - y0))+$x0+$y0 +repage $OUT/$name
  echo "$name $((x1 - x0))x$((y1 - y0))"
done
