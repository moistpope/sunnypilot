// three.js car view. World objects (vehicles, people) are 3D; road markings are flat ribbons.
//
// Vehicle frame (server data): x forward, y left, meters, origin = ego front bumper.
// Scene frame (three.js):      X right, Y up, Z backward. So X = -y, Z = -x.
import * as THREE from '../vendor/three.module.min.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { makeEgo, makeObject, fitScale, loadEgoModel } from './models.js';

const EGO_LEN = 4.775;
const EGO_W = 1.98;
const MODEL_X_OFFSET = -1.6;      // comma device sits ~1.6 m behind the front bumper
const DASH = 3.0, GAP = 9.0;      // US lane dash pattern (10 ft / 30 ft)
const RECENTER_S = 5;             // pan springs back to the car after this long untouched

const THEMES = {
  light: { bg: 0xeceef1, object: 0xc6cad1, lead: 0x4f5562, line: 0x8e949d, edge: 0x6c727b, yellow: 0xdcaa2e,
    blue: 0x3e6ae1, red: 0xe5413a, path: 0x3e6ae1, model: 0xa7adb5, hemiSky: 0xffffff, hemiGround: 0xb8bcc4 },
  dark: { bg: 0x101216, object: 0x50565f, lead: 0xd5dae2, line: 0x6b717a, edge: 0x8a9099, yellow: 0xc9982a,
    blue: 0x5b86ff, red: 0xff5a4f, path: 0x5b86ff, model: 0x4d535c, hemiSky: 0x8a93a6, hemiGround: 0x1a1d22 },
};

export const VIEWS = {
  chase: { r: 17, phi: 1.02, theta: 0, offY: 0.2 },
  top: { r: 26, phi: 0.04, theta: 0, offY: 0.0 },
  close: { r: 8.5, phi: 1.12, theta: 0.65, offY: 0.06 },
  far: { r: 36, phi: 0.9, theta: 0, offY: 0.26 },
};

function toScene(x, y) { return [-y, -x]; }

// A flat strip along a polyline, preallocated so per-frame updates don't allocate.
class Ribbon {
  constructor(material, capacity = 512) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 2 * 3);
    const idx = [];
    for (let i = 0; i < capacity - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.segIdx = [];   // vertex index ranges per drawn piece
  }

  // pieces: array of polylines [[x, y], ...] in vehicle frame; all drawn with the same width
  set(pieces, width, lift = 0.02) {
    const P = this.positions;
    let v = 0;
    const index = this.geo.index.array;
    let n = 0;
    for (const pts of pieces) {
      if (pts.length < 2 || v / 2 + pts.length > this.capacity) continue;
      const base = v / 2;
      for (let i = 0; i < pts.length; i++) {
        const [x0, y0] = pts[Math.max(0, i - 1)], [x1, y1] = pts[Math.min(pts.length - 1, i + 1)];
        let dx = x1 - x0, dy = y1 - y0;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        const nx = -dy * width / 2, ny = dx * width / 2;   // left normal in vehicle frame
        const [X1, Z1] = toScene(pts[i][0] + nx, pts[i][1] + ny);
        const [X2, Z2] = toScene(pts[i][0] - nx, pts[i][1] - ny);
        P.set([X1, lift, Z1, X2, lift, Z2], v * 3);
        v += 2;
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const a = (base + i) * 2, b = a + 1, c = a + 2, d = a + 3;
        index[n++] = a; index[n++] = c; index[n++] = b; index[n++] = b; index[n++] = c; index[n++] = d;
      }
    }
    this.geo.index.needsUpdate = true;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.setDrawRange(0, n);
    this.mesh.visible = n > 0;
  }
}

function lineMaterial(color, opacity = 1) {
  return new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: false, side: THREE.DoubleSide });
}

// y(x) for a Fisker lane line: offset + heading + curvature (radius in m)
function fiskerLinePoints(line, xFrom, xTo, step, signs) {
  const tanH = Math.tan((line.heading || 0) * signs.heading * Math.PI / 180);
  const k = line.radius ? signs.curvature / line.radius : 0;
  const pts = [];
  for (let x = xFrom; x <= xTo + 1e-6; x += step) pts.push([x, line.y0 + tanH * x + 0.5 * k * x * x]);
  return pts;
}

function dashed(pts, phase) {
  // split a polyline into dashes by arc length; phase (distance driven) keeps them fixed to the road
  const out = [];
  let s = phase, cur = null;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const m = ((s % (DASH + GAP)) + (DASH + GAP)) % (DASH + GAP);
    if (m < DASH) {
      if (!cur) { cur = []; out.push(cur); }
      cur.push(pts[i]);
    } else {
      cur = null;
    }
  }
  return out.filter(p => p.length >= 2);
}

function densify(pts, step = 1.0) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let j = 0; j < n; j++) out.push([x0 + (x1 - x0) * j / n, y0 + (y1 - y0) * j / n]);
  }
  if (pts.length) out.push(pts[pts.length - 1]);
  return out;
}

function offsetLine(pts, d) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    return [p[0] - dy / len * d, p[1] + dx / len * d];
  });
}

export class CarScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.3, 600);
    this.target = new THREE.Vector3(0, 0.7, EGO_LEN / 2);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0xb8bcc4, 1.6);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.sun.position.set(6, 14, 9);   // from behind the default camera so the car's rear and roof are lit
    this.scene.add(this.hemi, this.sun, new THREE.AmbientLight(0xffffff, 0.35));

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xeceef1 }));
    this.ground.position.y = -0.01;
    this.scene.add(this.ground);

    // procedural Ocean until the detailed glTF model has loaded (or if it can't be)
    this.ego = makeEgo();
    this.scene.add(this.ego);
    this.egoColor = null;
    loadEgoModel('/models/fisker_ocean.glb').then((g) => {
      this.scene.remove(this.ego);
      this.ego = g;
      this.scene.add(g);
      this.setEgoColor(this.egoColor);
    }).catch((e) => console.warn('Ocean model unavailable, keeping the procedural car', e));

    // lane & path materials (colors set by theme)
    this.mats = {
      line: lineMaterial(0x8e949d), lineBlue: lineMaterial(0x3e6ae1), lineYellow: lineMaterial(0xdcaa2e),
      lineRed: lineMaterial(0xe5413a), edge: lineMaterial(0x6c727b), model: lineMaterial(0xa7adb5, 0.7),
      modelEdge: lineMaterial(0x6c727b, 0.5), path: lineMaterial(0x3e6ae1, 0.16), slot: lineMaterial(0x3e6ae1, 0.8),
      ussRed: lineMaterial(0xe5413a, 0.9), ussAmber: lineMaterial(0xf0a020, 0.9), ussYellow: lineMaterial(0xe8d23a, 0.85),
      ussGreen: lineMaterial(0x2fa84f, 0.6), bsd: lineMaterial(0xe5413a, 0.22),
    };
    this.ribbons = {};
    for (const key of Object.keys(this.mats)) {
      this.ribbons[key] = new Ribbon(this.mats[key], key === 'path' ? 128 : 1024);
      this.scene.add(this.ribbons[key].mesh);
    }
    this.ribbons.path.mesh.renderOrder = 1;

    this.objects = new Map();   // key -> {group, target:{x,y,h}, cls, alpha, seen}
    this.labels = new Map();
    this.theme = THEMES.light;
    this.odometer = 0;
    this.blinkPhase = 0;
    this.state = null;
    this.settings = {};

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 90;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.rotateSpeed = 0.7;
    this.controls.panSpeed = 0.8;
    this.controls.screenSpacePanning = false;
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.target.copy(this.target);
    this.lastInteract = -1e9;
    this.controls.addEventListener('start', () => { this.interacting = true; this.viewAnim = null; });
    this.controls.addEventListener('end', () => { this.interacting = false; this.lastInteract = performance.now(); });

    this.viewOffset = { x: 0, y: VIEWS.chase.offY };
    this.setView('chase', true);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setTheme(dark) {
    this.theme = dark ? THEMES.dark : THEMES.light;
    const t = this.theme;
    this.scene.background = new THREE.Color(t.bg);
    this.scene.fog = new THREE.Fog(t.bg, 70, 190);
    this.ground.material.color.set(t.bg);
    this.hemi.color.set(t.hemiSky);
    this.hemi.groundColor.set(t.hemiGround);
    this.mats.line.color.set(t.line);
    this.mats.lineBlue.color.set(t.blue);
    this.mats.lineYellow.color.set(t.yellow);
    this.mats.lineRed.color.set(t.red);
    this.mats.edge.color.set(t.edge);
    this.mats.model.color.set(t.model);
    this.mats.path.color.set(t.path);
    this.mats.slot.color.set(t.blue);
    for (const o of this.objects.values()) o.color = null;   // recolor on next frame
  }

  // hex color, or null/'model' for the model's own paint
  setEgoColor(hex) {
    this.egoColor = hex;
    const ud = this.ego.userData;
    ud.paint.forEach((m, i) => {
      if (hex && hex !== 'model') m.color.set(hex);
      else if (ud.originalPaint) m.color.copy(ud.originalPaint[i]);
      else m.color.set(0x23262c);
    });
  }

  setLayoutOffset(xFrac) { this.viewOffset.x = xFrac; this.resize(); }

  setView(name, instant = false) {
    const v = VIEWS[name] || VIEWS.chase;
    this.view = name;
    const to = new THREE.Spherical(v.r, v.phi, v.theta);
    const from = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    this.viewAnim = instant ? null : { from, to, t: 0, targetFrom: this.controls.target.clone(), offFrom: this.viewOffset.y, offTo: v.offY };
    if (instant) {
      this.controls.target.copy(this.target);
      this.camera.position.copy(this.target).add(new THREE.Vector3().setFromSpherical(to));
      this.viewOffset.y = v.offY;
      this.resize();
    }
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // a rotated (portrait) screen needs a wider vertical field of view to keep the lanes in frame
    this.camera.fov = w < h ? 60 : 42;
    // shift the projection so the car sits in the lower part of the free screen area (Tesla-like)
    const offY = this.viewOffset.y + (w < h && this.viewOffset.y > 0 ? 0.06 : 0);   // clear the portrait header
    this.camera.setViewOffset(w, h, -this.viewOffset.x * w, -offY * h, w, h);
    this.camera.updateProjectionMatrix();
  }

  // ---- data -----------------------------------------------------------------------------------

  update(state, settings) {
    this.state = state;
    this.settings = settings;
  }

  _laneGeometry(dt) {
    const st = this.state || {};
    const op = st.op || {};
    const f = st.fisker;
    const s = this.settings;
    const cs = op.carState || {};
    const v = cs.vEgo || (f && f.vehicle && f.vehicle.speedKph != null ? f.vehicle.speedKph / 3.6 : 0);
    this.odometer += v * dt;
    const phase = this.odometer % (DASH + GAP);
    const signs = { heading: s.laneHeadingSign || 1, curvature: s.laneCurvatureSign || 1 };

    const latActive = !!((op.carControl && op.carControl.latActive) || (op.selfdriveStateSP && op.selfdriveStateSP.mads && op.selfdriveStateSP.mads.active));
    const hmi = f && f.lanes ? f.lanes.hmi : null;
    const pieces = { line: [], lineBlue: [], lineYellow: [], lineRed: [], edge: [], model: [], modelEdge: [] };
    const xTo = 90, xFrom = -12;

    const fiskerLines = (f && f.lanes ? f.lanes.lines : []).filter(l => l.valid);
    const useFisker = s.laneSource === 'fisker' || s.laneSource === 'both' || (s.laneSource !== 'model' && fiskerLines.length >= 1);
    const useModel = s.laneSource === 'model' || s.laneSource === 'both' || (s.laneSource !== 'fisker' && fiskerLines.length === 0);

    if (useFisker) {
      for (const line of fiskerLines) {
        const pts = fiskerLinePoints(line, xFrom, xTo, 2, signs);
        if (line.roadEdge) { pieces.edge.push(pts); continue; }
        const ego = line.id === 'L1' || line.id === 'R1';
        let key = line.color === 'yellow' ? 'lineYellow' : 'line';
        const side = line.id === 'L1' ? hmi && hmi.left : line.id === 'R1' ? hmi && hmi.right : null;
        if (ego && (latActive || (side && side.color === 'blue'))) key = 'lineBlue';
        if (ego && side && (side.color === 'red' || (side.flash && this.blinkPhase % 1 < 0.5))) key = 'lineRed';
        const t = line.type;   // 2 dashed, 3 Botts dots, 4..7 double lines
        const solid = (p) => pieces[key].push(p);
        const dash = (p) => dashed(p, phase).forEach(d => pieces[key].push(d));
        if (t === 2 || t === 3) dash(pts);
        else if (t >= 4 && t <= 7) {
          const a = offsetLine(pts, 0.11), b = offsetLine(pts, -0.11);
          (t === 5 || t === 6 ? dash : solid)(a);
          (t === 4 || t === 5 ? dash : solid)(b);
        } else solid(pts);
      }
    }
    if (useModel && op.modelV2) {
      const md = op.modelV2;
      const probs = md.laneLineProbs || [];
      (md.laneLines || []).forEach((pts, i) => {
        if (!pts.length || (probs[i] || 0) < 0.25) return;
        const p = densify(pts.map(([x, y]) => [x + MODEL_X_OFFSET, y]), 2);
        const ego = i === 1 || i === 2;
        // the model doesn't classify markings, so its lines are drawn solid
        pieces[useFisker ? 'model' : (ego && latActive ? 'lineBlue' : 'line')].push(p);
      });
      (md.roadEdges || []).forEach((pts, i) => {
        const std = (md.roadEdgeStds || [])[i];
        if (pts.length && (std == null || std < 1.0)) pieces[useFisker ? 'modelEdge' : 'edge'].push(densify(pts.map(([x, y]) => [x + MODEL_X_OFFSET, y]), 2));
      });
    }
    this.ribbons.line.set(pieces.line, 0.14);
    this.ribbons.lineBlue.set(pieces.lineBlue, 0.2);
    this.ribbons.lineYellow.set(pieces.lineYellow, 0.15);
    this.ribbons.lineRed.set(pieces.lineRed, 0.22);
    this.ribbons.edge.set(pieces.edge, 0.32);
    this.ribbons.model.set(pieces.model, 0.08, 0.015);
    this.ribbons.modelEdge.set(pieces.modelEdge, 0.18, 0.015);

    // planned path (openpilot) as a soft band while steering is engaged
    const path = op.modelV2 && op.modelV2.path;
    if (s.showPath !== false && latActive && path && path.length > 1) {
      this.ribbons.path.set([densify(path.map(([x, y]) => [x + MODEL_X_OFFSET, y]), 2).filter(p => p[0] > -2)], 1.9, 0.01);
    } else this.ribbons.path.set([], 0);

    // blind-spot glow beside the car
    const bsd = [];
    const thr = f && f.threats;
    const left = thr ? (thr.left.bsd && thr.left.bsd.v >= 1 && thr.left.bsd.v <= 3) : cs.leftBlindspot;
    const right = thr ? (thr.right.bsd && thr.right.bsd.v >= 1 && thr.right.bsd.v <= 3) : cs.rightBlindspot;
    if (left || cs.leftBlindspot) bsd.push([[-8, 3.0], [2, 3.0]]);
    if (right || cs.rightBlindspot) bsd.push([[-8, -3.0], [2, -3.0]]);
    this.ribbons.bsd.set(bsd, 2.6, 0.012);
  }

  _uss() {
    const f = this.state && this.state.fisker;
    const s = this.settings;
    const out = { ussRed: [], ussAmber: [], ussYellow: [], ussGreen: [] };
    const park = f && f.parking;
    const slow = !(f && f.vehicle && f.vehicle.speedKph > 20);
    if (s.showUss !== false && park && park.uss && slow) {
      const zoneDist = (z, rear) => 0.25 + (rear ? 0.22 : 0.3) * (z - 1);
      const color = (z) => (z <= 1 ? 'ussRed' : z <= 2 ? 'ussAmber' : z <= 3 ? 'ussYellow' : 'ussGreen');
      const add = (z, rear, ptsFn) => {
        if (!(z >= 1 && z <= 8)) return;
        out[color(z)].push(ptsFn(zoneDist(z, rear)));
      };
      const W = EGO_W, L = EGO_LEN, R = 0.8;   // bumper corner radius
      // Bumper sectors (left -> right) sit on an ellipse around each bumper so the arcs wrap the
      // corners; side sectors (front -> rear) run parallel to the doors.
      const bumperArc = (front, i, d) => {
        const cx = front ? -R : -L + R, a = R + d, b = W / 2 + d * 0.85;
        const pts = [];
        for (let k = 0; k <= 8; k++) {
          const th = (Math.PI / 2) - (i + k / 8) * (Math.PI / 4);   // +90 deg (left) .. -90 deg (right)
          pts.push([cx + (front ? 1 : -1) * a * Math.cos(th), b * Math.sin(th)]);
        }
        return pts;
      };
      park.uss.front.forEach((z, i) => add(z, false, d => bumperArc(true, i, d)));
      park.uss.rear.forEach((z, i) => add(z, true, d => bumperArc(false, i, d)));
      const side = (sign, i, d) => {
        const x0 = -R - i * (L - 2 * R) / 4, x1 = x0 - (L - 2 * R) / 4;
        return densify([[x0, sign * (W / 2 + d)], [x1, sign * (W / 2 + d)]], 0.25);
      };
      park.uss.left.forEach((z, i) => add(z, false, d => side(1, i, d)));
      park.uss.right.forEach((z, i) => add(z, false, d => side(-1, i, d)));
    }
    this.ribbons.ussRed.set(out.ussRed, 0.3, 0.03);
    this.ribbons.ussAmber.set(out.ussAmber, 0.26, 0.03);
    this.ribbons.ussYellow.set(out.ussYellow, 0.22, 0.03);
    this.ribbons.ussGreen.set(out.ussGreen, 0.16, 0.03);

    // park-assist slots (corners in body frame; drawn relative to the ego center)
    const slots = [];
    const apa = park && park.apa;
    if (apa && apa.state && apa.state.v >= 3) {
      for (const sl of [...apa.slots, apa.selected].filter(Boolean)) {
        const c = sl.corners.filter(Boolean);
        if (c.length === 4) slots.push([...c, c[0]].map(([x, y]) => [x - EGO_LEN / 2, y]));
      }
    }
    this.ribbons.slot.set(slots, 0.1, 0.02);
  }

  _objects(dt) {
    const st = this.state || {};
    const f = st.fisker;
    const op = st.op || {};
    const s = this.settings;
    const t = this.theme;
    const seen = new Set();
    const list = [];

    for (const o of (f && f.objects) || []) {
      list.push({ key: 'f' + o.id, x: o.x, y: o.y, h: (o.heading || 0) * (s.objectHeadingSign || 1), cls: o.cls, w: o.w, l: o.l, hgt: o.h,
        lead: o.flags.includes('accPrimary') || o.flags.includes('leading'), threat: o.flags.some(fl => ['bsd', 'dow', 'aeb', 'raeb', 'bacm', 'elka'].includes(fl)),
        brake: o.brake, label: `${o.cls} #${o.id}` });
    }
    // openpilot's leads, unless the ADAS already reports an object there
    const rs = op.radarState;
    const engaged = !!(op.selfdriveState && op.selfdriveState.enabled);
    if (rs && s.showOpLeads !== false) {
      [rs.leadOne, rs.leadTwo].forEach((ld, i) => {
        if (!ld || !ld.present) return;
        const dup = list.some(o => Math.abs(o.x - ld.dRel) < 4 && Math.abs(o.y - ld.yRel) < 2);
        if (!dup) list.push({ key: 'op' + i, x: ld.dRel, y: ld.yRel, h: 0, cls: 'car', w: 1.9, l: 4.6, hgt: 1.5, lead: i === 0 && engaged, threat: false, label: `lead ${ld.dRel.toFixed(0)} m` });
      });
    }

    for (const o of list) {
      seen.add(o.key);
      let e = this.objects.get(o.key);
      if (!e || e.cls !== o.cls) {
        if (e) this.scene.remove(e.pivot);
        // low cars get the sedan body, everything else car-sized the SUV body
        const group = makeObject(o.cls === 'car' && o.hgt > 0.5 && o.hgt < 1.55 ? 'sedan' : o.cls, t.object);
        const pivot = new THREE.Group();
        group.position.z = -group.userData.length / 2;   // pivot at the object's center
        pivot.add(group);
        this.scene.add(pivot);
        e = { pivot, group, cls: o.cls, alpha: 0, x: o.x, y: o.y, h: o.h, color: null };
        this.objects.set(o.key, e);
      }
      fitScale(e.group, o.cls, o.w, o.l, o.hgt);
      const L = e.group.userData.length * e.group.scale.z;
      // the ADAS measures to the nearest point: a car ahead is reported at its rear bumper
      const cx = o.x > 2 ? o.x + L / 2 : o.x < -2 ? o.x - L / 2 : o.x;
      e.tx = cx; e.ty = o.y; e.th = o.h * Math.PI / 180;
      e.dead = false;
      const color = o.threat ? t.red : o.lead ? t.lead : t.object;
      if (e.color !== color) {
        for (const m of e.group.userData.paint) m.color.set(color);
        e.color = color;
      }
      e.label = o.label;
    }
    for (const [key, e] of this.objects) {
      if (!seen.has(key)) e.dead = true;
    }

    // smooth motion + fade in/out
    const k = 1 - Math.exp(-dt * 10);
    for (const [key, e] of this.objects) {
      if (e.tx !== undefined) {
        if (e.alpha === 0) { e.x = e.tx; e.y = e.ty; e.h = e.th; }
        e.x += (e.tx - e.x) * k; e.y += (e.ty - e.y) * k;
        e.h += (((e.th - e.h + Math.PI) % (2 * Math.PI)) - Math.PI) * k;
      }
      e.alpha = Math.max(0, Math.min(1, e.alpha + (e.dead ? -dt * 3 : dt * 4)));
      if (e.alpha <= 0 && e.dead) {
        this.scene.remove(e.pivot);
        this.objects.delete(key);
        continue;
      }
      const [X, Z] = toScene(e.x, e.y);
      e.pivot.position.set(X, 0, Z);
      e.pivot.rotation.y = e.h;
      const sc = 0.85 + 0.15 * e.alpha;
      e.pivot.scale.set(sc, sc, sc);
      for (const m of e.group.userData.paint) { m.opacity = e.alpha; m.transparent = e.alpha < 1; }
    }
  }

  _ego(dt) {
    const st = this.state || {};
    const cs = (st.op && st.op.carState) || {};
    const lights = st.fisker && st.fisker.vehicle ? st.fisker.vehicle.lights : {};
    this.blinkPhase += dt * 1.6;
    const on = this.blinkPhase % 1 < 0.55;
    const left = cs.leftBlinker || lights.left || lights.hazard;
    const right = cs.rightBlinker || lights.right || lights.hazard;
    const b = this.ego.userData.blink;
    b.fl.visible = b.rl.visible = !!left && on;
    b.fr.visible = b.rr.visible = !!right && on;
    const braking = cs.brakePressed || lights.brake;
    for (const m of this.ego.userData.tailMats) m.emissiveIntensity = braking ? 2.4 : 0.6;
  }

  _camera(dt) {
    const now = performance.now();
    if (this.viewAnim) {
      const a = this.viewAnim;
      a.t = Math.min(1, a.t + dt / 0.6);
      const e = 1 - Math.pow(1 - a.t, 3);
      const sph = new THREE.Spherical(
        a.from.radius + (a.to.radius - a.from.radius) * e,
        a.from.phi + (a.to.phi - a.from.phi) * e,
        a.from.theta + ((((a.to.theta - a.from.theta) + Math.PI) % (2 * Math.PI)) - Math.PI) * e,
      );
      this.controls.target.lerpVectors(a.targetFrom, this.target, e);
      this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(sph));
      this.viewOffset.y = a.offFrom + (a.offTo - a.offFrom) * e;
      this.resize();
      if (a.t >= 1) this.viewAnim = null;
    } else if (!this.interacting && now - this.lastInteract > RECENTER_S * 1000) {
      // panned away? glide the orbit center back onto the car
      const d = this.controls.target.distanceTo(this.target);
      if (d > 0.05) {
        const delta = this.target.clone().sub(this.controls.target).multiplyScalar(1 - Math.exp(-dt * 3));
        this.controls.target.add(delta);
        this.camera.position.add(delta);
      }
    }
    // keep panning within reach of the car
    const off = this.controls.target.clone().sub(this.target);
    if (off.length() > 40) {
      off.setLength(40);
      const corr = this.target.clone().add(off).sub(this.controls.target);
      this.controls.target.add(corr);
      this.camera.position.add(corr);
    }
    this.controls.update();
  }

  frame(dt) {
    dt = Math.min(dt, 0.1);
    this._camera(dt);
    this._laneGeometry(dt);
    this._uss();
    this._objects(dt);
    this._ego(dt);
    this.renderer.render(this.scene, this.camera);
  }
}
