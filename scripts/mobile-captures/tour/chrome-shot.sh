#!/bin/bash
# chrome-shot.sh WxH OUT.png URL: a headless Chrome screenshot of exactly WxH.
# Headless Chrome's viewport is ~87 px shorter than its window and it tiles the rows below the
# viewport with copies of the top, so render into a taller window and keep the top WxH.
# FMT=rgba keeps transparency (video layers); stills default to opaque rgb24, as the stores require.
size=$1; out=$2; url=$3; w=${size%x*}; h=${size#*x}
C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
FF=$HOME/happy-render/task241-ad2-r4/bin/ffmpeg
dir=$(mktemp -d /tmp/vq03-chrome.XXXX)
"$C" --headless=new --user-data-dir=$dir/profile --allow-file-access-from-files ${FMT:+--default-background-color=00000000} --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=$w,$((h + 200)) --virtual-time-budget=${BUDGET:-8000} --screenshot=$dir/shot.png "$url" 2>/dev/null
$FF -v error -y -i $dir/shot.png -vf crop=$w:$h:0:0 -pix_fmt ${FMT:-rgb24} -update 1 "$out"
rm -rf $dir
