// Traffic lights, signs and road markings, placed where they most likely are.
//
// All of it comes from the car's ADAS camera (fisker.tlr / fisker.tsr / fisker.road), which gives
// what it saw and, for lights and markings, how far ahead, but never where across the road:
//  - the ego-lane traffic light floats over our lane at the reported distance (else at the stop
//    line's or a landmark's distance, else an estimate), dead-reckoned between updates;
//  - a sign the camera has just read (speed limit change or re-read, prohibition sign) is put up at
//    the roadside a little ahead, so the car drives past it;
//  - stop lines and crosswalks are painted across the road at their distance.
// Each is anchored to the road, not the ground: a station down it (distance driven, road.js `odo`) and
// an offset across it (over our lane's center, or beside its outer lane on our side), placed every
// frame on the road as it's drawn then (road.js `place`). A sign 50 m down a road drawn curving left
// that turns out to run straight is, 10 m on, 40 m down the straight road and still beside it.
import * as THREE from '../vendor/three.module.min.js';

const LIGHT_HEIGHT = 3.8;      // m, bottom of the signal head over the road (a bit low, so it stays in view)
const LIGHT_SCALE = 1.6;       // drawn larger than life so it reads at 60+ m
const SIGN_SCALE = 1.7;
const SIGN_AHEAD = 16;         // m: where a just-read sign goes up...
const SIGN_GAP = 1.3;          // ...this far beyond the outer lane line on our side
const LAMP = { red: 0xff3b30, amber: 0xffb020, green: 0x34d058 };

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ---- traffic light ------------------------------------------------------------------------------

const lampTextures = {};
function lampTexture(shape) {   // white symbol on transparent; tinted by the material color
  if (lampTextures[shape]) return lampTextures[shape];
  lampTextures[shape] = canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = '#fff';
    if (shape === 'circle') {
      ctx.beginPath(); ctx.arc(64, 64, 58, 0, Math.PI * 2); ctx.fill();
      return;
    }
    // arrow on a dark disc, pointing left or right
    ctx.beginPath(); ctx.arc(64, 64, 58, 0, Math.PI * 2); ctx.globalAlpha = 0.18; ctx.fill(); ctx.globalAlpha = 1;
    ctx.save();
    ctx.translate(64, 64);
    if (shape === 'right') ctx.scale(-1, 1);
    ctx.beginPath();
    ctx.moveTo(-42, 0); ctx.lineTo(-6, -32); ctx.lineTo(-6, -13); ctx.lineTo(40, -13);
    ctx.lineTo(40, 13); ctx.lineTo(-6, 13); ctx.lineTo(-6, 32); ctx.closePath();
    ctx.fill();
    ctx.restore();
  });
  return lampTextures[shape];
}

class TrafficLight {
  constructor() {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.alpha = 0;
    this.d = null;          // m ahead, estimated
    this.key = null;
    this.housing = new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.6, metalness: 0.2, transparent: true });
  }

  // (re)build the head for a lamp count and orientation
  build(spots, horizontal) {
    const key = `${spots}/${horizontal}`;
    if (key === this.key) return;
    this.key = key;
    this.group.clear();
    const pitch = 0.32, r = 0.12;
    const len = spots * pitch + 0.06;
    const box = new THREE.Mesh(new THREE.BoxGeometry(horizontal ? len : 0.4, horizontal ? 0.4 : len, 0.24), this.housing);
    this.group.add(box);
    this.lamps = [];
    for (let i = 0; i < spots; i++) {
      const off = (i - (spots - 1) / 2) * pitch;
      const mat = new THREE.MeshBasicMaterial({ map: lampTexture('circle'), transparent: true, depthWrite: false, toneMapped: false });
      const lamp = new THREE.Mesh(new THREE.CircleGeometry(r, 24), mat);
      // order: red, amber, green, then extra (arrow) lamps; top -> bottom, or left -> right
      lamp.position.set(horizontal ? off : 0, horizontal ? 0 : -off, 0.125);
      const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.14), this.housing);
      visor.position.set(lamp.position.x, lamp.position.y + r + 0.02, 0.19);
      this.group.add(lamp, visor);
      this.lamps.push(mat);
    }
    this.group.scale.setScalar(LIGHT_SCALE);
  }

  // which lamps are lit: [{i, color, shape}]
  static lit(tlr, spots, clock) {
    // the active light (fisker_world picks it from the ego-lane color, the plain light color or the
    // warning); the ego-lane status only speaks for the ego-lane color
    const active = tlr.active || (tlr.detected ? { color: tlr.color, source: 'egoLane' } : null);
    if (!active) return [];
    const color = active.color || '';
    const shape = tlr.shape === 'Left_Arrow' ? 'left' : tlr.shape === 'Right_Arrow' ? 'right' : 'circle';
    if (tlr.status === 'Off' && active.source === 'egoLane') return [];
    if (tlr.status === 'Blinking' && clock % 1 > 0.5) return [];
    const out = [];
    const main = /^Red/.test(color) ? 0 : /Amber|Orange/.test(color) && !/^Red/.test(color) ? 1 : /Green/.test(color) ? 2 : -1;
    if (main >= 0) out.push({ i: main, color: ['red', 'amber', 'green'][main], shape });
    if (/Supp_green/.test(color)) out.push({ i: Math.min(spots - 1, 3), color: 'green', shape: 'left' });
    if (/Supp_Orange/.test(color)) out.push({ i: 1, color: 'amber', shape: 'circle' });
    return out;
  }

  update(f, road, vehicle, dt, clock, toScene) {
    const tlr = (f && f.tlr) || {};
    const rd = (f && f.road) || {};
    const seen = tlr.detected || (tlr.orientation && !/No_Structure|Unknown/.test(tlr.orientation)) ||
      (rd.landmark && rd.landmark.type === 'Traffic_Light');
    // distance: measured, else the stop line's (the head usually stands past it), else a landmark's,
    // else carry the last estimate along, else a guess
    const stop = rd.laneMarking && rd.laneMarking.type === 'Intersection_Stop_Line' ? rd.laneMarking.dist : null;
    const meas = tlr.dist || (stop ? stop + 18 : null) || (rd.landmark && rd.landmark.type === 'Traffic_Light' ? rd.landmark.dist : null);
    if (this.d != null) this.d -= (vehicle ? vehicle.v : 0) * dt;
    if (seen) {
      if (this.d == null || this.alpha === 0) this.d = meas || 45;
      else if (meas) this.d = Math.abs(meas - this.d) > 15 ? meas : this.d + (meas - this.d) * (1 - Math.exp(-dt / 0.3));
    }
    const show = seen && this.d != null && this.d > -6 && this.d < 160;
    this.alpha = Math.max(0, Math.min(1, this.alpha + (show ? dt * 3 : -dt * 2)));
    this.group.visible = this.alpha > 0;
    if (!this.group.visible) { if (!seen) this.d = null; return; }

    const spots = Math.max(2, Math.min(5, tlr.lights || 3));
    this.build(spots, tlr.orientation === 'Horizontal');
    const lit = TrafficLight.lit(tlr, spots, clock);
    this.lamps.forEach((m, i) => {
      const on = lit.find(l => l.i === i);
      const base = [LAMP.red, LAMP.amber, LAMP.green][Math.min(i, 2)];
      m.map = lampTexture(on ? on.shape : 'circle');
      m.color.setHex(on ? LAMP[on.color] : base).multiplyScalar(on ? 1 : 0.035);   // linear: dark glass when off
      m.opacity = this.alpha;
    });
    this.housing.opacity = this.alpha;

    // over our lane, facing back down the road
    const p = road.place(this.d, 0);
    const [X, Z] = toScene(p.x, p.y);
    this.group.position.set(X, LIGHT_HEIGHT + 0.5 * LIGHT_SCALE, Z);
    this.group.rotation.y = p.h;
  }
}

// ---- signs ----------------------------------------------------------------------------------------

function ring(ctx, w, h) {
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(w / 2, h / 2, w / 2 - 2, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#d8241c'; ctx.lineWidth = w * 0.11;
  ctx.beginPath(); ctx.arc(w / 2, h / 2, w / 2 - w * 0.075, 0, Math.PI * 2); ctx.stroke();
}

function slash(ctx, w) {
  ctx.strokeStyle = '#d8241c'; ctx.lineWidth = w * 0.1; ctx.lineCap = 'butt';
  const a = w * 0.17;
  ctx.beginPath(); ctx.moveTo(a, a); ctx.lineTo(w - a, w - a); ctx.stroke();
}

function turnArrow(ctx, w, dir) {   // a turn arrow (dir -1 left, +1 right) or U-turn (0)
  ctx.save();
  ctx.translate(w / 2, w / 2);
  ctx.strokeStyle = '#111'; ctx.fillStyle = '#111'; ctx.lineWidth = w * 0.09; ctx.lineCap = 'butt';
  const s = w / 256;
  ctx.beginPath();
  if (dir === 0) {
    ctx.moveTo(30 * s, 70 * s); ctx.lineTo(30 * s, -10 * s); ctx.arc(-5 * s, -10 * s, 35 * s, 0, Math.PI, true); ctx.lineTo(-40 * s, 30 * s);
    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-72 * s, 20 * s); ctx.lineTo(-8 * s, 20 * s); ctx.lineTo(-40 * s, 70 * s); ctx.closePath(); ctx.fill();
  } else {
    ctx.scale(dir, 1);
    ctx.moveTo(-20 * s, 75 * s); ctx.lineTo(-20 * s, -5 * s); ctx.quadraticCurveTo(-20 * s, -30 * s, 10 * s, -30 * s); ctx.lineTo(30 * s, -30 * s);
    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(30 * s, -62 * s); ctx.lineTo(75 * s, -30 * s); ctx.lineTo(30 * s, 2 * s); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

const signTextures = new Map();
// face texture + aspect for a sign spec ({kind:'limit', value, unit, plate} | {kind:'prohibited', name})
function signFace(spec) {
  const key = JSON.stringify(spec);
  if (signTextures.has(key)) return signTextures.get(key);
  let out;
  if (spec.kind === 'limit' && spec.unit === 'mph') {
    const plate = spec.plate ? 0.32 : 0;
    out = { aspect: 0.8 / (1 + plate), tex: canvasTexture(256, Math.round(320 * (1 + plate)), (ctx, w) => {
      const draw = (y0, h, lines) => {
        ctx.fillStyle = '#fff'; ctx.fillRect(0, y0, w, h);
        ctx.strokeStyle = '#111'; ctx.lineWidth = 10; ctx.strokeRect(12, y0 + 12, w - 24, h - 24);
        ctx.fillStyle = '#111'; ctx.textAlign = 'center';
        for (const [text, size, y] of lines) { ctx.font = `700 ${size}px Arial, sans-serif`; ctx.fillText(text, w / 2, y0 + y); }
      };
      draw(0, 320, [['SPEED', 52, 78], ['LIMIT', 52, 132], [String(spec.value), 128, 270]]);
      if (plate) draw(320, 100, [[spec.plate, 46, 66]]);
    }) };
  } else if (spec.kind === 'limit') {
    out = { aspect: 1, tex: canvasTexture(256, 256, (ctx, w, h) => {
      ring(ctx, w, h);
      ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `700 ${String(spec.value).length > 2 ? 92 : 112}px Arial, sans-serif`;
      ctx.fillText(String(spec.value), w / 2, h / 2 + 6);
    }) };
  } else {
    out = { aspect: 1, tex: canvasTexture(256, 256, (ctx, w, h) => {
      const n = spec.name;
      if (n === 'No_entry') {
        ctx.fillStyle = '#d8241c'; ctx.beginPath(); ctx.arc(w / 2, h / 2, w / 2 - 2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillRect(w * 0.18, h * 0.42, w * 0.64, h * 0.16);
        return;
      }
      ring(ctx, w, h);
      if (n === 'Forbidden_to_turn_left') turnArrow(ctx, w, -1);
      else if (n === 'Forbidden_to_turn_right') turnArrow(ctx, w, 1);
      else if (n === 'Do_not_U-turn') turnArrow(ctx, w, 0);
      else if (n === 'No_motor_vehicles_allowed') {
        ctx.fillStyle = '#111';
        ctx.fillRect(w * 0.26, h * 0.46, w * 0.48, h * 0.14);
        ctx.fillRect(w * 0.34, h * 0.36, w * 0.3, h * 0.12);
        for (const x of [0.35, 0.65]) { ctx.beginPath(); ctx.arc(w * x, h * 0.62, w * 0.06, 0, Math.PI * 2); ctx.fill(); }
      }
      if (n !== 'Prohibited') slash(ctx, w);
    }) };
  }
  signTextures.set(key, out);
  return out;
}

function makeSign(spec) {
  // own materials per sign, so each fades on its own
  const postMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.5, metalness: 0.5, transparent: true });
  const backMaterial = new THREE.MeshStandardMaterial({ color: 0x8d939b, roughness: 0.6, metalness: 0.4, transparent: true });
  const g = new THREE.Group();
  const face = signFace(spec);
  const h = 0.75 * SIGN_SCALE, w = h * face.aspect;
  const top = 2.1 * SIGN_SCALE;
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035 * SIGN_SCALE, 0.035 * SIGN_SCALE, top, 8), postMaterial);
  post.position.set(0, top / 2, -0.07);   // behind the face
  const mat = new THREE.MeshBasicMaterial({ map: face.tex, transparent: true });
  const front = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  front.position.set(0, top - h / 2, 0.01);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(w, h), backMaterial);
  back.rotation.y = Math.PI;
  back.position.set(0, top - h / 2, 0.0);
  g.add(post, front, back);
  g.userData.mats = [mat, postMaterial, backMaterial];
  return g;
}

// ---- the lot ----------------------------------------------------------------------------------------

export class RoadFurniture {
  constructor(scene) {
    this.scene = scene;
    this.light = new TrafficLight();
    scene.add(this.light.group);
    this.signs = [];
    this.prev = {};            // last TSR readings, to spot a new sign
    this.lastSpawn = new Map(); // sign key -> odometer at spawn
    this.marking = null;       // {type, d}
    this.odo = 0;
  }

  _spawn(spec, f, road, vehicle, toScene) {
    const key = JSON.stringify(spec);
    if (this.odo - (this.lastSpawn.get(key) ?? -1e9) < 120) return;   // same sign again within 120 m
    this.lastSpawn.set(key, this.odo);
    const left = f.road && f.road.trafficSide === 'Left_Hand_Traffic';
    const sign = makeSign(spec);
    // SIGN_AHEAD m down the road, beyond the outer lane on our side (a typical shoulder's width out
    // while the lanes aren't sure enough to show)
    sign.userData.anchor = { s: road.odo + SIGN_AHEAD, side: left ? 1 : -1, gap: road.lanesShown ? SIGN_GAP : SIGN_GAP + 1.5 };
    sign.userData.alpha = 0;
    sign.userData.age = 0;
    this.scene.add(sign);
    this.signs.push(sign);
    if (this.signs.length > 6) this._remove(this.signs[0]);
  }

  _remove(sign) {
    this.scene.remove(sign);
    this.signs = this.signs.filter(s => s !== sign);
  }

  // place an anchored sign on the road as it is now: facing back down the road, toed in toward it
  _place(sign, road, toScene) {
    const a = sign.userData.anchor;
    const p = road.place(a.s - road.odo, road.laneEdge(a.side) + a.side * a.gap);
    const [X, Z] = toScene(p.x, p.y);
    sign.position.set(X, 0, Z);
    sign.rotation.y = p.h - a.side * 0.18;
    return a.s - road.odo;
  }

  update(state, road, vehicle, settings, dt, clock, toScene) {
    const f = (state && state.fisker) || null;
    const v = vehicle ? vehicle.v : 0;
    this.odo += Math.abs(v) * dt;
    const showSigns = settings.showSigns !== false;

    // traffic light
    this.light.update(showSigns ? f : null, road, vehicle, dt, clock, toScene);

    // new signs: the camera's limit changed or was just re-read, or a prohibition sign appeared
    const tsr = (f && f.tsr) || {};
    const moving = Math.abs(v) > 1.5;
    if (showSigns && f) {
      const plate = { School: 'SCHOOL', School_when_flashing: 'SCHOOL', End_of_Speed_Limit: 'END', Where_Workers_Present: 'WORK ZONE' }[tsr.condition];
      const limit = tsr.speedLimit ? { kind: 'limit', value: tsr.speedLimit, unit: tsr.unit || 'kmh', ...(plate ? { plate } : {}) } : null;
      const read = tsr.state && tsr.state.n === 'Vision_Mode' && !(this.prev.state === 'Vision_Mode');
      const changed = limit && this.prev.limit && JSON.stringify(limit) !== this.prev.limit;
      if (limit && moving && (changed || read)) this._spawn(limit, f, road, vehicle, toScene);
      if (tsr.prohibited && tsr.prohibited !== this.prev.prohibited && moving) this._spawn({ kind: 'prohibited', name: tsr.prohibited }, f, road, vehicle, toScene);
      this.prev = { limit: limit ? JSON.stringify(limit) : this.prev.limit, state: tsr.state && tsr.state.n, prohibited: tsr.prohibited };
    }
    // signs fade in, ride with the road, and go once well behind (or old)
    for (const sign of [...this.signs]) {
      const u = sign.userData;
      u.age += dt;
      const behind = this._place(sign, road, toScene) < -25 || u.age > 120 || !showSigns;
      u.alpha = Math.max(0, Math.min(1, u.alpha + (behind ? -dt * 2 : dt * 2.5)));
      for (const m of u.mats) m.opacity = u.alpha;
      if (behind && u.alpha === 0) this._remove(sign);
    }

    // stop line / crosswalk distance, carried with the car between updates
    const lm = f && f.road && f.road.laneMarking;
    const paint = lm && /Stop_Line|Crosswalk/.test(lm.type || '') ? lm : null;
    if (this.marking) this.marking.d -= v * dt;
    if (paint && showSigns) {
      if (!this.marking || this.marking.type !== paint.type) this.marking = { type: paint.type, d: paint.dist, seen: 0 };
      else this.marking.d = Math.abs(paint.dist - this.marking.d) > 15 ? paint.dist : this.marking.d + (paint.dist - this.marking.d) * (1 - Math.exp(-dt / 0.3));
      this.marking.seen = 0;
    } else if (this.marking) {
      this.marking.seen += dt;
      if (this.marking.seen > 1.5 || this.marking.d < -8) this.marking = null;
    }
  }

  // stop line / crosswalk as ribbon pieces: {stop: [...], zebra: [...]} in vehicle frame
  markings(road) {
    const out = { stop: [], zebra: [] };
    const m = this.marking;
    if (!m || m.d < -8 || m.d > 90) return out;
    const at = (s, d) => { const p = road.place(s, d); return [p.x, p.y]; };
    const right = road.laneEdge(-1), left = road.laneEdge(1);
    if (/Stop_Line/.test(m.type)) {
      // across the lanes going our way (the ego lane and any to the right)
      out.stop.push([at(m.d, road.width / 2), at(m.d, right)]);
    } else {
      for (let y = right + 0.4; y <= left - 0.4; y += 1.1) out.zebra.push([at(m.d, y), at(m.d + 3, y)]);
    }
    return out;
  }
}
