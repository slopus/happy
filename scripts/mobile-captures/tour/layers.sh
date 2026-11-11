#!/bin/bash
# Renders the tour video's 3840x2560 layers from art.html with Chrome on the Mac.
cd ~/happy-store-v8/tour
C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
shot() { rm -rf /tmp/vq03-chrome; "$C" --headless=new --user-data-dir=/tmp/vq03-chrome --allow-file-access-from-files --default-background-color=00000000 \
  --hide-scrollbars --force-device-scale-factor=1 --window-size=3840,2560 --virtual-time-budget=5000 --screenshot=$PWD/layers2/$1.png "file://$PWD/art.html?kind=tour&fit=1&layer=overlay&$2" 2>/dev/null; }
mkdir -p layers2
shot phone "only=phone"
for c in 0 1 2 3 4 5; do shot copy$c "only=copy&caption=$c&title=${TITLE:-185}"; done
rm -rf /tmp/vq03-chrome
"$C" --headless=new --user-data-dir=/tmp/vq03-chrome --allow-file-access-from-files --window-size=3840,2560 --virtual-time-budget=5000 --dump-dom "file://$PWD/art.html?kind=tour&fit=1&layer=overlay&only=phone" 2>/dev/null | grep -o '<title>[^<]*'
for c in 0 1 2 3 4 5; do rm -rf /tmp/vq03-chrome; "$C" --headless=new --user-data-dir=/tmp/vq03-chrome --allow-file-access-from-files --window-size=3840,2560 --virtual-time-budget=5000 --dump-dom "file://$PWD/art.html?kind=tour&fit=1&caption=$c&title=${TITLE:-185}" 2>/dev/null | grep -o '<title>[^<]*'; done
