// What the map says stands along the roads around the car: traffic signals, stop and give-way signs,
// speed limit changes, pedestrian and level crossings, traffic calming, mini roundabouts. They come with
// the worker's roads layer (state.js `_features`), each with the road directions that arrive at it, and
// are built once per layer as meshes in the view's ground-fixed `world` group, in the pose frame -- so,
// like the road network (roadnet.js), they stay put on the ground while the car drives past.
//
// A signal head goes up for every arriving direction, over its right lane, facing the traffic; a sign
// stands at the right edge of its road a little before the node, facing it. Speed limits are not the map's
// business here: the camera reads the real sign (furniture.js). The head on our own road ahead takes the camera's light state (fisker.tlr),
// so the map says where the light is and the camera what it shows; the others keep dark glass.
import * as THREE from '../vendor/three.module.min.js';
import { LIGHT_HEIGHT, LIGHT_SCALE, SIGN_GAP, TrafficLight, applyLamps, buildSignalHead, makeSign } from './furniture.js';

const MARK_LIFT = -0.001;       // below the tires' contact plane; over the network's lines by polygon offset
// A feature's node is the crossing's center; the crossing road's half width (`cross`, state.js) puts the stop line at
// its edge and the sign a little before that, outside the corner's fillet
const STOP_LINE_BACK = 1.0;     // m before the crossing road's edge
const SIGN_BACK = 3.5;          // m before the stop line a stop or give-way sign stands
const OUR_SIGNAL_M = 150;       // the signal ahead on our road: this far at most...
const OUR_SIGNAL_RAD = 35 * Math.PI / 180;   // ...and facing within this of our heading
const LANE_W = 3.6;
const MAX_HEADS = 48, MAX_SIGNS = 60;

// pose frame (x east, y north) -> world-group axes (X = -y, Z = -x), like the network
const toWorld = (x, y, lift) => [-y, lift, -x];
const wrap = (a) => (((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

export class MapFeatures {
  constructor(world) {
    this.group = new THREE.Group();
    world.add(this.group);
    this.matMark = new THREE.MeshBasicMaterial({ color: 0x8e949d, transparent: true, opacity: 0.85, fog: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -6 });
    this.marks = new THREE.Mesh(new THREE.BufferGeometry(), this.matMark);
    this.marks.frustumCulled = false;
    this.marks.renderOrder = 1;
    this.group.add(this.marks);
    this.housing = new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.6, metalness: 0.2 });
    this.objects = new THREE.Group();   // heads and signs
    this.group.add(this.objects);
    this.signals = [];   // [{x, y, h, lamps, head}]
    this.version = -1;
    this.layer = null;
    this.ours = null;
  }

  setTheme(t) { this.matMark.color.set(t.line); }

  /** Take the snapshot's layer when a new one came; light the signal ahead on our road from the camera's light
   *  state `tlr` (or null). pose: the view's pose (rear axle, pose frame). Returns that signal ({along} m ahead) or null. */
  update(map, show, tlr, pose, clock) {
    if (map && map.roads && map.roads.version !== this.version) { this.layer = map.roads; this.version = map.roads.version; this._rebuild(); }
    this.group.visible = show && !!this.layer;
    if (!this.group.visible) { this.ours = null; return null; }
    // our signal: the nearest head ahead that faces our way
    const c = Math.cos(pose.h), s = Math.sin(pose.h);
    let ours = null;
    for (const sg of this.signals) {
      const dx = sg.x - pose.x, dy = sg.y - pose.y;
      const along = c * dx + s * dy, left = -s * dx + c * dy;
      if (along < -5 || along > OUR_SIGNAL_M || Math.abs(left) > 15 || Math.abs(wrap(sg.h - pose.h)) > OUR_SIGNAL_RAD) continue;
      if (!ours || along < ours.along) ours = { along, sg };
    }
    if (this.ours && this.ours.sg !== (ours && ours.sg)) applyLamps(this.ours.sg.lamps, []);
    if (ours) applyLamps(ours.sg.lamps, tlr && (tlr.detected || tlr.active) ? TrafficLight.lit(tlr, 3, clock) : []);
    this.ours = ours;
    return ours ? { along: ours.along } : null;
  }

  /** Drop the layer (the pose frame changed: its positions are in the old one). */
  clear() {
    this.layer = null;
    this.version = -1;
    this.ours = null;
    this._rebuild();
    this.group.visible = false;
  }

  _rebuild() {
    // drop what stood before
    this.objects.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); if (o.material !== this.housing) o.material.dispose(); } });
    this.objects.clear();
    this.signals = [];
    const pieces = [];   // [{pts, width}] flat markings
    let heads = 0, signs = 0;
    const place = (obj, x, y, h, height = 0) => { const [X, Y, Z] = toWorld(x, y, height); obj.position.set(X, Y, Z); obj.rotation.y = h; this.objects.add(obj); };
    for (const f of (this.layer && this.layer.features) || []) {
      for (const a of f.arms) {
        const ux = Math.cos(a.h), uy = Math.sin(a.h), rx = uy, ry = -ux;   // along the arrival, and to its right
        const at = (fwd, right) => [f.x + ux * fwd + rx * right, f.y + uy * fwd + ry * right];
        const ourLanes = a.oneWay ? [-a.half, a.half] : [0.3, a.half];   // the arriving direction's own width (m right of the centerline, as [from, to])
        const across = (fwd, from, to, width) => pieces.push({ pts: [at(fwd, from), at(fwd, to)], width });
        const stopAt = -((a.cross || 0) + STOP_LINE_BACK);   // the stop line's station from the node
        const signAt = stopAt - SIGN_BACK;
        switch (f.kind) {
          case 'signal': {
            if (heads >= MAX_HEADS) break;
            const head = new THREE.Group();
            const lamps = buildSignalHead(head, 3, false, this.housing);
            applyLamps(lamps, []);
            const [x, y] = at(0, Math.max(0, a.half - LANE_W / 2));
            place(head, x, y, a.h, LIGHT_HEIGHT + 0.5 * LIGHT_SCALE);
            this.signals.push({ x, y, h: a.h, lamps, head });
            heads++;
            across(stopAt, ourLanes[0], ourLanes[1], 0.5);
            break;
          }
          case 'stop':
          case 'yield': {
            if (signs >= MAX_SIGNS) break;
            const [x, y] = at(signAt, a.half + SIGN_GAP);
            place(makeSign(f.kind === 'stop' ? { kind: 'stop', ...(f.all ? { all: true } : {}) } : { kind: 'yield' }), x, y, a.h - 0.18);
            signs++;
            if (f.kind === 'stop') across(stopAt, ourLanes[0], ourLanes[1], 0.5);
            break;
          }
          case 'crossing':
            for (let o = -a.half + 0.4; o <= a.half - 0.4; o += 1.1) pieces.push({ pts: [at(-1.5, o), at(1.5, o)], width: 0.55 });
            break;
          case 'rail': {
            across(0, -a.half, a.half, 0.3);
            if (signs < MAX_SIGNS) { const [x, y] = at(-SIGN_BACK - 2, a.half + SIGN_GAP); place(makeSign({ kind: 'rail' }), x, y, a.h - 0.18); signs++; }
            break;
          }
          case 'calming':
            for (const d of [-0.8, 0, 0.8]) across(d, -a.half, a.half, 0.35);
            break;
          case 'miniRoundabout': {
            const ring = new THREE.Mesh(new THREE.RingGeometry(1.2, 2.2, 32).rotateX(-Math.PI / 2), this.matMark);
            place(ring, f.x, f.y, 0, MARK_LIFT);
            break;
          }
          default:
            break;
        }
      }
    }
    this.marks.geometry.dispose();
    this.marks.geometry = marksGeometry(pieces, MARK_LIFT);
  }
}

function marksGeometry(pieces, lift) {
  const pos = [], idx = [];
  for (const { pts, width } of pieces) {
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
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}
