// The map's road network drawn on the ground around the car (mapsurface.js `roadNetwork`): meshes in the
// view's ground-fixed `world` group (under the scene's map group, which takes the lane placement's slide and
// turn), in the pose frame the worker's roads layer comes in, rebuilt only when a new layer arrives. Every
// road gets its strip and its lines, the one we're on included: one source of lines, nothing toggles.
import * as THREE from '../vendor/three.module.min.js';
import { roadNetwork, NET_LINE_LIFT } from './mapsurface.js';

const DASH = 3.0, GAP = 9.0;   // the network's lane dashes (world-fixed, so laid out once)
// The strips lie just above the ground plane (-0.01) and below the tires' contact plane (0), so the car stands on
// them rather than in them; against the plane, far out where millimeters are below the depth buffer's resolution,
// they win by polygon offset instead of height, and the lines over them by a larger one.
const STRIP_LIFT = -0.004;

export class RoadNetwork {
  constructor(world) {
    this.world = world;
    this.group = new THREE.Group();
    this.group.renderOrder = 0;
    world.add(this.group);
    // double-sided: the strips' boundaries run whichever way the OSM way does; lifted clear of the ground plane,
    // which otherwise wins the depth test at a distance
    const side = THREE.DoubleSide;
    const over = (units) => ({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -units });
    this.mats = {
      strip: new THREE.MeshBasicMaterial({ color: 0x1e2127, fog: true, side, ...over(2) }),
      edge: new THREE.MeshBasicMaterial({ color: 0x6c727b, transparent: true, opacity: 0.6, fog: true, depthWrite: false, side, ...over(4) }),
      center: new THREE.MeshBasicMaterial({ color: 0xdcaa2e, transparent: true, opacity: 0.5, fog: true, depthWrite: false, side, ...over(4) }),
      lane: new THREE.MeshBasicMaterial({ color: 0x8e949d, transparent: true, opacity: 0.45, fog: true, depthWrite: false, side, ...over(4) }),
    };
    this.meshes = {};
    for (const k in this.mats) {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), this.mats[k]);
      m.frustumCulled = false;
      m.renderOrder = k === 'strip' ? 0 : 1;
      this.group.add(m);
      this.meshes[k] = m;
    }
    this.version = -1;
    this.layer = null;
    this.visible = true;
  }

  setTheme(t, dark) {
    this.mats.strip.color.set(t.ground).lerp(new THREE.Color(t.road), dark ? 0.35 : 0.07);
    this.mats.edge.color.set(t.edge);
    this.mats.center.color.set(t.yellow);
    this.mats.lane.color.set(t.line);
  }

  /** Take the snapshot's layer when a new one came and rebuild. */
  update(map, show = true) {
    this.group.visible = show && !!this.layer;
    if (!map) return;
    if (map.roads && map.roads.version !== this.version) { this.layer = map.roads; this.version = map.roads.version; this._rebuild(); }
    this.group.visible = show && !!this.layer;
  }

  /** Drop the layer (the pose frame changed: its geometry is in the old one). */
  clear() {
    this.layer = null;
    this.version = -1;
    this.group.visible = false;
    for (const k in this.meshes) { this.meshes[k].geometry.dispose(); this.meshes[k].geometry = new THREE.BufferGeometry(); }
  }

  _rebuild() {
    const net = roadNetwork(this.layer);
    this.meshes.strip.geometry.dispose(); this.meshes.strip.geometry = stripsGeometry(net.strips, STRIP_LIFT);
    this.meshes.edge.geometry.dispose(); this.meshes.edge.geometry = linesGeometry(net.edges, 0.25, NET_LINE_LIFT);
    this.meshes.center.geometry.dispose(); this.meshes.center.geometry = linesGeometry(net.centers, 0.13, NET_LINE_LIFT);
    const dashes = [];
    for (const l of net.lanes) dashes.push(...dashed(l));
    this.meshes.lane.geometry.dispose(); this.meshes.lane.geometry = linesGeometry(dashes, 0.12, NET_LINE_LIFT);
  }
}

// pose frame (x east, y north) -> world-group axes (X = -y, Z = -x), like the world objects
const toWorld = (x, y, lift) => [-y, lift, -x];

function stripsGeometry(strips, lift) {
  const pos = [], idx = [];
  for (const { left, right } of strips) {
    const m = Math.min(left.length, right.length);
    if (m < 2) continue;
    const base = pos.length / 3;
    for (let i = 0; i < m; i++) { pos.push(...toWorld(left[i][0], left[i][1], lift), ...toWorld(right[i][0], right[i][1], lift)); }
    for (let i = 0; i < m - 1; i++) { const a = base + 2 * i, b = a + 1, c = a + 2, d = a + 3; idx.push(a, c, b, b, c, d); }
  }
  return geometry(pos, idx);
}

function linesGeometry(lines, width, lift) {
  const pos = [], idx = [];
  for (const pts of lines) {
    if (pts.length < 2) continue;
    const base = pos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const L = Math.hypot(dx, dy) || 1;
      dx /= L; dy /= L;
      const nx = -dy * width / 2, ny = dx * width / 2;
      pos.push(...toWorld(pts[i][0] + nx, pts[i][1] + ny, lift), ...toWorld(pts[i][0] - nx, pts[i][1] - ny, lift));
    }
    for (let i = 0; i < pts.length - 1; i++) { const a = base + 2 * i, b = a + 1, c = a + 2, d = a + 3; idx.push(a, c, b, b, c, d); }
  }
  return geometry(pos, idx);
}

function geometry(pos, idx) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

function dashed(pts) {
  const P = DASH + GAP, out = [];
  let s0 = 0, cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-6) continue;
    const at = (d) => [x0 + (x1 - x0) * d / len, y0 + (y1 - y0) * d / len];
    let a = 0;
    while (a < len) {
      const m = ((s0 + a) % P + P) % P, dash = m < DASH;
      const next = Math.min(len, a + (dash ? DASH - m : P - m));
      if (dash) { if (!cur) { cur = [at(a)]; out.push(cur); } cur.push(at(next)); } else cur = null;
      a = next;
    }
    s0 += len;
  }
  return out.filter(p => p.length >= 2);
}
