// 2D overlay (titles, step badges, BOM, karaoke lyrics, counters) drawn with Canvas2D.
import { BOM } from './choreo.js';

const B = (bar, beat = 0) => bar * 4 + beat;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };
// visibility envelope for [t0, t1] with fade in/out (beats)
const env = (t, t0, t1, fi = 0.5, fo = 0.5) => Math.min(smooth((t - t0) / fi), smooth((t1 - t) / fo));

const CYAN = '#5ff4ff', PINK = '#ff4fd8', YEL = '#ffe45c', VIOLET = '#b14bff';

const STEPS = [
  { n: 1, t0: B(16) - 0.5, t1: B(18), title: 'SLIDE IN THE T-NUTS', chips: ['1× 150 mm BEAM', '4× M5 T-NUT'] },
  { n: 2, t0: B(18), t1: B(20), title: 'BRACKETS ON BOTH ENDS', chips: ['2× ANGLE BRACKET', '2× M5×10'] },
  { n: 3, t0: B(24) - 0.5, t1: B(32), title: 'FOUR POSTS · BOTTOM RING', chips: ['4× 396 mm POST', '8× T-NUT', '8× M5×10'] },
  { n: 4, t0: B(32), t1: B(34), title: 'RING TWO', chips: ['8× T-NUT', '8× M5×10'] },
  { n: 5, t0: B(34), t1: B(36), title: 'RING THREE', chips: ['8× T-NUT', '8× M5×10'] },
  { n: 6, t0: B(36), t1: B(38), title: 'RING FOUR', chips: ['8× T-NUT', '8× M5×10'] },
  { n: 7, t0: B(40), t1: B(46), title: 'FLIP IT · FEET ON', chips: ['4× RUBBER BUMPER', '4× M5×25'] },
];

export class Hud {
  constructor(width, height, song, choreo) {
    this.w = width; this.h = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width; this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    this.song = song;
    this.choreo = choreo;
    this.lines = song.lyrics.map((l) => {
      const words = [];
      for (const [txt, off, dur, midi] of l.syl) {
        const t0 = l.bar * 4 + off;
        if (txt === '~' && words.length) words[words.length - 1].t1 = t0 + dur;
        else words.push({ txt, t0, t1: t0 + dur });
      }
      return { words, t0: words[0].t0, t1: words[words.length - 1].t1 };
    });
    // coincidence times (muons that light all three paddles, excluding the slow-mo one)
    this.coinc = choreo.muons.filter((m) => m.hitPanels && !m.slow).map((m) => m.t).sort((a, b) => a - b);
    this.slowT = (choreo.muons.find((m) => m.slow) || {}).t;
  }

  // ---------------------------------------------------------------- primitives
  text(str, x, y, o = {}) {
    const c = this.ctx;
    c.save();
    c.globalAlpha = o.alpha ?? 1;
    c.font = o.font || '700 40px Orbitron';
    c.textAlign = o.align || 'left';
    c.textBaseline = o.base || 'alphabetic';
    c.letterSpacing = (o.ls || 0) + 'px';
    if (o.rot) { c.translate(x, y); c.rotate(o.rot); x = 0; y = 0; }
    if (o.scale) { c.translate(x, y); c.scale(o.scale, o.scale); x = 0; y = 0; }
    if (o.glow) {
      c.shadowColor = o.glow; c.shadowBlur = o.blur ?? 18;
      c.fillStyle = o.glowFill || o.glow;
      c.fillText(str, x, y);
    }
    c.shadowBlur = o.blur2 ?? 0; c.shadowColor = o.glow || 'transparent';
    if (o.stroke) { c.lineWidth = o.lw || 3; c.strokeStyle = o.stroke; c.strokeText(str, x, y); }
    c.fillStyle = o.fill || '#fff';
    c.fillText(str, x, y);
    c.restore();
  }
  measure(str, font, ls = 0) {
    const c = this.ctx; c.save(); c.font = font; c.letterSpacing = ls + 'px';
    const w = c.measureText(str).width; c.restore(); return w;
  }
  chrome(y0, y1) {
    const g = this.ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.45, '#bfd4ff'); g.addColorStop(0.5, '#4a3aa8');
    g.addColorStop(0.62, '#ff8fe0'); g.addColorStop(1, '#fff4fb');
    return g;
  }
  sunset(y0, y1) {
    const g = this.ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, '#fff27a'); g.addColorStop(0.45, '#ff8a5c'); g.addColorStop(0.75, '#ff3fb4'); g.addColorStop(1, '#b14bff');
    return g;
  }
  line(x0, y0, x1, y1, col, a = 1, w = 3) {
    const c = this.ctx; c.save(); c.globalAlpha = a; c.strokeStyle = col; c.lineWidth = w;
    c.shadowColor = col; c.shadowBlur = 14; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); c.restore();
  }
  pill(str, x, y, col, a) {
    const c = this.ctx, font = '700 22px Orbitron';
    const w = this.measure(str, font, 2) + 34;
    c.save(); c.globalAlpha = a;
    c.fillStyle = 'rgba(12,4,30,0.55)'; c.strokeStyle = col; c.lineWidth = 2; c.shadowColor = col; c.shadowBlur = 10;
    c.beginPath(); c.roundRect(x, y - 30, w, 42, 21); c.fill(); c.stroke(); c.restore();
    this.text(str, x + 17, y - 1, { font, ls: 2, fill: '#fff', alpha: a });
    return w;
  }

  // ---------------------------------------------------------------- frame
  draw(t, kick) {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    // layout is authored at 1920x1080 and scaled to the render size
    c.setTransform(this.w / 1920, 0, 0, this.h / 1080, 0, 0);
    const W = 1920, H = 1080;

    // bottom gradient for lyric legibility
    const lyr = this.activeLine(t);
    if (lyr) {
      const g = c.createLinearGradient(0, H - 230, 0, H);
      g.addColorStop(0, 'rgba(5,0,18,0)'); g.addColorStop(1, `rgba(5,0,18,${0.62 * lyr.a})`);
      c.fillStyle = g; c.fillRect(0, H - 230, W, 230);
    }

    this.intro(t);
    this.title(t, kick);
    this.parts(t);
    this.steps(t);
    this.times16(t);
    this.complete(t);
    this.tip(t);
    this.detector(t);
    this.counter(t);
    this.credits(t);
    if (lyr) this.lyrics(t, lyr);
  }

  intro(t) {
    const a = env(t, 3, 14.5, 0.5, 1.2);
    if (a <= 0) return;
    const s = 'github.com/muonTelescope/docs';
    const n = Math.floor(clamp((t - 3.2) / 5) * s.length);
    const cur = (Math.floor(t * 2) % 2 === 0 || n < s.length) ? '▌' : ' ';
    this.text(s.slice(0, n) + cur, 960, 900, { font: '400 40px "Share Tech Mono"', align: 'center', fill: CYAN, glow: CYAN, blur: 16, alpha: a, ls: 2 });
    this.text('p r e s e n t s', 960, 952, { font: '400 26px "Share Tech Mono"', align: 'center', fill: '#e8d9ff', alpha: a * smooth((t - 9) / 1.5), ls: 4 });
  }

  title(t, kick) {
    const a = env(t, B(4), B(7, 3.5), 0.4, 1.2);
    const b = env(t, B(68), B(72, 2), 1.0, 2.0);
    for (const [alpha, t0, y] of [[a, B(4), 470], [b, B(68), 430]]) {
      if (alpha <= 0) continue;
      const c = this.ctx;
      const reveal = smooth((t - t0) / 2.2);
      c.save();
      c.beginPath(); c.rect(0, 0, 250 + reveal * 1500, this.h); c.clip();
      this.text('Cosmic Rain', 960, y, {
        font: '400 230px Yellowtail', align: 'center', rot: -0.07, fill: this.sunset(y - 170, y + 20),
        glow: PINK, blur: 30 + 25 * kick, alpha, stroke: 'rgba(255,255,255,0.85)', lw: 2,
      });
      c.restore();
      const sub = smooth((t - t0 - 1.5) / 1.5) * alpha;
      this.text('MUON TELESCOPE · FRAME ASSEMBLY', 960, y + 125, { font: '700 38px Orbitron', align: 'center', ls: 10, fill: '#ffffff', glow: CYAN, blur: 16, alpha: sub });
      const lw = 420 * sub;
      this.line(960 - 560 - lw, y + 112, 960 - 560, y + 112, CYAN, sub);
      this.line(960 + 560, y + 112, 960 + 560 + lw, y + 112, CYAN, sub);
      if (t0 === B(68)) {
        this.text('built from github.com/muonTelescope/docs', 960, y + 200, { font: '400 34px "Share Tech Mono"', align: 'center', fill: CYAN, glow: CYAN, blur: 10, alpha: smooth((t - t0 - 3) / 2) * alpha, ls: 2 });
        this.text('tools required: one 4 mm hex key', 960, y + 250, { font: '400 28px "Share Tech Mono"', align: 'center', fill: '#f3e6ff', alpha: smooth((t - t0 - 5) / 2) * alpha, ls: 2 });
      }
    }
  }

  parts(t) {
    const a = env(t, B(8) - 0.5, B(16) - 0.3, 0.5, 0.6);
    if (a <= 0) return;
    {
      const c = this.ctx, rows = clamp(Math.floor((t - B(8) + 0.5) / 4), 0, 7) + 1;
      c.save(); c.globalAlpha = a * 0.75; c.fillStyle = 'rgba(8,2,24,0.72)'; c.strokeStyle = 'rgba(255,79,216,0.5)'; c.lineWidth = 2;
      c.beginPath(); c.roundRect(62, 62, 560, 120 + rows * 38, 14); c.fill(); c.stroke(); c.restore();
    }
    this.text('BILL OF MATERIALS', 90, 120, { font: '900 46px Orbitron', fill: '#fff', glow: PINK, blur: 18, alpha: a, ls: 4 });
    this.line(90, 142, 90 + 470 * a, 142, PINK, a);
    const i = clamp(Math.floor((t - B(8) + 0.5) / 4), 0, 7);
    for (let k = 0; k <= i; k++) {
      const b = BOM[k];
      const ak = a * smooth((t - (B(8 + k) - 0.2)) / 0.6);
      const cur = k === i;
      this.text(`${String(b.n).padStart(3, ' ')}×  ${b.name}`, 92, 190 + k * 38, {
        font: '400 27px "Share Tech Mono"', fill: cur ? '#ffffff' : '#bda9e8', alpha: ak * (cur ? 1 : 0.8), glow: cur ? CYAN : undefined, blur: 10,
      });
    }
    // big current item
    const b = BOM[i];
    const tl = t - B(8 + i);
    const ai = a * env(tl, -0.45, 3.85, 0.45, 0.35);
    const dx = (1 - smooth((tl + 0.45) / 0.8)) * 120;
    const x = 1110 + dx;
    this.text(`${b.n}×`, x, 520, { font: '900 190px Orbitron', fill: this.chrome(360, 520), glow: VIOLET, blur: 26, alpha: ai });
    this.text(b.name, x + 6, 590, { font: '700 44px Orbitron', fill: '#fff', glow: PINK, blur: 14, alpha: ai, ls: 2 });
    this.text(b.spec, x + 8, 640, { font: '400 32px "Share Tech Mono"', fill: CYAN, alpha: ai, ls: 1 });
  }

  steps(t) {
    for (const s of STEPS) {
      const a = env(t, s.t0, s.t1, 0.4, 0.4);
      if (a <= 0) continue;
      const slide = (1 - smooth((t - s.t0) / 0.6)) * -60;
      const x = 90 + slide;
      this.text('STEP', x, 92, { font: '700 30px Orbitron', fill: CYAN, glow: CYAN, blur: 10, alpha: a, ls: 8 });
      this.text(String(s.n), x, 205, { font: '900 120px Orbitron', fill: this.chrome(110, 205), glow: VIOLET, blur: 22, alpha: a });
      const nw = this.measure(String(s.n), '900 120px Orbitron');
      this.text('/7', x + nw + 8, 205, { font: '700 44px Orbitron', fill: '#cdb8ff', alpha: a * 0.9 });
      this.text(s.title, x + 2, 262, { font: '700 36px Orbitron', fill: '#fff', glow: PINK, blur: 14, alpha: a, ls: 3 });
      let cx = x;
      s.chips.forEach((ch, j) => { cx += this.pill(ch, cx, 322, j % 2 ? PINK : CYAN, a * smooth((t - s.t0 - 0.3 - 0.25 * j) / 0.4)) + 14; });
    }
  }

  times16(t) {
    const a = env(t, B(20) - 0.2, B(22) + 1.5, 0.3, 0.6);
    if (a <= 0) return;
    const n = clamp(1 + Math.floor((t - B(20)) / 0.5 + 1e-6), 1, 16);
    const pop = 1 + 0.12 * Math.exp(-((t - B(20)) % 0.5) / 0.12);
    this.text('×', 1455, 245, { font: '900 110px Orbitron', fill: '#fff', glow: PINK, blur: 20, alpha: a, align: 'right' });
    this.text(String(n), 1470, 245, { font: '900 200px Orbitron', fill: this.chrome(90, 245), glow: VIOLET, blur: 28, alpha: a, scale: pop });
    this.text('BEAM ASSEMBLIES', 1470, 300, { font: '700 30px Orbitron', fill: CYAN, glow: CYAN, blur: 10, alpha: a, ls: 4 });
  }

  complete(t) {
    const a = env(t, B(38), B(40) - 0.2, 0.3, 0.5);
    if (a <= 0) return;
    const s = 1 + 0.25 * Math.exp(-(t - B(38)) / 0.4);
    this.text('FRAME COMPLETE', 960, 150, { font: '900 86px Orbitron', align: 'center', fill: this.chrome(80, 150), glow: YEL, blur: 30, alpha: a, scale: s, ls: 6 });
    this.text('4 POSTS · 16 BEAMS · 4 RINGS · 1 HEX KEY', 960, 215, { font: '400 32px "Share Tech Mono"', align: 'center', fill: '#fff6c2', alpha: a * smooth((t - B(38) - 1) / 0.8), ls: 3 });
  }

  tip(t) {
    const a = env(t, B(46), B(48) - 0.3, 0.4, 0.6);
    if (a <= 0) return;
    const c = this.ctx;
    c.save(); c.globalAlpha = a * 0.9; c.fillStyle = 'rgba(8,10,40,0.6)'; c.strokeStyle = '#2f7bff'; c.lineWidth = 2;
    c.shadowColor = '#2f7bff'; c.shadowBlur = 16; c.beginPath(); c.roundRect(80, 70, 700, 150, 16); c.fill(); c.stroke(); c.restore();
    this.text('PRO TIP', 110, 122, { font: '900 34px Orbitron', fill: '#8fb8ff', glow: '#2f7bff', blur: 14, alpha: a, ls: 5 });
    this.text('A dab of blue threadlocker', 110, 165, { font: '400 30px "Share Tech Mono"', fill: '#fff', alpha: a });
    this.text('makes the frame vibration-proof.', 110, 200, { font: '400 30px "Share Tech Mono"', fill: '#fff', alpha: a });
  }

  detector(t) {
    const items = [
      [B(48), B(52), 'SCINTILLATOR PADDLES', '3× plastic scintillator, one per ring'],
      [B(52), B(54), 'SILICON PHOTOMULTIPLIERS', 'MPPC / SiPM boards on each paddle'],
      [B(54), B(56) - 0.2, 'TRIPLE COINCIDENCE', 'all three paddles fire = one muon'],
    ];
    for (const [t0, t1, head, sub] of items) {
      const a = env(t, t0, t1, 0.4, 0.4);
      if (a <= 0) continue;
      this.text('DETECTOR', 90, 92, { font: '700 30px Orbitron', fill: VIOLET, glow: VIOLET, blur: 12, alpha: a, ls: 8 });
      this.text(head, 90, 150, { font: '900 50px Orbitron', fill: '#fff', glow: PINK, blur: 18, alpha: a, ls: 3 });
      this.text(sub, 92, 196, { font: '400 30px "Share Tech Mono"', fill: CYAN, alpha: a });
    }
    if (this.slowT) {
      const tt = t - (this.slowT + 1);
      const a = tt > 0 ? env(tt, 0, 3.2, 0.05, 0.8) : 0;
      if (a > 0) {
        const s = 1 + 0.4 * Math.exp(-tt / 0.3);
        this.text('COINCIDENCE!', 960, 560, { font: '900 110px Orbitron', align: 'center', fill: this.chrome(460, 560), glow: CYAN, blur: 36, alpha: a, scale: s, ls: 6 });
      }
    }
  }

  counter(t) {
    const a = env(t, B(56) - 0.5, B(64) - 0.2, 0.5, 0.8);
    if (a <= 0) return;
    let n = 0, lastT = -1e9;
    for (const tc of this.coinc) if (tc <= t) { n++; lastT = tc; }
    const pop = Math.exp(-(t - lastT) / 0.25);
    this.text('COINCIDENCES', 1830, 90, { font: '700 30px Orbitron', align: 'right', fill: CYAN, glow: CYAN, blur: 10, alpha: a, ls: 6 });
    this.text(String(n).padStart(4, '0'), 1830, 220, { font: '900 130px Orbitron', align: 'right', fill: this.chrome(110, 220), glow: pop > 0.1 ? PINK : VIOLET, blur: 20 + 40 * pop, alpha: a });
    this.text('sea-level muon flux ≈ 1 / cm² / min', 1830, 268, { font: '400 26px "Share Tech Mono"', align: 'right', fill: '#e8d9ff', alpha: a * 0.9 });
    // 3-channel scope, top-left
    const c = this.ctx, x0 = 80, y0 = 70, w = 470, h = 190;
    c.save(); c.globalAlpha = a; c.fillStyle = 'rgba(6,2,20,0.55)'; c.strokeStyle = 'rgba(95,244,255,0.6)'; c.lineWidth = 2;
    c.beginPath(); c.roundRect(x0, y0, w, h, 12); c.fill(); c.stroke();
    c.strokeStyle = 'rgba(177,75,255,0.25)'; c.lineWidth = 1;
    for (let i = 1; i < 8; i++) { c.beginPath(); c.moveTo(x0 + (i * w) / 8, y0 + 8); c.lineTo(x0 + (i * w) / 8, y0 + h - 8); c.stroke(); }
    const span = 4; // beats shown
    const cols = [PINK, CYAN, PINK];
    for (let ch = 0; ch < 3; ch++) {
      const yb = y0 + 48 + ch * 52;
      c.strokeStyle = cols[ch]; c.shadowColor = cols[ch]; c.shadowBlur = 8; c.lineWidth = 2.2;
      c.beginPath();
      for (let px = 0; px <= w - 60; px += 2) {
        const tt = t - span + (px / (w - 60)) * span;
        let v = 0;
        for (const tc of this.coinc) {
          const d = tt - tc - ch * 0.02;
          if (d > -0.05 && d < 0.6) v += d < 0 ? 0 : Math.exp(-d / 0.08) * (1 - Math.exp(-d / 0.01));
        }
        const noise = Math.sin(tt * 91.7 + ch * 7) * Math.sin(tt * 37.3 + ch) * 1.5;
        const y = yb - v * 34 + noise;
        if (px === 0) c.moveTo(x0 + 50 + px, y); else c.lineTo(x0 + 50 + px, y);
      }
      c.stroke();
      c.shadowBlur = 0;
      c.restore(); c.save(); c.globalAlpha = a;
      this.text(`CH${ch + 1}`, x0 + 12, yb + 6, { font: '400 20px "Share Tech Mono"', fill: cols[ch], alpha: a });
    }
    c.restore();
  }

  credits(t) {
    const lines = [
      [B(64), 'FRAME & DOCS', 'github.com/muonTelescope/docs'],
      [B(65), 'STRUCTURE', '4 m of Misumi 2020 aluminium extrusion'],
      [B(66), 'TOOLS', 'one 4 mm hex key · optional blue threadlocker'],
      [B(67), 'MUSIC · VOCALS · ANIMATION', 'procedurally generated from the assembly docs'],
    ];
    const a0 = env(t, B(64), B(68) - 0.2, 0.5, 0.8);
    if (a0 <= 0) return;
    lines.forEach(([t0, head, sub], i) => {
      const a = a0 * smooth((t - t0) / 0.8);
      const y = 150 + i * 105;
      this.text(head, 90, y, { font: '700 26px Orbitron', fill: PINK, glow: PINK, blur: 10, alpha: a, ls: 6 });
      this.text(sub, 90, y + 44, { font: '400 34px "Share Tech Mono"', fill: '#fff', alpha: a });
    });
  }

  activeLine(t) {
    for (const l of this.lines) {
      const a = env(t, l.t0 - 0.6, l.t1 + 0.9, 0.35, 0.6);
      if (a > 0) return { ...l, a };
    }
    return null;
  }

  lyrics(t, l) {
    const font = '700 54px Orbitron', ls = 2, gap = 22;
    const widths = l.words.map((w) => this.measure(w.txt, font, ls));
    const total = widths.reduce((a, b) => a + b, 0) + gap * (l.words.length - 1);
    let x = 960 - total / 2;
    l.words.forEach((w, i) => {
      const sung = t >= w.t0;
      const cur = t >= w.t0 && t < w.t1 + 0.1;
      const pop = sung ? 1 + 0.14 * Math.exp(-(t - w.t0) / 0.18) : 1;
      const cx = x + widths[i] / 2;
      this.text(w.txt, cx, 1000, {
        font, ls, align: 'center', scale: pop,
        fill: sung ? (cur ? '#ffffff' : '#ffd6f5') : 'rgba(255,255,255,0.38)',
        glow: sung ? (cur ? CYAN : PINK) : undefined, blur: cur ? 22 : 12, alpha: l.a,
      });
      x += widths[i] + gap;
    });
  }
}
