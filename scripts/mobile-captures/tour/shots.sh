#!/bin/bash
# Renders the six iPhone screenshots (1320x2868) from renderer/index.html with Chrome on the Mac.
cd ~/happy-store-v8/tour/renderer
mkdir -p out
for n in 1 2 3 4 5 6; do ../chrome-shot.sh 1320x2868 $PWD/out/iphone-0$n.png "file://$PWD/index.html?export=$n"; done
sips -g pixelWidth -g pixelHeight out/*.png | grep pixel | sort | uniq -c
