#!/usr/bin/env bash
# usage: tools/capture_all.sh <html> <outroot> [pr]
H=$1; O=$2; PR=${3:-1}
mkdir -p $O
node tools/shot.mjs $H $O/full_4242 full 1280 720 4242 $PR > $O/full_4242.log 2>&1
node tools/shot.mjs $H $O/full_77 full 1280 720 77 $PR > $O/full_77.log 2>&1
node tools/shot.mjs $H $O/miss_9001 miss 1280 720 9001 $PR > $O/miss_9001.log 2>&1
node tools/shot.mjs $H $O/modes_4242 modes 1280 720 4242 $PR > $O/modes_4242.log 2>&1
echo ALLDONE > $O/DONE
