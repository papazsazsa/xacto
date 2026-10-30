#!/usr/bin/env python3
"""Blind A/B compare: python3 tools/compare.py <dirA> <dirB> <outDir> [keyFile]
Pairs images with the same filename, randomly assigns them to LEFT/RIGHT, writes side-by-side
composites to outDir and the hidden answer key to keyFile (default /home/claude/.abkeys/<outDir name>.json).
Critics must NOT read the key file."""
import sys, os, json, random
from PIL import Image, ImageDraw
a, b, out = sys.argv[1], sys.argv[2], sys.argv[3]
key = sys.argv[4] if len(sys.argv) > 4 else os.path.join('/home/claude/.abkeys', os.path.basename(os.path.normpath(out)) + '.json')
os.makedirs(out, exist_ok=True); os.makedirs(os.path.dirname(key), exist_ok=True)
fa = {f for f in os.listdir(a) if f.endswith('.png')}; fb = {f for f in os.listdir(b) if f.endswith('.png')}
names = sorted(fa & fb); answers = {}
for n in names:
    ia, ib = Image.open(os.path.join(a, n)).convert('RGB'), Image.open(os.path.join(b, n)).convert('RGB')
    h = min(ia.height, ib.height); ia = ia.resize((ia.width * h // ia.height, h)); ib = ib.resize((ib.width * h // ib.height, h))
    flip = random.random() < 0.5
    L, R = (ib, ia) if flip else (ia, ib)
    canvas = Image.new('RGB', (L.width + R.width + 20, h + 40), (40, 40, 40)); canvas.paste(L, (0, 40)); canvas.paste(R, (L.width + 20, 40))
    d = ImageDraw.Draw(canvas); d.text((10, 12), 'LEFT', fill=(255, 255, 0)); d.text((L.width + 30, 12), 'RIGHT', fill=(255, 255, 0))
    canvas.save(os.path.join(out, n)); answers[n] = {'LEFT': 'B' if flip else 'A', 'RIGHT': 'A' if flip else 'B'}
json.dump(answers, open(key, 'w'), indent=1)
print(f'{len(names)} pairs -> {out}; key hidden')
