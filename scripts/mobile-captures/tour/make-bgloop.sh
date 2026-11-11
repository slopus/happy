#!/bin/bash
# The videos' background: the hero shader (seed 0, violet/magenta/orange/blue) at 1920x1280,
# 30 fps, speed 0.35, 555 frames, with its last second dissolved into its first, so 525 frames
# loop seamlessly. Rendered on the CPU by shader-search.mjs. The loop the shipped videos used
# has sha256 07001c14…; a re-render has not been checked to be byte-identical.
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p .bg; E="-c:v libx264 -preset fast -crf 6 -pix_fmt yuv444p"
for c in 0 1 2 3; do a=$((c * 139)); b=$(( c == 3 ? 555 : (c + 1) * 139 ))
  node shader-search.mjs 1920 1280 30 0.35 1024 0.2421 0.5 $a $b |
    ffmpeg -v error -y -f rawvideo -pix_fmt rgb24 -s 1920x1280 -r 30 -i - $E .bg/c$c.mp4 & done; wait
for c in 0 1 2 3; do echo "file '$PWD/.bg/c$c.mp4'"; done > .bg/list.txt
cat=".bg/list.txt"
ffmpeg -v error -y -f concat -safe 0 -i $cat -vf "trim=start_frame=525:end_frame=555,setpts=PTS-STARTPTS" $E .bg/tail.mp4
ffmpeg -v error -y -f concat -safe 0 -i $cat -vf "trim=start_frame=0:end_frame=30,setpts=PTS-STARTPTS" $E .bg/head.mp4
ffmpeg -v error -y -f concat -safe 0 -i $cat -vf "trim=start_frame=30:end_frame=525,setpts=PTS-STARTPTS" $E .bg/rest.mp4
ffmpeg -v error -y -i .bg/tail.mp4 -i .bg/head.mp4 -filter_complex "[0:v]format=gbrp[a];[1:v]format=gbrp[b];[a][b]blend=all_expr='A*(1-N/30)+B*(N/30)',format=yuv444p" $E .bg/mix.mp4
printf "file '%s'\nfile '%s'\n" "$PWD/.bg/mix.mp4" "$PWD/.bg/rest.mp4" > .bg/loop.txt
ffmpeg -v error -y -f concat -safe 0 -i .bg/loop.txt -c copy bgloop.mp4
