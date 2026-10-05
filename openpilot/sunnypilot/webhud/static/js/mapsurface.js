// The road's reference line when the map knows the road: the matcher's horizon (state.map, world/mapmatch.js,
// a centerline polyline in the pose frame) is the road's geometry, whole; nothing of the cameras' lane
// shape is mixed into it. What the cameras do is place the car on it: the pose's heading and position put
// the map into the car frame (that is the ground truth of where we are and which way we point, to a
// degree and a meter or two), and the lane model refines the sideways placement -- it knows where the
// ego lane's center is to centimeters, where GPS and the OSM centerline only know it to meters -- by
// sliding the whole map line sideways so it passes through that center at the car, and nudging its
// rotation by the small angle between the map's direction and the lanes' (clamped and smoothed, so the
// far end doesn't swing). Lane lines are then parallel offsets of the map line at the distances the
// cameras measure at the car. So the road keeps the map's shape -- its bends, its branches, the way on
// past the cameras' reach -- and the car sits in its lane on it.
//
// Car frame: x ahead of the front bumper, y left, meters; stations s are arc length from the bumper.

export const POLY_MAX = 64;              // points the ground shader takes
const REAR_AXLE_TO_BUMPER = 4.775 - 0.93; // scene.js REAR_AXLE_Z, until the model says
const LANE_W = 3.6;
const DENSE_STEP_NEAR = 2, DENSE_STEP_FAR = 4, DENSE_NEAR_M = 80;   // the lines' sampling
const FAR_FADE = 60;                     // m: the field's fade past the horizon's end
const ALIGN_MAX = 4 * Math.PI / 180;     // rad: the most the lanes may turn the map by
const ALIGN_TAU_S = 1.0;                 // s: how fast that turn follows the lanes
const SHIFT_MAX = 6.0;                   // m: the most the lanes may slide the map by (beyond that they disagree about the road)
const BRANCH_MIN_LANES = 1;
const PRIOR_W = 0.7;                     // with no lanes seen on a two-way road: how much "we drive in the right half" counts vs the GPS
const PRIOR_TAU_S = 2.0;                 // ...and how slowly that placement moves
const END_FADE = 12;                     // m: the field's fade where the road itself ends (a T-junction)

const mix = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Linear interpolation on a polyline given by parallel arrays, at station s (clamped to the ends). */
function sample(xs, ys, st, s) {
  const n = st.length;
  if (s <= st[0]) return [xs[0], ys[0], 0];
  if (s >= st[n - 1]) return [xs[n - 1], ys[n - 1], n - 2];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (st[m] <= s) lo = m; else hi = m; }
  const f = (s - st[lo]) / (st[hi] - st[lo] || 1);
  return [mix(xs[lo], xs[hi], f), mix(ys[lo], ys[hi], f), lo];
}

/** Unit direction of the polyline's segment i (the last point uses the segment before it). */
function direction(xs, ys, i) {
  const n = xs.length;
  if (n < 2) return [1, 0];
  const k = Math.max(0, Math.min(i, n - 2)), j = k + 1;
  const dx = xs[j] - xs[k], dy = ys[j] - ys[k], L = Math.hypot(dx, dy) || 1;
  return [dx / L, dy / L];
}

/**
 * Build the reference from a snapshot's map, the scene's pose (the frame the horizon is in), this frame's
 * road model output and the settings. `align` carries the smoothed rotation and slide between frames ({dh, shift}).
 * Returns null when there is nothing to build from, else
 *  { pts: [[x, y], ...] (<= POLY_MAX, for the shader), st: [stations], dense: {xs, ys, st} (2-4 m sampling for the
 *    lines), width: [right, left] | null (the carriageway from the map when the cameras show no lanes),
 *    reveal, reach, back, centerY0, shifted, shift, rotated }.
 */
export function mapReference(map, pose, road, settings, rearAxleZ = REAR_AXLE_TO_BUMPER, align = null, dt = 1 / 60) {
  if (!map || !map.way || !map.horizon || map.horizon.length < 2 || settings.mapRoad === false) return null;
  const H = map.horizon, n = H.length;
  const ci = Math.min(Math.max(map.carIndex || 0, 0), n - 1);
  const c = Math.cos(pose.h), s = Math.sin(pose.h);
  const xs = new Float64Array(n), ys = new Float64Array(n), st = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const dx = H[i][0] - pose.x, dy = H[i][1] - pose.y;
    xs[i] = c * dx + s * dy - rearAxleZ;   // ahead of the bumper
    ys[i] = -s * dx + c * dy;
  }
  // stations: the matched point is the rear axle's, the bumper is rearAxleZ further along
  st[ci] = -rearAxleZ;
  for (let i = ci + 1; i < n; i++) st[i] = st[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  for (let i = ci - 1; i >= 0; i--) st[i] = st[i + 1] - Math.hypot(xs[i] - xs[i + 1], ys[i] - ys[i + 1]);
  if (st[n - 1] < 5) return null;   // the horizon ends at the car

  const way = map.way;
  const lanes = way.oneWay ? Math.max(1, way.lanes || 0) : Math.max(2, way.lanes || 0);
  const half = lanes * LANE_W / 2;
  // where the lanes say the ego lane's center is at the car, and which way they run
  const a = road && road.anchor, shown = !!(road && road.shown && a && road.surface.reveal > 0.2);
  const [, yMap0, seg0] = sample(xs, ys, st, 0);
  const [ux, uy] = direction(xs, ys, seg0);
  const hMap = Math.atan2(uy, ux);
  let shift = 0, dhTarget = 0, tau = ALIGN_TAU_S;
  if (shown) {
    const yCenter = a.c.y0 - a.offset;
    if (Math.abs(yCenter - yMap0) <= SHIFT_MAX) shift = yCenter - yMap0;
    dhTarget = clamp(Math.atan(a.c.t) - hMap, -ALIGN_MAX, ALIGN_MAX);
  } else if (!way.oneWay) {
    // no lanes seen: the GPS puts the car across a two-way road to a meter or two, which would have it wander
    // over the centerline; we drive in the right half, so lean on that and move slowly
    shift = clamp(PRIOR_W * (half / 2 - yMap0), -half, half);
    tau = PRIOR_TAU_S;
  } else {
    tau = PRIOR_TAU_S;   // one-way: the GPS alone, but smoothed
  }
  // the rotation and the slide follow their sources slowly, so a wobble in them doesn't swing the far end of
  // the road, and the road slides rather than snaps when the lanes appear or go
  let dh = dhTarget;
  if (align) {
    const k = 1 - Math.exp(-Math.max(0, dt) / tau);
    align.dh = (align.dh || 0) + (dhTarget - (align.dh || 0)) * k;
    align.shift = (align.shift || 0) + (shift - (align.shift || 0)) * k;
    dh = align.dh;
    shift = align.shift;
  }
  // the rigid placement: rotate about the car's spot on the line (station 0), slide sideways to the lanes' center
  const px0 = 0, py0 = yMap0;
  const cr = Math.cos(dh), sr = Math.sin(dh);
  const refX = new Float64Array(n), refY = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - px0, dy = ys[i] - py0;
    refX[i] = px0 + cr * dx - sr * dy;
    refY[i] = py0 + sr * dx + cr * dy + shift;
  }
  const centerY0 = yMap0 + shift;

  // the shader's polyline: at most POLY_MAX points, thinned from the far end first
  let pts = Array.from(refX, (x, i) => [x, refY[i]]), pst = Array.from(st);
  while (pts.length > POLY_MAX) {
    const keep = [], ks = [];
    for (let i = 0; i < pts.length; i++) if (i === 0 || i === pts.length - 1 || i % 2 === 0 || pst[i] < 100) { keep.push(pts[i]); ks.push(pst[i]); }
    if (keep.length === pts.length) { keep.length = POLY_MAX; ks.length = POLY_MAX; }
    pts = keep; pst = ks;
  }
  // a dense sampling for the lane strips
  const dXs = [], dYs = [], dSt = [];
  for (let si = Math.max(st[0], -30); si <= st[n - 1]; si += si < DENSE_NEAR_M ? DENSE_STEP_NEAR : DENSE_STEP_FAR) {
    const [x, y] = sample(refX, refY, st, si);
    dXs.push(x); dYs.push(y); dSt.push(si);
  }
  // the lane structure the map implies, as offsets from the reference line (the carriageway's center): the
  // centerline of a two-way road, the boundaries between lanes, the edges. Drawn when the cameras show no lanes.
  const structure = [];
  if (way.oneWay) {
    for (let k = 1; k < lanes; k++) structure.push({ d: -half + k * LANE_W, kind: 'lane' });
  } else {
    structure.push({ d: 0, kind: 'center' });
    for (let k = 1; k < lanes / 2; k++) { structure.push({ d: k * LANE_W, kind: 'lane' }); structure.push({ d: -k * LANE_W, kind: 'lane' }); }
  }
  structure.push({ d: half, kind: 'edge' }, { d: -half, kind: 'edge' });
  // the roads leaving the horizon, placed the same way (pose, then the lanes' turn and slide)
  const toCar = (wx, wy) => {
    const dx = wx - pose.x, dy = wy - pose.y;
    const x = c * dx + s * dy - rearAxleZ, y = -s * dx + c * dy;
    const rx = x - px0, ry = y - py0;
    return [px0 + cr * rx - sr * ry, py0 + sr * rx + cr * ry + shift];
  };
  const branches = [];
  for (const b of map.branches || []) {
    if (!b.pts || b.pts.length < 2) continue;
    const bl = b.oneWay ? Math.max(BRANCH_MIN_LANES, b.lanes || 0) : Math.max(2, b.lanes || 0);
    branches.push({ pts: b.pts.map(p => toCar(p[0], p[1])), width: bl * LANE_W, along: b.along, angle: b.angle, name: b.name, ref: b.ref, className: b.className, oneWay: b.oneWay, merge: !!b.merge });
  }
  return {
    pts, st: pst,
    dense: { xs: dXs, ys: dYs, st: dSt },
    width: shown ? null : [-half, half],
    reveal: Math.min(1, Math.max(0, map.conf ?? 0.5)) * (map.coasting ? 0.5 : 1),
    reach: st[n - 1], back: -st[0], fade: map.ended ? END_FADE : FAR_FADE,
    centerY0,
    shifted: shown, shift, rotated: dh,
    branches, structure,
    lanes, oneWay: !!way.oneWay,
  };
}

/** Unit left normal of the dense polyline at index i. */
function normalAt(ref, i) {
  const [dx, dy] = direction(ref.dense.xs, ref.dense.ys, i);
  return [-dy, dx];
}

/**
 * A lane line along the reference: the map line offset sideways by the line's distance from the ego lane's
 * center as the cameras measure it at the car (`c.y0 - centerY0` for a measured line's quadratic `c`, or `d`
 * for an inferred one). Returns [[x, y], ...] in the car frame.
 */
export function lineAlong(ref, c, d = null) {
  const { xs, ys } = ref.dense;
  const off = c ? c.y0 - ref.centerY0 : d;
  const out = [];
  for (let i = 0; i < xs.length; i++) {
    const [nx, ny] = normalAt(ref, i);
    out.push([xs[i] + nx * off, ys[i] + ny * off]);
  }
  return out;
}

// ---- junctions ------------------------------------------------------------------------------------------
//
// Where a road leaves (or joins) the one we're on, draw what a map would: the arm's edges don't stop dead at
// our edge, they curve into it (fillets: tight at a street corner, long and shallow at a ramp's gore), our edge
// line opens across the mouth between the two fillets, and inside a crossing our lane dashes stop. The arm
// itself is a strip of road between its two filleted edges, with its own centerline or lane boundaries
// starting past the mouth. Everything is in the car frame; stations are along our own reference line.

const R_ACUTE = 2.0, R_RIGHT = 6.0, R_OBTUSE = 4.0;   // fillet radii by the corner's angle
const FILLET_MAX_D = 30;                              // m: a gore's taper, at most
const PARALLEL = 0.08;                                // |sin| below which an arm runs with the road (no mouth to cut)
const BOX_ANGLE = 60 * Math.PI / 180;                 // an arm turning more than this makes an intersection, not an exit
const BOX_PAIR_M = 15;                                // arms on both sides this close in station form one crossing
const ARC_N = 8;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const norm = (a) => { const L = Math.hypot(a[0], a[1]) || 1; return [a[0] / L, a[1] / L]; };
const left = (u) => [-u[1], u[0]];

/** Intersection of the lines p + a*u and q + b*v: [a, b], or null when parallel. */
function meet(p, u, q, v) {
  const den = cross(u, v);
  if (Math.abs(den) < 1e-9) return null;
  const d = sub(q, p);
  return [cross(d, v) / den, cross(d, u) / den];
}

/** Points of a quadratic Bezier from a through (toward) c to b: a round enough fillet. */
function fillet(a, c, b) {
  const out = [];
  for (let i = 0; i <= ARC_N; i++) {
    const t = i / ARC_N, s = 1 - t;
    out.push([s * s * a[0] + 2 * s * t * c[0] + t * t * b[0], s * s * a[1] + 2 * s * t * c[1] + t * t * b[1]]);
  }
  return out;
}

/** Cumulative arc length of a polyline. */
function cumulative(pts) {
  const st = [0];
  for (let i = 1; i < pts.length; i++) st.push(st[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return st;
}

/** A polyline resampled at n points by arc length. */
export function resample(pts, n) {
  if (pts.length < 2) return pts.slice();
  const st = cumulative(pts), L = st[st.length - 1], out = [];
  for (let k = 0; k < n; k++) {
    const s = L * k / (n - 1);
    let i = 1;
    while (i < st.length - 1 && st[i] < s) i++;
    const f = st[i] - st[i - 1] > 0 ? (s - st[i - 1]) / (st[i] - st[i - 1]) : 0;
    out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f]);
  }
  return out;
}

/** The part of a polyline from arc length `from` on, starting exactly there (or [] when it's shorter). */
export function fromDistance(pts, from) {
  const st = cumulative(pts);
  for (let i = 1; i < pts.length; i++) {
    if (st[i] >= from) {
      const f = st[i] - st[i - 1] > 0 ? (from - st[i - 1]) / (st[i] - st[i - 1]) : 0;
      return [[pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f], ...pts.slice(i)];
    }
  }
  return [];
}

/** A polyline offset to its left by d (uses each point's neighbours for the direction). */
function offsetPoly(pts, d) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const u = norm(sub(b, a));
    return [p[0] - u[1] * d, p[1] + u[0] * d];
  });
}

/** Split a line (points with stations) into the pieces outside the given [s0, s1] intervals. */
export function cutByStations(pts, st, intervals) {
  if (!intervals.length) return [pts];
  const out = [];
  let cur = [];
  for (let i = 0; i < pts.length; i++) {
    const s = st[i];
    const inside = intervals.some(([a, b]) => s >= a && s <= b);
    if (inside) { if (cur.length >= 2) out.push(cur); cur = []; } else cur.push(pts[i]);
  }
  if (cur.length >= 2) out.push(cur);
  return out;
}

/**
 * The junction geometry for the reference's branches. hm = {left, right}: the main road's half widths
 * (from its centerline) on each side. Returns { arms: [{strip: {left, right} (two boundaries, equal counts),
 * edges: [polyline], arcs: [polyline], center: polyline | null, lanes: [polyline], along, angle, merge, name}],
 * cuts: {left: [[s0, s1]], right: [...], all: [...]} } with cuts as station intervals along the reference.
 */
export function junctions(ref, hm) {
  const arms = [], mouths = [];
  const { xs, ys, st } = ref.dense;
  for (const b of ref.branches || []) {
    if (b.along < -10 || b.pts.length < 2) continue;
    const bp = densifyPts(b.pts, 3);
    const P0 = bp[0];
    // our direction and station at the junction: the nearest dense point
    let ni = 0, best = Infinity;
    for (let i = 0; i < xs.length; i++) { const d2 = (xs[i] - P0[0]) ** 2 + (ys[i] - P0[1]) ** 2; if (d2 < best) { best = d2; ni = i; } }
    const um = direction(xs, ys, ni), nm = left(um), s0 = st[ni] + dot(sub(P0, [xs[ni], ys[ni]]), um);
    const ub = norm(sub(bp[1], P0));
    const sin = cross(um, ub);
    if (Math.abs(sin) < PARALLEL) continue;   // runs alongside: nothing to cut or round
    const side = sin > 0 ? 1 : -1;
    const H = side > 0 ? hm.left : hm.right, hb = b.width / 2;
    const E = add(P0, mul(nm, side * H));     // a point on our edge on that side
    const nb = left(ub);
    const corners = [];
    for (const j of [1, -1]) {
      const B = add(P0, mul(nb, j * hb));
      const ab = meet(E, um, B, ub);
      if (!ab) continue;
      corners.push({ j, C: add(E, mul(um, ab[0])), sC: s0 + ab[0], tC: ab[1] });
    }
    if (corners.length < 2) continue;
    corners.sort((p, q) => p.sC - q.sC);
    const arcs = [], edges = [], bounds = {};
    let cutFrom = Infinity, cutTo = -Infinity;
    corners.forEach((k, idx) => {
      const upstream = idx === 0;
      const e1 = upstream ? mul(um, -1) : um, e2 = ub;
      const alpha = Math.acos(Math.max(-1, Math.min(1, dot(e1, e2))));
      const R = alpha > 100 * Math.PI / 180 ? R_OBTUSE : alpha > 50 * Math.PI / 180 ? R_RIGHT : R_ACUTE;
      let d = alpha > 1e-3 ? R / Math.tan(alpha / 2) : FILLET_MAX_D;
      d = Math.min(d, FILLET_MAX_D, Math.max(1, k.tC + 25));
      const T1 = add(k.C, mul(e1, d)), T2 = add(k.C, mul(e2, d));
      const arc = fillet(T1, k.C, T2);
      arcs.push(arc);
      // our edge opens from the upstream tangent point to the downstream one
      const sT1 = upstream ? k.sC - d : k.sC + d;
      cutFrom = Math.min(cutFrom, sT1); cutTo = Math.max(cutTo, sT1);
      // the arm's edge: from the tangent point on out along the arm
      const edgePoly = offsetPoly(bp, k.j * hb);
      const beyondT2 = fromDistance(edgePoly, Math.max(0, k.tC + d));
      const edge = [T2, ...beyondT2.slice(beyondT2.length && Math.hypot(beyondT2[0][0] - T2[0], beyondT2[0][1] - T2[1]) < 0.5 ? 1 : 0)];
      edges.push(edge);
      bounds[k.j] = [...arc, ...edge.slice(1)];
    });
    if (!(cutFrom < cutTo)) continue;
    // the arm's own markings start past the mouth
    const start = Math.max(...corners.map(k => k.tC)) + 2;
    let center = null;
    const lanes = [];
    const bl = Math.max(1, Math.round(b.width / LANE_W));
    if (!b.oneWay) center = fromDistance(bp, start);
    else for (let k = 1; k < bl; k++) lanes.push(fromDistance(offsetPoly(bp, -hb + k * LANE_W), start));
    const N = 24;
    arms.push({ strip: { left: resample(bounds[1], N), right: resample(bounds[-1], N) }, edges, arcs, center: center && center.length >= 2 ? center : null,
      lanes: lanes.filter(l => l.length >= 2), along: b.along, angle: b.angle, merge: !!b.merge, name: b.name || b.ref || '', side, s0, crossing: Math.abs(b.angle) * Math.PI / 180 > BOX_ANGLE });
    mouths.push({ side, s0, from: cutFrom, to: cutTo, crossing: Math.abs(b.angle) * Math.PI / 180 > BOX_ANGLE });
  }
  // what our lines lose: the edge across each mouth; everything across a crossing with arms on both sides
  const cuts = { left: [], right: [], all: [] };
  for (const m of mouths) (m.side > 0 ? cuts.left : cuts.right).push([m.from, m.to]);
  for (const m of mouths) {
    if (!m.crossing) continue;
    const other = mouths.find(o => o !== m && o.side !== m.side && o.crossing && Math.abs(o.s0 - m.s0) < BOX_PAIR_M);
    if (other && m.side > 0) cuts.all.push([Math.min(m.from, other.from), Math.max(m.to, other.to)]);
  }
  return { arms, cuts };
}

function densifyPts(pts, step) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let j = 0; j < n; j++) out.push([x0 + (x1 - x0) * j / n, y0 + (y1 - y0) * j / n]);
  }
  if (pts.length) out.push(pts[pts.length - 1]);
  return out;
}
