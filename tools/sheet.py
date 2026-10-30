#!/usr/bin/env python3
"""Contact sheet of a frame sequence: python3 tools/sheet.py <framesDir> <out.png> [start=6] [every=5] [count=24]
Frames are numbered as the sequence tool writes them (fNNNN.png); each tile is labelled with its frame number."""
import sys, glob
from PIL import Image, ImageDraw
src, out = sys.argv[1], sys.argv[2]
start, every, count = (int(sys.argv[i]) if len(sys.argv) > i else d for i, d in ((3, 6), (4, 5), (5, 24)))
fs = sorted(glob.glob(src.rstrip('/') + '/f*.png'))[start::every][:count]
tw, th, cols = 480, 270, 4
rows = (len(fs) + cols - 1) // cols
sheet = Image.new('RGB', (tw * cols, th * rows))
for i, f in enumerate(fs):
    im = Image.open(f).convert('RGB').resize((tw, th))
    ImageDraw.Draw(im).text((6, 6), f[-8:-4], fill=(255, 255, 0))
    sheet.paste(im, ((i % cols) * tw, (i // cols) * th))
sheet.save(out)
print(out, len(fs), 'tiles')
