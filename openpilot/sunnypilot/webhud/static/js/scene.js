// three.js car view. World objects (vehicles, people) are 3D; road markings are flat ribbons.
//
// Vehicle frame (server data): x forward, y left, meters, origin = ego front bumper.
// Scene frame (three.js):      X right, Y up, Z backward. So X = -y, Z = -x.
import * as THREE from '../vendor/three.module.min.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { makeEgo, makeObject, fitScale, loadEgoModel } from './models.js';
import { applyLamps } from './lamps.js';
import { RoadModel, linePoints } from './road.js';
import { RoadFurniture } from './furniture.js';
import { PowerTrails, motorLoad } from './tracks.js';
import { STEER_RATIO } from './vehicle.js';

const EGO_LEN = 4.775;
const EGO_W = 1.98;
const MODEL_X_OFFSET = -1.6;      // comma device sits ~1.6 m behind the front bumper
const DASH = 3.0, GAP = 9.0;      // US lane dash pattern (10 ft / 30 ft)
const RECENTER_S = 5;             // pan springs back to the car after this long untouched
const CHASE_SPEED_DOLLY = 0.5;    // chase camera backs off this much farther (x its distance) at 70 mph
const DOLLY_FULL_SPEED = 31.3;    // m/s
const CAM_YAW_W = 2.6;            // rad/s: camera heading spring (critically damped); lags 2/W s of yaw
const CAM_YAW_MAX = 0.6;          // rad: most the camera trails the car's heading by
const TILE = 48;                  // m: every layer of the road surface repeats over this
const GROUND_SIZE = 10 * TILE;    // textured plane under the car; fog hides its edge
const REAR_AXLE_Z = EGO_LEN - 0.93;   // until the model reports its own
const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

// Tileable value-noise fBm (period = the texture), as a grey canvas texture.
function noiseTexture(size, cells, octaves, gain, seed, anisotropy) {
  const hash = (x, y, o) => {
    let h = (x * 374761393 + y * 668265263 + o * 2147483647 + seed * 144269) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const val = new Float32Array(size * size);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const n = cells << o;
    for (let py = 0; py < size; py++) {
      const fy = py / size * n, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
      for (let px = 0; px < size; px++) {
        const fx = px / size * n, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
        const x0 = ix % n, x1 = (ix + 1) % n, y0 = iy % n, y1 = (iy + 1) % n;
        const a = hash(x0, y0, o), b = hash(x1, y0, o), c = hash(x0, y1, o), d = hash(x1, y1, o);
        val[py * size + px] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
      }
    }
    total += amp;
    amp *= gain;
  }
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  let lo = Infinity, hi = -Infinity;
  for (const v of val) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (let i = 0; i < val.length; i++) {
    const g = Math.round(255 * (val[i] - lo) / (hi - lo || 1));
    img.data.set([g, g, g, 255], i * 4);
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = anisotropy;
  return tex;
}

// The road surface: a fine, soft "cloud" rather than slabs. Fine grain (2 m tile) over two soft
// cloud layers (12 m and 48 m), mixed in the shader from the plane's own coordinates, so it reads as
// a fine surface near the car and never shows a repeating pattern. Nothing in it has a direction:
// the plane turns with the integrated heading while lane lines stay car-relative.
function groundMaterial(anisotropy) {
  const uniforms = {
    tGrain: { value: noiseTexture(256, 24, 4, 0.6, 7, anisotropy) },
    tCloud: { value: noiseTexture(256, 4, 5, 0.55, 3, anisotropy) },
    uContrast: { value: 0.1 },
    uBg: { value: new THREE.Color(0xffffff) },
    uFade: { value: new THREE.Vector2(40, 160) },   // m from the car: start/end of the fade into the background
  };
  const m = new THREE.MeshBasicMaterial({ color: 0xffffff });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = 'varying vec2 vGround;\nvarying vec2 vScene;\n' + sh.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\nvGround = position.xz;\nvScene = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = 'varying vec2 vGround;\nvarying vec2 vScene;\nuniform sampler2D tGrain;\nuniform sampler2D tCloud;\nuniform float uContrast;\nuniform vec3 uBg;\nuniform vec2 uFade;\n' +
      sh.fragmentShader.replace('#include <map_fragment>', `
        float grain = texture2D(tGrain, vGround / 2.0).r;
        float mid = texture2D(tCloud, vGround / 12.0 + vec2(0.37, 0.61)).r;
        float cloud = texture2D(tCloud, vGround / 48.0).r;
        float n = (cloud - 0.5) * 0.6 + (mid - 0.5) * 0.45 + (grain - 0.5) * 0.8;
        diffuseColor.rgb *= 1.0 + n * uContrast;
        // fade into the background with distance from the car (sooner when there's no road to show)
        diffuseColor.rgb = mix(diffuseColor.rgb, uBg, smoothstep(uFade.x, uFade.y, length(vScene - vec2(0.0, 2.4))));`);
  };
  m.userData.uniforms = uniforms;
  return m;
}

// headlight throw: narrow and bright at the bumper (bottom), widening and fading down the road (top)
let beamTexture = null;
function beamTex() {
  if (beamTexture) return beamTexture;
  const W = 64, H = 128;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const d = 1 - y / (H - 1);                      // 0 at the bumper, 1 at the far end
    const half = 0.32 + 0.68 * Math.sqrt(d);        // half-width of the throw, as a fraction
    const along = Math.min(1, d * 6) * Math.pow(1 - d, 1.4);
    for (let x = 0; x < W; x++) {
      const u = Math.abs(x / (W - 1) * 2 - 1) / half;
      const a = u >= 1 ? 0 : along * (1 - u * u);
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(255 * a);
    }
  }
  ctx.putImageData(img, 0, 0);
  beamTexture = new THREE.CanvasTexture(c);
  return beamTexture;
}

// light thrown on the road, stretched by scale
function lightPool(color, map) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map, color, transparent: true, depthWrite: false }),
  );
  m.position.y = 0.012;
  m.renderOrder = 1;
  m.visible = false;
  return m;
}

const THEMES = {
  light: { bg: 0xeceef1, ground: 0xe2e5e9, road: 0x1a1d22, object: 0xc6cad1, lead: 0x4f5562, line: 0x8e949d, edge: 0x6c727b, yellow: 0xdcaa2e,
    blue: 0x3e6ae1, red: 0xe5413a, path: 0x3e6ae1, model: 0xa7adb5, hemiSky: 0xffffff, hemiGround: 0xb8bcc4 },
  dark: { bg: 0x101216, ground: 0x181b20, road: 0x2c3038, object: 0x50565f, lead: 0xd5dae2, line: 0x6b717a, edge: 0x8a9099, yellow: 0xc9982a,
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

function dashed(pts, phase) {
  // split a polyline into dashes by arc length, cutting exact dash ends inside each segment (the
  // line is sampled every ~2 m, coarser than a dash); phase (distance driven) keeps them on the road
  const P = DASH + GAP;
  const out = [];
  let s0 = phase, cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-6) continue;
    const at = (d) => [x0 + (x1 - x0) * d / len, y0 + (y1 - y0) * d / len];
    let a = 0;
    while (a < len) {
      const m = (((s0 + a) % P) + P) % P;
      const dash = m < DASH;
      const next = Math.min(len, a + (dash ? DASH - m : P - m));
      if (dash) {
        if (!cur) { cur = [at(a)]; out.push(cur); }
        cur.push(at(next));
      } else cur = null;
      a = next;
    }
    s0 += len;
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

    // World-anchored road surface. `world` carries the inverse of the car's integrated pose, so the
    // texture stays put on the "road" while the car drives over it; the plane itself is re-centered
    // under the car in whole tiles so it never runs out.
    this.world = new THREE.Group();
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE).rotateX(-Math.PI / 2), groundMaterial(this.renderer.capabilities.getMaxAnisotropy()));
    this.ground.position.y = -0.01;
    this.world.add(this.ground);
    this.scene.add(this.world);
    this.pose = { x: 0, y: 0, h: 0 };   // rear axle: m, m, rad; x forward / y left at h = 0

    this.headBeam = lightPool(0xfff1cf, beamTex());
    this.scene.add(this.headBeam);

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
      // inferred (procedural) lane lines and the road surface
      lineSoft: lineMaterial(0x8e949d, 0.55), lineYellowSoft: lineMaterial(0xdcaa2e, 0.5), lineBlueSoft: lineMaterial(0x3e6ae1, 0.5),
      road: lineMaterial(0x000000, 0.06),
      // stop lines and crosswalks
      marking: lineMaterial(0x8e949d, 0.9),
    };
    this.ribbons = {};
    for (const key of Object.keys(this.mats)) {
      this.ribbons[key] = new Ribbon(this.mats[key], key === 'path' ? 128 : 1024);
      this.scene.add(this.ribbons[key].mesh);
    }
    this.ribbons.path.mesh.renderOrder = 1;
    this.ribbons.road.mesh.renderOrder = 0;
    this.road = new RoadModel();
    this.ribbons.zebra = new Ribbon(this.mats.marking, 256);
    this.scene.add(this.ribbons.zebra.mesh);
    this.furniture = new RoadFurniture(this.scene, this.world);
    this.tracks = new PowerTrails(this.world);

    this.objects = new Map();   // key -> track (see _track)
    this.labels = new Map();
    this.theme = THEMES.light;
    this.odometer = 0;
    this.clock = 0;
    this.state = null;
    this.vehicle = null;
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
    this.chaseDolly = 1;   // chase distance multiplier, grows with speed
    this.camYaw = { h: 0, v: 0, carH: 0 };   // camera heading (rad), its rate, the car's last heading
    this.camLag = 0;       // camera heading - car heading, applied as an orbit about the car
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
    this.ground.material.color.set(t.ground);
    this.ground.material.userData.uniforms.uBg.value.set(t.bg);
    this.ground.material.userData.uniforms.uContrast.value = dark ? 0.85 : 0.15;
    // headlight light adds up on a dark road; on a light one it tints it instead
    this.headBeam.material.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.headBeam.material.opacity = dark ? 0.45 : 0.2;
    this.headBeam.material.needsUpdate = true;
    this.tracks.setTheme(dark);
    this.hemi.color.set(t.hemiSky);
    this.hemi.groundColor.set(t.hemiGround);
    this.mats.line.color.set(t.line);
    this.mats.lineSoft.color.set(t.line);
    this.mats.marking.color.set(t.line);
    this.mats.lineYellowSoft.color.set(t.yellow);
    this.mats.lineBlueSoft.color.set(t.blue);
    this.mats.road.color.set(t.road);
    // inferred road: full opacity, scaled by the road model's confidence each frame
    this.softOpacity = { road: dark ? 0.35 : 0.07, lineSoft: 0.55, lineYellowSoft: 0.5, lineBlueSoft: 0.5 };
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
    const to = new THREE.Spherical(v.r * (name === 'chase' ? this.chaseDolly : 1), v.phi, v.theta);
    const from = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    from.theta -= this.camLag;   // the animation works without the lag and adds the current one
    this.viewAnim = instant ? null : { from, to, t: 0, targetFrom: this.controls.target.clone(), offFrom: this.viewOffset.y, offTo: v.offY };
    if (instant) {
      this.controls.target.copy(this.target);
      this.camera.position.copy(this.target).add(new THREE.Vector3().setFromSpherical(new THREE.Spherical(to.radius, to.phi, to.theta + this.camLag)));
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
    const offY = this.viewOffset.y;
    this.camera.setViewOffset(w, h, -this.viewOffset.x * w, -offY * h, w, h);
    this.camera.updateProjectionMatrix();
  }

  // ---- data -----------------------------------------------------------------------------------

  update(state, settings) {
    this.state = state;
    this.settings = settings;
    this.stateSeq = (this.stateSeq || 0) + 1;
  }

  _laneGeometry(dt) {
    const st = this.state || {};
    const op = st.op || {};
    const f = st.fisker;
    const s = this.settings;
    const cs = op.carState || {};
    const phase = this.odometer % (DASH + GAP);   // advanced in _ground, so dashes and road move together

    const latActive = !!((op.carControl && op.carControl.latActive) || (op.selfdriveStateSP && op.selfdriveStateSP.mads && op.selfdriveStateSP.mads.active));
    const hmi = f && f.lanes ? f.lanes.hmi : null;
    const pieces = { line: [], lineBlue: [], lineYellow: [], lineRed: [], lineSoft: [], lineYellowSoft: [], lineBlueSoft: [], edge: [], model: [], modelEdge: [] };
    const xTo = 90, xFrom = -30;

    // smoothed + procedurally completed road (road.js)
    const road = this.road.update(st, this.vehicle, s, dt);
    const anchor = linePoints(road.anchor.c, xFrom, xTo, 2);
    const fromCenter = (d) => offsetLine(anchor, d - road.anchor.offset);
    // the inferred road only shows as far as we believe the car is on a laned road
    const rc = s.showRoad === false ? 0 : road.confidence;
    for (const [k, o] of Object.entries(this.softOpacity || {})) this.mats[k].opacity = o * rc;
    this.ribbons.road.set(rc > 0.02 ? [fromCenter(road.surface.offset)] : [], road.surface.width, 0.006);
    const u = this.ground.material.userData.uniforms;
    u.uFade.value.set(16 + 34 * rc, 60 + 110 * rc);
    for (const line of road.lines) {
      if (line.inferred && rc <= 0.02) continue;
      const pts = line.inferred ? fromCenter(line.offset) : linePoints(line.c, xFrom, xTo, 2);
      if (line.edge) { pieces.edge.push(pts); continue; }
      const ego = line.id === 'L1' || line.id === 'R1';
      let key = line.color === 'yellow' ? 'lineYellow' : 'line';
      const side = line.id === 'L1' ? hmi && hmi.left : line.id === 'R1' ? hmi && hmi.right : null;
      if (ego && (latActive || (side && side.color === 'blue'))) key = 'lineBlue';
      if (ego && side && (side.color === 'red' || (side.flash && this.clock % 0.6 < 0.3))) key = 'lineRed';
      if (line.inferred) key = { line: 'lineSoft', lineYellow: 'lineYellowSoft', lineBlue: 'lineBlueSoft', lineRed: 'lineRed' }[key];
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
    // stop line / crosswalk the ADAS reports, across the road at its distance
    const mk = this.furniture.markings(this.road);
    this.ribbons.marking.set(mk.stop, 0.5, 0.025);
    this.ribbons.zebra.set(mk.zebra, 0.55, 0.025);
    // 'both': openpilot's raw lane lines on top, thin
    if (s.laneSource === 'both' && op.modelV2) {
      const md = op.modelV2;
      const probs = md.laneLineProbs || [];
      (md.laneLines || []).forEach((pts, i) => {
        if (pts.length && (probs[i] || 0) >= 0.25) pieces.model.push(densify(pts.map(([x, y]) => [x + MODEL_X_OFFSET, y]), 2));
      });
      (md.roadEdges || []).forEach((pts, i) => {
        const std = (md.roadEdgeStds || [])[i];
        if (pts.length && (std == null || std < 1.0)) pieces.modelEdge.push(densify(pts.map(([x, y]) => [x + MODEL_X_OFFSET, y]), 2));
      });
    }
    this.ribbons.line.set(pieces.line, 0.14);
    this.ribbons.lineSoft.set(pieces.lineSoft, 0.13);
    this.ribbons.lineYellowSoft.set(pieces.lineYellowSoft, 0.14);
    this.ribbons.lineBlueSoft.set(pieces.lineBlueSoft, 0.18);
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

  // Objects are tracked, not just drawn: an alpha-beta filter per object estimates its relative
  // velocity from the ~10-20 Hz, 0.5 m-quantized ADAS positions and extrapolates between updates,
  // so cars glide instead of stepping. Size, heading and class are smoothed too, and an object has
  // to be missing for a moment before it fades.
  _objects(dt) {
    const st = this.state || {};
    const f = st.fisker;
    const op = st.op || {};
    const s = this.settings;
    const t = this.theme;
    const now = this.clock;
    const fresh = this.stateSeq !== this.objSeq;
    this.objSeq = this.stateSeq;

    if (fresh) {
      const list = [];
      for (const o of (f && f.objects) || []) {
        list.push({ key: 'f' + o.id, x: o.x, y: o.y, h: (o.heading || 0) * (s.objectHeadingSign || 1), cls: o.cls, w: o.w, l: o.l, hgt: o.h,
          lead: o.flags.includes('accPrimary') || o.flags.includes('leading'), threat: o.flags.some(fl => ['bsd', 'dow', 'aeb', 'raeb', 'bacm', 'elka'].includes(fl)),
          label: `${o.cls} #${o.id}` });
      }
      // The ADAS sometimes reports one car twice while it hands a track over to a new ID: keep one
      // (the flagged one if either is), else the pair shows as a car with an echo right behind it.
      // Two cars in one lane can't be closer than a car length (positions are their rear bumpers).
      const near = (a, b, d) => Math.abs(a.x - b.x) < Math.max(4.5, a.l || 0, b.l || 0, 0.1 * d) && Math.abs(a.y - b.y) < 1.5;
      for (let i = list.length - 1; i >= 0; i--) {
        const j = list.findIndex((o, k) => k !== i && o.cls === list[i].cls && near(o, list[i], Math.abs(o.x)));
        if (j >= 0 && (list[i].lead || list[i].threat) <= (list[j].lead || list[j].threat)) list.splice(i, 1);
      }
      // openpilot's leads (from the comma camera; the Fisker port has no radar), unless the ADAS
      // already reports a car there; camera ranging gets looser with distance, so the gate does too
      const rs = op.radarState;
      const engaged = !!(op.selfdriveState && op.selfdriveState.enabled);
      if (rs && s.showOpLeads !== false) {
        [rs.leadOne, rs.leadTwo].forEach((ld, i) => {
          if (!ld || !ld.present) return;
          const dup = list.some(o => Math.abs(o.x - ld.dRel) < Math.max(4, 0.15 * ld.dRel) && Math.abs(o.y - ld.yRel) < 2.2);
          if (!dup) list.push({ key: 'op' + i, x: ld.dRel, y: ld.yRel, vx: ld.vRel, h: 0, cls: 'car', w: 1.9, l: 4.6, hgt: 1.5, lead: i === 0 && engaged, threat: false, label: `lead ${ld.dRel.toFixed(0)} m` });
        });
      }
      // known IDs first, so a handover (in _track) only ever takes a track nobody updated this time
      list.sort((a, b) => this.objects.has(b.key) - this.objects.has(a.key));
      for (const o of list) this._track(o, now);
    }

    const kDisp = 1 - Math.exp(-dt / 0.06), kSlow = 1 - Math.exp(-dt / 0.4), kHead = 1 - Math.exp(-dt / 0.25);
    // a track that stopped updating while another one sits on top of it is the same car re-IDed
    const live = [...this.objects.values()].filter(e => now - e.lastSeen < 0.12);
    const overlapped = (e) => live.some(o => o !== e && Math.abs(o.dx - e.dx) < Math.max(4.5, 0.1 * Math.abs(e.dx)) && Math.abs(o.dy - e.dy) < 1.5);
    for (const [key, e] of this.objects) {
      const stale = now - e.lastSeen;
      const dead = stale > 0.5 || (stale > 0.12 && overlapped(e));
      // extrapolate from the last update (not too far), then ease the drawn position onto it
      const ahead = Math.min(0.35, now - e.tmeas);
      const tx = e.x + e.vx * ahead, ty = e.y + e.vy * ahead;
      if (e.alpha === 0) { e.dx = tx; e.dy = ty; e.dh = e.th; }
      e.dx += (tx - e.dx) * kDisp;
      e.dy += (ty - e.dy) * kDisp;
      e.dh += (((e.th - e.dh + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI) * kHead;
      for (const d of ['w', 'l', 'hgt']) e.dim[d] += (e.mdim[d] - e.dim[d]) * kSlow;
      fitScale(e.group, e.cls, e.dim.w, e.dim.l, e.dim.hgt);

      e.alpha = Math.max(0, Math.min(1, e.alpha + (dead ? -dt * 3 : dt * 4)));
      if (e.alpha <= 0 && dead) {
        this.scene.remove(e.pivot);
        this.objects.delete(key);
        continue;
      }
      // the ADAS measures to the nearest point: a car ahead is reported at its rear bumper
      const L = e.group.userData.length * e.group.scale.z;
      const cx = e.dx > 2 ? e.dx + L / 2 : e.dx < -2 ? e.dx - L / 2 : e.dx;
      const [X, Z] = toScene(cx, e.dy);
      e.pivot.position.set(X, 0, Z);
      e.pivot.rotation.y = e.dh;
      const sc = 0.85 + 0.15 * e.alpha;
      e.pivot.scale.set(sc, sc, sc);
      const color = e.threat ? t.red : e.lead ? t.lead : t.object;
      if (e.color !== color) {
        for (const m of e.group.userData.paint) m.color.set(color);
        e.color = color;
      }
      for (const m of e.group.userData.paint) { m.opacity = e.alpha; m.transparent = e.alpha < 1; }
    }
  }

  _objectModel(e, kind) {
    if (e.pivot) this.scene.remove(e.pivot);
    const group = makeObject(kind, this.theme.object);
    const pivot = new THREE.Group();
    group.position.z = -group.userData.length / 2;   // pivot at the object's center
    pivot.add(group);
    this.scene.add(pivot);
    Object.assign(e, { pivot, group, kind, color: null });
  }

  _track(o, now) {
    // low cars get the sedan body, everything else car-sized the SUV body
    const kindOf = (cls, hgt) => (cls === 'car' && hgt > 0.5 && hgt < 1.55 ? 'sedan' : cls);
    let e = this.objects.get(o.key);
    if (!e) {
      // A new ID right where a track just stopped updating is the same object handed over (the ADAS
      // re-IDs cars, and a car moves from openpilot's lead to the ADAS list): take that track over
      // rather than drawing a second car beside the fading old one.
      for (const [key, old] of this.objects) {
        if (old.lastSeen >= now || (old.cls !== o.cls && !(o.cls === 'car' && key.startsWith('op')))) continue;
        const ahead = Math.min(0.35, now - old.tmeas);
        const px = old.x + old.vx * ahead, py = old.y + old.vy * ahead;
        if (Math.abs(px - o.x) < Math.max(4.5, 0.12 * Math.abs(o.x)) && Math.abs(py - o.y) < 1.6) {
          this.objects.delete(key);
          this.objects.set(o.key, old);
          e = old;
          break;
        }
      }
    }
    if (!e) {
      const dim = { w: o.w || 0, l: o.l || 0, hgt: o.hgt || 0 };
      e = { alpha: 0, x: o.x, y: o.y, vx: o.vx || 0, vy: 0, th: o.h * DEG, tmeas: now, raw: null, cls: o.cls,
        mdim: { ...dim }, dim, cand: null, candAt: now };
      this._objectModel(e, kindOf(o.cls, o.hgt));
      this.objects.set(o.key, e);
    }
    e.lastSeen = now;
    e.lead = o.lead; e.threat = o.threat; e.label = o.label;
    e.mdim = { w: o.w || 0, l: o.l || 0, hgt: o.hgt || 0 };
    e.th = o.h * DEG;
    // a class change has to persist before the model is swapped
    const kind = kindOf(o.cls, e.dim.hgt);
    if (kind !== e.kind) {
      if (e.cand !== kind) { e.cand = kind; e.candAt = now; }
      else if (now - e.candAt > 0.6) { e.cls = o.cls; this._objectModel(e, kind); e.cand = null; }
    } else e.cand = null;

    // same reading as last time: the ADAS hasn't updated yet (unless it's been a while)
    const raw = `${o.x},${o.y}`;
    if (raw === e.raw && now - e.tmeas < 0.25) return;
    e.raw = raw;
    const dtm = Math.min(0.5, Math.max(0.02, now - e.tmeas));
    const px = e.x + e.vx * dtm, py = e.y + e.vy * dtm;
    const rx = o.x - px, ry = o.y - py;
    if (Math.hypot(rx, ry) > 5 + 0.08 * Math.abs(o.x)) {
      // jumped (reused id, or reacquired): restart the track there
      e.x = o.x; e.y = o.y; e.vx = o.vx || 0; e.vy = 0;
    } else {
      const A = 0.45, B = 0.12;
      e.x = px + A * rx; e.y = py + A * ry;
      e.vx = Math.max(-45, Math.min(45, e.vx + B * rx / dtm));
      e.vy = Math.max(-12, Math.min(12, e.vy + B * ry / dtm));
    }
    e.tmeas = now;
  }

  // Integrate the car's motion and move the road surface (and lane dashes) under it. The pose is
  // the rear axle's (kinematic bicycle model: the rear axle moves along the heading), so turns
  // pivot about it like the real car.
  _ground(dt) {
    const vs = this.vehicle;
    const v = vs ? vs.v : 0;
    const p = this.pose;
    p.h += v * (vs ? vs.curvature : 0) * dt;
    p.x += v * Math.cos(p.h) * dt;
    p.y += v * Math.sin(p.h) * dt;
    // keep the numbers small; the texture repeats every TILE so whole-tile jumps are invisible
    const wrap = TILE * 1000;
    if (Math.abs(p.x) > wrap) p.x -= Math.sign(p.x) * wrap;
    if (Math.abs(p.y) > wrap) p.y -= Math.sign(p.y) * wrap;
    this.odometer += v * dt;

    // `world` = inverse of the rear axle's pose, in scene axes (X = -y, Z = -x), about the axle
    const c = Math.cos(p.h), s = Math.sin(p.h);
    const zr = this.ego.userData.rearAxleZ ?? REAR_AXLE_Z;
    this.world.rotation.y = -p.h;
    this.world.position.set(p.y * c - p.x * s, 0, p.y * s + p.x * c + zr);
    this.ground.position.set(Math.round(-p.y / TILE) * TILE, -0.01, Math.round(-p.x / TILE) * TILE);
    this.ground.visible = this.settings.showGround !== false;
  }

  _ego(dt) {
    const vs = this.vehicle;
    const ud = this.ego.userData;
    if (!vs) return;
    const L = vs.lamps;

    if (ud.lamps) applyLamps(ud.lamps, L);

    // wheels roll with the distance travelled; the front pair follows the road-wheel angle.
    // Past ~30 km/h (at 60 fps) the per-frame turn is capped at a fraction of the spoke pitch, so the rims
    // read as spinning fast instead of strobing backwards (the wagon-wheel effect).
    const steer = THREE.MathUtils.clamp(vs.steerDeg / STEER_RATIO * DEG, -0.6, 0.6);
    const k = 1 - Math.exp(-dt * 15);   // steering arrives at 20 Hz; ease between samples
    for (const w of ud.wheels || []) {
      const cap = 0.3 * Math.PI * 2 / (w.spokes || 5);
      const turn = THREE.MathUtils.clamp(vs.v * dt / w.r, -cap, cap);
      w.spin.rotation.x = (w.spin.rotation.x - turn) % (Math.PI * 2);
      if (w.front) w.steer.rotation.y += (steer - w.steer.rotation.y) * k;
    }

    // headlight throw on the road ahead (low/high beam only)
    const beam = L.high ? 28 : 15;
    this.headBeam.visible = L.low || L.high;
    this.headBeam.scale.set(L.high ? 4.2 : 3.6, 1, beam);
    this.headBeam.position.z = -beam / 2 - 0.3;
  }

  _tracks(dt) {
    const h = this.renderer.getDrawingBufferSize(this._buf || (this._buf = new THREE.Vector2())).y;
    const pxScale = h / (2 * Math.tan(this.camera.fov * DEG / 2));
    this.tracks.update(dt, this.vehicle, this.ego, motorLoad(this.state), this.settings.showTracks !== false, pxScale);
  }

  _camera(dt) {
    const now = performance.now();
    // inertia: the camera's heading follows the car's on a critically damped spring, so in a sharp turn
    // the car swings round in the frame first and the camera catches up as it straightens out. Applied
    // as an orbit about the car (Spherical theta), on top of the view and any user rotation.
    const cy = this.camYaw, h = this.pose.h;
    if (dt > 0) {
      const carRate = (h - cy.carH) / dt;
      cy.carH = h;
      cy.v += (CAM_YAW_W * CAM_YAW_W * (h - cy.h) - 2 * CAM_YAW_W * cy.v) * dt;
      cy.h += cy.v * dt;
      if (Math.abs(cy.h - h) > CAM_YAW_MAX) {   // trail no farther; turn with the car from there
        cy.h = h + Math.sign(cy.h - h) * CAM_YAW_MAX;
        cy.v = carRate;
      }
    }
    const lag = cy.h - h, dLag = lag - this.camLag;
    this.camLag = lag;
    if (!this.viewAnim && dLag) {
      const off = this.camera.position.clone().sub(this.controls.target).applyAxisAngle(UP, dLag);
      this.camera.position.copy(this.controls.target).add(off);
    }
    // the chase view backs off as speed builds, showing more road ahead; scaling the current offset
    // keeps whatever zoom the user set, and the view animation targets the scaled distance
    const speed = this.vehicle ? this.vehicle.speed : 0;
    const dolly = 1 + CHASE_SPEED_DOLLY * Math.min(1, speed / DOLLY_FULL_SPEED);
    const prevDolly = this.chaseDolly;
    this.chaseDolly += (dolly - prevDolly) * (1 - Math.exp(-dt * 1.2));
    if (this.view === 'chase' && !this.viewAnim && !this.interacting) {
      const off = this.camera.position.clone().sub(this.controls.target).multiplyScalar(this.chaseDolly / prevDolly);
      this.camera.position.copy(this.controls.target).add(off);
    } else if (this.viewAnim && this.view === 'chase') {
      this.viewAnim.to.radius *= this.chaseDolly / prevDolly;
    }
    if (this.viewAnim) {
      const a = this.viewAnim;
      a.t = Math.min(1, a.t + dt / 0.6);
      const e = 1 - Math.pow(1 - a.t, 3);
      const sph = new THREE.Spherical(
        a.from.radius + (a.to.radius - a.from.radius) * e,
        a.from.phi + (a.to.phi - a.from.phi) * e,
        a.from.theta + ((((a.to.theta - a.from.theta) + Math.PI) % (2 * Math.PI)) - Math.PI) * e + this.camLag,
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

  frame(dt, vehicle) {
    dt = Math.min(dt, 0.1);
    this.clock += dt;
    this.vehicle = vehicle;
    this._ground(dt);
    this._camera(dt);
    this.furniture.update(this.state, this.road, this.vehicle, this.settings, dt, this.clock, toScene);
    this._laneGeometry(dt);
    this._uss();
    this._objects(dt);
    this._ego(dt);
    this._tracks(dt);
    this.renderer.render(this.scene, this.camera);
  }
}
