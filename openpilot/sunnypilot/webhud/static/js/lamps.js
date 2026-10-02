// Lamps that light up on the car body itself: each lamp is a lens (the model's own light geometry,
// or a thin strip laid flush on the body where the model has none) plus a soft glow strip on the
// surrounding paint. Nothing floats off the car.
import * as THREE from '../vendor/three.module.min.js';

export const LAMP = { white: 0xf2f6ff, amber: 0xffa01e, red: 0xff2414 };
const GLOW_SCALE = 1.6;   // glow strips this much wider than modeled, so lit lamps read from the chase camera

// across-strip falloff for the glow: bright in the middle, gone at both edges
let stripTexture = null;
function stripTex() {
  if (stripTexture) return stripTexture;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 2;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 64, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.5)');
  g.addColorStop(0.5, 'rgba(255,255,255,1)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 2);
  stripTexture = new THREE.CanvasTexture(c);
  return stripTexture;
}

export class Lamp {
  // color: lit color; lens: the unlit lens color
  constructor(color, lens) {
    this.lens = new THREE.MeshStandardMaterial({
      color: lens, emissive: color, emissiveIntensity: 0, roughness: 0.25, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2, side: THREE.DoubleSide,
    });
    this.glow = new THREE.MeshBasicMaterial({
      map: stripTex(), color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, side: THREE.DoubleSide, toneMapped: false,
    });
    this.glowMeshes = [];
    this.color = color;
    this.level = -1;
  }

  // level 0..1; color switches a combination lamp (e.g. red tail / amber indicator)
  set(level, color = this.color) {
    if (color !== this.shown) {
      this.shown = color;
      this.lens.emissive.setHex(color);
      this.glow.color.setHex(color);
      this.level = -1;
    }
    if (level === this.level) return;
    this.level = level;
    // colored lamps saturate (amber turns yellow) when pushed far past full emissive; the glow carries
    // the rest of their brightness
    this.lens.emissiveIntensity = level * (this.shown === LAMP.white ? 2.6 : 1.3);
    this.glow.opacity = Math.min(1, level * 1.05);
    for (const m of this.glowMeshes) m.visible = level > 0.02;
  }

  // add a glow strip along points/normals (ego space)
  addGlow(parent, points, normals, width, extend = 0) {
    if (points.length < 2) return;
    const m = new THREE.Mesh(surfaceStrip(points, normals, width * GLOW_SCALE, 0.006, extend), this.glow);
    m.renderOrder = 3;
    m.visible = false;
    parent.add(m);
    this.glowMeshes.push(m);
  }

  // add a lens strip (for lamps the model doesn't have) plus its glow
  addStrip(parent, points, normals, width, glowWidth) {
    if (points.length < 2) return;
    parent.add(new THREE.Mesh(surfaceStrip(points, normals, width, 0.004), this.lens));
    this.addGlow(parent, points, normals, glowWidth, glowWidth / 3);
  }
}

// A strip `width` wide laid along points with outward normals, lifted off the surface by `lift`;
// `extend` lengthens it past both ends.
export function surfaceStrip(points, normals, width, lift = 0.004, extend = 0) {
  const n = points.length;
  const pos = new Float32Array(n * 6), nrm = new Float32Array(n * 6), uv = new Float32Array(n * 4);
  const idx = [];
  const t = new THREE.Vector3(), side = new THREE.Vector3(), q = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    t.subVectors(points[Math.min(n - 1, i + 1)], points[Math.max(0, i - 1)]).normalize();
    side.crossVectors(normals[i], t).normalize().multiplyScalar(width / 2);
    q.copy(points[i]).addScaledVector(normals[i], lift);
    if (i === 0) q.addScaledVector(t, -extend);
    if (i === n - 1) q.addScaledVector(t, extend);
    pos.set([q.x + side.x, q.y + side.y, q.z + side.z, q.x - side.x, q.y - side.y, q.z - side.z], i * 6);
    nrm.set([...normals[i].toArray(), ...normals[i].toArray()], i * 6);
    uv.set([0, i / (n - 1), 1, i / (n - 1)], i * 4);
    if (i < n - 1) idx.push(2 * i, 2 * i + 2, 2 * i + 1, 2 * i + 1, 2 * i + 2, 2 * i + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

function smoothNormals(normals) {
  return normals.map((n, i) => n.clone().add(normals[Math.max(0, i - 1)]).add(normals[Math.min(normals.length - 1, i + 1)]).normalize());
}

// Lay a polyline onto the body: each point (ego space, densified every `step`) is pushed along
// `dir` until it meets one of `meshes`. Returns surface points and outward normals.
export function conform(meshes, pts, dir, step = 0.015) {
  const d = new THREE.Vector3(...dir).normalize();
  const dense = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = new THREE.Vector3(...pts[i]), b = new THREE.Vector3(...pts[i + 1]);
    const k = Math.max(1, Math.ceil(a.distanceTo(b) / step));
    for (let j = 0; j < k; j++) dense.push(a.clone().lerp(b, j / k));
  }
  dense.push(new THREE.Vector3(...pts[pts.length - 1]));
  const ray = new THREE.Raycaster();
  const points = [], normals = [];
  for (const p of dense) {
    ray.set(p.clone().addScaledVector(d, -1.0), d);
    ray.far = 3.0;
    const hit = ray.intersectObjects(meshes, false)[0];
    if (!hit || !hit.face) continue;   // off the body: leave it out rather than float in the air
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    if (n.dot(d) > 0) n.negate();
    points.push(hit.point.clone());
    normals.push(n);
  }
  return { points, normals: smoothNormals(smoothNormals(normals)) };
}

// Centerline of a thin lamp strip from its triangles: the vertices ordered by `order(p)` and merged
// every `step` (a strip's top and bottom vertices pair up), normals pointed away from `center`.
export function centerline(tris, order, center, step = 0.02) {
  const verts = [];
  for (const t of tris) {
    const n = t.n.clone();
    if (n.dot(t.c.clone().sub(center)) < 0) n.negate();
    for (const p of t.v) verts.push({ p, n, o: order(p) });
  }
  verts.sort((a, b) => a.o - b.o);
  const points = [], normals = [];
  let acc = null;
  const flush = () => {
    if (!acc) return;
    points.push(acc.p.divideScalar(acc.k));
    normals.push(acc.n.normalize());
    acc = null;
  };
  for (const v of verts) {
    if (acc && acc.p.clone().divideScalar(acc.k).distanceTo(v.p) > step) flush();
    if (!acc) acc = { p: new THREE.Vector3(), n: new THREE.Vector3(), k: 0 };
    acc.p.add(v.p); acc.n.add(v.n); acc.k += 1;
  }
  flush();
  // a strip modeled with some depth yields front and back vertices: average out the zigzag
  const smooth = points.map((p, i) => (i === 0 || i === points.length - 1 ? p.clone()
    : p.clone().multiplyScalar(2).add(points[i - 1]).add(points[i + 1]).multiplyScalar(0.25)));
  return { points: smooth, normals: smoothNormals(normals) };
}

// triangles of a mesh in ego space ({v: vertices, c: centroid, n: face normal, box, i: first index})
export function meshTriangles(mesh) {
  mesh.updateWorldMatrix(true, false);
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const index = geo.index ? geo.index.array : null;
  const out = [];
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const count = index ? index.length : pos.count;
  for (let i = 0; i < count; i += 3) {
    for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(pos, index ? index[i + k] : i + k).applyMatrix4(mesh.matrixWorld);
    const c = v[0].clone().add(v[1]).add(v[2]).divideScalar(3);
    const n = new THREE.Vector3().subVectors(v[1], v[0]).cross(new THREE.Vector3().subVectors(v[2], v[0])).normalize();
    const box = new THREE.Box3().setFromPoints(v);
    out.push({ c, n, box, i, v: v.map(p => p.clone()) });
  }
  return out;
}

// Re-split a mesh's triangles into material groups: classify(tri) -> material (or null to keep the
// original). Index order is rearranged so each material's triangles are contiguous.
export function splitMesh(mesh, classify) {
  const geo = mesh.geometry.index ? mesh.geometry : mesh.geometry.setIndex([...Array(mesh.geometry.attributes.position.count).keys()]);
  const tris = meshTriangles(mesh);
  const original = mesh.material;
  const buckets = new Map();
  for (const t of tris) {
    const m = classify(t) || original;
    if (!buckets.has(m)) buckets.set(m, []);
    buckets.get(m).push(t);
  }
  const src = geo.index.array;
  const dst = new (src.constructor)(src.length);
  const materials = [];
  geo.clearGroups();
  let n = 0;
  for (const [m, list] of buckets) {
    const start = n;
    for (const t of list) { dst[n++] = src[t.i]; dst[n++] = src[t.i + 1]; dst[n++] = src[t.i + 2]; }
    geo.addGroup(start, n - start, materials.length);
    materials.push(m);
  }
  geo.setIndex(new THREE.BufferAttribute(dst, 1));
  mesh.material = materials;
  return buckets;
}

// Drive a car's lamps from VehicleState.lamps. Missing lamps (simpler models) are skipped.
export function applyLamps(lamps, L) {
  const pos = L.position || L.low || L.high;
  const set = (name, level, color) => { if (lamps[name]) lamps[name].set(level, color); };
  set('drl', L.drl || pos ? 1 : 0);
  set('head', L.high ? 1 : L.low ? 0.9 : 0);
  set('tail', L.brake ? 1 : pos ? 0.5 : 0);
  set('chmsl', L.brake ? 1 : 0);
  set('reverse', L.reverse ? 1 : 0);
  for (const [s, on, active] of [['L', L.left, L.leftActive], ['R', L.right, L.rightActive]]) {
    set('front' + s, on ? 1 : 0);
    set('mirror' + s, on ? 1 : 0);
    // the rear-quarter marker is part of the tail lamp: lit with it, bright for braking, and it
    // flashes with the indicator on its side
    set('marker' + s, L.brake ? 1 : active ? (on ? 1 : 0) : pos ? 0.5 : 0);
    // lower rear lamp: amber indicator, red tail otherwise
    if (active) set('rear' + s, on ? 1 : 0, LAMP.amber);
    else set('rear' + s, pos ? 0.45 : 0, LAMP.red);
  }
}
