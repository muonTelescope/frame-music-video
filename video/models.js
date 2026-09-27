// Procedural models of the muonTelescope frame parts (all dimensions in mm).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------- materials
export const MAT = {
  alu: new THREE.MeshStandardMaterial({ color: 0xc9ced8, metalness: 0.88, roughness: 0.3 }),
  cast: new THREE.MeshStandardMaterial({ color: 0x80838d, metalness: 0.72, roughness: 0.48 }),
  steel: new THREE.MeshStandardMaterial({ color: 0xa9acb4, metalness: 0.9, roughness: 0.28 }),
  oxide: new THREE.MeshStandardMaterial({ color: 0x55565f, metalness: 0.85, roughness: 0.3 }),
  socket: new THREE.MeshStandardMaterial({ color: 0x0c0c10, metalness: 0.5, roughness: 0.6 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x19191d, metalness: 0.0, roughness: 0.72 }),
  brass: new THREE.MeshStandardMaterial({ color: 0xe0bd62, metalness: 0.55, roughness: 0.34 }),
  panel: new THREE.MeshStandardMaterial({ color: 0x101016, metalness: 0.25, roughness: 0.42 }),
  pcb: new THREE.MeshStandardMaterial({ color: 0x5d2a8c, metalness: 0.15, roughness: 0.5 }),
  header: new THREE.MeshStandardMaterial({ color: 0xe9e2cf, metalness: 0.05, roughness: 0.6 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xe6c36a, metalness: 1.0, roughness: 0.25 }),
  chip: new THREE.MeshStandardMaterial({ color: 0x141418, metalness: 0.3, roughness: 0.35 }),
  led: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 3.0, 0.6), toneMapped: false }),
};
MAT.rubber.side = THREE.DoubleSide;
MAT.oxide.side = THREE.DoubleSide;

// ---------------------------------------------------------------- 2020 T-slot profile
export function profileShape() {
  const s = new THREE.Shape();
  const h = 10, open = 3.1, lip = 1.8, under = 5.6, mid = 3.4, bot = 2.9, depth = 6.1, ch = 0.6;
  // one side's slot, described along the +y face going from +x to -x (a = along side, d = depth)
  const slot = [[open, 0], [open, lip], [under, lip], [under, mid], [bot, depth], [-bot, depth], [-under, mid], [-under, lip], [-open, lip], [-open, 0]];
  const pts = [];
  // rotate the +y face template to each of the four faces (counter-clockwise)
  const faces = [
    (a, d) => [a, h - d],      // top  (+y), a runs from +x to -x
    (a, d) => [-h + d, a],     // left (-x), a runs from +y to -y
    (a, d) => [-a, -h + d],    // bottom
    (a, d) => [h - d, -a],     // right
  ];
  for (let f = 0; f < 4; f++) {
    const m = faces[f];
    // corner before this face (chamfered)
    pts.push(m(h - ch, 0));
    for (const [a, d] of slot) pts.push(m(a, d));
    pts.push(m(-h + ch, 0));
  }
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, 2.1, 0, Math.PI * 2, true);
  s.holes.push(hole);
  return s;
}

let _profile;
export function extrusion(len, axis = 'x') {
  _profile ||= profileShape();
  const g = new THREE.ExtrudeGeometry(_profile, { depth: len, bevelEnabled: false, curveSegments: 10 });
  g.translate(0, 0, -len / 2);
  if (axis === 'x') g.rotateY(Math.PI / 2);
  if (axis === 'y') g.rotateX(-Math.PI / 2);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- cast angle bracket
// right-angle corner at the origin, base plate along +x, back plate along +y, width in z.
export function bracketGeometry() {
  const L = 20, t = 3, W = 18;
  const outer = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(L, 0), new THREE.Vector2(0, L)]);
  const k = L - t * Math.SQRT2 - t;
  const inner = new THREE.Path([new THREE.Vector2(t, t), new THREE.Vector2(t, t + k - t), new THREE.Vector2(t + k - t, t)]);
  const tubeShape = outer.clone();
  tubeShape.holes = [inner];
  const tube = new THREE.ExtrudeGeometry(tubeShape, { depth: W - t, bevelEnabled: false });
  tube.translate(0, 0, -W / 2);
  const wall = new THREE.ExtrudeGeometry(outer, { depth: t, bevelEnabled: true, bevelThickness: 0.4, bevelSize: 0.4, bevelSegments: 1 });
  wall.translate(0, 0, W / 2 - t);
  const g = mergeGeometries([tube.toNonIndexed(), wall.toNonIndexed()]);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- M5 T-nut (plate in xz)
export function tnutGeometry() {
  const w = 11, d = 8.5, r = 1.2;
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -d / 2);
  s.lineTo(w / 2 - r, -d / 2); s.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r);
  s.lineTo(w / 2, d / 2 - r); s.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2);
  s.lineTo(-w / 2 + r, d / 2); s.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r);
  s.lineTo(-w / 2, -d / 2 + r); s.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2);
  const hole = new THREE.Path(); hole.absarc(0, 0, 2.5, 0, Math.PI * 2, true); s.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(s, { depth: 3.8, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.3, bevelSegments: 1, curveSegments: 6 });
  g.translate(0, 0, -1.9);
  g.rotateX(-Math.PI / 2);
  return g;
}

// ---------------------------------------------------------------- M5 socket head cap screw
// head underside at y=0, head up (+y), threaded shank down (-y).
const _screwCache = {};
export function screwParts(len) {
  if (_screwCache[len]) return _screwCache[len];
  const head = new THREE.LatheGeometry([
    new THREE.Vector2(2.5, 0), new THREE.Vector2(4.25, 0), new THREE.Vector2(4.25, 4.55), new THREE.Vector2(3.95, 5.0),
    new THREE.Vector2(2.35, 5.0), new THREE.Vector2(2.35, 2.3), new THREE.Vector2(0.01, 2.3),
  ].reverse(), 28);
  const socket = new THREE.CylinderGeometry(2.3, 2.3, 2.4, 6);
  socket.translate(0, 3.55, 0);
  const pts = [new THREE.Vector2(0.01, -len), new THREE.Vector2(1.9, -len), new THREE.Vector2(2.3, -len + 0.4)];
  for (let y = -len + 0.8, i = 0; y < -0.2; y += 0.4, i++) pts.push(new THREE.Vector2(i % 2 ? 2.5 : 2.08, y));
  pts.push(new THREE.Vector2(2.5, 0), new THREE.Vector2(0.01, 0));
  const shank = new THREE.LatheGeometry(pts.reverse(), 18);
  return (_screwCache[len] = { head, socket, shank });
}
export function makeScrew(len) {
  const p = screwParts(len);
  const g = new THREE.Group();
  g.add(new THREE.Mesh(p.head, MAT.oxide), new THREE.Mesh(p.socket, MAT.socket), new THREE.Mesh(p.shank, MAT.oxide));
  return g;
}

// ---------------------------------------------------------------- rubber foot (top at y=0)
export function footGeometry() {
  const pts = [[4.8, -13], [9.6, -13], [10.1, -12.4], [9.3, -0.7], [8.7, 0], [2.9, 0], [2.9, -6.5], [4.8, -6.5], [4.8, -13]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(pts, 40);
}

// ---------------------------------------------------------------- 4 mm hex key
// tip of the short arm at the origin, short arm up +y, long arm along +x.
export function hexKeyGeometry() {
  const r = 2.3;
  const short = new THREE.CylinderGeometry(r, r, 22, 6); short.translate(0, 11, 0);
  const bend = new THREE.TorusGeometry(4, r, 6, 10, Math.PI / 2); bend.rotateZ(Math.PI / 2); bend.translate(4, 22, 0);
  const long = new THREE.CylinderGeometry(r, r, 75, 6); long.rotateZ(Math.PI / 2); long.translate(4 + 37.5, 26, 0);
  const g = mergeGeometries([short.toNonIndexed(), bend.toNonIndexed(), long.toNonIndexed()]);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- scintillator paddle
export function panelGeometry() {
  const a = 72, c = 22;
  const s = new THREE.Shape([
    new THREE.Vector2(-a, -a), new THREE.Vector2(a - c, -a), new THREE.Vector2(a, -a + c), new THREE.Vector2(a, a), new THREE.Vector2(-a, a),
  ]);
  const g = new THREE.ExtrudeGeometry(s, { depth: 10, bevelEnabled: true, bevelThickness: 1.2, bevelSize: 1.2, bevelSegments: 2 });
  g.translate(0, 0, -5);
  g.rotateX(-Math.PI / 2);
  return g;
}

// SiPM (MPPC) interface board, normal along local +z
export function makeMppc() {
  const g = new THREE.Group();
  const board = new THREE.Mesh(new THREE.BoxGeometry(22, 12, 1.6), MAT.pcb);
  const hdr = new THREE.Mesh(new THREE.BoxGeometry(12, 5, 3), MAT.header); hdr.position.set(0, -2, 2.3);
  for (let i = 0; i < 4; i++) {
    const pin = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 6), MAT.gold);
    pin.position.set(-4.5 + i * 3, -2, 5.5); g.add(pin);
  }
  const sensor = new THREE.Mesh(new THREE.BoxGeometry(6, 6, 1.2), MAT.chip); sensor.position.set(0, 1, -1.4);
  const led = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1, 1), MAT.led); led.position.set(8, 3.5, 1.2); led.name = 'led';
  g.add(board, hdr, sensor, led);
  return g;
}
