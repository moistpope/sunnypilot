// Road model for the 3D view: smoothed lane lines, a procedurally completed road, how sure we are of
// the lanes, the shape the ground takes for them, and a road frame to anchor signs and lights to.
//
// Lines are kept as y(x) = y0 + t*x + k*x^2/2 in the car frame (x forward, y left, m). Every frame
// each line is first carried along with the car's own motion (so a line the camera lost stays put
// on the road, and smoothing doesn't lag), then eased toward the latest measurement in proportion
// to its confidence. Validity has hysteresis, so a line that flickers valid/invalid doesn't blink.
// The cameras name lines by where they are from the car, so a lane change renames them all at once;
// that's spotted and the carried road renamed the same way, so it stays put on the ground.
//
// Sources: 'blend' (default) takes the ADAS lines and refines each with openpilot's matching line
// where the two agree, adding openpilot-only lines it is confident about; 'fisker' and 'model' use
// one source; 'both' is 'fisker' here (scene.js overlays openpilot's raw lines).
//
// Lane boundaries nobody measures are filled in from a road model: an ego-lane center, a lane
// width and the number of lanes either side, from whatever evidence there is (ADAS lines and lane
// info, openpilot's lane lines and road edges) and held for a while. With no evidence the road
// follows the car's own path. Inferred lines are offsets (`offset`, m, +left) from the ego-lane center,
// drawn relative to `anchor` (a measured ego line when there is one), and flagged so they can be
// drawn softer.
//
// Lane confidence is spatio-temporal. It lives on stations fixed to the road every 5 m of distance
// driven, from just behind the car to 100 m ahead, so what was learned about a stretch of road stays
// with that stretch as the car drives onto it. Each station eases toward how much stable lane evidence
// there is at its distance (the ego lane's lines where they're plausible, weighted by their confidence
// and reach and by how well each new measurement agrees with where the carried line predicted it; else
// openpilot's road edges): up within a second or so, down slowly, more slowly standing still than
// driving, so a lane has to stay stable a while to be trusted and a brief dropout doesn't lose it. The lanes
// show once the stations over the next 30 m average past the threshold (a Display setting), with a
// little hysteresis, and the road reaches as far ahead as the stations stay above it.
//
// `surface` is the shape the ground takes (ground.js draws it): a disc around the car that grows out
// into the road once the lanes show, then follows its lane region and reach. All of it is eased on
// springs, so every change morphs: lanes found or lost, a lane added or dropped, the road reshaping.
//
// `place(s, d)` gives the point s m down the road and d m left of the ego lane's center, on the road
// as drawn now. Signs and lights are anchored to the road with it (furniture.js), so when the road
// is corrected they move with it and stay beside or over it.

const MODEL_X_OFFSET = -1.6;   // openpilot's model frame is the device, ~1.6 m behind the bumper (uncalibrated)

// where openpilot's model frame (the comma camera) sits relative to the front bumper, m: the world model's sensor
// calibration has it (world_model.py SensorCalibration.model_x_offset), else the uncalibrated guess
export function modelXOffset(st) {
  const c = st && st.calibration;
  return c && c.modelXOffset != null ? c.modelXOffset : MODEL_X_OFFSET;
}
const LANE_W = 3.6;
const SHOW_AFTER = 0.2, HIDE_AFTER = 1.0;     // s of valid / invalid before a measured line toggles
const COUNT_HOLD = 25;                         // s a lane-count observation is kept
const COUNT_DROP_S = 8;                        // s without seeing a lane before the count drops it (outer lines flicker)
const MODEL_ONLY_PROB = 0.45;                  // openpilot line probability to add a line the ADAS lacks
const MODEL_WEIGHT = 0.6;                      // openpilot's weight relative to the ADAS when both see a line
const TAU = { y0: 0.3, t: 0.35, k: 0.6 };
const K_MAX = 0.2;                             // 1/m: tightest curve drawn (5 m radius)
const H_MAX = 2.2;                             // rad: lines stop where they'd wind past a U-turn

// lane confidence
export const LANE_CONF_THRESHOLD = 0.5;        // default for the Display setting
const STATION = 5;                             // m of road between stations...
const STATIONS_FROM = -10, STATIONS_TO = 100;  // ...kept from this far behind the bumper to this far ahead
const NEAR = 30;                               // m ahead: the lane confidence is the stations' mean over this
const CONF_RISE_S = 0.8;                       // s for a station to ease up toward better evidence
const CONF_FALL_S = 10;                        // ...and down toward worse over this long standing still...
const CONF_FALL_M = 180;                       // ...and over this far driven
const CONF_FALL_PARK_S = 2;                    // ...or this long in Park
const HIDE_RATIO = 0.8;                        // shown lanes hide below this fraction of the threshold
const REACH_RATIO = 0.6;                       // the road reaches as far as the stations hold this fraction of it
const JITTER_MEAN = 0.12;                      // weight of each new measurement in a line's running jitter (20 Hz)
const UNPROVEN = { y0: 0.25, t: 0.003, k: 1e-6 };   // a new line's jitter (y0 m^2, heading^2, curvature^2): unproven
const MIN_REACH = 30;                          // m: the road always reaches this far once it shows

// lane boundaries numbered right to left: the ego lane's right line is 0, its left line 1
const BOUNDARY = { R3: -2, R2: -1, R1: 0, L1: 1, L2: 2, L3: 3 };
const BOUNDARY_ID = Object.fromEntries(Object.entries(BOUNDARY).map(([id, b]) => [b, id]));

const ease = (dt, tau) => 1 - Math.exp(-dt / tau);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const ramp = (v, a, b) => clamp01((v - a) / (b - a));

// critically damped spring {x, v} toward a target; settles in about 5/w s
function spring(s, target, w, dt) {
  s.v += (w * w * (target - s.x) - 2 * w * s.v) * dt;
  s.x += s.v * dt;
}

class Line {
  constructor(id) {
    this.id = id;
    this.c = null;          // {y0, t, k}
    this.shown = false;
    this.validFor = 0;
    this.invalidFor = 1e9;
    this.color = 'white';
    this.type = 0;
    this.styleAt = -1e9;
    this.jitter = { ...UNPROVEN };   // running mean squared miss of each measurement from the prediction
  }
}

// carry a car-frame line along with the car moving ds forward and turning dth (left +)
function advance(c, ds, dth) {
  c.y0 += c.t * ds + 0.5 * c.k * ds * ds;
  c.t += c.k * ds - dth;
}

function blend(c, m, dt, w) {
  c.y0 += (m.y0 - c.y0) * ease(dt, TAU.y0) * w;
  c.t += (m.t - c.t) * ease(dt, TAU.t) * w;
  c.k += (m.k - c.k) * ease(dt, TAU.k) * w;
}

const yAt = (c, x) => c.y0 + c.t * x + 0.5 * c.k * x * x;

// least-squares quadratic through points (x forward) -> {y0, t, k}
function fitQuadratic(pts) {
  let n = 0, sx = 0, sx2 = 0, sx3 = 0, sx4 = 0, sy = 0, sxy = 0, sx2y = 0;
  for (const [x, y] of pts) {
    if (x < -5 || x > 60) continue;
    const x2 = x * x;
    n++; sx += x; sx2 += x2; sx3 += x2 * x; sx4 += x2 * x2; sy += y; sxy += x * y; sx2y += x2 * y;
  }
  if (n < 4) return null;
  // solve the 3x3 normal equations [n sx sx2; sx sx2 sx3; sx2 sx3 sx4] [a b c] = [sy sxy sx2y]
  const M = [[n, sx, sx2, sy], [sx, sx2, sx3, sxy], [sx2, sx3, sx4, sx2y]];
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    [M[i], M[p]] = [M[p], M[i]];
    if (Math.abs(M[i][i]) < 1e-9) return null;
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = M[r][i] / M[i][i];
      for (let c = i; c < 4; c++) M[r][c] -= f * M[i][c];
    }
  }
  const a = M[0][3] / M[0][0], b = M[1][3] / M[1][1], c = M[2][3] / M[2][2];
  return { y0: a, t: b, k: 2 * c };
}

// points along a line from s0 to s1 (arc length), integrating heading so tight curves stay round
export function linePoints(c, s0, s1, step = 2) {
  const k = Math.max(-K_MAX, Math.min(K_MAX, c.k));
  const h0 = Math.atan(c.t);
  const pts = [];
  // walk out both ways from x = 0 so the line passes through y0 at the car
  const walk = (dir, len) => {
    let x = 0, y = c.y0, h = h0;
    const out = [];
    for (let s = 0; s <= len + 1e-6; s += step) {
      out.push([x, y]);
      const hm = h + dir * k * step / 2;
      x += dir * Math.cos(hm) * step;
      y += dir * Math.sin(hm) * step;
      h += dir * k * step;
      if (Math.abs(h - h0) > H_MAX) break;   // don't wind past a U-turn
    }
    return out;
  };
  const back = walk(-1, -s0).reverse();
  back.pop();
  pts.push(...back, ...walk(1, s1));
  return pts;
}

// the point s m along a line (arc length from x = 0) and d m to its left, as linePoints draws it:
// {x, y, h} in the car frame, h the line's heading there (+ left)
export function arcPoint(c, s, d = 0) {
  const k = Math.max(-K_MAX, Math.min(K_MAX, c.k));
  const h0 = Math.atan(c.t);
  const h = h0 + Math.max(-H_MAX, Math.min(H_MAX, k * s));
  let x, y;
  if (Math.abs(k) < 1e-6) { x = s * Math.cos(h0); y = c.y0 + s * Math.sin(h0); }
  else { x = (Math.sin(h) - Math.sin(h0)) / k; y = c.y0 + (Math.cos(h0) - Math.cos(h)) / k; }
  return { x: x - Math.sin(h) * d, y: y + Math.cos(h) * d, h };
}

// Lane confidence on stations fixed to the road (see the top of the file). Station i sits at i * STATION
// m of distance driven, so `odo` (the distance driven now) says how far ahead each one is.
export class LaneConfidence {
  constructor() {
    this.cells = new Map();   // station index -> confidence 0..1
  }

  // evidence(x): stable lane evidence 0..1 for the road x m ahead; dt s of data time, ds m driven
  update(odo, evidence, dt, ds, fallS = CONF_FALL_S) {
    const i0 = Math.ceil((odo + STATIONS_FROM) / STATION), i1 = Math.floor((odo + STATIONS_TO) / STATION);
    for (const i of this.cells.keys()) if (i < i0 || i > i1) this.cells.delete(i);
    if (dt <= 0) return;
    const rise = Math.min(1, dt / CONF_RISE_S), fall = Math.min(1, dt / fallS + Math.abs(ds) / CONF_FALL_M);
    for (let i = i0; i <= i1; i++) {
      const c = this.cells.get(i) ?? 0;   // road that has just come into range starts unknown
      const e = evidence(i * STATION - odo);
      this.cells.set(i, c + (e - c) * (e > c ? rise : fall));
    }
  }

  at(odo, x) {
    const u = (odo + x) / STATION, i = Math.floor(u);
    const a = this.cells.get(i) ?? 0, b = this.cells.get(i + 1) ?? 0;
    return a + (b - a) * (u - i);
  }

  mean(odo, x0, x1) {
    let sum = 0, n = 0;
    for (let x = x0; x <= x1 + 1e-6; x += STATION / 2) { sum += this.at(odo, x); n++; }
    return n ? sum / n : 0;
  }

  // m ahead to where the stations first drop below thr
  reach(odo, thr) {
    for (let x = 0; x <= STATIONS_TO; x += STATION / 2) if (this.at(odo, x) < thr) return x;
    return STATIONS_TO;
  }
}

export class RoadModel {
  constructor() { this.reset(); }

  /** Forget the road: back to the start, as if nothing had been seen yet. */
  reset() {
    this.lines = new Map();
    this.center = { y0: 0, t: 0, k: 0 };   // ego-lane center
    this.width = LANE_W;
    this.count = { left: { n: 0, at: -1e9 }, right: { n: 0, at: -1e9 } };
    this.oncomingLeft = { v: false, at: -1e9 };
    this.pathK = 0;
    this.t = 0;
    this.odo = 0;                    // m driven (signed): the road's own length coordinate for anchors
    this.slot = null;                // ego lane placed between openpilot's road edges
    this.conf = new LaneConfidence();
    this.laneConf = 0;               // the stations' mean over the next NEAR m
    this.evidence = () => 0;         // lane evidence along the road from the latest snapshot (_laneEvidence)
    this.lanesShown = false;
    this.frame = { c: this.center, offset: 0 };   // what the road is drawn from (see update's `anchor`)
    // the ground's road shape: lane region (m from the ego-lane center to its outer lines), reach ahead,
    // how far it has grown out of the car's disc, and how hard it is reshaping (for the edge's ripple)
    this.surf = { left: { x: LANE_W / 2, v: 0 }, right: { x: -LANE_W / 2, v: 0 }, reach: { x: MIN_REACH, v: 0 },
      reveal: { x: 0, v: 0 }, energy: 0, phase: 0 };
    this.shifts = 0;                 // lane changes seen (+ left), for debugging
  }

  line(id) {
    if (!this.lines.has(id)) this.lines.set(id, new Line(id));
    return this.lines.get(id);
  }

  _fiskerLines(st, settings) {
    const out = new Map();
    const f = st && st.fisker;
    const hs = settings.laneHeadingSign || 1, ks = settings.laneCurvatureSign || 1;
    for (const l of ((f && f.lanes && f.lanes.lines) || []).filter(x => x.valid)) {
      const c = { y0: l.y0, t: Math.tan((l.heading || 0) * hs * Math.PI / 180), k: l.radius ? ks / l.radius : 0 };
      out.set(l.id, { c, conf: l.conf, color: l.color === 'yellow' ? 'yellow' : 'white', type: l.type, edge: !!l.roadEdge });
    }
    return out;
  }

  _modelLines(st, minProb) {
    const out = new Map();
    const md = st && st.op && st.op.modelV2;
    if (!md || !md.laneLines) return out;
    const ids = ['L2', 'L1', 'R1', 'R2'], mx = modelXOffset(st);
    md.laneLines.forEach((pts, i) => {
      const p = (md.laneLineProbs || [])[i] || 0;
      if (!pts || pts.length < 4 || p < minProb) return;
      const c = fitQuadratic(pts.map(([x, y]) => [x + mx, y]));
      if (c) out.set(ids[i], { c, conf: Math.min(1, p), color: 'white', type: 0, edge: false });
    });
    return out;
  }

  // measured lines this frame: id -> {c, conf, color, type, edge}
  _measurements(st, settings) {
    const src = settings.laneSource || 'blend';
    if (src === 'fisker' || src === 'both') return this._fiskerLines(st, settings);
    if (src === 'model') return this._modelLines(st, 0.3);
    // blend: ADAS first, refined by openpilot where both see the same line
    const out = this._fiskerLines(st, settings);
    for (const [id, m] of this._modelLines(st, 0.25)) {
      const a = out.get(id);
      if (!a) {
        if (m.conf >= MODEL_ONLY_PROB) out.set(id, { ...m, conf: m.conf * 0.8 });
        continue;
      }
      // more than ~0.9 m apart 10 m ahead: probably not the same line; keep the ADAS's
      if (a.edge || Math.abs(yAt(a.c, 10) - yAt(m.c, 10)) > 0.9) continue;
      const wa = Math.max(0.1, a.conf), wm = MODEL_WEIGHT * m.conf, w = wa + wm;
      const mix = (k) => (a.c[k] * wa + m.c[k] * wm) / w;
      out.set(id, { ...a, c: { y0: mix('y0'), t: mix('t'), k: mix('k') }, conf: Math.min(1, a.conf + 0.5 * m.conf) });
    }
    return out;
  }

  // openpilot's road edges 10 m ahead (y, +left), when it's reasonably sure of them, smoothed over
  // ~1.5 s so a driveway or side street flaring the edge out doesn't add a lane
  _edges(st, dt) {
    const md = st && st.op && st.op.modelV2;
    this.edge = this.edge || { left: { y: null, at: -1e9 }, right: { y: null, at: -1e9 } };
    const out = { left: null, right: null };
    ['left', 'right'].forEach((side, i) => {
      const e = this.edge[side];
      const pts = md && md.roadEdges && md.roadEdges[i];
      const std = md && (md.roadEdgeStds || [])[i];
      const at = pts && pts.find(([x]) => x + modelXOffset(st) >= 10);
      if (at && (std == null || std < 1.1)) {
        e.y = e.y == null || this.t - e.at > 2 ? at[1] : e.y + (at[1] - e.y) * ease(dt, 1.5);
        e.at = this.t;
      }
      if (e.y != null && this.t - e.at < 1) out[side] = e.y;
    });
    return out;
  }

  // lane counts / width / oncoming evidence, held for COUNT_HOLD s
  _evidence(st, meas, shown, edges) {
    const f = st && st.fisker;
    const road = f && f.road;
    const md = st && st.op && st.op.modelV2;
    const probs = (md && md.laneLineProbs) || [];
    // a higher count is taken once it has held for a second, a lower one after COUNT_DROP_S without the higher
    const see = (side, n) => {
      const c = this.count[side];
      if (n === c.n) { c.at = this.t; c.cand = null; return; }
      if (n > c.n) {
        if (!c.cand || c.cand.n !== n) c.cand = { n, since: this.t };
        if (this.t - c.cand.since >= 1 || this.t - c.at > COUNT_DROP_S) { c.n = n; c.at = this.t; c.cand = null; }
      } else if (this.t - c.at > COUNT_DROP_S) { c.n = n; c.at = this.t; }
    };
    const L1 = shown.has('L1') && this.lines.get('L1'), R1 = shown.has('R1') && this.lines.get('R1');
    this.slot = null;
    if (!L1 && !R1 && edges.left != null && edges.right != null) {
      // no ego line: split the road between the edges into lanes and put the car in its slot
      const roadW = edges.left - edges.right;
      if (roadW > 2.6 && roadW < 25) {
        const n = Math.max(1, Math.round(roadW / 3.4));
        const w = Math.max(2.7, Math.min(4.2, roadW / n));
        const i = Math.max(0, Math.min(n - 1, Math.floor(-edges.right / w)));
        this.slot = { y0: edges.right + (i + 0.5) * w, w };
        see('right', i);
        see('left', n - 1 - i);
      }
    }
    for (const side of ['left', 'right']) {
      if (this.slot) break;
      const p = side === 'left' ? 'L' : 'R';
      let n = null;
      if (shown.has(p + '3')) n = 2;
      else if (shown.has(p + '2')) n = 1;
      // openpilot sees the next line over: there's a lane beyond ours
      if ((side === 'left' ? probs[0] : probs[3]) >= 0.5) n = Math.max(n || 0, 1);
      const lane = road && road[side + 'Lane'];
      if (lane && lane.width > 2 && lane.width < 5.5) n = Math.max(n || 0, 1);
      // a measured road edge right next to the ego lane: nothing beyond it
      const e1 = meas.get(p + '1'), e2 = meas.get(p + '2');
      if (e1 && e1.edge) n = 0;
      else if (e2 && e2.edge && n == null) n = 1;
      // room between our lane and openpilot's road edge (a shoulder up to ~3 m isn't a lane)
      const edge = edges[side];
      if (edge != null) {
        const ours = side === 'left' ? (L1 ? L1.c.y0 : this.center.y0 + this.width / 2) : (R1 ? R1.c.y0 : this.center.y0 - this.width / 2);
        const room = side === 'left' ? edge - ours : ours - edge;
        const m = Math.max(0, Math.floor((room + 0.4) / this.width));
        n = n == null ? m : Math.max(n, m);
      }
      if (n != null) see(side, Math.min(3, n));
    }
    if (road && road.leftLane && road.leftLane.width > 2 && road.oncoming) {
      this.oncomingLeft = { v: !!road.oncoming.L1, at: this.t };
    }
    if (road && road.laneWidth > 2.6 && road.laneWidth < 4.8) this.widthTarget = road.laneWidth;
    else if (this.slot && !(L1 && R1)) this.widthTarget = this.slot.w;
  }

  // A lane change renames every line at once (cross the left line and it becomes the right one, the
  // next line over becomes the left one). Spotted as both ego lines measured a lane width from where
  // the carried ego lane puts them and right where the lane beside it would be; the carried lines,
  // lane counts and surface are renamed the same way, so the road doesn't slide a lane sideways (nor
  // take signs, lights and the lane confidence with it).
  _laneShift(meas) {
    const L1 = meas.get('L1'), R1 = meas.get('R1');
    if (!L1 || !R1) return 0;
    const W = this.width;
    const err = (sh) => (Math.abs(L1.c.y0 - (this.center.y0 + (0.5 + sh) * W)) + Math.abs(R1.c.y0 - (this.center.y0 + (sh - 0.5) * W))) / 2;
    const stay = err(0);
    if (stay < 0.5 * W) return 0;
    for (const sh of [1, -1]) {
      if (err(sh) < 0.3 * W && stay - err(sh) > 0.35 * W) {
        this._shift(sh);
        return sh;
      }
    }
    return 0;
  }

  _shift(sh) {   // +1: the car moved a lane to the left
    const W = this.width;
    const lines = new Map();
    for (const [id, l] of this.lines) {
      const to = BOUNDARY_ID[BOUNDARY[id] - sh];
      if (to) { l.id = to; lines.set(to, l); }
    }
    this.lines = lines;
    this.center.y0 += sh * W;
    this.count.left.n = Math.max(0, this.count.left.n - sh);
    this.count.right.n = Math.max(0, this.count.right.n + sh);
    this.count.left.cand = this.count.right.cand = null;
    this.surf.left.x -= sh * W;
    this.surf.right.x -= sh * W;
    this.shifts += sh;
  }

  // Stable lane evidence 0..1 for the road x m ahead, from a new snapshot's measurements: the ego
  // lane's own lines where they're plausible (on their side of the car, or just across it in a lane
  // change, roughly along our heading, a lane's width apart), each weighted by its confidence, how far
  // ahead it can reach, and how stable it has been: how far its measurements have been landing from
  // where the carried line predicted them, lately (a line that jumps about counts for little, and a new
  // one has to prove itself over a second or so). Else openpilot's road edges while moving.
  _laneEvidence(meas, moving) {
    const ego = {};
    for (const [id, side] of [['L1', 1], ['R1', -1]]) {
      const m = meas.get(id);
      if (!m) continue;
      const l = this.line(id);
      if (l.shown && l.c) {
        for (const k of ['y0', 't', 'k']) l.jitter[k] += ((m.c[k] - l.c[k]) ** 2 - l.jitter[k]) * JITTER_MEAN;
      } else l.jitter = { ...UNPROVEN };
      const y = side * m.c.y0;
      const plaus = ramp(y, -0.8, -0.2) * (1 - ramp(y, 4.2, 5.0)) * (1 - ramp(Math.abs(m.c.t), 0.3, 0.6)) * (m.edge ? 0.7 : 1);
      if (plaus > 0) ego[id] = { c: m.c, j: l.jitter, w: Math.min(1, m.conf) * plaus, reach: 40 + 60 * Math.min(1, m.conf) };
    }
    const lines = Object.values(ego);
    const edges = !!this.slot && moving;
    if (!lines.length && !edges) return () => 0;
    return (x) => {
      if (x < -5) return 0;
      let miss = 1;
      for (const l of lines) {
        const cover = 1 - ramp(x, 40, l.reach);
        if (cover <= 0) continue;
        // its typical miss this far out, against what's tolerable this far out
        const miss2 = l.j.y0 + x * x * l.j.t + x * x * x * x / 4 * l.j.k, tol = 0.25 + 0.012 * Math.max(0, x);
        miss *= 1 - l.w * cover * Math.exp(-0.5 * miss2 / (tol * tol));
      }
      let e = 1 - miss;
      if (ego.L1 && ego.R1) {
        const w = yAt(ego.L1.c, x) - yAt(ego.R1.c, x);
        e *= ramp(w, 2.0, 2.6) * (1 - ramp(w, 5.0, 5.8));
      }
      if (edges) e = Math.max(e, 0.5 * (1 - ramp(x, 20, 60)));
      return e;
    };
  }

  // a point s m down the road (arc length from the bumper) and d m left of the ego lane's center, on
  // the road as drawn now: {x, y, h} in the car frame
  place(s, d) {
    return arcPoint(this.frame.c, s, d - this.frame.offset);
  }

  // m left of the ego lane's center to the outer lane line on a side (+1 left, -1 right), as the
  // surface is easing toward it
  laneEdge(side) {
    return side > 0 ? this.surf.left.x : this.surf.right.x;
  }

  update(st, vehicle, settings, dt) {
    this.t += dt;
    const v = vehicle ? vehicle.v : 0;
    const ds = v * dt;
    this.odo += ds;
    const kCar = vehicle ? vehicle.curvature : 0;
    const dth = kCar * ds;
    const dtData = dt * (vehicle ? vehicle.rate : 0);   // 0 while a replay is paused or the data is stale
    const parked = vehicle && vehicle.gear === 'park';

    // 1) carry everything along with the car
    for (const l of this.lines.values()) if (l.c) advance(l.c, ds, dth);
    advance(this.center, ds, dth);

    // 2) measurements: a lane change renames the carried road first; the lane confidence takes the
    // measurements against where the carried lines predicted them; then they're eased in, with
    // hysteresis on validity
    const meas = this._measurements(st, settings);
    this._laneShift(meas);
    if (st !== this.measured || parked !== this.measuredParked) {   // a new snapshot (they come at 20 Hz)
      this.measured = st;
      this.measuredParked = parked;
      this.evidence = parked ? () => 0 : this._laneEvidence(meas, Math.abs(v) > 2);
    }
    this.conf.update(this.odo, this.evidence, dtData, ds, parked ? CONF_FALL_PARK_S : CONF_FALL_S);
    const shown = new Set();
    for (const id of new Set([...this.lines.keys(), ...meas.keys()])) {
      const l = this.line(id);
      const m = meas.get(id);
      if (m) {
        l.validFor += dt;
        l.invalidFor = 0;
        if (!l.c || !l.shown && l.validFor <= dt * 1.5) l.c = { ...m.c };
        else blend(l.c, m.c, dt, 0.35 + 0.65 * Math.min(1, m.conf));
        l.color = m.color;
        l.type = m.type;
        l.edge = m.edge;
        l.styleAt = this.t;
        if (!l.shown && (l.validFor >= SHOW_AFTER || m.conf >= 0.6)) l.shown = true;
      } else {
        l.validFor = 0;
        l.invalidFor += dt;
        if (l.shown && l.invalidFor > HIDE_AFTER) l.shown = false;
      }
      if (l.shown) shown.add(id);
    }

    // 3) road model: width, center, lane counts
    const edges = this._edges(st, dt);
    this._evidence(st, meas, shown, edges);
    const L1 = shown.has('L1') && this.lines.get('L1'), R1 = shown.has('R1') && this.lines.get('R1');
    if (L1 && R1 && !L1.edge && !R1.edge) {
      const w = L1.c.y0 - R1.c.y0;
      if (w > 2.6 && w < 4.8) this.widthTarget = w;
    }
    if (this.widthTarget) this.width += (this.widthTarget - this.width) * ease(dt, 2.0);
    const W = this.width;
    // the car's own path curvature (openpilot's plan, else steering), smoothed
    const md = st && st.op && st.op.modelV2;
    let kPath = kCar;
    if (md && md.path && md.path.length > 4) {
      const mx = modelXOffset(st);
      const fit = fitQuadratic(md.path.map(([x, y]) => [x + mx, y]));
      if (fit) kPath = fit.k;
    }
    this.pathK += (Math.max(-0.15, Math.min(0.15, kPath)) - this.pathK) * ease(dt, 1.0);
    // where the ego lane's center is, by the best evidence
    let target = null, w = 1;
    if (L1 && R1) target = { y0: (L1.c.y0 + R1.c.y0) / 2, t: (L1.c.t + R1.c.t) / 2, k: (L1.c.k + R1.c.k) / 2 };
    else if (L1) target = { ...L1.c, y0: L1.c.y0 - W / 2 };
    else if (R1) target = { ...R1.c, y0: R1.c.y0 + W / 2 };
    else if (this.slot) {
      // between openpilot's road edges: our lane's slot, heading/curvature from the path
      target = { y0: this.slot.y0, t: 0, k: this.pathK };
      w = 0.5;
    } else {
      // nothing measured: drift back to the car's own path (curvature from steering, smoothed)
      target = { y0: 0, t: 0, k: this.pathK };
      // slow, to keep the last good road for a while, unless the car has since turned away from it
      // (an intersection): then the road it's on now is the one ahead of it
      const turned = Math.min(1, Math.abs(this.center.t) / 0.25);
      w = 0.12 + 0.88 * turned * turned;
    }
    const was = { ...this.center };
    blend(this.center, target, dt, w);
    // how fast the road is being reshaped (heading and curvature corrections, not the car's own motion)
    const bend = dt > 0 ? Math.max(0, Math.abs(this.center.t - was.t) / dt - 0.03) * 6 + Math.max(0, Math.abs(this.center.k - was.k) / dt - 0.0004) * 400 : 0;

    // 4) the lane confidence, and the ground's road shape on springs, so that every change morphs
    const thr = settings.laneConfThreshold ?? LANE_CONF_THRESHOLD;
    this.laneConf = this.conf.mean(this.odo, 0, NEAR);
    if (!this.lanesShown && this.laneConf >= thr) this.lanesShown = true;
    else if (this.lanesShown && this.laneConf < thr * HIDE_RATIO) this.lanesShown = false;
    const lanes = (side) => (this.t - this.count[side].at < COUNT_HOLD ? this.count[side].n : 0);
    const nl = lanes('left'), nr = lanes('right');
    const sf = this.surf;
    spring(sf.left, W * (0.5 + nl), 3.0, dt);
    spring(sf.right, -W * (0.5 + nr), 3.0, dt);
    spring(sf.reach, Math.max(MIN_REACH, this.conf.reach(this.odo, thr * REACH_RATIO)), 1.6, dt);
    spring(sf.reveal, this.lanesShown ? 1 : 0, 2.6, dt);
    // how hard the drawn road is reshaping (a road that isn't drawn bending with the car's path doesn't count)
    const reshaping = (Math.max(0, (Math.abs(sf.left.v) + Math.abs(sf.right.v)) / 2 - 0.15) +
      Math.max(0, Math.abs(sf.reach.v) - 4) / 12 + bend) * clamp01(sf.reveal.x) + Math.abs(sf.reveal.v) * 3;
    const energy = Math.min(1, reshaping / 2);
    sf.energy += (energy - sf.energy) * ease(dt, energy > sf.energy ? 0.08 : 0.7);
    sf.phase += sf.energy * dt;

    // 5) lines to draw: measured ones that are shown, inferred ones for every other boundary, out to
    // whichever is wider of the lanes there are now and the surface still easing in or out of them
    const nlDraw = Math.max(nl, Math.ceil(sf.left.x / W - 0.55)), nrDraw = Math.max(nr, Math.ceil(-sf.right.x / W - 0.55));
    const oncoming = this.oncomingLeft.v && this.t - this.oncomingLeft.at < COUNT_HOLD;
    const out = [];
    for (const id of shown) {
      const l = this.lines.get(id);
      out.push({ id, c: l.c, color: l.color, type: l.type, edge: l.edge, inferred: false });
    }
    const boundary = (p, i) => {   // i = 1 for the ego lane's own line
      const id = p + i;
      if (shown.has(id)) return;
      const side = p === 'L' ? 'left' : 'right';
      const known = this.t - this.count[side].at < COUNT_HOLD;
      const outer = i === (p === 'L' ? nl : nr) + 1;
      const prev = this.lines.get(id);
      const recent = prev && this.t - prev.styleAt < COUNT_HOLD && prev.type !== 0;
      // remembered marking if we saw this line lately; else solid at a known road edge, dashed otherwise
      let color = recent ? prev.color : 'white', type = recent ? prev.type : (outer && known ? 1 : 2);
      if (!recent && p === 'L' && i === 1 && oncoming) { color = 'yellow'; type = 7; }
      out.push({ id, offset: (p === 'L' ? 1 : -1) * W * (i - 0.5), color, type, edge: false, inferred: true });
    };
    for (let i = 1; i <= nlDraw + 1; i++) boundary('L', i);
    for (let i = 1; i <= nrDraw + 1; i++) boundary('R', i);
    // inferred geometry hangs off a measured ego line when there is one (so it stays exactly
    // parallel to it), else off the ego-lane center
    const anchor = L1 ? { c: L1.c, offset: W / 2 } : R1 ? { c: R1.c, offset: -W / 2 } : { c: this.center, offset: 0 };
    this.frame = anchor;
    return {
      lines: out,
      anchor,
      laneConf: this.laneConf,
      shown: this.lanesShown,
      // the ground's road shape: lane region (outer lines, m left of the ego-lane center), m it reaches
      // ahead, 0..1 grown out of the disc, how hard it's reshaping (0..1) and the edge ripple's phase
      surface: { left: sf.left.x, right: sf.right.x, reach: sf.reach.x, reveal: clamp01(sf.reveal.x), energy: sf.energy, phase: sf.phase },
    };
  }
}
