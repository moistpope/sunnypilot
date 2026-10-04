// The next turn on the road: once it's near, an arrow lies on the ego lane at the turn, bending the way
// the turn goes (a ring at the destination). The nav app gives the distance rounded (0.3 mi is anywhere
// from 0.25 to 0.35), so the turn is pinned to the road (road.js odo) when it's first given and carried
// along with the car from there; each later distance only nudges it back inside what that distance
// allows, as little as it takes, so it doesn't jump with every rounding.
import * as THREE from '../vendor/three.module.min.js';

const SHOW_M = 160, FADE_M = 30;    // shows inside this far, fading in over the last FADE_M of it
const PAST_M = 8;                   // gone this far past the turn
const WIDTH = 1.25, LEAD = 14;      // m: the arrow's band, and its straight run up to the turn
const HEAD_L = 2.6, HEAD_W = 3.1;   // m: the arrowhead
const BEND = { straight: 0, slight: 45, turn: 90, sharp: 135, uturn: 180, keep: 22, ramp: 35, merge: 22 };   // deg
const RADIUS = { uturn: 3.4, keep: 18, ramp: 14, merge: 18 };   // m; else 7

export class NavArrow {
  constructor(road) {
    this.road = road;   // road.js RoadModel
    this.group = new THREE.Group();
    this.group.name = 'navarrow';
    this.material = new THREE.MeshBasicMaterial({ color: 0x3e6ae1, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.renderOrder = 2;
    this.group.add(this.mesh);
    this.group.visible = false;
    this.turn = null;   // { kind, side, step, at (road odo of the turn) }
    this.shape = '';
  }

  // the next turn ({ kind, side, m ahead, half: m either way it was rounded, step: its instruction }), or null
  set(t) {
    if (!t || !(t.kind in BEND || t.kind === 'arrive')) { this.turn = null; return; }
    const odo = this.road.odo;
    if (!this.turn || this.turn.step !== t.step) this.turn = { ...t, at: odo + t.m };   // a new turn
    else {
      const ahead = this.turn.at - odo, half = (t.half || 0) + 3;
      this.turn.at = odo + Math.max(t.m - half, Math.min(t.m + half, ahead));
    }
    const shape = `${t.kind}-${t.side}`;
    if (shape !== this.shape) { this.shape = shape; this._build(t); }
  }

  // Built in the arrow's own frame: the turn at the origin, the road coming from +Z (toward the car),
  // forward -Z and left -X, as scene.js lays the car frame out. scene's rotation.y = heading turns it.
  _build(t) {
    const pts = [];   // centerline [x ahead, y left] in m, the turn at 0
    for (let s = -LEAD; s <= 0; s += 2) pts.push([s, 0]);
    let geo;
    if (t.kind === 'arrive') {
      geo = new THREE.RingGeometry(1.6, 1.6 + WIDTH * 0.8, 40).rotateX(-Math.PI / 2);
    } else {
      const sign = t.side === 'right' ? -1 : 1;
      const bend = (BEND[t.kind] || 0) * Math.PI / 180, r = RADIUS[t.kind] || 7;
      for (let a = 0.15; a < bend; a += 0.15) pts.push([r * Math.sin(a), sign * r * (1 - Math.cos(a))]);
      const end = bend > 0 ? [r * Math.sin(bend), sign * r * (1 - Math.cos(bend))] : [0, 0];
      const h = sign * bend;
      const tail = bend > 0 ? 2 : 6;
      pts.push([end[0] + Math.cos(h) * tail, end[1] + Math.sin(h) * tail]);
      geo = ribbon(pts, h);
    }
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
  }

  // place it on the road as it is now; road.place(s, d): s m ahead, d m left of the ego lane's center
  update(toScene, clock) {
    const t = this.turn, road = this.road;
    const ahead = t ? t.at - road.odo : Infinity;
    const show = ahead < SHOW_M && ahead > -PAST_M;
    this.group.visible = show;
    if (!show) return;
    const p = road.place(Math.max(0, ahead), 0);
    const [X, Z] = toScene(p.x, p.y);
    this.mesh.position.set(X, 0.03, Z);
    this.mesh.rotation.y = p.h;
    const fadeIn = Math.min(1, (SHOW_M - ahead) / FADE_M), fadeOut = Math.min(1, (ahead + PAST_M) / PAST_M);
    this.material.opacity = 0.78 * Math.min(fadeIn, fadeOut) * (0.9 + 0.1 * Math.sin(clock * 3));
  }
}

// a flat band along pts ([x ahead, y left]) with an arrowhead at the end, heading h there, in the
// arrow's frame (X = -y, Z = -x)
function ribbon(pts, h) {
  const pos = [], idx = [];
  const at = (x, y) => [-y, 0, -x];
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[Math.max(0, i - 1)], [x1, y1] = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;   // left of the way it goes
    const [x, y] = pts[i];
    pos.push(...at(x + nx * WIDTH / 2, y + ny * WIDTH / 2), ...at(x - nx * WIDTH / 2, y - ny * WIDTH / 2));
    if (i > 0) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  // the arrowhead: a triangle out from the last point
  const [ex, ey] = pts[pts.length - 1], c = Math.cos(h), s = Math.sin(h), b = pos.length / 3;
  pos.push(...at(ex - s * HEAD_W / 2, ey + c * HEAD_W / 2), ...at(ex + s * HEAD_W / 2, ey - c * HEAD_W / 2), ...at(ex + c * HEAD_L, ey + s * HEAD_L));
  idx.push(b, b + 1, b + 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}
