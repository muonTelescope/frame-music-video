#!/usr/bin/env python3
"""Write dist/cosmic-rain.srt (lyric subtitles) from the lyric timing in song.json."""
import json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
song = json.load(open(os.path.join(ROOT, 'song.json')))
spb = 60 / song['bpm']


def ts(sec):
    ms = int(round(sec * 1000))
    return f'{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}'


cues = []
for line in song['lyrics']:
    words = [s[0] for s in line['syl'] if s[0] != '~']
    text = re.sub(r'\s+', ' ', ' '.join(words)).strip()
    start = (line['bar'] * 4 + line['syl'][0][1]) * spb
    end = (line['bar'] * 4 + max(s[1] + s[2] for s in line['syl']) + 0.5) * spb
    cues.append([start - 0.15, end, text])
for a, b in zip(cues, cues[1:]):
    a[1] = min(a[1], b[0] - 0.05)

out = os.path.join(ROOT, 'dist', 'cosmic-rain.srt')
with open(out, 'w') as f:
    for i, (s, e, t) in enumerate(cues, 1):
        f.write(f'{i}\n{ts(s)} --> {ts(e)}\n{t}\n\n')
print(f'wrote {out}: {len(cues)} cues')
