#!/usr/bin/env python3
"""Cosmic Rain — procedural synthwave score for the muon telescope frame assembly video.

Everything is synthesised from scratch with numpy/scipy/numba:
  * drums (808-ish kick, gated-reverb snare, claps, hats, toms, crashes, risers)
  * octave bass, supersaw pads, a plucky arpeggiator, a saw lead
  * robot vocals: espeak-ng speaks each word, and a 24-band channel vocoder re-sings it on the
    melody from song.json (time-stretched per syllable), with a harmony voice in the choruses
  * assembly Foley (T-nut clinks, hex-key ratchets, whooshes, muon zaps) placed from
    build/cues.json, which is exported from the video choreography so sound and picture match.

Outputs build/audio.wav (44.1 kHz stereo) and build/timeline.json (kick/snare times for the
visuals).
"""
import json
import os
import re
import subprocess
import sys
import tempfile

import numba
import numpy as np
from scipy import signal
from scipy.io import wavfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SR = 44100
SONG = json.load(open(os.path.join(ROOT, 'song.json')))
SPB = 60.0 / SONG['bpm']
TOTAL_BEATS = SONG['totalBeats']
TAIL = 2.5
N = int((TOTAL_BEATS * SPB + TAIL) * SR)
RNG = np.random.default_rng(1912)


def b2s(beat):
    """beats -> sample index"""
    return int(round(beat * SPB * SR))


def bar_of(beat):
    return int(beat // 4)


def hz(m):
    return 440.0 * 2 ** ((np.asarray(m, dtype=np.float64) - 69) / 12)


def section(bar):
    for s in SONG['sections']:
        if s['bar'] <= bar < s['bar'] + s['bars']:
            return s['name']
    return 'end'


# ------------------------------------------------------------------------------ DSP kernels
@numba.njit(cache=True)
def svf_lp(x, fc, q):
    """Time-varying zero-delay-feedback state-variable low-pass (cutoff per sample)."""
    n = x.size
    y = np.zeros(n)
    ic1 = 0.0
    ic2 = 0.0
    k = 1.0 / q
    for t in range(n):
        f = fc[t]
        if f > 0.45 * SR:
            f = 0.45 * SR
        g = np.tan(np.pi * f / SR)
        a1 = 1.0 / (1.0 + g * (g + k))
        a2 = g * a1
        a3 = g * a2
        v3 = x[t] - ic2
        v1 = a1 * ic1 + a2 * v3
        v2 = ic2 + a2 * ic1 + a3 * v3
        ic1 = 2.0 * v1 - ic1
        ic2 = 2.0 * v2 - ic2
        y[t] = v2
    return y


@numba.njit(cache=True)
def freeverb_ch(x, combs, aps, fb, damp):
    n = x.size
    out = np.zeros(n)
    nc = combs.size
    na = aps.size
    coff = np.zeros(nc, np.int64)
    aoff = np.zeros(na, np.int64)
    s = 0
    for i in range(nc):
        coff[i] = s
        s += combs[i]
    cb = np.zeros(s)
    s = 0
    for i in range(na):
        aoff[i] = s
        s += aps[i]
    ab = np.zeros(s)
    ci = np.zeros(nc, np.int64)
    ai = np.zeros(na, np.int64)
    filt = np.zeros(nc)
    for t in range(n):
        inp = x[t] * 0.015
        acc = 0.0
        for i in range(nc):
            j = coff[i] + ci[i]
            y = cb[j]
            filt[i] = y * (1.0 - damp) + filt[i] * damp
            cb[j] = inp + filt[i] * fb
            ci[i] += 1
            if ci[i] >= combs[i]:
                ci[i] = 0
            acc += y
        for i in range(na):
            j = aoff[i] + ai[i]
            bo = ab[j]
            y = -acc + bo
            ab[j] = acc + bo * 0.5
            ai[i] += 1
            if ai[i] >= aps[i]:
                ai[i] = 0
            acc = y
        out[t] = acc
    return out


def reverb(st, room=0.86, damp=0.35):
    combs = np.array([1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], np.int64)
    aps = np.array([556, 441, 341, 225], np.int64)
    l = freeverb_ch(st[0], combs, aps, room, damp)
    r = freeverb_ch(st[1], combs + 23, aps + 23, room, damp)
    return np.stack([l, r]) * 3.0


@numba.njit(cache=True)
def pingpong(xl, xr, d, fb, lp):
    n = xl.size
    bl = np.zeros(d)
    br = np.zeros(d)
    ol = np.zeros(n)
    orr = np.zeros(n)
    sl = 0.0
    sr = 0.0
    i = 0
    for t in range(n):
        yl = bl[i]
        yr = br[i]
        sl += lp * (yl - sl)
        sr += lp * (yr - sr)
        bl[i] = 0.5 * (xl[t] + xr[t]) + sr * fb
        br[i] = sl * fb
        ol[t] = yl
        orr[t] = yr
        i += 1
        if i >= d:
            i = 0
    return ol, orr


def delay(st, beats, fb=0.35, lp=0.35):
    l, r = pingpong(st[0], st[1], b2s(beats), fb, lp)
    return np.stack([l, r])


def blep(ph, dt):
    y = np.zeros_like(ph)
    m = ph < dt
    t = ph[m] / dt[m]
    y[m] = t + t - t * t - 1
    m = ph > 1 - dt
    t = (ph[m] - 1) / dt[m]
    y[m] = t * t + t + t + 1
    return y


def osc_saw(freq, n, ph0=None):
    f = np.broadcast_to(np.asarray(freq, dtype=np.float64), (n,))
    dt = np.clip(f / SR, 1e-6, 0.49)
    ph = ((RNG.random() if ph0 is None else ph0) + np.cumsum(dt)) % 1.0
    return 2 * ph - 1 - blep(ph, dt)


def osc_pulse(freq, n, width=0.5, ph0=None):
    f = np.broadcast_to(np.asarray(freq, dtype=np.float64), (n,))
    dt = np.clip(f / SR, 1e-6, 0.49)
    ph = ((RNG.random() if ph0 is None else ph0) + np.cumsum(dt)) % 1.0
    ph2 = (ph + width) % 1.0
    return (2 * ph - 1 - blep(ph, dt)) - (2 * ph2 - 1 - blep(ph2, dt))


def env_adsr(n, a, d, s, r_start=None, r=0.05):
    t = np.arange(n) / SR
    e = np.where(t < a, t / max(a, 1e-4), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-4)))
    if r_start is not None:
        rs = int(r_start * SR)
        if rs < n:
            e[rs:] *= np.exp(-(np.arange(n - rs) / SR) / r)
    return e


def sos(kind, f, order=2):
    return signal.butter(order, f, btype=kind, fs=SR, output='sos')


def filt(x, kind, f, order=2):
    return signal.sosfilt(sos(kind, f, order), x)


def pan2(x, p):
    p = np.clip(p, -1, 1)
    a = (p + 1) * np.pi / 4
    return np.stack([x * np.cos(a), x * np.sin(a)])


def noise(n):
    return RNG.standard_normal(n)


class Stem:
    def __init__(self, name):
        self.name = name
        self.x = np.zeros((2, N))

    def add(self, sig, beat_or_sample, gain=1.0, pan=0.0, samples=False):
        s = beat_or_sample if samples else b2s(beat_or_sample)
        if sig.ndim == 1:
            sig = pan2(sig, pan)
        if s < 0:
            sig = sig[:, -s:]
            s = 0
        e = min(N, s + sig.shape[1])
        if e > s:
            self.x[:, s:e] += sig[:, : e - s] * gain


# ------------------------------------------------------------------------------ harmony
PC = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}


def chord_pcs(name):
    root = PC[name[0]]
    minor = name.endswith('m')
    return root, [root, (root + (3 if minor else 4)) % 12, (root + 7) % 12]


def closest(pc, target):
    return min((pc + 12 * k for k in range(0, 10)), key=lambda m: abs(m - target))


CHORDS = SONG['chords']


# ------------------------------------------------------------------------------ drums
def kick_sample():
    n = int(0.55 * SR)
    t = np.arange(n) / SR
    f = 46 + 120 * np.exp(-t / 0.032) + 30 * np.exp(-t / 0.004)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.3)
    click = filt(noise(n), 'bandpass', [1500, 7000]) * np.exp(-t / 0.004) * 0.5
    return np.tanh((body + click) * 1.8) * 0.95


def snare_sample():
    n = int(0.5 * SR)
    t = np.arange(n) / SR
    tone = (np.sin(2 * np.pi * 186 * t) + 0.6 * np.sin(2 * np.pi * 332 * t)) * np.exp(-t / 0.06)
    nz = filt(noise(n), 'bandpass', [1200, 9000]) * np.exp(-t / 0.16)
    dry = tone * 0.55 + nz * 0.9
    # 80s gated reverb: dense noise IR held for 240 ms then cut
    ir_n = int(0.3 * SR)
    ti = np.arange(ir_n) / SR
    ir = noise(ir_n) * np.where(ti < 0.24, 1.0 - ti * 1.2, 0.0) * np.exp(-ti / 0.5)
    ir = filt(ir, 'lowpass', 7000) * 0.06
    wet = signal.fftconvolve(dry, ir)[:n]
    x = dry + wet * 1.3
    return x / np.max(np.abs(x))


def clap_sample():
    n = int(0.4 * SR)
    t = np.arange(n) / SR
    env = np.zeros(n)
    for k, d in enumerate([0, 0.011, 0.022, 0.034]):
        m = t >= d
        env[m] += np.exp(-(t[m] - d) / (0.008 if k < 3 else 0.14))
    x = filt(noise(n), 'bandpass', [900, 4500]) * env
    return x / np.max(np.abs(x))


def metallic(n, base=1.0):
    t = np.arange(n) / SR
    freqs = np.array([205.3, 304.4, 369.6, 522.7, 540.0, 800.0]) * 2.6 * base
    x = sum(np.sign(np.sin(2 * np.pi * f * t + RNG.random() * 6)) for f in freqs)
    return x


def hat_sample(open_=False):
    n = int((0.6 if open_ else 0.12) * SR)
    t = np.arange(n) / SR
    x = metallic(n) * 0.5 + noise(n)
    x = filt(x, 'highpass', 7000, 4)
    x *= np.exp(-t / (0.22 if open_ else 0.035))
    return x / np.max(np.abs(x))


def crash_sample():
    n = int(2.6 * SR)
    t = np.arange(n) / SR
    out = []
    for ch in range(2):
        x = metallic(n, 1.0 + 0.03 * ch) * 0.4 + noise(n)
        x = filt(x, 'highpass', 4500, 2) * (np.exp(-t / 0.9) * (1 - np.exp(-t / 0.002)))
        out.append(x / np.max(np.abs(x)))
    return np.stack(out)


def tom_sample(f0):
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    f = f0 * (1 + 0.6 * np.exp(-t / 0.05))
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.22)
    x += filt(noise(n), 'bandpass', [300, 3000]) * np.exp(-t / 0.03) * 0.3
    return np.tanh(x * 1.4)


def riser(beats, up=True):
    n = b2s(beats)
    t = np.arange(n) / n
    fc = 300 * (30 ** t) if up else 8000 * (0.04 ** t)
    x = svf_lp(noise(n), fc, 3.0) * 0.6
    tone = osc_saw(hz(45 + 36 * t), n) * 0.12
    x = (x + filt(tone, 'lowpass', 5000)) * (t ** 2 if up else (1 - t) ** 2)
    return x


# ------------------------------------------------------------------------------ instruments
def bass_note(m, dur):
    n = int((dur + 0.08) * SR)
    f = hz(m)
    x = osc_saw(f, n) * 0.6 + osc_saw(f * 1.004, n) * 0.5 + np.sin(2 * np.pi * f * np.arange(n) / SR) * 0.7
    e = env_adsr(n, 0.004, 0.18, 0.55, dur, 0.03)
    fc = 140 + 1400 * env_adsr(n, 0.002, 0.07, 0.12)
    x = svf_lp(x, fc, 1.1)
    return np.tanh(x * 1.5) * e


def pad_chord(notes, dur, bright):
    n = int((dur + 1.2) * SR)
    out = np.zeros((2, n))
    for m in notes:
        for v in range(5):
            det = (v - 2) * 0.09
            x = osc_saw(hz(m + det), n)
            out += pan2(x, (v - 2) * 0.35) * 0.22
    e = env_adsr(n, 0.35, 1.0, 1.0, dur, 0.55)
    fc = np.full(n, bright)
    out = np.stack([svf_lp(out[0], fc, 0.9), svf_lp(out[1], fc, 0.9)]) * e
    return out


def arp_note(m, dur, bright):
    n = int((dur + 0.25) * SR)
    f = hz(m)
    x = osc_pulse(f, n, 0.28) * 0.5 + osc_saw(f * 1.003, n) * 0.35
    e = env_adsr(n, 0.002, 0.11, 0.0)
    fc = 250 + bright * (0.15 + 0.85 * env_adsr(n, 0.001, 0.09, 0.0))
    return svf_lp(x, fc, 2.2) * e


def lead_note(m, dur, prev=None):
    n = int((dur + 0.3) * SR)
    t = np.arange(n) / SR
    glide = hz(prev) if prev is not None else hz(m)
    f = hz(m) + (glide - hz(m)) * np.exp(-t / 0.03)
    vib = 1 + 0.006 * np.sin(2 * np.pi * 5.4 * t) * np.clip((t - 0.18) / 0.2, 0, 1)
    x = osc_saw(f * vib, n) * 0.5 + osc_saw(f * vib * 1.006, n) * 0.4 + osc_pulse(f * vib * 0.5, n, 0.5) * 0.25
    e = env_adsr(n, 0.01, 0.3, 0.75, dur, 0.12)
    fc = 900 + 3200 * env_adsr(n, 0.005, 0.25, 0.35)
    return svf_lp(x, fc, 1.3) * e


def ping_note(m):
    n = int(0.9 * SR)
    t = np.arange(n) / SR
    f = hz(m)
    x = np.sin(2 * np.pi * f * t + 1.2 * np.sin(2 * np.pi * f * 2.01 * t) * np.exp(-t / 0.05))
    return x * np.exp(-t / 0.28) * (1 - np.exp(-t / 0.002))


# ------------------------------------------------------------------------------ foley / sfx
def sfx_clink(pitch=0):
    n = int(0.5 * SR)
    t = np.arange(n) / SR
    f0 = 2100 * 2 ** (pitch / 12 * 2)
    x = sum(a * np.sin(2 * np.pi * f0 * r * t) * np.exp(-t / d) for r, a, d in [(1, 1, 0.16), (2.76, 0.6, 0.08), (5.4, 0.35, 0.04), (8.93, 0.2, 0.02)])
    x += filt(noise(n), 'highpass', 3000) * np.exp(-t / 0.003) * 0.6
    return x * 0.5


def sfx_clank():
    n = int(0.8 * SR)
    t = np.arange(n) / SR
    f0 = 690 + RNG.random() * 60
    x = sum(a * np.sin(2 * np.pi * f0 * r * t) * np.exp(-t / d) for r, a, d in [(1, 1, 0.25), (1.51, 0.7, 0.18), (2.37, 0.5, 0.1), (3.9, 0.3, 0.06)])
    x += np.sin(2 * np.pi * 90 * t) * np.exp(-t / 0.08) * 1.2
    x += filt(noise(n), 'bandpass', [800, 6000]) * np.exp(-t / 0.01) * 0.8
    return x * 0.45


def sfx_ratchet():
    n = int(0.4 * SR)
    x = np.zeros(n)
    for k in range(7):
        s = int((0.012 + k * 0.042 + RNG.random() * 0.006) * SR)
        m = int(0.02 * SR)
        tt = np.arange(m) / SR
        click = filt(noise(m), 'highpass', 2500) * np.exp(-tt / 0.0025) + np.sin(2 * np.pi * 3300 * tt) * np.exp(-tt / 0.006) * 0.5
        x[s:s + m] += click * (0.7 + 0.3 * RNG.random())
    return x * 0.55


def sfx_whoosh(pan):
    n = int(0.9 * SR)
    t = np.arange(n) / n
    fc = 350 * (8 ** np.sin(np.pi * t * 0.9))
    x = svf_lp(noise(n), fc, 1.6)
    e = np.sin(np.pi * t) ** 2
    l = x * e * (0.5 + 0.5 * (1 - t) * (pan > 0) + 0.5 * t * (pan <= 0))
    r = x * e * (0.5 + 0.5 * t * (pan > 0) + 0.5 * (1 - t) * (pan <= 0))
    return np.stack([l, r]) * 0.5


def sfx_impact():
    n = int(0.9 * SR)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * np.cumsum(55 + 80 * np.exp(-t / 0.04)) / SR) * np.exp(-t / 0.25)
    x += filt(noise(n), 'lowpass', 1800) * np.exp(-t / 0.03) * 0.6
    return np.tanh(x * 1.3) * 0.6


def sfx_thunk():
    n = int(0.8 * SR)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * np.cumsum(45 + 70 * np.exp(-t / 0.05)) / SR) * np.exp(-t / 0.3)
    x += filt(noise(n), 'lowpass', 500) * np.exp(-t / 0.05) * 0.8
    x += sfx_clank()[:n] * 0.5
    return np.tanh(x * 1.5) * 0.7


def sfx_thud():
    n = int(0.4 * SR)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * np.cumsum(70 + 60 * np.exp(-t / 0.03)) / SR) * np.exp(-t / 0.1)
    x += filt(noise(n), 'lowpass', 900) * np.exp(-t / 0.02) * 0.5
    return x * 0.6


def sfx_boom():
    n = int(2.2 * SR)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * np.cumsum(32 + 45 * np.exp(-t / 0.12)) / SR) * np.exp(-t / 0.9)
    x += filt(noise(n), 'lowpass', 1200) * np.exp(-t / 0.08) * 0.8
    return np.tanh(x * 1.6) * 0.8


def sfx_scan():
    n = int(1.4 * SR)
    t = np.arange(n) / n
    x = svf_lp(noise(n), 400 * (25 ** t), 4.0) * np.sin(np.pi * t) ** 1.5
    x += np.sin(2 * np.pi * np.cumsum(300 * (6 ** t)) / SR) * np.sin(np.pi * t) ** 2 * 0.15
    return x * 0.35


PENTA = [0, 3, 5, 7, 10]


def penta(i, base=69):
    return base + 12 * (i // 5) + PENTA[i % 5]


def sfx_blip(nidx):
    m = penta(nidx, 69)
    n = int(0.3 * SR)
    t = np.arange(n) / SR
    x = osc_pulse(hz(m), n, 0.5) * np.exp(-t / 0.07)
    return filt(x, 'lowpass', 6000) * 0.35


def sfx_shimmer():
    n = int(2.0 * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for k, m in enumerate([93, 100, 105, 112]):
        s = int(k * 0.07 * SR)
        tt = t[: n - s]
        x[s:] += np.sin(2 * np.pi * hz(m) * tt) * np.exp(-tt / 0.6) * (1 - np.exp(-tt / 0.01))
    return x * 0.18


def sfx_whoomp():
    n = int(0.9 * SR)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * np.cumsum(60 + 160 * np.exp(-t / 0.08)) / SR) * np.exp(-t / 0.22)
    x += filt(noise(n), 'lowpass', 700) * np.exp(-t / 0.06) * 0.4
    return x * 0.6


def sfx_spark(k):
    n = int(1.2 * SR)
    t = np.arange(n) / SR
    f = (1800 * 2 ** (k * 5 / 12)) * np.exp(-t / 0.09) + 250
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.35)
    x += filt(noise(n), 'highpass', 4000) * np.exp(-t / 0.01) * 0.7
    return x * 0.5


def sfx_zap3():
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for k in range(3):
        s = int(k * 0.021 * SR)
        m = int(0.012 * SR)
        x[s:s + m] += filt(noise(m), 'highpass', 5000) * np.exp(-np.arange(m) / SR / 0.002)
    f = 2400 * np.exp(-t / 0.045) + 180
    x += np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.09) * 0.5
    return x * 0.5


# ------------------------------------------------------------------------------ vocoder vocals
NBANDS = int(os.environ.get('VOC_BANDS', 40))  # 40 bands scored best in tools/asr_check.py
BAND_EDGES = np.geomspace(100, 8000, NBANDS + 1)
BANDS = [signal.butter(2, [BAND_EDGES[i], BAND_EDGES[i + 1]], btype='bandpass', fs=SR, output='sos') for i in range(NBANDS)]
ENV_RATE = 441  # envelope frames per second
ENV_LP = signal.butter(2, float(os.environ.get('VOC_ENVLP', 30)), fs=SR, output='sos')
SIB_GLOBAL = os.environ.get('VOC_SIBG', '1') == '1'
OCT_DOWN = float(os.environ.get('VOC_OCT', 0.6))
_word_cache = {}


def espeak(text, speed=150):
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        path = f.name
    subprocess.run(['espeak-ng', '-v', 'en-us', '-s', str(speed), '-p', '40', '-g', '0', '-w', path, text], check=True)
    sr, x = wavfile.read(path)
    os.unlink(path)
    x = x.astype(np.float64) / 32768.0
    x = signal.resample_poly(x, SR, sr)
    # trim silence
    a = np.abs(x)
    idx = np.where(a > 0.02 * a.max())[0]
    x = x[max(0, idx[0] - 200): idx[-1] + 400]
    return x


def word_envelopes(text):
    """Band envelopes (24 x frames), sibilance envelope and vowel region of a spoken word."""
    if text in _word_cache:
        return _word_cache[text]
    x = espeak(text)
    hop = SR // ENV_RATE
    envs = []
    for b in BANDS:
        e = signal.sosfilt(ENV_LP, np.abs(signal.sosfilt(b, x)))
        envs.append(e[::hop])
    envs = np.maximum(np.array(envs), 0)
    sib = np.maximum(signal.sosfilt(ENV_LP, np.abs(filt(x, 'highpass', 4500, 4)))[::hop], 0)
    vb = (BAND_EDGES[:-1] > 200) & (BAND_EDGES[:-1] < 2000)
    voiced = envs[vb].sum(axis=0)
    thr = 0.25 * voiced.max()
    vi = np.where(voiced > thr)[0]
    vs, ve = (vi[0], vi[-1]) if len(vi) else (0, envs.shape[1] - 1)
    res = (envs, sib, vs / ENV_RATE, ve / ENV_RATE, envs.shape[1] / ENV_RATE, envs.max())
    _word_cache[text] = res
    return res


def time_map(u, Dt, Dn, vs, ve):
    """output time u (s) in a word of target length Dt -> native time in the spoken word"""
    if Dt <= Dn or ve - vs < 0.02:
        return u * Dn / Dt
    head, tail = vs, Dn - ve
    mid_out = Dt - head - tail
    return np.where(u < head, u, np.where(u > Dt - tail, ve + (u - (Dt - tail)), vs + (u - head) * (ve - vs) / mid_out))


SCALE = [9, 11, 0, 2, 4, 5, 7]  # A natural minor


def harmony_below(m):
    pc = m % 12
    if pc not in SCALE:
        return m - 4
    i = SCALE.index(pc)
    target = SCALE[(i - 2) % 7]
    d = (pc - target) % 12
    return m - d


def vocode(text, notes, dur, harmony=False):
    """notes: [(t_rel_sec, dur_sec, midi)] inside the word; returns mono vocal and harmony"""
    envs, sib, vs, ve, Dn, emax = word_envelopes(text)
    n = int(dur * SR)
    u = np.arange(n) / SR
    tn = time_map(u, dur, Dn, vs, ve)
    fi = np.clip(tn * ENV_RATE, 0, envs.shape[1] - 1.001)
    i0 = fi.astype(int)
    fr = fi - i0

    def interp(a):
        return a[i0] * (1 - fr) + a[i0 + 1] * fr

    band_env = np.array([interp(e) for e in envs])
    band_env /= max(1e-6, band_env.max())
    sib_env = interp(sib) / (max(1e-6, emax) * 1.2 if SIB_GLOBAL else max(1e-6, sib.max()))

    def carrier(pitches):
        f = np.zeros(n)
        prev = None
        for (t0, d, m) in pitches:
            s0, s1 = int(t0 * SR), min(n, int((t0 + d) * SR) + 1)
            seg = np.full(max(0, s1 - s0), hz(m))
            if prev is not None and seg.size:
                k = np.exp(-np.arange(seg.size) / (0.025 * SR))
                seg = seg + (hz(prev) - hz(m)) * k
            f[s0:s1] = seg
            prev = m
        f[f == 0] = hz(pitches[0][2])
        tt = np.arange(n) / SR
        vib = 1 + 0.005 * np.sin(2 * np.pi * 5.2 * tt) * np.clip((tt - 0.2) / 0.25, 0, 1)
        c = osc_saw(f * vib, n) + OCT_DOWN * osc_saw(f * vib * 0.5 * 1.002, n) + 0.5 * osc_pulse(f * vib * 1.003, n, 0.4)
        c += noise(n) * 0.08
        return c

    def voc(c):
        out = np.zeros(n)
        for k, b in enumerate(BANDS):
            out += signal.sosfilt(b, c) * band_env[k] ** 0.9
        return out

    lead = voc(carrier(notes))
    lead += filt(noise(n), 'highpass', 5000, 4) * sib_env ** 1.2 * 0.9
    fade = np.minimum(1, np.minimum(np.arange(n), n - np.arange(n)) / (0.006 * SR))
    lead *= fade
    harm = None
    if harmony:
        harm = voc(carrier([(a, b, harmony_below(m)) for a, b, m in notes])) * fade
    return lead, harm


def spoken_text(display):
    return re.sub(r"[^A-Za-z0-9'\- ]", '', display).replace('-', ' ').strip()


def build_words():
    """Group syllables into words with absolute timing (beats)."""
    words = []
    for line in SONG['lyrics']:
        cur = None
        for syl in line['syl']:
            txt, off, dur, midi = syl[:4]
            say = syl[4] if len(syl) > 4 else None
            b0 = line['bar'] * 4 + off
            if txt == '~' and cur is not None:
                cur['notes'].append((b0, dur, midi))
                continue
            cur = {'text': say or spoken_text(txt), 'notes': [(b0, dur, midi)], 'harmony': bool(line.get('harmony'))}
            words.append(cur)
    return words


# ------------------------------------------------------------------------------ arrangement
def vox_only():
    stem = Stem('vox')
    for w in build_words():
        start = w['notes'][0][0]
        end = w['notes'][-1][0] + w['notes'][-1][1]
        notes = [((b - start) * SPB, d * SPB, m) for b, d, m in w['notes']]
        lead, _ = vocode(w['text'], notes, (end - start - 0.06) * SPB, False)
        stem.add(lead, start, 1.0, 0.0)
    stem.x *= 0.5 / np.abs(stem.x).max()
    wavfile.write(os.path.join(ROOT, 'build', 'stem_vox.wav'), SR, (stem.x.T * 32767).astype(np.int16))


def main():
    if '--vox-only' in sys.argv:
        return vox_only()
    stems = {k: Stem(k) for k in ['kick', 'snare', 'hats', 'perc', 'bass', 'pad', 'arp', 'lead', 'vox', 'harm', 'sfx', 'fx']}
    kicks, snares = [], []
    K, S, CL = kick_sample(), snare_sample(), clap_sample()
    HC, HO, CR = hat_sample(), hat_sample(True), crash_sample()

    def kick(b, g=1.0):
        stems['kick'].add(K, b, g)
        kicks.append(b * SPB)

    def snare(b, g=1.0, clap=False):
        stems['snare'].add(S, b, g, 0.05)
        if clap:
            stems['snare'].add(CL, b, 0.55 * g, -0.1)
        snares.append(b * SPB)

    def crash(b, g=0.55):
        stems['perc'].add(CR, b, g)

    total_bars = TOTAL_BEATS // 4
    for bar in range(total_bars):
        sec = section(bar)
        b0 = bar * 4
        chord = CHORDS[min(bar, len(CHORDS) - 1)]
        root, pcs = chord_pcs(chord)
        in_sec = bar - next(s['bar'] for s in SONG['sections'] if s['name'] == sec)

        # ---------------- drums
        full = sec in ('parts', 'verse1', 'pre', 'chorus1', 'verse2', 'chorus2') or (sec == 'outro' and in_sec < 4)
        chorus = sec in ('chorus1', 'chorus2')
        if sec == 'intro' and in_sec >= 4:
            for k in range(4):
                kick(b0 + k, 0.8)
            for k in range(4):
                stems['hats'].add(HC, b0 + k + 0.5, 0.25, 0.3)
            if in_sec == 7:
                for k in range(8):
                    snare(b0 + 2 + k * 0.25, 0.25 + 0.06 * k)
        if full:
            for k in range(4):
                kick(b0 + k)
            snare(b0 + 1, 1.0, clap=chorus)
            snare(b0 + 3, 1.0, clap=chorus)
            step = 0.25 if sec in ('verse1', 'verse2', 'chorus1', 'chorus2', 'pre') else 0.5
            for k in np.arange(0, 4, step):
                acc = 0.55 if (k % 1) == 0.5 else 0.32
                stems['hats'].add(HC, b0 + k, acc * (0.85 if step == 0.25 else 1), 0.3 if (k * 4) % 2 else -0.2)
            if chorus:
                for k in range(4):
                    stems['hats'].add(HO, b0 + k + 0.5, 0.28, 0.35)
            if sec == 'pre' and in_sec == 7:
                for k, f0 in enumerate([220, 220, 180, 180, 150, 150, 120, 120]):
                    stems['perc'].add(tom_sample(f0), b0 + 2 + k * 0.25, 0.55, -0.5 + k * 0.14)
        if sec == 'bridge':
            if in_sec < 4:
                snare(b0 + 2, 0.8)
                stems['hats'].add(HC, b0 + 3.5, 0.25, 0.3)
            elif in_sec < 6:
                kick(b0, 0.9)
                kick(b0 + 2.5, 0.7)
                snare(b0 + 2, 0.9)
                for k in np.arange(0, 4, 0.5):
                    stems['hats'].add(HC, b0 + k, 0.35, 0.3)
            elif in_sec == 6:
                for k in range(4):
                    kick(b0 + k)
                for k in range(8):
                    snare(b0 + k * 0.5, 0.3 + 0.05 * k)
            else:  # last bar: tension, only the slow-motion muon and the riser
                for k in range(8):
                    snare(b0 + k * 0.25, 0.35 + 0.05 * k)
        if sec == 'outro' and in_sec >= 4 and in_sec < 6:
            for k in range(0, 4, 2):
                kick(b0 + k, 0.6)
            for k in np.arange(0, 4, 0.5):
                stems['hats'].add(HC, b0 + k, 0.2, 0.3)
        if bar in (8, 16, 24, 32, 36, 40, 56, 60, 64):
            crash(b0, 0.6 if bar in (32, 56) else 0.45)

        # ---------------- bass
        low = closest(root, 33)
        if sec == 'intro' and in_sec < 4 or sec == 'bridge' and in_sec < 4 or sec == 'outro' and in_sec >= 6:
            stems['bass'].add(bass_note(low, 4 * SPB - 0.05), b0, 0.8)
        elif sec == 'pre':
            for k in np.arange(0, 4, 0.25):
                stems['bass'].add(bass_note(low + (12 if k % 1 == 0.5 else 0), 0.25 * SPB * 0.8), b0 + k, 0.75)
        elif sec == 'bridge' and in_sec == 7:
            stems['bass'].add(bass_note(low, 1.5 * SPB), b0, 0.8)
        else:
            for k in np.arange(0, 4, 0.5):
                m = low + (12 if (k * 2) % 2 == 1 else 0)
                stems['bass'].add(bass_note(m, 0.5 * SPB * 0.85), b0 + k, 0.8)

        # ---------------- pad
        notes = sorted(closest(pc, 62) for pc in pcs) + [closest(root, 50)]
        bright = {'intro': 350 + 2200 * (bar / 8) ** 1.5, 'parts': 2200, 'verse1': 1800, 'pre': 2600, 'chorus1': 3800,
                  'verse2': 1900, 'bridge': 1400 + 300 * in_sec, 'chorus2': 4200, 'outro': max(600, 3000 - in_sec * 300)}.get(sec, 2000)
        stems['pad'].add(pad_chord(notes, 4 * SPB, bright), b0, 1.0)

        # ---------------- arp
        arp_on = (sec == 'intro' and in_sec >= 2) or sec in ('parts', 'verse1', 'pre', 'chorus1', 'verse2', 'chorus2') \
            or (sec == 'bridge' and in_sec >= 4 and in_sec < 7) or (sec == 'outro' and in_sec < 7)
        if arp_on:
            tones = [m for m in range(64, 89) if m % 12 in pcs]
            seq = tones + tones[-2:0:-1]
            a_bright = {'intro': 900 + 500 * in_sec, 'verse1': 2200, 'verse2': 2400, 'pre': 2500 + 400 * in_sec,
                        'chorus1': 5200, 'chorus2': 5600, 'bridge': 1800 + 800 * (in_sec - 4)}.get(sec, 3500)
            gain = {'verse1': 0.7, 'verse2': 0.75, 'intro': 0.6 + 0.08 * in_sec}.get(sec, 1.0)
            for k in range(16):
                m = seq[(bar * 16 + k) % len(seq)]
                stems['arp'].add(arp_note(m, 0.25 * SPB, a_bright), b0 + k * 0.25, gain * (1.0 if k % 4 == 0 else 0.8), 0.25 * np.sin(k * 0.9))

        # ---------------- risers / impacts
        if bar in (7, 31, 55):
            stems['fx'].add(riser(8 if bar != 55 else 6), b0 - 4 if bar != 55 else b0 - 2, 0.9)
        if bar in (32, 56):
            stems['fx'].add(sfx_boom(), b0, 0.8)

    # ---------------- lead: chorus doubles the vocal an octave up; outro plays the hook
    def lead_line(line_bar, at_bar, octave=12, gain=1.0):
        line = next(l for l in SONG['lyrics'] if l['bar'] == line_bar)
        prev = None
        for syl in line['syl']:
            _, off, dur, m = syl[:4]
            stems['lead'].add(lead_note(m + octave, dur * SPB * 0.95, prev), at_bar * 4 + off, gain)
            prev = m + octave
    for lb in (32, 34, 36, 38, 56, 58, 60, 62):
        lead_line(lb, lb, 12, 0.35)
    lead_line(32, 68, 12, 1.0)
    lead_line(38, 70, 12, 1.0)

    # ---------------- vocals
    words = build_words()
    print(f'vocoding {len(words)} words ...', flush=True)
    for w in words:
        start = w['notes'][0][0]
        end = w['notes'][-1][0] + w['notes'][-1][1]
        dur_b = end - start - 0.06
        notes = [((b - start) * SPB, d * SPB, m) for b, d, m in w['notes']]
        lead, harm = vocode(w['text'], notes, dur_b * SPB, w['harmony'])
        stems['vox'].add(lead, start, 1.0, 0.0)
        if harm is not None:
            stems['harm'].add(harm, start, 1.0, 0.0)

    # ---------------- muon rain pings + assembly foley from the video choreography
    cues = json.load(open(os.path.join(ROOT, 'build', 'cues.json')))['cues']
    SFX = {
        'clink': lambda c: sfx_clink(c.get('pitch', 0)), 'clank': lambda c: sfx_clank(), 'ratchet': lambda c: sfx_ratchet(),
        'whoosh': lambda c: sfx_whoosh(c.get('pan', 0)), 'impact': lambda c: sfx_impact(), 'thunk': lambda c: sfx_thunk(),
        'thud': lambda c: sfx_thud(), 'boom': lambda c: sfx_boom(), 'scan': lambda c: sfx_scan(), 'blip': lambda c: sfx_blip(c['n']),
        'shimmer': lambda c: sfx_shimmer(), 'whoomp': lambda c: sfx_whoomp(), 'spark': lambda c: sfx_spark(c['pitch']),
        'zap3': lambda c: sfx_zap3(), 'ping': lambda c: ping_note(penta(c['pitch'], 81)) * 0.35,
    }
    GAIN = {'ping': 0.9, 'zap3': 0.8, 'blip': 0.9, 'ratchet': 1.0, 'clink': 0.9, 'whoosh': 0.9}
    for c in cues:
        x = SFX[c['type']](c)
        stems['sfx'].add(x, c['t'], GAIN.get(c['type'], 1.0), float(np.clip(c.get('pan', 0) * 0.7, -0.8, 0.8)))

    # ------------------------------------------------------------------------------ mix
    # stem level targets (RMS dBFS over active parts), measured then normalised
    def active_rms(x):
        m = np.abs(x).max(axis=0)
        blk = 2048
        nb = m.size // blk
        e = (x[:, : nb * blk] ** 2).reshape(2, nb, blk).mean(axis=(0, 2))
        act = e > (e.max() * 1e-3)
        return np.sqrt(e[act].mean()) if act.any() else 1e-9

    targets = {'kick': -17, 'snare': -21, 'hats': -29, 'perc': -27, 'bass': -19, 'pad': -24, 'arp': -26, 'lead': -26,
               'vox': -17.5, 'harm': -24, 'sfx': -25, 'fx': -26}
    for k, st in stems.items():
        r = active_rms(st.x)
        g = 10 ** (targets[k] / 20) / r
        st.x *= g
        print(f'  {k:6s} rms {20*np.log10(r):6.1f} dB -> {targets[k]} dB (gain {20*np.log10(g):+.1f})')

    # sidechain ducking from the kick
    duck = np.ones(N)
    for tk in kicks:
        s = int(tk * SR)
        m = int(0.42 * SR)
        e = min(N, s + m)
        tt = np.arange(e - s) / SR
        duck[s:e] = np.minimum(duck[s:e], 1 - 0.55 * np.exp(-tt / 0.11) * np.clip(tt / 0.004, 0, 1))
    for k in ('pad', 'bass', 'arp'):
        stems[k].x *= duck ** (0.6 if k == 'bass' else 1.0)

    # vocal bus: tone + compression
    v = stems['vox'].x + stems['harm'].x * np.array([[0.8], [1.0]])
    v = np.stack([filt(v[0], 'highpass', 140), filt(v[1], 'highpass', 140)])
    pk = signal.iirpeak(3000, 1.2, fs=SR)
    v += np.stack([signal.lfilter(*pk, v[0]), signal.lfilter(*pk, v[1])]) * 0.35
    env = signal.sosfilt(sos('lowpass', 12), np.abs(v).max(axis=0))
    thr = np.percentile(env[env > 1e-4], 70)
    v *= np.where(env > thr, (thr / np.maximum(env, 1e-9)) ** 0.5, 1.0)

    dry = stems['kick'].x + stems['snare'].x + stems['hats'].x + stems['perc'].x + stems['bass'].x + stems['pad'].x \
        + stems['arp'].x + stems['lead'].x + v + stems['sfx'].x + stems['fx'].x
    print('reverb/delay ...', flush=True)
    rv_send = stems['snare'].x * 0.25 + stems['pad'].x * 0.3 + stems['arp'].x * 0.25 + stems['lead'].x * 0.4 + v * 0.3 \
        + stems['sfx'].x * 0.35 + stems['perc'].x * 0.2 + stems['fx'].x * 0.3
    dl_send = stems['arp'].x * 0.45 + stems['lead'].x * 0.35 + v * 0.22 + stems['sfx'].x * 0.15
    rv = reverb(rv_send)
    rv = np.stack([filt(rv[0], 'highpass', 250), filt(rv[1], 'highpass', 250)])
    dl = delay(dl_send, 0.75, 0.38, 0.4)
    mix = dry + rv * 0.55 + dl * 0.45

    # master: glue compression, soft clip, fades, normalise
    env = signal.sosfilt(sos('lowpass', 8), np.sqrt((mix ** 2).mean(axis=0)))
    thr = 10 ** (-14 / 20)
    gain = np.where(env > thr, (thr / np.maximum(env, 1e-9)) ** (1 - 1 / 2.0), 1.0)
    mix *= gain
    mix = np.stack([filt(mix[0], 'highpass', 22), filt(mix[1], 'highpass', 22)])
    mix /= np.abs(mix).max()
    mix = np.tanh(mix * 1.6) / np.tanh(1.6)
    fade_in = np.clip(np.arange(N) / (0.05 * SR), 0, 1)
    end_s = b2s(TOTAL_BEATS - 2)
    fade_out = np.ones(N)
    fade_out[end_s:] = np.linspace(1, 0, N - end_s) ** 2
    mix *= fade_in * fade_out
    mix *= 10 ** (-0.8 / 20) / np.abs(mix).max()
    rms = np.sqrt((mix ** 2).mean())
    print(f'master: peak -0.8 dBFS, rms {20*np.log10(rms):.1f} dBFS, {N/SR:.1f} s')

    os.makedirs(os.path.join(ROOT, 'build'), exist_ok=True)
    wavfile.write(os.path.join(ROOT, 'build', 'audio.wav'), SR, (mix.T * 32767).astype(np.int16))
    with open(os.path.join(ROOT, 'build', 'timeline.json'), 'w') as f:
        json.dump({'kick': sorted(kicks), 'snare': sorted(snares)}, f)
    if '--stems' in sys.argv:
        for k, st in stems.items():
            wavfile.write(os.path.join(ROOT, 'build', f'stem_{k}.wav'), SR, (np.clip(st.x.T, -1, 1) * 32767).astype(np.int16))
    print('wrote build/audio.wav, build/timeline.json')


if __name__ == '__main__':
    main()
