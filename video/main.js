// Page entry: loads fonts + song data, builds the scene and exposes a frame-stepping API
// (window.renderFrame / window.grab) for the headless renderer. Open with ?play to preview.
import { createScene } from './scene.js';
import { FRAMES_PER_BEAT } from './choreo.js';

const qs = new URLSearchParams(location.search);
const W = +qs.get('w') || 1920;
const H = +qs.get('h') || 1080;

async function loadFonts() {
  const fs = '/node_modules/@fontsource';
  const faces = [
    ['Orbitron', `${fs}/orbitron/files/orbitron-latin-400-normal.woff2`, '400'],
    ['Orbitron', `${fs}/orbitron/files/orbitron-latin-700-normal.woff2`, '700'],
    ['Orbitron', `${fs}/orbitron/files/orbitron-latin-900-normal.woff2`, '900'],
    ['Yellowtail', `${fs}/yellowtail/files/yellowtail-latin-400-normal.woff2`, '400'],
    ['Share Tech Mono', `${fs}/share-tech-mono/files/share-tech-mono-latin-400-normal.woff2`, '400'],
  ];
  await Promise.all(faces.map(async ([family, url, weight]) => {
    const f = new FontFace(family, `url(${url})`, { weight });
    document.fonts.add(await f.load());
  }));
}

const song = await (await fetch('/song.json')).json();
let timeline = null;
try { const r = await fetch('/build/timeline.json'); if (r.ok) timeline = await r.json(); } catch { /* audio not built yet */ }
await loadFonts();
const S = await createScene({ width: W, height: H, song, timeline });

window.S = S;
window.totalFrames = Math.round(song.totalBeats * FRAMES_PER_BEAT);
window.renderFrame = (f) => S.renderAt(f / FRAMES_PER_BEAT);
window.renderBeat = (b) => S.renderAt(b);
window.grab = (q = 0.95) => S.renderer.domElement.toDataURL('image/jpeg', q);
window.ready = true;

if (qs.has('play')) {
  const audio = new Audio('/build/audio.wav');
  const t0 = performance.now();
  audio.play().catch(() => {});
  const loop = () => {
    const sec = audio.currentTime || (performance.now() - t0) / 1000;
    S.renderAt(sec / (60 / song.bpm));
    requestAnimationFrame(loop);
  };
  loop();
} else {
  S.renderAt(+qs.get('beat') || 0);
}
