// World model for the web HUD: every object source placed in one ground-fixed frame and tracked there
// (a port of the former Python world_model.py; it now runs in the page's world-model worker).
//
// The sources see the same road with different strengths and different delays, and each measurement
// is weighted by its source's noise model (the *Noise functions below), so where they overlap the
// more trustworthy source dominates each quantity:
//   radar  the mid-range radar (bus 1, fisker_radar.js). Range to the near face and range rate are
//          excellent (checked against the road camera: boxes land on bumpers); bearing is coarse, so
//          lateral error grows with range; its lateral velocity is unreliable in turns. Young tracks
//          are mostly flicker (median life 0.13 s) and are left out; maturing ones count for less.
//   adas   the OEM ADAS object list (FiskerWorld). Camera classification, size, heading and the widest
//          coverage; range is the camera's, with no velocity. As decoded it's off in scale and origin
//          (see the calibration below).
//   op     openpilot's radarState leads (radar-backed when the model confirms a radar track, else
//          vision). Two leads; depth from the model, its error growing with distance; weighted by the
//          model's lead probability. The least stable source here (in a parking lot it put a car 13 m
//          ahead at 6 m), so an openpilot lead refines objects the others see but only stands alone
//          when it's the only object source there is. leadTwo is the model's lead 2 s from now
//          (modelV2.leadsV3[1]), most often the same car as leadOne, so it only counts when it's
//          clearly another car.
// Each object is a constant-velocity Kalman filter over ground position and velocity. A measurement is
// placed at the time it was taken (the radar's synced MeasTime; the others by their typical latency)
// using the ego pose at that time, dead-reckoned from wheel speed and the yaw-rate gyro. Measurements
// are processed FUSION_DELAY_S behind the present so every source is in before its time is passed, and
// tracks are then predicted to the present. A stationary object therefore stays put on the ground
// through a turn and each source's lag is undone.
//
// Before fusion each source is corrected by a sensor calibration. MEASURED_CALIBRATION (the default)
// holds what replaying routes 000000b5--bfe13ac451 and 000000b4--d0f733ebb2 against GPS, openpilot's
// leads and lane lines found; NO_CALIBRATION takes every source as it decodes, for comparison
// (Display -> Geometry calibration). Uncorrected, the ADAS list reads 0.8x the radar's range plus ~3 m
// (so its copy of a car and the radar's cross over at ~10-15 m and split apart beyond) and puts
// left-lane cars 1.4 m too far out.
//
// Each object also carries a confidence (0..1) that it's really there, which the view fades it by
// (the CONF_* constants below). The radar measures range, bearing and Doppler but no elevation, so it
// tracks sign gantries, traffic lights and bridges like stopped cars in our lane until it passes under
// them (track 791 on route 000000b5--bfe13ac451--12 at 45-48 s: a "car" 3.4 m wide and 0.2-1.0 m long,
// dropped at 24 m). A camera positively classifying an object settles it. Without one, the radar alone
// can't show an object it hasn't classified (a point target needs a camera detection as well, from the
// ADAS list or an openpilot lead), nor one whose radar track hasn't lasted 1.3 s (mostly flicker). Past
// that, a radar-only object counts for more when it moves (signs and poles don't), less when it
// stands, less again when the radar draws it as a wide thin strip, and least where openpilot's model
// would plainly see a car and doesn't: standing in our path, within its range, with nothing nearer to
// hide it.
//
// Frames: world (x, y, heading) is fixed to the ground with an arbitrary origin, reset on seek. The ego
// frame is x forward from the front bumper, y left, like every other HUD object list.
import { pyRound } from './dbc.js';

export const FRONT_TO_REAR_AXLE = 3.85;   // m: the Ocean is 4.775 m long with its rear axle 0.93 m from the back
export const FUSION_DELAY_S = 0.2;        // radar measurements arrive ~0.10-0.13 s after they're taken
const HISTORY_S = 5.0;
const ADAS_LATENCY_S = 0.12;       // uncalibrated guess: a typical camera pipeline (MEASURED_CALIBRATION has 0.23)
export const OP_LATENCY_S = 0.05;  // radarState.mdMonoTime is when the model ran; its frame is about this older
export const RADAR_MIN_AGE = 8;    // cycles (65 ms): younger radar tracks are left out entirely
const RADAR_MATURE_AGE = 20;
const OP_MIN_PROB = 0.5;
const LEAD_TWO_SAME_M = 6.0;       // openpilot's leadTwo within this (or LEAD_TWO_SAME_FRAC of the range) ahead or behind
const LEAD_TWO_SAME_FRAC = 0.15;   // leadOne and LEAD_TWO_SAME_Y beside it is the same car
const LEAD_TWO_SAME_Y = 2.0;
const GATE = 16.0;                 // Mahalanobis^2 (4 sigma) to associate a measurement with a track...
const GATE_M = 3.0;                // ...and no farther than this plus 2.5 sigma of the measurement, whatever the covariance
const MERGE_GATE = 4.0;            // two tracks this close (and within MERGE_M) are one object...
const MERGE_M = 1.5;
const MERGE_V = 2.5;               // ...if their speeds agree within this, or within 3 sigma of their velocity estimates
const MERGE_GATE_V = 9.0;
const SAME_ID_S = 1.0;             // two tracks one source fed under one id this close in time are one object split in two...
const SAME_ID_M = 5.0;             // ...unless they're farther apart than this
const ACCEL_SIGMA = 3.0;           // m/s^2: process noise of the constant-velocity model
const COAST_MOVING_S = 1.0;        // a track is dropped this long after its last measurement...
const COAST_STATIONARY_S = 2.5;    // ...longer when it stands still (e.g. parked cars the radar stops reporting in a turn)
const STATIONARY_SPEED = 0.7;      // m/s over ground
const CONFIRM_UPDATES = 3;         // a radar-only track is shown after this many measurements...
const CONFIRM_SPAN_S = 0.15;       // ...spanning at least this long
const HEADING_FROM_MOTION = 1.5;   // m/s: faster than this, an object points where it's going
const SOURCE_GONE_S = 5.0;         // a source silent this long no longer counts as available

// confidence (see above); the view fades objects in between about 0.35 and 0.65
const VISION_CLASSES = new Set(['car', 'truck', 'motorcycle', 'bicycle', 'pedestrian', 'animal']);
const CONF_VISION = 1.0;           // a camera positively classified it (ADAS list class, or an openpilot lead)...
const VISION_HOLD_S = 1.0;         // ...this recently
const CONF_VISION_HELD = 0.9;      // one did earlier, and the others still track it
const CONF_UNCLASSIFIED = 0.25;    // radar alone, and it hasn't classified it: a point target needs a camera detection too
const RADAR_CLASS_CYCLES = 5;      // radar cycles with a class before it counts as classified (classes flicker for a cycle)
const CONF_YOUNG = 0.3;            // radar alone, before its track has lasted RADAR_MATURE_AGE: mostly flicker
const CONF_MOVING = 0.85;          // radar alone, moving over the ground
export const CONF_STANDING = 0.6;  // radar alone, standing: as often a parked car as a post
const THIN_ASPECT = 4.0;           // the radar has drawn it at least this many times wider than long...
const THIN_MIN_W = 1.5;            // ...and at least this wide: a sign or a gantry seen edge-on
const THIN_FACTOR = 0.55;
const CONF_UNSEEN = 0.15;          // standing in our path where openpilot's model would see a car, and doesn't...
const UNSEEN_HOLD_S = 0.5;         // ...for this long in all: then it stays that low, even once a turn takes it out of our path
const UNSEEN_MIN_V = 5.0;          // m/s: slower than this (parking), the model's leads are too unsteady to go by
const UNSEEN_X = [8.0, 80.0];      // m ahead: where the model reliably reports a stopped car in our lane
const CORRIDOR_HALF_W = 1.5;       // m either side of our predicted path: our half width and half a meter
const MOVING_SPEED = 1.5;          // m/s over ground, plus movingFrac (calibration) of our speed: how far apart
const MOVING_FRAC = 0.06;          // the Doppler and ego speed scales may be (4% uncorrected, so a standing object can read ~1 m/s)
const CONF_RISE_S = 0.5;           // confidence eases toward its target over about this long, in data time...
const CONF_FALL_S = 0.25;
const CONF_COAST_S = 0.3;          // ...but can't rise once no source has reported the object for this long, and a moving one fades out


// ---- sensor calibration ----------------------------------------------------------------------------

/** Corrections applied to each source before it's fused (the view's lanes and ego motion use the last two). */
function calibration(fields) {
  return Object.freeze({
    name: 'none',
    speedScale: 1.0,          // true speed / ESP_VehSpd (wheel speed), for the ego odometry
    radarDopplerScale: 1.0,   // true / decoded radar relative velocity
    radarYaw: 0.0,            // rad: the radar's output is turned this far left (CCW) into the car's frame
    adasXScale: 1.0,          // ADAS object range: x = decoded / adasXScale - adasXOrigin
    adasXOrigin: 0.0,         // m from the front bumper back to the ADAS list's origin
    adasYScale: 1.0,          // ADAS object lateral: y = decoded / adasYScale
    adasLatency: ADAS_LATENCY_S,
    opXOffset: 0.0,           // m added to openpilot leads' dRel
    modelXOffset: -1.6,       // m: openpilot's model frame (the comma camera) relative to the front bumper
    movingFrac: MOVING_FRAC,
    ...fields,
  });
}

export function calibrationToJson(c) {
  return { on: c.name !== 'none', name: c.name, speedScale: c.speedScale, modelXOffset: c.modelXOffset };
}

export const NO_CALIBRATION = calibration({});
// Measured on 2026-10-02 from routes 000000b5--bfe13ac451 and 000000b4--d0f733ebb2 (12 segments with the radar):
export const MEASURED_CALIBRATION = calibration({
  name: 'measured',
  speedScale: 1.031,                  // GPS / wheel speed: 1.031 on all six driving segments
  radarDopplerScale: 0.0625 / 0.06,   // standing targets fit 0.0618-0.0631 m/s per bit against GPS speed: 1/16, not the DBC's 0.06
  radarYaw: 0.6 * Math.PI / 180,      // cars in our lane drifted right with range (-0.7 m at 70 m) against openpilot's lanes and leads
  adasXScale: 0.80,                   // 60 cars paired with radar tracks: decoded = 0.80 (x + 3.7), 0.3 m median residual,
  adasXOrigin: 3.7,                   // i.e. ~0.25 m/bit rather than 0.2, from about the rear axle
  adasYScale: 1.35,                   // left-lane cars sat 1.4 m too far out at every range against openpilot's lanes
  adasLatency: 0.23,                  // lag that best lines up its ranges with the radar's (13 cars; 0.1-0.3 s for most)
  opXOffset: 0.2,                     // leads read 0.2 m short close up: the camera is ~1.72 m behind the radar, radard assumes 1.52
  modelXOffset: -1.7,
  movingFrac: 0.025,                  // both scales corrected, standing targets read within ~1.3% of our speed
});


// ---- measurement noise (1 sigma) -------------------------------------------------------------------

/** sx, sy (m), svx, svy (m/s) in the ego frame, and how much less a young or coasting track counts.
 *  ~1 deg of bearing error; range and Doppler fine. Its lateral velocity is barely usable: a young
 *  track's bearing converges over its first second and the radar reports that as sideways motion. */
function radarNoise(rng, age, hist) {
  let k = age >= RADAR_MATURE_AGE ? 1.0 : 2.5;
  if ((hist & 0b11) !== 0b11) k *= 2.0;   // no detection in one of the last two cycles: the track is coasting
  return [0.25 + 0.005 * rng, 0.15 + 0.017 * rng, 0.3, 6.0, k];
}

/** Camera ranging (~6%) and 0.2 m quantization; bearing is the camera's strength. */
function adasNoise(rng) {
  return [0.5 + 0.06 * rng, 0.3 + 0.012 * rng];
}

/** sx, sy, svx. openpilot leads backed by a car radar (not this port) are radar-grade. */
function opNoise(rng, prob, radar) {
  if (radar) return [0.3 + 0.01 * rng, 0.3 + 0.017 * rng, 0.4];
  const k = 1.0 / Math.sqrt(Math.max(prob, 0.2));
  return [k * (0.6 + 0.08 * rng), k * (0.4 + 0.015 * rng), k * (0.6 + 0.04 * rng)];
}


// ---- small dense matrices (arrays of rows) ---------------------------------------------------------

const zeros = (n, m) => Array.from({ length: n }, () => new Array(m).fill(0));
const eye = (n) => { const I = zeros(n, n); for (let i = 0; i < n; i++) I[i][i] = 1; return I; };
function matmul(A, B) {
  const n = A.length, m = B[0].length, k = B.length;
  const C = zeros(n, m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) { let s = 0; for (let l = 0; l < k; l++) s += A[i][l] * B[l][j]; C[i][j] = s; }
  return C;
}
const transpose = (A) => A[0].map((_, j) => A.map(row => row[j]));
const matadd = (A, B) => A.map((row, i) => row.map((v, j) => v + B[i][j]));
const matvec = (A, v) => A.map(row => row.reduce((s, a, j) => s + a * v[j], 0));
const sub = (A, B) => A.map((row, i) => row.map((v, j) => v - B[i][j]));
const block = (A, r0, r1, c0, c1) => A.slice(r0, r1).map(row => row.slice(c0, c1));

/** Gauss-Jordan inverse with partial pivoting (n <= 4). */
function inv(A) {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...eye(n)[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let i = c + 1; i < n; i++) if (Math.abs(M[i][c]) > Math.abs(M[p][c])) p = i;
    if (p !== c) [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    if (d === 0) throw new Error('singular matrix');
    for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let i = 0; i < n; i++) {
      if (i === c) continue;
      const f = M[i][c];
      if (f !== 0) for (let j = 0; j < 2 * n; j++) M[i][j] -= f * M[c][j];
    }
  }
  return M.map(row => row.slice(n));
}

/** d^T S^-1 d for a 2x2 S. */
function quad2(S, d) {
  const det = S[0][0] * S[1][1] - S[0][1] * S[1][0];
  const x = (S[1][1] * d[0] - S[0][1] * d[1]) / det;
  const y = (-S[1][0] * d[0] + S[0][0] * d[1]) / det;
  return d[0] * x + d[1] * y;
}

const rot = (h) => { const c = Math.cos(h), s = Math.sin(h); return [[c, -s], [s, c]]; };
const wrap = (a) => (((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const hypot = (x, y) => Math.sqrt(x * x + y * y);


// ---- ego pose ---------------------------------------------------------------------------------------

/** Pose of the rear axle in the world frame, integrated from signed speed and yaw rate, with a
 *  few seconds of history so a measurement can be placed at the pose it was taken from. */
export class EgoOdometry {
  constructor() { this.reset(); }

  reset() {
    this.ts = [];
    this.poses = [];   // [x, y, heading, signed speed]
    this.t = null;
    this.x = this.y = this.h = this.v = this.w = 0.0;
  }

  /** v: signed speed (m/s, negative in reverse), w: yaw rate (rad/s, + = left). */
  update(t, v, w) {
    if (this.t !== null) {
      const dt = t - this.t;
      if (dt <= 0) return;
      if (dt < 0.5) {   // a longer gap (seek, dropout) restarts the integration in place
        const hm = this.h + 0.5 * w * dt;
        this.x += v * Math.cos(hm) * dt;
        this.y += v * Math.sin(hm) * dt;
        this.h += w * dt;
      }
    }
    this.t = t; this.v = v; this.w = w;
    this.ts.push(t);
    this.poses.push([this.x, this.y, this.h, v]);
    if (this.ts.length > 256 && t - this.ts[0] > HISTORY_S) {
      const cut = bisectLeft(this.ts, t - HISTORY_S);
      this.ts.splice(0, cut);
      this.poses.splice(0, cut);
    }
  }

  pose(t) {
    if (!this.ts.length) return [0.0, 0.0, 0.0];
    if (t >= this.ts[this.ts.length - 1]) {   // carry the last motion forward (briefly)
      const dt = Math.min(t - this.ts[this.ts.length - 1], 0.5);
      const hm = this.h + 0.5 * this.w * dt;
      return [this.x + this.v * Math.cos(hm) * dt, this.y + this.v * Math.sin(hm) * dt, this.h + this.w * dt];
    }
    const i = bisectRight(this.ts, t);
    if (i === 0) return this.poses[0].slice(0, 3);
    const t0 = this.ts[i - 1], t1 = this.ts[i];
    const a = this.poses[i - 1], b = this.poses[i];
    const f = (t - t0) / (t1 - t0);
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }

  speed(t) {
    if (!this.ts.length || t >= this.ts[this.ts.length - 1]) return this.v;
    const i = Math.max(1, bisectRight(this.ts, t));
    return this.poses[i - 1][3];
  }
}

function bisectLeft(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
function bisectRight(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (x < a[m]) hi = m; else lo = m + 1; } return lo; }

export function toWorld(pose, x, y) {
  const [px, py, h] = pose;
  const xr = x + FRONT_TO_REAR_AXLE;
  const c = Math.cos(h), s = Math.sin(h);
  return [px + c * xr - s * y, py + s * xr + c * y];
}

export function toEgo(pose, wx, wy) {
  const [px, py, h] = pose;
  const dx = wx - px, dy = wy - py;
  const c = Math.cos(h), s = Math.sin(h);
  return [c * dx + s * dy - FRONT_TO_REAR_AXLE, -s * dx + c * dy];
}


// ---- measurements & tracks --------------------------------------------------------------------------

export class Meas {
  constructor(src, sid, t, x, y, sx, sy, { vx = null, vy = null, svx = 10.0, svy = 10.0, weight = 1.0, cls = null, dims = null, heading = null, info = {} } = {}) {
    this.src = src;         // 'radar' | 'adas' | 'op'
    this.sid = sid;         // the source's own track id (op: lead index)
    this.t = t;             // when it was measured (log clock, s)
    this.x = x;             // ego frame at t: m ahead of the front bumper (near face of the object)
    this.y = y;             // m left
    this.sx = sx;           // 1-sigma noise, ego axes: what the source measures to, used to gate association
    this.sy = sy;
    this.vx = vx;           // velocity over ground, ego axes at t (null: not measured)
    this.vy = vy;
    this.svx = svx;
    this.svy = svy;
    this.weight = weight;   // < 1: counts for less (a young or coasting radar track); the noise is scaled by 1/weight
    this.cls = cls;
    this.dims = dims;       // [w, l, h]
    this.heading = heading; // deg, + = left of the ego heading at t
    this.info = info;       // what the source said, for the stats view
  }
}

const SOURCE_RANK = { adas: 0, radar: 1, op: 2 };   // whose class / size / heading wins
const RANK_SRC = { 0: 'adas', 1: 'radar', 2: 'op' };

class Track {
  constructor(tid, t, z, Rp, v, Rv) {
    this.id = tid;
    this.t = t;
    this.X = [z[0], z[1], 0.0, 0.0];
    this.P = zeros(4, 4);
    this.P[0][0] = Rp[0][0]; this.P[0][1] = Rp[0][1]; this.P[1][0] = Rp[1][0]; this.P[1][1] = Rp[1][1];
    this.P[2][2] = this.P[3][3] = 25.0;
    if (v !== null) {
      this.X[2] = v[0]; this.X[3] = v[1];
      this.P[2][2] = Rv[0][0]; this.P[2][3] = Rv[0][1]; this.P[3][2] = Rv[1][0]; this.P[3][3] = Rv[1][1];
    }
    this.first = t;
    this.n = 0;
    this.last = {};        // src -> time of its last measurement
    this.sources = {};     // src -> {id, t, dx, dy, info}
    this.confirmed = false;
    this.cls = null;
    this.clsRank = 99;
    this.dims = null;
    this.heading = null;   // world, rad
    this.headingRank = 99;
    this.visionT = null;   // last time a camera positively classified it
    this.thin = 0.0;       // widest-for-its-length the radar has drawn it (w/l)
    this.radarAge = 0;     // oldest radar track (cycles) that has reported it
    this.radarClsN = 0;    // radar cycles that gave it a class (not just a point target)
    this.unseenS = 0.0;    // how long openpilot's model has missed it in plain view
    this.conf = 0.0;
    this.confT = t;
    this.confWhy = '';
  }

  get lastT() {
    const v = Object.values(this.last);
    return v.length ? Math.max(...v) : this.first;
  }

  speed() { return hypot(this.X[2], this.X[3]); }

  predict(t) {
    const dt = t - this.t;
    if (dt === 0) return;
    const F = eye(4);
    F[0][2] = F[1][3] = dt;
    this.X = matvec(F, this.X);
    this.P = matmul(matmul(F, this.P), transpose(F));
    if (dt > 0) {
      const q = ACCEL_SIGMA ** 2;
      const a = dt ** 4 / 4, b = dt ** 3 / 2, c = dt ** 2;
      const Q = [[a, 0, b, 0], [0, a, 0, b], [b, 0, c, 0], [0, b, 0, c]];
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) this.P[i][j] += q * Q[i][j];
    }
    this.t = t;
  }

  maha(z, Rp) {
    const S = matadd(block(this.P, 0, 2, 0, 2), Rp);
    return quad2(S, [z[0] - this.X[0], z[1] - this.X[1]]);
  }

  update(z, Rp, v, Rv) {
    let H, zz, R;
    if (v === null) {
      H = zeros(2, 4);
      H[0][0] = H[1][1] = 1;
      zz = z; R = Rp;
    } else {
      H = eye(4);
      zz = [z[0], z[1], v[0], v[1]];
      R = zeros(4, 4);
      R[0][0] = Rp[0][0]; R[0][1] = Rp[0][1]; R[1][0] = Rp[1][0]; R[1][1] = Rp[1][1];
      R[2][2] = Rv[0][0]; R[2][3] = Rv[0][1]; R[3][2] = Rv[1][0]; R[3][3] = Rv[1][1];
    }
    const Ht = transpose(H);
    const S = matadd(matmul(matmul(H, this.P), Ht), R);
    const K = matmul(matmul(this.P, Ht), inv(S));
    const hx = matvec(H, this.X);
    const innov = zz.map((zi, i) => zi - hx[i]);
    const dx = matvec(K, innov);
    this.X = this.X.map((xi, i) => xi + dx[i]);
    this.P = matmul(sub(eye(4), matmul(K, H)), this.P);
  }
}

/** Both fed by the same radar or ADAS track id within SAME_ID_S (openpilot's lead index isn't an identity). */
function sameSourceId(a, b) {
  for (const src in a.sources) {
    const s = a.sources[src], o = b.sources[src];
    if (src !== 'op' && o !== undefined && o.id === s.id && Math.abs(o.t - s.t) < SAME_ID_S) return true;
  }
  return false;
}


export class WorldModel {
  constructor(calib = MEASURED_CALIBRATION) {
    this.odo = new EgoOdometry();
    this.calib = calib;
    this.nextId = 1;   // never reset: a viewer keyed by id mustn't mistake a new object for an old one after a seek
    this.reset();
  }

  /** Switch calibrations; tracks built on the other one start over (they'd jump by meters). */
  setCalibration(calib) {
    if (calib.name !== this.calib.name) {
      this.calib = calib;
      this.reset();
    }
  }

  reset() {
    this.odo.reset();
    this.tracks = new Map();   // tid -> Track, in creation order
    this.pending = [];
    this.sticky = new Map();   // "src:sid" -> track id
    this.srcSeen = {};         // src -> time of its latest measurement
    this.modelSeen = -1e9;     // time of openpilot's latest model output, leads or not
    this.lastNow = null;
  }

  add(meas) { this.pending.push(...meas); }

  /** openpilot's model looked at t. Where it reported no lead, it saw no car. */
  modelRan(t) { this.modelSeen = Math.max(this.modelSeen, t); }

  /** Fuse everything measured up to FUSION_DELAY_S ago; return the objects as of `now`. */
  step(now) {
    // waiting for late sources only makes sense while time moves; paused (a replay), take everything
    const paused = this.lastNow !== null && now <= this.lastNow;
    const cutoff = paused ? now : now - FUSION_DELAY_S;
    this.lastNow = now;
    const ready = this.pending.filter(m => m.t <= cutoff).sort((a, b) => a.t - b.t || (a.src < b.src ? -1 : a.src > b.src ? 1 : 0));
    this.pending = this.pending.filter(m => m.t > cutoff && m.t > now - HISTORY_S);
    let i = 0;
    while (i < ready.length) {   // one batch = one source's report at one time
      let j = i;
      while (j < ready.length && ready[j].t === ready[i].t && ready[j].src === ready[i].src) j++;
      this._process(ready.slice(i, j));
      i = j;
    }
    this._merge();
    this._prune(cutoff);
    this._confidence(cutoff, paused);
    return this._output(now);
  }

  // ---- fusion ----
  _process(batchIn) {
    // one measurement per source id: the radar sometimes re-sends a whole cycle, and a second copy of an id would
    // find its track already taken and start a duplicate of it
    const byId = new Map();
    for (const m of batchIn) byId.set(`${m.src}:${m.sid}`, m);
    const batch = [...byId.values()];
    const t = batch[0].t;
    this.srcSeen[batch[0].src] = t;
    const pose = this.odo.pose(t);
    const R = rot(pose[2]), Rt = transpose(R);
    const meas = [];
    for (const m of batch) {
      const z = toWorld(pose, m.x, m.y);
      const Rg = matmul(matmul(R, [[m.sx ** 2, 0], [0, m.sy ** 2]]), Rt);   // gates association
      const k2 = 1.0 / m.weight ** 2;                                       // weighs the update
      let v = null, Rv = null;
      if (m.vx !== null) {
        v = matvec(R, [m.vx, m.vy ?? 0.0]);
        const svy = m.vy !== null ? m.svy : 10.0;
        Rv = matmul(matmul(R, [[k2 * m.svx ** 2, 0], [0, k2 * svy ** 2]]), Rt);
      }
      meas.push([m, z, Rg, Rg.map(row => row.map(x => k2 * x)), v, Rv]);
    }
    for (const tr of this.tracks.values()) tr.predict(t);

    const assigned = new Map();   // meas index -> track id
    const used = new Set();
    const near = (tr, m, z) => hypot(z[0] - tr.X[0], z[1] - tr.X[1]) < GATE_M + 2.5 * Math.max(m.sx, m.sy);

    // a source's own track id keeps feeding the same object while it's plausible
    meas.forEach(([m, z, Rg], k) => {
      const tid = this.sticky.get(`${m.src}:${m.sid}`);
      const tr = tid !== undefined ? this.tracks.get(tid) : undefined;
      if (tr !== undefined && !used.has(tid) && near(tr, m, z) && tr.maha(z, Rg) < 4 * GATE) {
        assigned.set(k, tid);
        used.add(tid);
      }
    });
    // the rest by nearest fit
    const cands = [];
    meas.forEach(([m, z, Rg], k) => {
      if (assigned.has(k)) return;
      for (const [tid, tr] of this.tracks) {
        if (used.has(tid) || !near(tr, m, z)) continue;
        const d2 = tr.maha(z, Rg);
        if (d2 < GATE) cands.push([d2, k, tid]);
      }
    });
    cands.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    for (const [, k, tid] of cands) {
      if (assigned.has(k) || used.has(tid)) continue;
      assigned.set(k, tid);
      used.add(tid);
    }

    meas.forEach(([m, z, , Rp, v, Rv], k) => {
      let tid = assigned.get(k);
      let innovation;
      if (tid === undefined) {
        if (m.src === 'op' && (m.info.modelProb ?? 1.0) < OP_MIN_PROB) return;
        tid = this.nextId++;
        this.tracks.set(tid, new Track(tid, t, z, Rp, v, Rv));
        innovation = [0, 0];
      } else {
        const tr = this.tracks.get(tid);
        innovation = [z[0] - tr.X[0], z[1] - tr.X[1]];
      }
      const tr = this.tracks.get(tid);
      tr.update(z, Rp, v, Rv);
      this._annotate(tr, m, matvec(Rt, innovation), pose[2]);
      this.sticky.set(`${m.src}:${m.sid}`, tid);
    });
  }

  _annotate(tr, m, resid, h) {
    tr.n += 1;
    tr.last[m.src] = m.t;
    tr.sources[m.src] = { id: m.sid, t: m.t, dx: resid[0], dy: resid[1], info: m.info };
    const rank = SOURCE_RANK[m.src];
    if (m.cls && m.cls !== 'unclassified' && m.cls !== 'unknown' && rank <= tr.clsRank) {
      tr.cls = m.cls; tr.clsRank = rank;
    } else if (tr.cls === null) {
      tr.cls = m.src === 'op' ? 'car' : m.cls;
    }
    if (m.dims && rank <= tr.clsRank) tr.dims = m.dims;
    if ((m.src === 'adas' && VISION_CLASSES.has(m.cls)) || (m.src === 'op' && (m.info.modelProb ?? 0.0) >= OP_MIN_PROB)) tr.visionT = m.t;
    if (m.src === 'radar') {
      tr.radarAge = Math.max(tr.radarAge, m.info.cycles);
      tr.radarClsN += m.cls !== null ? 1 : 0;
      if (m.dims && m.dims[0] >= THIN_MIN_W) tr.thin = Math.max(tr.thin, m.dims[0] / m.dims[1]);
    }
    if (m.heading !== null && rank <= tr.headingRank) {
      const hw = h + m.heading * Math.PI / 180;
      tr.heading = (tr.heading === null || rank < tr.headingRank) ? hw : tr.heading + 0.3 * wrap(hw - tr.heading);
      tr.headingRank = rank;
    }
    if (!tr.confirmed) {
      if (m.src === 'op') {   // alone, only once it has held for a second with neither the radar nor the ADAS around
        tr.confirmed = m.t - tr.first >= 1.0 && ['radar', 'adas'].every(s => m.t - (this.srcSeen[s] ?? -1e9) > SOURCE_GONE_S);
      } else {
        tr.confirmed = m.src === 'adas' || (tr.n >= CONFIRM_UPDATES && m.t - tr.first >= CONFIRM_SPAN_S);
      }
    }
  }

  _merge() {
    const ids = [...this.tracks.keys()].sort((a, b) => a - b);
    const gone = new Set();
    for (let ai = 0; ai < ids.length; ai++) {
      const a = ids[ai];
      if (gone.has(a)) continue;
      const A = this.tracks.get(a);
      for (let bi = ai + 1; bi < ids.length; bi++) {
        const b = ids[bi];
        if (gone.has(b)) continue;
        const B = this.tracks.get(b);
        if (B.t !== A.t) B.predict(A.t);
        const d = [A.X[0] - B.X[0], A.X[1] - B.X[1]];
        const same = sameSourceId(A, B);
        let keep, drop;
        if (same) {
          // one object split in two (its measurement jumped out of its own track's gate): keep the copy the
          // source fed last, which is where the object is now
          if (hypot(d[0], d[1]) > SAME_ID_M) continue;
          [keep, drop] = A.lastT >= B.lastT ? [A, B] : [B, A];
        } else {
          if (hypot(d[0], d[1]) > MERGE_M || quad2(matadd(block(A.P, 0, 2, 0, 2), block(B.P, 0, 2, 0, 2)), d) > MERGE_GATE) continue;
          // a new track's velocity is barely known (the radar's lateral velocity especially), so speeds
          // only have to agree within what the two estimates allow
          const dv = [A.X[2] - B.X[2], A.X[3] - B.X[3]];
          if (hypot(dv[0], dv[1]) > MERGE_V && quad2(matadd(block(A.P, 2, 4, 2, 4), block(B.P, 2, 4, 2, 4)), dv) > MERGE_GATE_V) continue;
          [keep, drop] = A.n >= B.n ? [A, B] : [B, A];
        }
        for (const src in drop.sources) {
          const s = drop.sources[src];
          if (!(src in keep.sources) || s.t > keep.sources[src].t) {
            keep.sources[src] = s;
            keep.last[src] = drop.last[src];
          }
        }
        keep.confirmed = keep.confirmed || drop.confirmed;
        keep.n += drop.n;
        if (drop.clsRank < keep.clsRank) {
          keep.cls = drop.cls; keep.clsRank = drop.clsRank; keep.dims = drop.dims || keep.dims;
        }
        if (drop.heading !== null && drop.headingRank < keep.headingRank) {
          keep.heading = drop.heading; keep.headingRank = drop.headingRank;
        }
        if (drop.visionT !== null && (keep.visionT === null || drop.visionT > keep.visionT)) keep.visionT = drop.visionT;
        keep.thin = Math.max(keep.thin, drop.thin);
        keep.radarAge = Math.max(keep.radarAge, drop.radarAge);
        keep.radarClsN = Math.max(keep.radarClsN, drop.radarClsN);
        keep.unseenS = Math.max(keep.unseenS, drop.unseenS);
        keep.conf = Math.max(keep.conf, drop.conf);
        for (const [key, tid] of this.sticky) if (tid === drop.id) this.sticky.set(key, keep.id);
        gone.add(drop.id);
        if (drop === A) break;
      }
    }
    for (const tid of gone) this.tracks.delete(tid);
  }

  _prune(cutoff) {
    for (const tid of [...this.tracks.keys()]) {
      const tr = this.tracks.get(tid);
      const srcs = Object.keys(tr.last);
      if (!tr.confirmed && srcs.length === 1 && srcs[0] === 'op' && cutoff - tr.first > 1.5) {
        this.tracks.delete(tid);   // an openpilot lead nothing else confirmed
        continue;
      }
      const stale = cutoff - tr.lastT;
      const limit = tr.speed() < STATIONARY_SPEED ? COAST_STATIONARY_S : COAST_MOVING_S;
      if ((!tr.confirmed && stale > 0.3) || stale > limit || tr.P[0][0] + tr.P[1][1] > 50) this.tracks.delete(tid);
    }
    for (const [key, tid] of [...this.sticky]) if (!this.tracks.has(tid)) this.sticky.delete(key);
  }

  /** Ease each track's confidence toward what its evidence supports as of t (see CONF_*); with `settle`
   *  (time standing still, as in a paused replay), go straight there. */
  _confidence(t, settle = false) {
    const pose = this.odo.pose(t);
    const v = this.odo.speed(t);
    const kappa = v > 1.0 ? this.odo.w / v : 0.0;
    const looking = v > UNSEEN_MIN_V && t - this.modelSeen < 1.0;
    const moving = MOVING_SPEED + this.calib.movingFrac * Math.abs(v);
    const seen = new Map(), ahead = new Map(), classified = new Map(), solid = new Map();
    for (const [tid, tr] of this.tracks) seen.set(tid, tr.visionT !== null || 'adas' in tr.last);   // a camera has it
    // tracks in our path within the model's range (m ahead), and the nearest one that surely blocks the model's
    // view past it: one a camera has, or a moving one the radar has classified and tracked for a while
    for (const [tid, tr] of this.tracks) {
      const dt = t - tr.t;
      const [x, y] = toEgo(pose, tr.X[0] + tr.X[2] * dt, tr.X[1] + tr.X[3] * dt);
      const xr = x + FRONT_TO_REAR_AXLE;
      if (UNSEEN_X[0] < x && x < UNSEEN_X[1] && Math.abs(y - kappa * xr * xr / 2) < CORRIDOR_HALF_W) ahead.set(tid, x);
    }
    for (const [tid, tr] of this.tracks) classified.set(tid, tr.radarClsN >= RADAR_CLASS_CYCLES);
    for (const [tid, tr] of this.tracks) solid.set(tid, seen.get(tid) || (classified.get(tid) && tr.radarAge >= RADAR_MATURE_AGE && tr.speed() > moving));
    let blocker = Infinity;
    for (const [tid, x] of ahead) if (solid.get(tid) && x < blocker) blocker = x;

    for (const [tid, tr] of this.tracks) {
      const dt = t - tr.confT;
      const standing = tr.speed() <= moving;
      if (dt > 0 && standing && looking && ahead.has(tid) && ahead.get(tid) < blocker + 2.0 && !seen.get(tid) && tr.cls !== 'pedestrian') tr.unseenS += dt;
      let target, why;
      if (tr.visionT !== null) {
        [target, why] = t - tr.visionT < VISION_HOLD_S ? [CONF_VISION, 'vision'] : [CONF_VISION_HELD, 'vision earlier'];
      } else if (!('adas' in tr.last) && !classified.get(tid)) {
        [target, why] = [CONF_UNCLASSIFIED, 'unclassified'];
      } else if (!('adas' in tr.last) && tr.radarAge < RADAR_MATURE_AGE) {
        [target, why] = [CONF_YOUNG, 'young'];
      } else if (!standing) {
        [target, why] = [CONF_MOVING, 'moving'];
      } else {
        [target, why] = [CONF_STANDING, 'standing'];
        if (tr.thin >= THIN_ASPECT) [target, why] = [target * THIN_FACTOR, 'thin'];
        if (tr.unseenS >= UNSEEN_HOLD_S) [target, why] = [Math.min(target, CONF_UNSEEN), 'unseen'];
      }
      if (t - tr.lastT > CONF_COAST_S) {
        // nothing reports it any more. A standing object stays put on the ground, so it waits out a gap (a parked
        // car the radar loses in a turn) without rising; a moving one would carry on along a velocity that's now
        // a guess, through whatever it's really doing, so it fades out
        target = Math.min(target, tr.conf);
        if (!standing) [target, why] = [0.0, 'coasting'];
      }
      if (settle) tr.conf = target;
      else if (dt > 0) tr.conf += (target - tr.conf) * (1 - Math.exp(-dt / (target > tr.conf ? CONF_RISE_S : CONF_FALL_S)));
      tr.confT = t;
      tr.confWhy = why;
    }
  }

  // ---- output ----
  _output(now) {
    const pose = this.odo.pose(now);
    const h = pose[2];
    const Rt = transpose(rot(h));
    const out = [];
    for (const tr of this.tracks.values()) {
      if (!tr.confirmed) continue;
      const dt = now - tr.t;
      const wx = tr.X[0] + tr.X[2] * dt, wy = tr.X[1] + tr.X[3] * dt;
      const [x, y] = toEgo(pose, wx, wy);
      const [vx, vy] = matvec(Rt, [tr.X[2], tr.X[3]]);
      const speed = tr.speed();
      let heading, hsrc;
      if (speed > HEADING_FROM_MOTION) { heading = Math.atan2(tr.X[3], tr.X[2]) - h; hsrc = 'motion'; }
      else if (tr.heading !== null) { heading = tr.heading - h; hsrc = RANK_SRC[tr.headingRank]; }
      else { heading = 0.0; hsrc = null; }
      const sxy = matmul(matmul(Rt, block(tr.P, 0, 2, 0, 2)), transpose(Rt));
      const sources = Object.keys(tr.sources).sort((a, b) => SOURCE_RANK[a] - SOURCE_RANK[b])
        .filter(src => now - tr.sources[src].t < COAST_STATIONARY_S + 1)
        .map(src => { const s = tr.sources[src]; return { src, id: s.id, dx: pyRound(s.dx, 2), dy: pyRound(s.dy, 2), age: pyRound(now - s.t, 2), ...s.info }; });
      out.push({
        id: tr.id,
        x: pyRound(x, 2), y: pyRound(y, 2),
        vx: pyRound(vx, 2), vy: pyRound(vy, 2), speed: pyRound(speed, 2),
        heading: pyRound(wrap(heading) * 180 / Math.PI, 1), headingSrc: hsrc,
        cls: tr.cls || 'unknown',
        w: tr.dims ? tr.dims[0] : null, l: tr.dims ? tr.dims[1] : null, h: tr.dims ? tr.dims[2] : null,
        std: [pyRound(Math.sqrt(Math.max(sxy[0][0], 0)), 2), pyRound(Math.sqrt(Math.max(sxy[1][1], 0)), 2)],
        age: pyRound(now - tr.first, 1),
        stale: pyRound(Math.max(0.0, now - FUSION_DELAY_S - tr.lastT), 2),
        stationary: speed < STATIONARY_SPEED,
        conf: pyRound(tr.conf, 2), confWhy: tr.confWhy,
        sources,
      });
    }
    out.sort((a, b) => hypot(a.x, a.y) - hypot(b.x, b.y));
    return out;
  }
}


// ---- source adapters -------------------------------------------------------------------------------

/** One radar cycle (fisker_radar objects, measured at t). Relative velocity is translational, so
 *  over ground it's v_rel + ego speed along x. vEgo is the calibrated speed the odometry runs on. */
export function radarMeasurements(t, objects, vEgo, calib = NO_CALIBRATION) {
  const c = Math.cos(calib.radarYaw), s = Math.sin(calib.radarYaw);
  const kV = calib.radarDopplerScale;
  const out = [];
  for (const o of objects) {
    if (o.age < RADAR_MIN_AGE) continue;
    const x = c * o.x - s * o.y, y = s * o.x + c * o.y;
    const vx = kV * (c * o.vx - s * o.vy), vy = kV * (s * o.vx + c * o.vy);
    const heading = o.heading ?? null;
    const [sx, sy, svx, svy, k] = radarNoise(hypot(x, y), o.age, o.hist ?? 0xFF);
    out.push(new Meas('radar', o.id, t, x, y, sx, sy, {
      vx: vx + vEgo, vy, svx, svy, weight: 1.0 / k,
      cls: o.cls === 'unclassified' ? null : o.cls,
      dims: (o.w && o.l) ? [o.w, o.l, 1.5] : null,
      heading: heading === null ? null : heading + calib.radarYaw * 180 / Math.PI,
      info: { cycles: o.age, state: o.state ?? null, quality: o.quality ?? null },
    }));
  }
  return out;
}

export function adasMeasurement(tRx, o, calib = NO_CALIBRATION) {
  const x = o.x / calib.adasXScale - calib.adasXOrigin, y = o.y / calib.adasYScale;
  const [sx, sy] = adasNoise(hypot(x, y));
  const dims = (o.w && o.l) ? [o.w, o.l, o.h ?? null] : null;
  return new Meas('adas', o.id, tRx - calib.adasLatency, x, y, sx, sy, {
    cls: o.cls ?? null, dims, heading: o.heading ?? null, info: { flags: o.flags || [], classConf: o.classConf ?? null },
  });
}

export function opMeasurements(t, rs, vEgo, calib = NO_CALIBRATION) {
  const out = [];
  const one = rs.leadOne || {};
  ['leadOne', 'leadTwo'].forEach((key, i) => {
    const ld = rs[key];
    if (!ld || !ld.present || ld.dRel == null) return;
    // leadTwo from the camera model is its lead 2 s from now, most often the car that's leadOne now: a second
    // object a few meters off it (route 000000b4--d0f733ebb2--5 showed one for 15 s)
    if (i === 1 && !ld.radar && one.present && one.dRel != null &&
        Math.abs(ld.dRel - one.dRel) < Math.max(LEAD_TWO_SAME_M, LEAD_TWO_SAME_FRAC * one.dRel) &&
        Math.abs((ld.yRel || 0.0) - (one.yRel || 0.0)) < LEAD_TWO_SAME_Y) return;
    const prob = ld.modelProb || 0.0;
    const dRel = ld.dRel + (ld.radar ? 0.0 : calib.opXOffset);
    const [sx, sy, svx] = opNoise(dRel, prob, Boolean(ld.radar));
    const v = ld.vLead != null ? ld.vLead : (ld.vRel != null ? ld.vRel + vEgo : null);
    out.push(new Meas('op', i, t, dRel, ld.yRel || 0.0, sx, sy, {
      vx: v, vy: null, svx, svy: 10.0, cls: 'car',
      info: { modelProb: prob, radar: Boolean(ld.radar), aLead: ld.aLead ?? null },
    }));
  });
  return out;
}
