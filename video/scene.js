// three.js scene for "Cosmic Rain" — deterministic: renderAt(beat) draws one frame.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import * as M from './models.js';
import {
  buildChoreo, evalTrack, evalCamera, flashAt, beamFinal, POSTS, HALF, BEAM_LEN, POST_LEN, RING_Y, FOOT_H, SEC_PER_BEAT,
} from './choreo.js';
import { Hud } from './hud.js';

const B = (bar, beat = 0) => bar * 4 + beat;
const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

export async function createScene({ width, height, song, timeline }) {
  const choreo = buildChoreo();
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x1a0630, 9000, 26000);
  const camera = new THREE.PerspectiveCamera(35, width / height, 2, 70000);

  // ---------------------------------------------------------------- neon reflection environment
  {
    const env = new THREE.Scene();
    const room = new THREE.Mesh(new THREE.BoxGeometry(100, 60, 100), new THREE.MeshBasicMaterial({ color: 0x0b0716, side: THREE.BackSide }));
    env.add(room);
    const strip = (w, h, d, col, x, y, z, k = 1) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(k) }));
      m.position.set(x, y, z); env.add(m);
    };
    strip(60, 1, 30, 0xffffff, 0, 29, 0, 1.7);        // softbox above
    strip(2, 40, 70, 0xff2d95, -49, 5, 0, 5);         // magenta wall strip
    strip(2, 40, 70, 0x00e5ff, 49, 5, 0, 4);          // cyan wall strip
    strip(80, 10, 2, 0xff7a3d, 0, -8, -49, 3);        // sunset band behind
    strip(80, 6, 2, 0x6a4cff, 0, 12, 49, 2.5);        // violet band in front
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(env, 0.02).texture;
    scene.environmentIntensity = 0.9;
  }

  // ---------------------------------------------------------------- lights
  const hemi = new THREE.HemisphereLight(0x7a5cff, 0x12051f, 0.7);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff0e0, 2.0);
  key.position.set(700, 1400, 900);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -420, right: 420, top: 520, bottom: -420, near: 200, far: 4000 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.6;
  key.target.position.set(0, 180, 0);
  scene.add(key, key.target);
  const rimM = new THREE.DirectionalLight(0xff2d95, 1.8); rimM.position.set(-900, 500, -700); scene.add(rimM);
  const rimC = new THREE.DirectionalLight(0x00e5ff, 1.5); rimC.position.set(900, 300, -800); scene.add(rimC);
  const lights = { hemi: hemi.intensity, key: key.intensity, rimM: rimM.intensity, rimC: rimC.intensity };

  // ---------------------------------------------------------------- sky + stars
  const skyU = { uTime: { value: 0 }, uPulse: { value: 0 } };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(40000, 64, 32), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, uniforms: skyU,
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `
      varying vec3 vDir; uniform float uTime; uniform float uPulse;
      float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
      void main(){
        float h = vDir.y;
        vec3 zen = vec3(0.012, 0.004, 0.045);
        vec3 mid = vec3(0.10, 0.02, 0.22);
        vec3 hor = vec3(0.95, 0.16, 0.55);
        vec3 col = mix(mid, zen, smoothstep(0.05, 0.6, h));
        col = mix(hor, col, smoothstep(-0.02, 0.16, h));
        col += vec3(1.0, 0.35, 0.2) * exp(-abs(h) * 38.0) * 0.9;
        // stars
        vec2 sp = vec2(atan(vDir.z, vDir.x) * 180.0, asin(clamp(h, -1., 1.)) * 180.0);
        vec2 cell = floor(sp); vec2 f = fract(sp) - 0.5;
        float r = h21(cell);
        if (r > 0.9 && h > 0.06) {
          vec2 o = vec2(h21(cell + 7.1), h21(cell + 3.3)) - 0.5;
          float d = length(f - o * 0.6);
          float tw = 0.6 + 0.4 * sin(uTime * (1.5 + r * 4.0) + r * 60.0);
          col += vec3(0.8, 0.85, 1.0) * smoothstep(0.09, 0.0, d) * tw * (0.3 + (r - 0.9) * 25.0) * smoothstep(0.06, 0.25, h);
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
  }));
  sky.renderOrder = -10;
  scene.add(sky);

  // retro sun
  const sunU = { uTime: { value: 0 }, uPulse: { value: 0 } };
  const sun = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false, toneMapped: false, uniforms: sunU,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `
      varying vec2 vUv; uniform float uTime; uniform float uPulse;
      void main(){
        vec2 p = vUv - 0.5; float d = length(p);
        float disc = smoothstep(0.5, 0.49, d);
        vec3 top = vec3(1.0, 0.92, 0.32), midc = vec3(1.0, 0.42, 0.22), bot = vec3(1.0, 0.08, 0.52);
        vec3 col = mix(midc, top, smoothstep(0.05, 0.45, p.y));
        col = mix(bot, col, smoothstep(-0.3, 0.1, p.y));
        float y = 0.22 - p.y;                          // stripes start a little above the centre
        float band = step(0.0, y) * step(fract((y + uTime*0.01) * 14.0), smoothstep(0.0, 0.55, y) * 0.75);
        float a = disc * (1.0 - band);
        float glow = exp(-max(d - 0.49, 0.0) * 22.0) * 0.3 * (1.0 - disc);
        gl_FragColor = vec4(col * (0.85 + uPulse * 0.15) * a + vec3(1.0, 0.25, 0.55) * glow, max(a, glow));
      }`,
  }));
  sun.position.set(0, 4300, -30000);
  sun.scale.set(13500, 13500, 1);
  sun.renderOrder = -9;
  scene.add(sun);

  // mountain silhouette on the horizon with a neon ridge line
  {
    const R = 24000, N = 720, rnd = mulberry(7);
    const oct = [[3, 1500], [7, 700], [17, 320], [41, 140], [97, 60]].map(([f, a]) => [f, a, rnd() * 6.28, rnd() * 6.28]);
    const ridge = [];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      let h = 900;
      for (const [f, amp, ph, ph2] of oct) h += amp * Math.sin(a * f + ph) * (0.6 + 0.4 * Math.sin(a * f * 0.5 + ph2));
      h = Math.max(120, h);
      ridge.push([R * Math.sin(a), h, -R * Math.cos(a)]);
    }
    const pos = [], line = [];
    for (let i = 0; i < N; i++) {
      const [x0, h0, z0] = ridge[i], [x1, h1, z1] = ridge[i + 1];
      pos.push(x0, -30, z0, x1, -30, z1, x1, h1, z1, x0, -30, z0, x1, h1, z1, x0, h0, z0);
      line.push(x0, h0, z0, x1, h1, z1);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const mtn = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x080214, side: THREE.DoubleSide, fog: false }));
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(line, 3));
    const mtnL = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: new THREE.Color(1.0, 0.2, 0.65).multiplyScalar(1.3), fog: false, toneMapped: false }));
    mtn.renderOrder = -8; mtnL.renderOrder = -7;
    scene.add(mtn, mtnL);
  }

  // ---------------------------------------------------------------- floor grid
  const floorU = { uPulse: { value: 0 }, uTime: { value: 0 }, uDim: { value: 1 }, uWave: { value: 0 } };
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80000, 80000), new THREE.ShaderMaterial({
    uniforms: floorU, fog: false, toneMapped: false,
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `
      varying vec3 vW; uniform float uPulse, uTime, uDim, uWave;
      float grid(vec2 p, float s, float w){ vec2 g = abs(fract(p/s - 0.5) - 0.5) * s; vec2 fw = fwidth(p) * 1.2; vec2 l = 1.0 - smoothstep(vec2(w), vec2(w) + fw, g); return max(l.x, l.y); }
      void main(){
        float r = length(vW.xz);
        vec3 base = vec3(0.018, 0.006, 0.05);
        float fine = grid(vW.xz, 100.0, 1.2) * (1.0 - smoothstep(1500.0, 4200.0, r));
        float coarse = grid(vW.xz, 500.0, 3.0);
        vec3 cyan = vec3(0.0, 0.9, 1.0), pink = vec3(1.0, 0.18, 0.6);
        vec3 lc = mix(cyan, pink, smoothstep(600.0, 9000.0, r));
        float wave = exp(-pow((r - uWave) / 160.0, 2.0)) * step(1.0, uWave);
        float k = (0.35 + 0.6 * uPulse * exp(-r / 2000.0)) * uDim + wave * 1.1;
        vec3 col = base + lc * (coarse * 1.4 + fine * 0.35) * k;
        float haze = smoothstep(3000.0, 26000.0, r);
        col = mix(col, vec3(0.55, 0.08, 0.35), haze * 0.85);
        gl_FragColor = vec4(col, 1.0);
      }`,
  }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -14;
  scene.add(floor);

  // platform
  const platMat = new THREE.MeshStandardMaterial({ color: 0x1a1426, metalness: 0.45, roughness: 0.6 });
  const platform = new THREE.Mesh(new THREE.CylinderGeometry(270, 282, 14, 96), platMat);
  platform.position.y = -7; platform.receiveShadow = true; scene.add(platform);
  const rimMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.18, 0.6).multiplyScalar(2.2), toneMapped: false });
  const rim = new THREE.Mesh(new THREE.TorusGeometry(276, 1.8, 8, 160), rimMat);
  rim.rotation.x = Math.PI / 2; rim.position.y = -1; scene.add(rim);
  const rim2Mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.0, 0.9, 1.0).multiplyScalar(1.3), toneMapped: false, transparent: true, opacity: 0.8 });
  const rim2 = new THREE.Mesh(new THREE.RingGeometry(205, 207, 128), rim2Mat);
  rim2.rotation.x = -Math.PI / 2; rim2.position.y = 0.3; scene.add(rim2);

  // ---------------------------------------------------------------- parts
  const objs = {};
  // flash gain by part size: big extrusions glow gently, small hardware sparkles
  const gainOf = (id) => (/^(post|beam\d\d$)/.test(id) ? 0.38 : /^panel/.test(id) ? 1.2 : /^(hero|foot)/.test(id) ? 0.7 : 0.85);
  const reg = (id, obj, mats) => { objs[id] = { pose: obj.pose, spin: obj.spin, mats, gain: gainOf(id) }; return objs[id]; };
  const node = (meshes, mats) => {
    const pose = new THREE.Group(); const spin = new THREE.Group(); pose.add(spin);
    for (const m of meshes) { m.castShadow = true; m.receiveShadow = true; spin.add(m); }
    return { pose, spin, mats };
  };
  const cloneMat = (m) => { const c = m.clone(); c.emissive = new THREE.Color(0); return c; };
  const meshOf = (geo, mat) => { const mm = cloneMat(mat); return [new THREE.Mesh(geo, mm), mm]; };
  const screwNode = (len) => {
    const p = M.screwParts(len);
    const m1 = cloneMat(M.MAT.oxide);
    const meshes = [new THREE.Mesh(p.head, m1), new THREE.Mesh(p.socket, M.MAT.socket), new THREE.Mesh(p.shank, m1)];
    return node(meshes, [m1]);
  };

  const G = {
    post: M.extrusion(POST_LEN, 'y'), beam: M.extrusion(BEAM_LEN, 'x'), bracket: M.bracketGeometry(), tnut: M.tnutGeometry(),
    foot: M.footGeometry(), hexkey: M.hexKeyGeometry(), panel: M.panelGeometry(),
  };

  const frame = node([], []); reg('frame', frame, []);
  const inner = new THREE.Group(); inner.position.y = -HALF; frame.spin.add(inner);
  scene.add(frame.pose);

  for (let i = 0; i < 4; i++) {
    const [mesh, mat] = meshOf(G.post, M.MAT.alu);
    const n = node([mesh], [mat]); reg(`post${i}`, n, [mat]); inner.add(n.pose);
  }
  for (let r = 0; r < 4; r++) for (let s = 0; s < 4; s++) {
    const [body, bmat] = meshOf(G.beam, M.MAT.alu);
    const b = node([body], [bmat]); const o = reg(`beam${r}${s}`, b, [bmat]); inner.add(b.pose);
    objs[`beam${r}${s}.body`] = { mesh: body, mats: [bmat], bodyOnly: true, gain: 0.38 };
    for (let e = 0; e < 2; e++) {
      const [bm, bmm] = meshOf(G.bracket, M.MAT.cast);
      const br = node([bm], [bmm]); reg(`beam${r}${s}.br${e}`, br, [bmm]); b.spin.add(br.pose);
      const bs = screwNode(10); reg(`beam${r}${s}.bs${e}`, bs, bs.mats); b.spin.add(bs.pose);
    }
    for (let k = 0; k < 4; k++) {
      const [nm, nmm] = meshOf(G.tnut, M.MAT.steel);
      const bn = node([nm], [nmm]); reg(`beam${r}${s}.bn${k}`, bn, [nmm]); b.spin.add(bn.pose);
    }
    // static anchor at the beam's final pose for the post T-nuts & screws
    const anchor = new THREE.Group();
    const f = beamFinal(r, s);
    anchor.position.set(...f.p); anchor.rotation.set(f.r[0], f.r[1], f.r[2], 'YXZ');
    inner.add(anchor);
    for (let e = 0; e < 2; e++) {
      const [nm, nmm] = meshOf(G.tnut, M.MAT.steel);
      const pn = node([nm], [nmm]); reg(`pn${r}${s}${e}`, pn, [nmm]); anchor.add(pn.pose);
      const ps = screwNode(10); reg(`ps${r}${s}${e}`, ps, ps.mats); anchor.add(ps.pose);
    }
  }
  // hex key rides on the demo beam
  {
    const [hm, hmm] = meshOf(G.hexkey, M.MAT.brass);
    const hk = node([hm], [hmm]); reg('hexA', hk, [hmm]); objs.beam00.spin.add(hk.pose);
  }
  for (let i = 0; i < 4; i++) {
    const [fm, fmm] = meshOf(G.foot, M.MAT.rubber);
    const ft = node([fm], [fmm]); reg(`foot${i}`, ft, [fmm]); inner.add(ft.pose);
    const fs = screwNode(25); reg(`fs${i}`, fs, fs.mats); inner.add(fs.pose);
  }
  for (let k = 0; k < 3; k++) {
    const [pm, pmm] = meshOf(G.panel, M.MAT.panel);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(G.panel, 30), new THREE.LineBasicMaterial({ color: new THREE.Color(0.75, 0.3, 1.6), toneMapped: false }));
    const pn = node([pm, edge], [pmm]); edge.castShadow = false; reg(`panel${k}`, pn, [pmm]); inner.add(pn.pose);
    const mp = M.makeMppc();
    mp.scale.setScalar(1.35);
    const mats = [];
    mp.traverse((o) => { if (o.isMesh && o.name !== 'led') { o.material = cloneMat(o.material); mats.push(o.material); } });
    const mn = node([mp], mats); reg(`mppc${k}`, mn, mats); pn.spin.add(mn.pose);
    objs[`mppc${k}`].led = mp.getObjectByName('led');
  }
  // heroes for the bill-of-materials parade (display scale)
  const heroDefs = [
    () => [[G.post, M.MAT.alu, 0.29, [0, 0, 1.15]]],
    () => [[G.beam, M.MAT.alu, 0.77, [0, 0.4, 0.25]]],
    () => [[G.bracket, M.MAT.cast, 5.2, [0, -0.6, 0], [-10, -10, 0]]],
    () => [[G.tnut, M.MAT.steel, 9, [0.9, 0, 0]]],
    () => 'screw10',
    () => 'screw25',
    () => [[G.foot, M.MAT.rubber, 5.6, [0.5, 0, 0], [0, 6.5, 0]]],
    () => [[G.hexkey, M.MAT.brass, 1.45, [0, 0, 0.3], [-40, -13, 0]]],
  ];
  heroDefs.forEach((def, i) => {
    const d = def();
    let n;
    if (typeof d === 'string') {
      const len = d === 'screw10' ? 10 : 25;
      n = screwNode(len);
      const holder = new THREE.Group(); holder.scale.setScalar(len === 10 ? 7 : 3.8); holder.rotation.set(0, 0, 1.2);
      holder.position.set(0, 0, 0);
      while (n.spin.children.length) holder.add(n.spin.children[0]);
      holder.children.forEach((c) => c.position.y += len / 2);
      n.spin.add(holder);
    } else {
      const meshes = [], mats = [];
      for (const [geo, mat, sc, rot, off] of d) {
        const [m, mm] = meshOf(geo, mat);
        const h = new THREE.Group(); h.scale.setScalar(sc); h.rotation.set(...rot);
        if (off) m.position.set(...off);
        h.add(m); meshes.push(h); mats.push(mm);
      }
      n = node(meshes, mats);
    }
    reg(`hero${i}`, n, n.mats); scene.add(n.pose);
  });

  // intro "ghost" preview of the finished frame
  const ghost = new THREE.Group();
  {
    const eMat = new THREE.LineBasicMaterial({ color: new THREE.Color(0.0, 0.9, 1.0).multiplyScalar(1.6), transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
    const postE = new THREE.EdgesGeometry(G.post, 40), beamE = new THREE.EdgesGeometry(G.beam, 40);
    POSTS.forEach(([x, z]) => { const l = new THREE.LineSegments(postE, eMat); l.position.set(x, HALF, z); ghost.add(l); });
    for (let r = 0; r < 4; r++) for (let s = 0; s < 4; s++) {
      const f = beamFinal(r, s); const l = new THREE.LineSegments(beamE, eMat);
      l.position.set(...f.p); l.rotation.set(f.r[0], f.r[1], f.r[2], 'YXZ'); ghost.add(l);
    }
    ghost.userData.mat = eMat;
  }
  scene.add(ghost);

  // shock rings
  const shockPool = [];
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 96), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2; m.visible = false; scene.add(m); shockPool.push(m);
  }
  // muon splashes
  const splashPool = [];
  for (let i = 0; i < 40; i++) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 48), new THREE.MeshBasicMaterial({ color: 0x66f6ff, transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2; m.visible = false; scene.add(m); splashPool.push(m);
  }
  // scintillation ripples where a muon crosses a paddle
  const hitPool = [];
  for (let i = 0; i < 12; i++) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.75, 1, 64), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2; m.visible = false; scene.add(m); hitPool.push(m);
  }
  const hits = [];
  for (const m of choreo.muons) if (m.hitPanels) {
    choreo.panelY.forEach((py, k) => {
      const t = m.t + (m.yRef - py) / m.v;
      hits.push({ t, x: m.x + m.dx * (py - m.yRef), z: m.z + m.dz * (py - m.yRef), y: py + 7, c: k === 1 ? [0.2, 1.8, 2.4] : [2.4, 0.4, 1.6], slow: m.slow });
    });
  }
  const head = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.6, 3.2), toneMapped: false }));
  head.visible = false; scene.add(head);
  // muon streaks (instanced)
  const MAXM = 260;
  const streakGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true); streakGeo.translate(0, 0.5, 0);
  const streakMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
    vertexShader: `varying float vL; attribute float aI; varying float vI;
      void main(){ vL = position.y; vI = aI; gl_Position = projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.); }`,
    fragmentShader: `varying float vL; varying float vI;
      void main(){ float a = pow(1.0 - vL, 2.2); vec3 c = mix(vec3(0.3, 1.2, 2.4), vec3(2.6, 2.4, 2.8), pow(1.0 - vL, 12.0));
        gl_FragColor = vec4(c * a * vI, a * vI); }`,
  });
  const streaks = new THREE.InstancedMesh(streakGeo, streakMat, MAXM);
  const aI = new THREE.InstancedBufferAttribute(new Float32Array(MAXM), 1);
  streakGeo.setAttribute('aI', aI);
  streaks.frustumCulled = false;
  scene.add(streaks);

  // ---------------------------------------------------------------- post-processing
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, samples: 4 }));
  composer.setPixelRatio(1);
  composer.setSize(width, height);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.6, 0.55, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const hud = new Hud(width, height, song, choreo);
  const hudTex = new THREE.CanvasTexture(hud.canvas);
  hudTex.colorSpace = THREE.NoColorSpace;
  hudTex.minFilter = THREE.LinearFilter; hudTex.generateMipmaps = false;
  const retro = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null }, tHud: { value: hudTex }, uTime: { value: 0 }, uFlash: { value: 0 }, uFade: { value: 1 },
      uRes: { value: new THREE.Vector2(width, height) }, uAberr: { value: 0.006 }, uScan: { value: 0.05 }, uGrain: { value: 0.018 }, uVig: { value: 0.55 },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `
      uniform sampler2D tDiffuse, tHud; uniform float uTime, uFlash, uFade, uAberr, uScan, uGrain, uVig; uniform vec2 uRes; varying vec2 vUv;
      void main(){
        vec2 c = vUv - 0.5; float r2 = dot(c, c);
        vec2 off = c * uAberr * (0.4 + r2 * 3.0);
        vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
        vec4 hud = texture2D(tHud, vUv);
        col = mix(col, hud.rgb, hud.a);
        float sl = 0.5 + 0.5 * sin(vUv.y * uRes.y * 2.094);
        col *= 1.0 - uScan * (1.0 - sl);
        col *= 1.0 - uVig * smoothstep(0.08, 0.55, r2);
        float n = fract(sin(dot(floor(vUv * uRes) + uTime * 17.0, vec2(12.9898, 78.233))) * 43758.5453);
        col += (n - 0.5) * uGrain;
        col = mix(col, vec3(1.0, 0.95, 1.0), uFlash);
        col *= 1.0 - uFade;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  retro.uniforms.tHud.value = hudTex;
  composer.addPass(retro);

  // ---------------------------------------------------------------- timing helpers
  const beatsOf = (arr) => (arr || []).map((s) => s / SEC_PER_BEAT).sort((a, b) => a - b);
  const kicks = beatsOf(timeline && timeline.kick);
  const snares = beatsOf(timeline && timeline.snare);
  const lastBefore = (arr, t) => {
    let lo = 0, hi = arr.length - 1, ans = -1e9;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= t) { ans = arr[mid]; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  };
  const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3(), tmpS = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const flashed = new Set();
  const col = new THREE.Color();

  function renderAt(t) {
    const kick = Math.exp(-(t - lastBefore(kicks, t)) / 0.3);
    const snare = Math.exp(-(t - lastBefore(snares, t)) / 0.35);

    // --- parts
    for (const [id, keys] of Object.entries(choreo.tracks)) {
      const o = objs[id];
      if (!o) continue;
      const st = evalTrack(keys, t);
      if (o.bodyOnly) {
        const op = st.o;
        for (const m of o.mats) { const tr = op < 0.999; m.transparent = tr; m.opacity = op; m.depthWrite = !tr; }
        o.mesh.castShadow = st.o > 0.99;
        continue;
      }
      o.pose.position.set(st.p[0], st.p[1], st.p[2]);
      o.pose.rotation.set(st.r[0], st.r[1], st.r[2], 'YXZ');
      o.pose.scale.setScalar(Math.max(1e-4, st.s));
      o.spin.rotation.y = st.sp;
      o.pose.visible = st.o > 0.002;
    }
    // --- flashes
    for (const id of flashed) {
      const o = objs[id]; for (const m of o.mats) m.emissive.setRGB(0, 0, 0);
    }
    flashed.clear();
    for (const [id, list] of Object.entries(choreo.flashes)) {
      const o = objs[id]; if (!o) continue;
      const f = flashAt(list, t);
      if (!f) continue;
      col.set(f.c).multiplyScalar(Math.min(3, f.k) * o.gain);
      for (const m of o.mats) m.emissive.copy(col);
      flashed.add(id);
    }
    // SiPM LEDs blink once attached
    for (let k = 0; k < 3; k++) {
      const led = objs[`mppc${k}`].led;
      const on = t > B(52) + k ? 0.25 + 0.75 * (Math.sin(t * Math.PI * 2 + k) > 0.6 ? 1 : 0) : 0;
      led.material = led.material === M.MAT.led ? led.material.clone() : led.material;
      led.material.color.setRGB(0.4 * on * 3, 3.0 * on, 0.6 * on);
    }

    // --- environment dynamics
    const dim = 1 - 0.72 * smooth((t - B(52)) / 2) * (1 - smooth((t - B(55, 2)) / 1.5));
    hemi.intensity = lights.hemi * dim; key.intensity = lights.key * dim;
    rimM.intensity = lights.rimM * (0.5 + 0.5 * dim) * (1 + 0.25 * kick); rimC.intensity = lights.rimC * (0.5 + 0.5 * dim) * (1 + 0.25 * snare);
    scene.environmentIntensity = 0.9 * (0.35 + 0.65 * dim);
    floorU.uPulse.value = kick; floorU.uTime.value = t; floorU.uDim.value = 0.5 + 0.5 * dim;
    const kb = lastBefore(kicks, t);
    floorU.uWave.value = t - kb < 2 ? (t - kb) * 1800 : 0;
    skyU.uTime.value = t * SEC_PER_BEAT; sunU.uTime.value = t; sunU.uPulse.value = kick;
    rimMat.color.setRGB(1.0, 0.18, 0.6).multiplyScalar(1.6 + 1.6 * kick);
    rim2Mat.opacity = 0.35 + 0.6 * snare;

    // ghost preview
    const ga = smooth((t - B(3)) / 4) * (1 - smooth((t - B(7, 2)) / 2.5));
    ghost.userData.mat.opacity = ga * (0.35 + 0.65 * kick);
    ghost.visible = ga > 0.002;

    // shocks
    let si = 0;
    for (const s of choreo.shocks) {
      const d = t - s.t;
      if (d < 0 || d > 1.4 || si >= shockPool.length) continue;
      const m = shockPool[si++]; const x = d / 1.4;
      const R = 20 + (s.big === 2 ? 1100 : s.big ? 700 : 260) * (1 - Math.pow(1 - x, 3));
      m.visible = true; m.position.set(s.x, 0.6, s.z); m.scale.set(R, R, R);
      m.material.color.set(s.c).multiplyScalar(2.5 * (1 - x) * (1 - x)); m.material.opacity = 1;
    }
    for (; si < shockPool.length; si++) shockPool[si].visible = false;

    // muons
    let mi = 0, spi = 0;
    for (const m of choreo.muons) {
      const y = m.yRef - (t - m.t) * m.v;
      const groundY = Math.abs(m.x) < 280 && Math.abs(m.z) < 280 ? 0 : -14;
      const topY = y + m.len;
      if (topY < groundY || y > 9000) {
        // splash after hitting the ground
        const tg = m.t + (m.yRef - groundY) / m.v;
        const d = t - tg;
        if (d >= 0 && d < 0.7 && spi < splashPool.length && Math.hypot(m.x, m.z) < 6000) {
          const sp = splashPool[spi++]; const x = d / 0.7;
          const gx = m.x + m.dx * (groundY - m.yRef), gz = m.z + m.dz * (groundY - m.yRef);
          sp.visible = true; sp.position.set(gx, groundY + 0.8, gz);
          const R = 8 + (m.hitPanels ? 160 : 110) * x; sp.scale.set(R, R, R);
          sp.material.color.setRGB(0.4, 2.2, 2.6).multiplyScalar((1 - x) * (1 - x) * (m.slow ? 2 : 1));
        }
        continue;
      }
      if (mi >= MAXM) continue;
      const hy = Math.max(y, groundY), ty = topY;
      const hx = m.x + m.dx * (hy - m.yRef), hz = m.z + m.dz * (hy - m.yRef);
      const dir = tmpV.set(m.dx, 1, m.dz).normalize();
      const L = (ty - hy) / dir.y;
      const dist = camera.position.distanceTo(tmpS.set(hx, hy, hz));
      const w = Math.max(m.slow ? 4.5 : m.hitPanels ? 2.2 : 1.3, dist * (m.slow ? 0.004 : 0.0011));
      if (m.slow) { head.visible = y > groundY; head.position.set(hx, hy, hz); head.scale.setScalar(Math.max(5, dist * 0.009)); }
      tmpQ.setFromUnitVectors(up, dir);
      tmpM.compose(tmpS.set(hx, hy, hz), tmpQ, new THREE.Vector3(w, L, w));
      streaks.setMatrixAt(mi, tmpM);
      aI.array[mi] = m.slow ? 1.6 : m.hitPanels ? 1.3 : 0.8;
      mi++;
    }
    let hi = 0;
    for (const h of hits) {
      const d = t - h.t;
      if (d < 0 || d > (h.slow ? 1.2 : 0.5) || hi >= hitPool.length) continue;
      const m = hitPool[hi++]; const x = d / (h.slow ? 1.2 : 0.5);
      const R = 4 + (h.slow ? 95 : 70) * (1 - Math.pow(1 - x, 2));
      m.visible = true; m.position.set(h.x, h.y, h.z); m.scale.set(R, R, R);
      m.material.color.setRGB(...h.c).multiplyScalar((1 - x) * (1 - x) * (h.slow ? 1.6 : 1));
    }
    for (; hi < hitPool.length; hi++) hitPool[hi].visible = false;
    if (!choreo.muons.some((m) => m.slow && t > m.t - 6 && t < m.t + 3)) head.visible = false;
    for (let k = mi; k < MAXM; k++) { tmpM.makeScale(0, 0, 0); streaks.setMatrixAt(k, tmpM); aI.array[k] = 0; }
    streaks.instanceMatrix.needsUpdate = true; aI.needsUpdate = true;
    for (; spi < splashPool.length; spi++) splashPool[spi].visible = false;

    // --- camera
    const cp = window.debugCam || evalCamera(choreo.camera, t);
    let sx = 0, sy = 0;
    for (const s of choreo.shocks) {
      const d = t - s.t; if (d < 0 || d > 1.5) continue;
      const a = (s.big === 2 ? 9 : s.big ? 6 : 3) * Math.exp(-d / 0.22);
      sx += a * Math.sin(d * 55); sy += a * Math.cos(d * 43);
    }
    camera.position.set(cp.p[0] + sx, cp.p[1] + sy, cp.p[2]);
    camera.fov = cp.fov * (1 - 0.012 * kick * (t > B(8) ? 1 : 0));
    camera.updateProjectionMatrix();
    camera.lookAt(cp.tg[0], cp.tg[1], cp.tg[2]);
    sky.position.copy(camera.position);

    // --- post
    const flashes = [[B(32), 0.55], [B(45, 2), 0.35], [B(56), 0.6], [B(38), 0.3], [B(55), 0.25]];
    let fl = 0;
    for (const [tf, k] of flashes) if (t >= tf) fl = Math.max(fl, k * Math.exp(-(t - tf) / 0.35));
    retro.uniforms.uFlash.value = fl;
    retro.uniforms.uFade.value = Math.max(1 - smooth(t / 3), smooth((t - B(71, 2)) / 3.5));
    retro.uniforms.uTime.value = t;
    bloom.strength = 0.55 + 0.2 * kick + (1 - dim) * 0.35;

    hud.draw(t, kick);
    hudTex.needsUpdate = true;
    composer.render();
  }

  return { renderer, renderAt, choreo, objs, scene };
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
