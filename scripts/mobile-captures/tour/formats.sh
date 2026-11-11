#!/bin/bash
# Renders the six-beat set for every non-iPhone format, and the Play feature graphic, from
# renderer/formats.html with Chrome on the Mac.
cd ~/happy-store-v8/tour/renderer
for spec in ${DEVICES:-ipad:2752x2064 duo-inner:2853x2007 duo-outer:1398x2034 android:1080x1920 tablet-7:1200x1920 tablet-10:1600x2560}; do
  dev=${spec%%:*}; size=${spec#*:}; mkdir -p out-formats/$dev
  for n in ${ONLY:-1 2 3 4 5 6}; do
    ../chrome-shot.sh $size $PWD/out-formats/$dev/$dev-0$n.png "file://$PWD/formats.html?device=$dev&export=$n"
  done
done
mkdir -p out-formats/feature
../chrome-shot.sh 1024x500 $PWD/out-formats/feature/play-feature-1024x500.png "file://$PWD/formats.html?device=feature&export=1"
sips -g pixelWidth -g pixelHeight out-formats/*/*.png | grep pixel | paste - - | sort | uniq -c
