// Assembly choreography for "Cosmic Rain".
//
// Everything is expressed in *beats* (112.5 BPM, 16 video frames per beat) and in
// millimetres, following the muonTelescope frame docs:
//   4x 396 mm vertical posts, 16x 150 mm beams (4 rings of 4), a cast angle bracket
//   on each beam end, M5 T-nuts + M5x10 screws, rubber feet on M5x25 screws.
//
// This module is plain data + math (no three.js) so it can run both in the browser
// (to drive the animation) and in Node (to export the sound-effect cue list that the
// audio engine mixes in sync with the picture).

export const BPM = 112.5;
export const FPS = 30;
export const FRAMES_PER_BEAT = (FPS * 60) / BPM; // 16
export const SEC_PER_BEAT = 60 / BPM;

// ---- geometry (mm), frame-local coordinates: posts stand on y = 0 ------------------
export const PROFILE = 20;
export const POST_LEN = 396;
export const HALF = POST_LEN / 2;
export const BEAM_LEN = 150;
export const POST_C = 85; // post centre offset from frame axis (150/2 + 20/2)
export const FOOT_H = 13;
export const RING_Y = [0, 1, 2, 3].map((r) => 10 + (r * (POST_LEN - 20)) / 3);
export const POSTS = [[-85, 85], [85, 85], [85, -85], [-85, -85]];
export const SIDES = [
  { p: [0, 0, 85], ry: 0 },
  { p: [85, 0, 0], ry: -Math.PI / 2 },
  { p: [0, 0, -85], ry: Math.PI },
  { p: [-85, 0, 0], ry: Math.PI / 2 },
];
// beam-local anchor points (beam runs along x, brackets sit on the +y face)
export const END_X = [-75, 75];
export const END_U = [1, -1]; // direction from the post face into the beam
export const BASE_SCREW = (e) => [END_X[e] + END_U[e] * 11, 13, 0];
export const BEAM_NUT = [[64, 6.3], [-64, 6.3], [40, -6.3], [-40, -6.3]]; // [x, y]
export const POST_HOLE_Y = 21;
export const PANEL_RINGS = [1, 2, 3];

const TAU = Math.PI * 2;
const B = (bar, beat = 0) => bar * 4 + beat;

// ---- easing ------------------------------------------------------------------------
export const EASE = {
  linear: (x) => x,
  step: (x) => (x < 1 ? 0 : 1),
  inQuad: (x) => x * x,
  outQuad: (x) => 1 - (1 - x) * (1 - x),
  inCubic: (x) => x * x * x,
  outCubic: (x) => 1 - Math.pow(1 - x, 3),
  inOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  inOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  inOutQuint: (x) => (x < 0.5 ? 16 * x ** 5 : 1 - Math.pow(-2 * x + 2, 5) / 2),
  outBack: (x) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  },
  outBounce: (x) => {
    const n1 = 7.5625, d1 = 2.75;
    if (x < 1 / d1) return n1 * x * x;
    if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
    if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
    return n1 * (x -= 2.625 / d1) * x + 0.984375;
  },
};

// ---- deterministic randomness --------------------------------------------------------
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- tracks --------------------------------------------------------------------------
// A track is a list of keyframes {t, p:[x,y,z], r:[x,y,z] (Euler YXZ), s, o, sp, e}.
// `sp` spins the object's inner mesh about its own local y axis (screws, hex keys).
// The easing `e` of keyframe i+1 shapes the segment i -> i+1. A keyframe may carry
// `orbit` to make the segment that *starts* there follow a circle instead.
const CH = { p: [0, 0, 0], r: [0, 0, 0], s: 1, o: 1, sp: 0 };

function finalize(keys) {
  keys.sort((a, b) => a.t - b.t);
  const out = [];
  let prev = { ...CH };
  for (const k of keys) {
    const n = { ...prev, ...k };
    delete n.orbit;
    if (k.orbit) n.orbit = k.orbit;
    out.push(n);
    prev = { p: n.p, r: n.r, s: n.s, o: n.o, sp: n.sp };
  }
  return out;
}

const lerp = (a, b, x) => a + (b - a) * x;
const lerp3 = (a, b, x) => [lerp(a[0], b[0], x), lerp(a[1], b[1], x), lerp(a[2], b[2], x)];

export function orbitPose(o, t) {
  const a = o.a0 + o.w * (t - o.t0);
  return {
    p: [o.c[0] + o.rad * Math.sin(a), o.y + (o.bob || 0) * Math.sin(a * 2 + o.a0), o.c[2] + o.rad * Math.cos(a)],
    r: [o.tilt || 0, a, 0],
  };
}

export function evalTrack(keys, t) {
  if (!keys || keys.length === 0) return { ...CH };
  if (t <= keys[0].t) return keys[0];
  let i = 0;
  // binary search for the last key with k.t <= t
  let lo = 0, hi = keys.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keys[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  i = lo;
  const a = keys[i];
  if (a.orbit) {
    const op = orbitPose(a.orbit, t);
    return { ...a, p: op.p, r: op.r };
  }
  if (i === keys.length - 1) return a;
  const b = keys[i + 1];
  const x = (EASE[b.e] || EASE.inOutCubic)((t - a.t) / (b.t - a.t));
  return {
    p: lerp3(a.p, b.p, x),
    r: lerp3(a.r, b.r, x),
    s: lerp(a.s, b.s, x),
    o: b.e === 'step' ? a.o : lerp(a.o, b.o, x),
    sp: lerp(a.sp, b.sp, x),
  };
}

// Camera: list of segments evaluated piecewise.
export function evalCamera(segs, t) {
  let seg = segs[0];
  for (const s of segs) if (t >= s.t0) seg = s;
  const x = Math.min(1, Math.max(0, (t - seg.t0) / (seg.t1 - seg.t0)));
  const k = (EASE[seg.e] || EASE.inOutCubic)(x);
  if (seg.orbit) {
    const o = seg.orbit;
    const a = lerp(o.a0, o.a1, k);
    const rad = lerp(o.r0, o.r1, k);
    return {
      p: [rad * Math.sin(a), lerp(o.y0, o.y1, k), rad * Math.cos(a)],
      tg: lerp3(o.tg0, o.tg1 || o.tg0, k),
      fov: o.fov || 35,
    };
  }
  return { p: lerp3(seg.from.p, seg.to.p, k), tg: lerp3(seg.from.tg, seg.to.tg, k), fov: lerp(seg.from.fov || 35, seg.to.fov || 35, k) };
}

// beam-local point -> frame-local point for the beam at ring r, side s
export function beamToFrame(r, s, q) {
  let [x, y, z] = q;
  if (r !== 0) { y = -y; z = -z; }
  const th = SIDES[s].ry, c = Math.cos(th), sn = Math.sin(th);
  return [c * x + sn * z + SIDES[s].p[0], y + RING_Y[r], -sn * x + c * z + SIDES[s].p[2]];
}
export function beamFinal(r, s) {
  return { p: [SIDES[s].p[0], RING_Y[r], SIDES[s].p[2]], r: [r === 0 ? 0 : Math.PI, SIDES[s].ry, 0] };
}

// ---- the parts parade ----------------------------------------------------------------
export const BOM = [
  { n: 4, name: '2020 EXTRUSION · 396 mm', spec: 'Misumi KHFS5-2020 · vertical post', part: 'post' },
  { n: 16, name: '2020 EXTRUSION · 150 mm', spec: 'horizontal beam · 4 per ring', part: 'beam' },
  { n: 64, name: 'CAST ANGLE BRACKET', spec: 'Misumi HBLFSNF5', part: 'bracket' },
  { n: 156, name: 'M5 T-NUT', spec: 'Misumi HNKK5-5', part: 'tnut' },
  { n: 128, name: 'M5 × 10 SOCKET CAP', spec: 'McMaster 91292A124', part: 'm5x10' },
  { n: 4, name: 'M5 × 25 SOCKET CAP', spec: 'McMaster 91292A129', part: 'm5x25' },
  { n: 4, name: 'ROUND RUBBER BUMPER', spec: 'McMaster 9540K717', part: 'foot' },
  { n: 1, name: '4 mm HEX KEY', spec: 'the only tool you need', part: 'hexkey' },
];

// ---- build -----------------------------------------------------------------------------
export function buildChoreo() {
  const T = {}; // id -> keyframes
  const flashes = {}; // id -> [{t, c, k}]
  const sfx = [];
  const shocks = [];
  const muons = [];
  const key = (id, t, v, e = 'inOutCubic') => { (T[id] ||= []).push({ t, ...v, e }); };
  const flash = (id, t, c = '#7ff6ff', k = 1) => { (flashes[id] ||= []).push({ t, c, k }); };
  const cue = (t, type, o = {}) => sfx.push({ t, type, ...o });
  const hidden = { o: 0, s: 1 };

  // ---------------------------------------------------------------- frame group (world)
  // pivot = frame centre; frame-local y=0 is the post bottoms.
  key('frame', -1, { p: [0, HALF, 0], r: [0, 0, 0] });

  // ---------------------------------------------------------------- hero parts parade
  BOM.forEach((b, i) => {
    const id = `hero${i}`;
    const t = B(8 + i);
    const home = [-90, 205, 250];
    key(id, -1, { ...hidden, p: [700, 330, 200], r: [0.4, -1.2, 0.3] });
    key(id, t - 0.6, { o: 1, p: [700, 330, 200], r: [0.4, -1.2, 0.3] }, 'step');
    key(id, t + 0.4, { p: home, r: [0.35, 0.2, 0.15] }, 'outBack');
    key(id, t + 3.3, { p: [home[0] + 10, home[1] + 6, home[2]], r: [0.35, 0.2 + 1.9, 0.15] }, 'linear');
    key(id, t + 4.1, { p: [-760, 150, 150], r: [0.2, 3.4, -0.3] }, 'inCubic');
    key(id, t + 4.2, { o: 0 }, 'step');
    cue(t - 0.6, 'whoosh', { pan: 0.5 });
    cue(t + 0.4, 'impact', { pan: -0.1 });
  });

  // ---------------------------------------------------------------- beam assemblies
  const orbitOf = (r, s) => ({ c: [0, 0, 0], rad: 305 + r * 24, y: RING_Y[r] + 70, a0: s * (TAU / 4) + r * 0.55, w: TAU / 36, t0: 92, tilt: 0.08 });
  const wallPos = (n) => [-270 + (n % 4) * 180, 330 - Math.floor(n / 4) * 80, 60];
  const ringStart = (r) => (r === 0 ? B(26) : B(32 + (r - 1) * 2) + 2);

  for (let r = 0; r < 4; r++) {
    for (let s = 0; s < 4; s++) {
      const id = `beam${r}${s}`;
      const n = r * 4 + s;
      const fin = beamFinal(r, s);
      const orb = orbitOf(r, s);
      const arrive = r === 0 ? B(26) + s : ringStart(r) + 0.5 * s;
      const depart = arrive - (r === 0 ? 1.6 : 1.3);
      const hover = { p: [fin.p[0] * 1.9, fin.p[1] + 150, fin.p[2] * 1.9], r: fin.r };

      if (n === 0) {
        // the demo beam of steps 1 & 2
        key(id, -1, { ...hidden, p: [0, 620, 0], r: [0, 0, 0] });
        key(id, B(15, 2), { o: 1 }, 'step');
        key(id, B(16), { p: [0, 150, 0] }, 'outCubic');
        key(id, B(19, 1), { p: [0, 150, 0], r: [0, 0, 0] });
        key(id, B(20), { p: [0, 165, 0], r: [0, TAU, 0] }, 'inOutCubic');
        key(id, B(20, 1), { p: wallPos(0), r: [0, TAU, 0] }, 'inOutCubic');
        flash(id, B(19, 1), '#ff4fd8', 1.2);
        cue(B(15, 2), 'whoosh', { pan: 0 });
      } else {
        const tApp = B(20) + 0.5 * n;
        key(id, -1, { ...hidden, s: 0.001, p: wallPos(n), r: [0, TAU, 0] });
        key(id, tApp, { o: 1 }, 'step');
        key(id, tApp + 0.5, { s: 1 }, 'outBack');
        flash(id, tApp, '#7ff6ff', 1.3);
        cue(tApp, 'blip', { n, pan: (wallPos(n)[0] / 400) });
      }
      // wall -> orbit
      const o0 = orbitPose(orb, 92);
      key(id, B(22) + 0.12 * n, { p: wallPos(n), r: [0, TAU, 0], s: 1 });
      key(id, 92, { p: o0.p, r: [o0.r[0], o0.r[1] + TAU, 0], orbit: undefined }, 'inOutCubic');
      // orbit (the orbit angle is continuous with TAU offset removed by using a0 in [0, TAU))
      T[id].push({ t: 92.0001, e: 'step', orbit: orb });
      const od = orbitPose(orb, depart);
      key(id, depart, { p: od.p, r: od.r }, 'linear');
      // unwrap yaw so the fly-in does not spin through several turns
      const yawF = fin.r[1] + Math.round((od.r[1] - fin.r[1]) / TAU) * TAU;
      key(id, arrive - 0.35, { p: hover.p, r: [fin.r[0], yawF, 0] }, 'inOutCubic');
      key(id, arrive, { p: fin.p, r: [fin.r[0], yawF, 0] }, 'inCubic');
      flash(id, arrive, '#7ff6ff', 1.4);
      cue(arrive, 'clank', { pan: fin.p[0] / 200 });
      if (s === 0) cue(depart, 'whoosh', { pan: 0 });
    }
  }
  // demo beam: x-ray body while the T-nuts go in
  key('beam00.body', -1, { o: 1 });
  key('beam00.body', B(15, 3), { o: 1 });
  key('beam00.body', B(16), { o: 0.32 });
  key('beam00.body', B(19), { o: 0.32 });
  key('beam00.body', B(19, 2), { o: 1 });

  // children of every beam: brackets, base screws, beam T-nuts (static except the demo)
  for (let r = 0; r < 4; r++) for (let s = 0; s < 4; s++) {
    const pre = `beam${r}${s}`;
    for (let e = 0; e < 2; e++) {
      key(`${pre}.br${e}`, -1, { p: [END_X[e], 10, 0], r: [0, e ? Math.PI : 0, 0] });
      key(`${pre}.bs${e}`, -1, { p: BASE_SCREW(e), r: [0, 0, 0] });
    }
    BEAM_NUT.forEach(([x, y], k) => key(`${pre}.bn${k}`, -1, { p: [x, y, 0], r: [0, 0, 0] }));
  }
  // --- step 1: four T-nuts slide into the demo beam
  BEAM_NUT.forEach(([x, y], k) => {
    const id = `beam00.bn${k}`;
    const t = B(16) + k;
    T[id] = [];
    key(id, -1, { ...hidden, p: [-128, y, 0], r: [0, 0, 0] });
    key(id, t - 0.7, { o: 1 }, 'step');
    key(id, t, { p: [-73, y, 0] }, 'outCubic');
    key(id, t + 1.4, { p: [x, y, 0] }, 'inOutCubic');
    flash(id, t, '#7ff6ff', 0.9);
    cue(t, 'clink', { pan: -0.4, pitch: k });
  });
  // --- step 2: brackets drop, screws + hex key
  for (let e = 0; e < 2; e++) {
    const id = `beam00.br${e}`;
    const t = B(18) + e;
    T[id] = [];
    key(id, -1, { ...hidden, p: [END_X[e], 170, 0], r: [0, e ? Math.PI : 0, 0.6 * (e ? -1 : 1)] });
    key(id, t - 0.8, { o: 1 }, 'step');
    key(id, t, { p: [END_X[e], 10, 0], r: [0, e ? Math.PI : 0, 0] }, 'outBounce');
    flash(id, t, '#7ff6ff', 1.4);
    cue(t, 'clank', { pan: END_X[e] / 150 });
  }
  const screwT = [B(18, 2), B(19) - 0.5];
  for (let e = 0; e < 2; e++) {
    const id = `beam00.bs${e}`;
    const t = screwT[e];
    const [x, y, z] = BASE_SCREW(e);
    T[id] = [];
    key(id, -1, { ...hidden, p: [x, y + 110, z] });
    key(id, t - 0.75, { o: 1 }, 'step');
    key(id, t, { p: [x, y + 7, z] }, 'outCubic');
    key(id, t + 1, { p: [x, y, z], sp: -4 * TAU }, 'inOutCubic');
    flash(id, t + 1, '#7ff6ff', 1.2);
    cue(t, 'ratchet', { pan: x / 150 });
    cue(t + 0.5, 'ratchet', { pan: x / 150 });
  }
  // hex key (child of the demo beam). Tip sits 2.5 mm into the socket.
  {
    const id = 'hexA';
    const tip = (e, dy) => [BASE_SCREW(e)[0], BASE_SCREW(e)[1] + 5 - 2.5 + dy, 0];
    key(id, -1, { ...hidden, p: [-150, 140, 60], r: [0, 0.6, 0] });
    key(id, screwT[0] - 0.6, { o: 1 }, 'step');
    key(id, screwT[0], { p: tip(0, 7), r: [0, 0.6, 0], sp: 0 }, 'outCubic');
    key(id, screwT[0] + 1, { p: tip(0, 0), sp: -4 * TAU }, 'inOutCubic');
    key(id, screwT[1] - 0.2, { p: [0, 60, 0], sp: -4 * TAU }, 'inOutCubic');
    key(id, screwT[1], { p: tip(1, 7), sp: -4 * TAU }, 'outCubic');
    key(id, screwT[1] + 1, { p: tip(1, 0), sp: -8 * TAU }, 'inOutCubic');
    key(id, screwT[1] + 1.8, { p: [160, 160, 80], sp: -8.5 * TAU }, 'inCubic');
    key(id, screwT[1] + 1.85, { o: 0 }, 'step');
  }

  // ---------------------------------------------------------------- posts
  for (let i = 0; i < 4; i++) {
    const id = `post${i}`;
    const [x, z] = POSTS[i];
    const t = B(24) + i;
    key(id, -1, { ...hidden, p: [x, HALF + 1100, z] });
    key(id, t - 1, { o: 1 }, 'step');
    key(id, t, { p: [x, HALF, z] }, 'inCubic');
    flash(id, t, '#ff4fd8', 1.5);
    cue(t, 'thunk', { pan: x / 150 });
    shocks.push({ t, x, z, c: '#ff3fb4', big: 0 });
  }

  // ---------------------------------------------------------------- post T-nuts + screws
  // children of static per-beam anchors (beam-local coordinates)
  for (let r = 0; r < 4; r++) for (let s = 0; s < 4; s++) for (let e = 0; e < 2; e++) {
    const k = 2 * s + e;
    const nutId = `pn${r}${s}${e}`;
    const scrId = `ps${r}${s}${e}`;
    const xe = END_X[e], ue = END_U[e];
    const tn = r === 0 ? B(25) + 0.5 * k : B(32 + (r - 1) * 2) + 0.25 * k;
    const ts = r === 0 ? B(27) + 0.5 * k : B(32 + (r - 1) * 2) + 4 + 0.5 * k;
    // T-nut: flies in along +u, enters the post slot rotated, twists to lock
    key(nutId, -1, { ...hidden, p: [xe + ue * 60, POST_HOLE_Y, 0], r: [Math.PI / 2, 0, Math.PI / 2] });
    key(nutId, tn - 0.45, { o: 1 }, 'step');
    key(nutId, tn, { p: [xe - ue * 6.3, POST_HOLE_Y, 0] }, 'outCubic');
    key(nutId, tn + 0.22, { r: [0, 0, Math.PI / 2] }, 'outBack');
    flash(nutId, tn, '#7ff6ff', 1.5);
    cue(tn, 'clink', { pan: beamToFrame(r, s, [xe, 0, 0])[0] / 150, pitch: k % 4 });
    // screw: through the bracket back plate into the T-nut
    const rz = ue > 0 ? -Math.PI / 2 : Math.PI / 2;
    key(scrId, -1, { ...hidden, p: [xe + ue * 60, POST_HOLE_Y, 0], r: [0, 0, rz] });
    key(scrId, ts - 0.45, { o: 1 }, 'step');
    key(scrId, ts - 0.05, { p: [xe + ue * 10, POST_HOLE_Y, 0] }, 'outCubic');
    key(scrId, ts + 0.42, { p: [xe + ue * 3, POST_HOLE_Y, 0], sp: -3 * TAU }, 'inOutCubic');
    flash(scrId, ts + 0.42, '#7ff6ff', 1.3);
    cue(ts, 'ratchet', { pan: beamToFrame(r, s, [xe, 0, 0])[0] / 150 });
  }

  // ring glow moments
  const ringParts = (r) => {
    const ids = [];
    for (let s = 0; s < 4; s++) {
      ids.push(`beam${r}${s}`);
      for (let e = 0; e < 2; e++) ids.push(`beam${r}${s}.br${e}`, `ps${r}${s}${e}`);
    }
    return ids;
  };
  ringParts(0).forEach((id) => flash(id, B(28), '#ff4fd8', 1.3));
  cue(B(28), 'scan');
  for (let r = 1; r < 4; r++) ringParts(r).forEach((id) => flash(id, B(32 + (r - 1) * 2) + 7.5, '#ff4fd8', 1.0));
  // frame complete: glow sweeps up ring by ring
  for (let r = 0; r < 4; r++) ringParts(r).forEach((id) => flash(id, B(38) + r * 0.5, '#fff27a', 1.4));
  for (let i = 0; i < 4; i++) flash(`post${i}`, B(38) + 2, '#fff27a', 1.2);
  cue(B(38), 'scan');

  // ---------------------------------------------------------------- step 7: flip + feet
  {
    const id = 'frame';
    key(id, B(40), { p: [0, HALF, 0], r: [0, 0, 0] });
    key(id, B(40, 2), { p: [0, 470, 0] }, 'inOutCubic');
    key(id, B(41, 1), { r: [Math.PI, Math.PI / 2, 0] }, 'inOutCubic');
    key(id, B(41, 2), { p: [0, HALF, 0] }, 'inCubic');
    key(id, B(41, 2.5), { p: [0, HALF + 14, 0] }, 'outQuad');
    key(id, B(41, 3), { p: [0, HALF, 0] }, 'inQuad');
    cue(B(40), 'whoosh', { pan: 0 });
    cue(B(41, 2), 'thunk', { pan: 0 });
    shocks.push({ t: B(41, 2), x: 0, z: 0, c: '#ff3fb4', big: 1 });
    // flip back and land on the rubber feet
    key(id, B(44), { p: [0, HALF, 0], r: [Math.PI, Math.PI / 2, 0] });
    key(id, B(44, 2), { p: [0, 470, 0] }, 'inOutCubic');
    key(id, B(45, 1), { r: [TAU, 0, 0] }, 'inOutCubic');
    key(id, B(45, 2), { p: [0, HALF + FOOT_H, 0] }, 'inCubic');
    key(id, B(45, 2.4), { p: [0, HALF + FOOT_H + 10, 0] }, 'outQuad');
    key(id, B(45, 2.8), { p: [0, HALF + FOOT_H, 0] }, 'inQuad');
    cue(B(44), 'whoosh', { pan: 0 });
    cue(B(45, 2), 'boom', { pan: 0 });
    shocks.push({ t: B(45, 2), x: 0, z: 0, c: '#00e5ff', big: 2 });
  }
  for (let i = 0; i < 4; i++) {
    const [x, z] = POSTS[i];
    const tf = B(42) + 0.5 * i;
    key(`foot${i}`, -1, { ...hidden, p: [x, -260, z], r: [0, 0, 0] });
    key(`foot${i}`, tf - 0.7, { o: 1 }, 'step');
    key(`foot${i}`, tf, { p: [x, 0, z] }, 'inCubic');
    flash(`foot${i}`, tf, '#ff4fd8', 1.0);
    cue(tf, 'thud', { pan: x / 150 });
    const ts = B(43) + 0.5 * i;
    key(`fs${i}`, -1, { ...hidden, p: [x, -90, z], r: [Math.PI, 0, 0] });
    key(`fs${i}`, ts - 0.5, { o: 1 }, 'step');
    key(`fs${i}`, ts, { p: [x, -15, z] }, 'outCubic');
    key(`fs${i}`, ts + 0.45, { p: [x, -7, z], sp: 3 * TAU }, 'inOutCubic');
    flash(`fs${i}`, ts + 0.45, '#7ff6ff', 1.2);
    cue(ts, 'ratchet', { pan: x / 150 });
  }
  // blue threadlocker wave (all screws, bottom to top)
  {
    const screws = [];
    for (let i = 0; i < 4; i++) screws.push([`fs${i}`, -10]);
    for (let r = 0; r < 4; r++) for (let s = 0; s < 4; s++) for (let e = 0; e < 2; e++) {
      screws.push([`ps${r}${s}${e}`, RING_Y[r]]);
      screws.push([`beam${r}${s}.bs${e}`, RING_Y[r]]);
    }
    for (const [id, y] of screws) flash(id, B(46) + 0.2 + (y + 10) / 400 * 3.2, '#2f7bff', 2.2);
    cue(B(46), 'scan');
  }

  // ---------------------------------------------------------------- bridge: panels + SiPMs
  for (let k = 0; k < 3; k++) {
    const id = `panel${k}`;
    const yT = RING_Y[PANEL_RINGS[k]];
    const yHover = 600 + 120 * k;
    const tDown0 = B(50) + 1.5 * k;
    const tLand = tDown0 + 3;
    key(id, -1, { ...hidden, s: 0.001, p: [0, yHover, 0], r: [0.42, -0.6, 0.2] });
    key(id, B(48) + 0.5 * k, { o: 1 }, 'step');
    key(id, B(48) + 0.5 * k + 0.8, { s: 1 }, 'outBack');
    key(id, tDown0, { p: [0, yHover + 10, 0], r: [0.3, -0.25, 0.1] }, 'inOutSine');
    key(id, tDown0 + 1.2, { p: [0, 470, 0], r: [0, 0, 0] }, 'inOutCubic');
    key(id, tLand, { p: [0, yT, 0] }, 'inOutCubic');
    flash(id, B(48) + 0.5 * k, '#b14bff', 1.0);
    flash(id, tLand, '#b14bff', 1.4);
    cue(B(48) + 0.5 * k, 'shimmer', { pan: 0 });
    cue(tLand, 'whoomp', { pan: 0 });
    // SiPM / MPPC interface board (child of the panel, panel-local coordinates)
    const mid = `mppc${k}`;
    const tm = B(52) + k;
    key(mid, -1, { ...hidden, p: [51, 70, 51], r: [-Math.PI / 2, Math.PI / 4, 0] });
    key(mid, tm - 0.6, { o: 1 }, 'step');
    key(mid, tm, { p: [51, 7, 51] }, 'outBack');
    flash(mid, tm, '#b6ff5c', 1.5);
    cue(tm, 'clink', { pan: 0.3, pitch: 5 + k });
  }

  // ---------------------------------------------------------------- muons
  const R = rng(1912); // Victor Hess' balloon flight year
  const panelY = PANEL_RINGS.map((r) => RING_Y[r] + FOOT_H); // world heights once on feet
  const mkMuon = (tHit, x, z, v, opts = {}) => {
    const dx = opts.dx ?? (R() - 0.5) * 0.25, dz = opts.dz ?? (R() - 0.5) * 0.25;
    muons.push({ t: tHit, x, z, dx, dz, v, yRef: opts.yRef ?? 0, hitPanels: !!opts.hit, len: opts.len ?? 380, slow: !!opts.slow });
  };
  // intro cosmic rain: dense, all over the sky
  for (let t = 0; t < B(8); t += 0.25) {
    const n = 1 + Math.floor(R() * 3);
    for (let j = 0; j < n; j++) {
      mkMuon(t + R() * 0.25, (R() - 0.5) * 6000, -3800 + R() * 4200, 5200, { len: 900, yRef: 0 });
    }
    if ((t * 2) % 1 === 0 && R() < 0.55) cue(t, 'ping', { pitch: Math.floor(R() * 8), pan: (R() - 0.5) * 1.4 });
  }
  // background rain elsewhere (sparser), bars 8..72
  for (let t = B(8); t < B(72); t += 0.5) {
    if (t >= B(52) && t < B(56)) continue; // keep the slow-motion moment clean
    const n = t >= B(56) ? 3 : t >= B(24) ? 1 : 1;
    for (let j = 0; j < n; j++) {
      let x = (R() - 0.5) * 5000, z = -3500 + R() * 4500;
      if (Math.abs(x) < 300 && Math.abs(z) < 300) x += 800;
      mkMuon(t + R() * 0.5, x, z, 5200, { len: 700 });
    }
  }
  // the slow-motion coincidence: sparks at beats 219, 219.5, 220 (top, middle, bottom panel)
  {
    const v = (panelY[2] - panelY[1]) / 0.5; // mm per beat
    mkMuon(B(55) - 1 + 0, 18, -12, v, { dx: 0.0, dz: 0.0, yRef: panelY[2], hit: true, len: 260, slow: true });
    const last = muons[muons.length - 1];
    last.t = B(54, 3); // head crosses the top panel at "three"
  }
  // final chorus + outro: coincidences on the groove
  const coinc = [];
  const pat = [[0, 1.5, 2, 3], [0, 1, 2.5, 3], [0, 1.5, 2, 3.5], [0, 0.5, 1, 2, 2.5, 3, 3.5]];
  for (let bar = 56; bar < 64; bar++) {
    const p = pat[bar === 63 ? 3 : (bar - 56) % 3];
    for (const bt of p) coinc.push(B(bar, bt));
  }
  for (let bar = 64; bar < 70; bar++) coinc.push(B(bar), B(bar, 2.5));
  coinc.push(B(71));
  for (const tc of coinc) {
    const v = 2600;
    mkMuon(tc, (R() - 0.5) * 70, (R() - 0.5) * 70, v, { yRef: panelY[1], hit: true, len: 950, dx: (R() - 0.5) * 0.12, dz: (R() - 0.5) * 0.12 });
    cue(tc, 'zap3', { pan: (R() - 0.5) * 0.4 });
  }

  // panel flash times from muons that hit
  for (const m of muons) if (m.hitPanels) {
    for (let k = 0; k < 3; k++) {
      const tk = m.t + (m.yRef - panelY[k]) / m.v;
      flash(`panel${k}`, tk, k === 1 ? '#00e5ff' : '#ff3fb4', m.slow ? 2.4 : 1.15);
      if (m.slow) cue(tk, 'spark', { pitch: k, pan: 0 });
    }
  }

  // ---------------------------------------------------------------- camera
  const cam = [];
  let last = null;
  const pose = (p, tg, fov = 35) => ({ p, tg, fov });
  const go = (t0, t1, to, e = 'inOutCubic') => { cam.push({ t0, t1, from: last, to, e }); last = to; };
  const orbit = (t0, t1, o, e = 'linear') => {
    cam.push({ t0, t1, orbit: o, e });
    const a = o.a1, rad = o.r1;
    last = pose([rad * Math.sin(a), o.y1, rad * Math.cos(a)], o.tg1 || o.tg0, o.fov || 35);
  };
  last = pose([0, 260, 1750], [0, 3400, -1400], 40);
  go(0, B(4), pose([0, 330, 1300], [0, 215, 0], 36), 'inOutSine');
  go(B(4), B(7, 2), pose([360, 350, 1060], [0, 205, 0], 35), 'linear');
  go(B(7, 2), B(8, 0.5), pose([0, 245, 900], [0, 200, 0], 35));
  go(B(8, 0.5), B(15, 3), pose([40, 255, 880], [0, 205, 0], 35), 'linear');
  go(B(15, 3), B(16, 2), pose([-205, 205, 165], [-62, 150, 0], 38));
  go(B(16, 2), B(17, 3), pose([-95, 240, 215], [-12, 148, 0], 38), 'linear');
  go(B(17, 3), B(18), pose([10, 285, 240], [0, 152, 0], 38));
  go(B(18), B(19), pose([45, 275, 225], [0, 152, 0], 38), 'linear');
  go(B(19), B(19, 3), pose([0, 225, 320], [0, 158, 0], 36));
  go(B(19, 3), B(20, 2), pose([0, 300, 860], [0, 250, 0], 35));
  go(B(20, 2), B(22), pose([-40, 310, 820], [0, 250, 0], 35), 'linear');
  go(B(22), B(23, 2), pose([720, 540, 980], [0, 210, 0], 35));
  go(B(23, 2), B(25), pose([640, 400, 900], [0, 190, 0], 35), 'linear');
  go(B(25), B(25, 2), pose([430, 190, 540], [0, 55, 0], 36));
  go(B(25, 2), B(26), pose([470, 230, 560], [0, 60, 0], 36), 'linear');
  orbit(B(26), B(28), { a0: 0.7, a1: -0.45, r0: 720, r1: 700, y0: 260, y1: 250, tg0: [0, 60, 0], tg1: [0, 70, 0] });
  orbit(B(28), B(30), { a0: -0.45, a1: -2.1, r0: 700, r1: 880, y0: 250, y1: 420, tg0: [0, 70, 0], tg1: [0, 200, 0] }, 'inOutSine');
  last = pose([880 * Math.sin(-2.1), 420, 880 * Math.cos(-2.1)], [0, 200, 0]);
  go(B(30), B(31, 2), pose([470, 40, 640], [0, 420, 0], 42));
  go(B(31, 2), B(32), pose([700, 250, 440], [0, 150, 0], 36));
  orbit(B(32), B(40), { a0: 1.0, a1: 1.0 + TAU, r0: 830, r1: 980, y0: 260, y1: 560, tg0: [0, 150, 0], tg1: [0, 230, 0] });
  go(B(40), B(41, 3), pose([960, 440, 640], [0, 320, 0], 36));
  go(B(41, 3), B(42, 1), pose([430, 860, 560], [0, 400, 0], 36));
  go(B(42, 1), B(44), pose([380, 900, 430], [0, 410, 0], 36), 'linear');
  go(B(44), B(45, 3), pose([0, 470, 1300], [0, 260, 0], 35));
  orbit(B(46), B(48), { a0: 0, a1: 0.9, r0: 1150, r1: 1050, y0: 470, y1: 430, tg0: [0, 250, 0], tg1: [0, 230, 0] }, 'inOutSine');
  last = pose([1050 * Math.sin(0.9), 430, 1050 * Math.cos(0.9)], [0, 230, 0]);
  go(B(48), B(48, 2), pose([720, 820, 930], [0, 640, 0], 35));
  go(B(48, 2), B(50), pose([650, 780, 860], [0, 620, 0], 35), 'linear');
  go(B(50), B(51, 3), pose([700, 520, 900], [0, 300, 0], 35));
  go(B(51, 3), B(52, 2), pose([175, 545, 100], [48, 405, 48], 38));
  go(B(52, 2), B(53, 3), pose([160, 515, 140], [48, 402, 48], 38), 'linear');
  go(B(53, 3), B(54, 2), pose([470, 680, 640], [0, 290, 0], 36));
  go(B(54, 2), B(55, 1), pose([330, 560, 460], [0, 270, 0], 34), 'inOutSine');
  go(B(55, 1), B(56), pose([900, 380, 700], [0, 230, 0], 36));
  orbit(B(56), B(64), { a0: 0.91, a1: 0.91 + TAU, r0: 1150, r1: 1080, y0: 380, y1: 620, tg0: [0, 230, 0], tg1: [0, 250, 0] });
  go(B(64), B(68), pose([0, 720, 2050], [0, 260, 0], 35), 'inOutSine');
  go(B(68), B(72, 2), pose([0, 1050, 2900], [0, 700, -3000], 38), 'inOutSine');

  // cleanup / finalize
  const tracks = {};
  for (const [id, keys] of Object.entries(T)) tracks[id] = finalize(keys);
  for (const f of Object.values(flashes)) f.sort((a, b) => a.t - b.t);
  sfx.sort((a, b) => a.t - b.t);
  return { tracks, flashes, sfx, shocks, muons, camera: cam, panelY };
}

// flash intensity for an object at time t (sum of decaying pulses) and latest colour
export function flashAt(list, t, decay = 0.45) {
  if (!list) return null;
  let k = 0, c = null;
  for (const f of list) {
    if (f.t > t) break;
    const d = t - f.t;
    if (d < 4) { k += f.k * Math.exp(-d / decay); c = f.c; }
  }
  return k > 0.003 ? { k, c } : null;
}
