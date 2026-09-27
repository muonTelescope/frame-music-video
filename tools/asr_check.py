#!/usr/bin/env python3
"""Objective intelligibility check for the vocoded vocals (no listening required).

For every lyric line, the sung vocal (build/stem_vox.wav, from `compose.py --stems`) is cut out
and fed to the pocketsphinx recogniser constrained to a grammar containing *all* lyric lines.
If it picks the right line, the words are intelligible enough to be told apart. The same test is
run on plain espeak speech as a baseline. Also prints free-decoding word recall.
"""
import json, os, re, subprocess, sys, tempfile
import numpy as np
from scipy import signal
from scipy.io import wavfile
from pocketsphinx import Decoder

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
song = json.load(open(os.path.join(ROOT, 'song.json')))
spb = 60 / song['bpm']


def words_of(line):
    out = []
    for syl in line['syl']:
        if syl[0] != '~':
            out.append(syl[4] if len(syl) > 4 else syl[0])
    txt = ' '.join(out).lower().replace('-', ' ')
    return re.sub(r"[^a-z' ]", '', txt).split()


lines = [(l['bar'], words_of(l), l) for l in song['lyrics']]
uniq = sorted({' '.join(w) for _, w, _ in lines})
gram = '#JSGF V1.0;\ngrammar lyr;\npublic <s> = ' + ' | '.join(f'( {u} )' for u in uniq) + ' ;\n'
gpath = os.path.join(tempfile.gettempdir(), 'lyr.gram')
open(gpath, 'w').write(gram)


def pcm16k(x, sr):
    x = signal.resample_poly(x, 16000, sr)
    x = x / (np.abs(x).max() + 1e-9) * 0.7
    return (x * 32767).astype(np.int16).tobytes()


def decode(dec, pcm):
    dec.start_utt(); dec.process_raw(pcm, full_utt=True); dec.end_utt()
    h = dec.hyp()
    return h.hypstr if h else ''


d_gram = Decoder(jsgf=gpath, samprate=16000, loglevel='FATAL')
d_free = Decoder(samprate=16000, loglevel='FATAL')
sr, vox = wavfile.read(os.path.join(ROOT, 'build', 'stem_vox.wav'))
vox = vox.astype(float).mean(axis=1) / 32768

res = {'sung': [0, 0, 0], 'spoken': [0, 0, 0]}
for bar, ref, l in lines:
    t0 = (bar * 4 + l['syl'][0][1] - 0.15) * spb
    t1 = (bar * 4 + max(s[1] + s[2] for s in l['syl']) + 0.3) * spb
    sung = pcm16k(vox[int(t0 * sr):int(t1 * sr)], sr)
    with tempfile.NamedTemporaryFile(suffix='.wav') as f:
        subprocess.run(['espeak-ng', '-v', 'en-us', '-s', '150', '-w', f.name, ' '.join(ref)], check=True)
        ssr, sp = wavfile.read(f.name)
    spoken = pcm16k(sp.astype(float) / 32768, ssr)
    row = []
    for kind, pcm in (('sung', sung), ('spoken', spoken)):
        g = decode(d_gram, pcm)
        fr = decode(d_free, pcm).split()
        ok = g == ' '.join(ref)
        recall = sum(1 for w in ref if w in fr) / len(ref)
        res[kind][0] += ok; res[kind][1] += recall; res[kind][2] += 1
        row.append(f"{'OK ' if ok else 'xx '}{recall:4.0%} [{g[:34]:34s}]")
    print(f"bar {bar:2d} {' '.join(ref)[:34]:34s} | sung {row[0]} | spoken {row[1]}")
for k, (ok, rec, n) in res.items():
    print(f"{k:7s}: grammar line-ID {ok}/{n} = {ok/n:.0%}, free-decoding word recall {rec/n:.0%}")
