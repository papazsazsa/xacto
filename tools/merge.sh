#!/usr/bin/env bash
# Merge each agent's owned files from its work copy into the main tree.
set -e
MAIN=/home/claude/xacto
W=/home/claude/work
cp $W/city/src/02_materials.js $W/city/src/03_city.js $MAIN/src/
cp $W/target/src/05_target.js $MAIN/src/
cp $W/flight/src/06_bullet.js $W/flight/src/09_game.js $MAIN/src/
cp $W/look/src/07_post.js $W/look/src/08_hud.js $W/look/src/template.html $MAIN/src/
cp $W/fxaudio/src/01_audio.js $W/fxaudio/src/04_fx.js $MAIN/src/
for n in city target flight look fxaudio; do
  [ -f $W/$n/REQUESTS.md ] && { echo "==== REQUESTS from $n"; cat $W/$n/REQUESTS.md; }
done
echo merged
