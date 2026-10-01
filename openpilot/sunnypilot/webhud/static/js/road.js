// Road model for the 3D view: smoothed lane lines plus a procedurally completed road.
//
// Lines are kept as y(x) = y0 + t*x + k*x^2/2 in the car frame (x forward, y left, m). Every frame
// each line is first carried along with the car's own motion (so a line the camera lost stays put
// on the road, and smoothing doesn't lag), then eased toward the latest measurement in proportion
// to its confidence. Validity has hysteresis, so a line that flickers valid/invalid doesn't blink.
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
// `confidence` (0..1) says whether the car is on a laned road at all: it rises with real lane
// evidence and falls after ~150 m of driving without any, or in Park. Inferred lanes and the road
// band are drawn with it, so a parked car, or one that hasn't seen a lane yet, sits on bare ground.

const MODEL_X_OFFSET = -1.6;   // openpilot's model frame is the device, ~1.6 m behind the bumper
const LANE_W = 3.6;
const SHOW_AFTER = 0.2, HIDE_AFTER = 1.0;     // s of valid / invalid before a measured line toggles
const COUNT_HOLD = 25;                         // s a lane-count observation is kept
const EVIDENCE_HOLD_M = 150;                   // m driven without lane evidence before the road fades
const MODEL_ONLY_PROB = 0.45;                  // openpilot line probability to add a line the ADAS lacks
const MODEL_WEIGHT = 0.6;                      // openpilot's weight relative to the ADAS when both see a line
const TAU = { y0: 0.3, t: 0.35, k: 0.6 };

const ease = (dt, tau) => 1 - Math.exp(-dt / tau);

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
  const k = Math.max(-0.2, Math.min(0.2, c.k));
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
      if (Math.abs(h - h0) > 2.2) break;   // don't wind past a U-turn
    }
    return out;
  };
  const back = walk(-1, -s0).reverse();
  back.pop();
  pts.push(...back, ...walk(1, s1));
  return pts;
}

export class RoadModel {
  constructor() {
    this.lines = new Map();
    this.center = { y0: 0, t: 0, k: 0 };   // ego-lane center
    this.width = LANE_W;
    this.count = { left: { n: 0, at: -1e9 }, right: { n: 0, at: -1e9 } };
    this.oncomingLeft = { v: false, at: -1e9 };
    this.pathK = 0;
    this.t = 0;
    this.confidence = 0;
    this.sinceEvidence = Infinity;   // m driven since the last lane evidence
    this.slot = null;                // ego lane placed between openpilot's road edges
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
    const ids = ['L2', 'L1', 'R1', 'R2'];
    md.laneLines.forEach((pts, i) => {
      const p = (md.laneLineProbs || [])[i] || 0;
      if (!pts || pts.length < 4 || p < minProb) return;
      const c = fitQuadratic(pts.map(([x, y]) => [x + MODEL_X_OFFSET, y]));
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
      const at = pts && pts.find(([x]) => x + MODEL_X_OFFSET >= 10);
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
    // a higher count is taken once it has held for a second, a lower one after 3 s without the higher
    const see = (side, n) => {
      const c = this.count[side];
      if (n === c.n) { c.at = this.t; c.cand = null; return; }
      if (n > c.n) {
        if (!c.cand || c.cand.n !== n) c.cand = { n, since: this.t };
        if (this.t - c.cand.since >= 1 || this.t - c.at > 3) { c.n = n; c.at = this.t; c.cand = null; }
      } else if (this.t - c.at > 3) { c.n = n; c.at = this.t; }
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

  update(st, vehicle, settings, dt) {
    this.t += dt;
    const v = vehicle ? vehicle.v : 0;
    const ds = v * dt;
    const kCar = vehicle ? vehicle.curvature : 0;
    const dth = kCar * ds;

    // 1) carry everything along with the car
    for (const l of this.lines.values()) if (l.c) advance(l.c, ds, dth);
    advance(this.center, ds, dth);

    // 2) measurements, with hysteresis and confidence-weighted easing
    const meas = this._measurements(st, settings);
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
      const fit = fitQuadratic(md.path.map(([x, y]) => [x + MODEL_X_OFFSET, y]));
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
    blend(this.center, target, dt, w);

    // on a laned road at all? real evidence = an ego lane line, or openpilot's road edges while moving
    const moving = Math.abs(v) > 2;
    if (L1 || R1 || (this.slot && moving)) this.sinceEvidence = 0;
    else this.sinceEvidence += Math.abs(ds);
    const parked = vehicle && vehicle.gear === 'park';
    const want = !parked && this.sinceEvidence < EVIDENCE_HOLD_M ? 1 : 0;
    this.confidence += (want - this.confidence) * ease(dt, want > this.confidence ? 0.6 : 1.5);

    // 4) lines to draw: measured ones that are shown, inferred ones for every other boundary
    const lanes = (side) => (this.t - this.count[side].at < COUNT_HOLD ? this.count[side].n : 0);
    const nl = lanes('left'), nr = lanes('right');
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
    for (let i = 1; i <= nl + 1; i++) boundary('L', i);
    for (let i = 1; i <= nr + 1; i++) boundary('R', i);
    // inferred geometry hangs off a measured ego line when there is one (so it stays exactly
    // parallel to it), else off the ego-lane center
    const anchor = L1 ? { c: L1.c, offset: W / 2 } : R1 ? { c: R1.c, offset: -W / 2 } : { c: this.center, offset: 0 };
    return {
      lines: out,
      anchor,
      confidence: this.confidence,
      // drivable surface across all lanes, plus a little shoulder (offset from the ego-lane center)
      surface: { offset: (nl - nr) * W / 2, width: (nl + nr + 1) * W + 1.0 },
    };
  }
}
