// The road reference placed from a map horizon (static/js/mapsurface.js): the map's shape, the car put on it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { POLY_MAX, lineAlong, mapReference } from '../../mapsurface.js';

const AXLE = 4.775 - 0.93;
const DEG = Math.PI / 180;

/** A horizon along a world-frame polyline, with the car at (0, 0) heading `h`. */
function mapOf(points, carIndex, way = { lanes: 2, oneWay: false }, conf = 1) {
  return { way, horizon: points, carIndex, conf, lateral: 0, coasting: false };
}
const roadModel = (y0, t = 0, k = 0, shown = true) => ({ anchor: { c: { y0, t, k }, offset: 0 }, shown, surface: { reveal: shown ? 1 : 0, left: 1.8, right: -1.8, reach: 80 } });
const straight = (from, to, step, y = 0) => { const pts = []; let ci = 0; for (let x = from; x <= to; x += step) { if (x === 0) ci = pts.length; pts.push([x, y]); } return [pts, ci]; };

describe('mapReference', () => {
  test('a straight road east with the car on it: stations from the bumper, map points carried into the car frame', () => {
    const [pts, ci] = straight(-60, 500, 20);
    const ref = mapReference(mapOf(pts, ci), { x: 0, y: 0, h: 0 }, roadModel(0), {}, AXLE);
    assert.ok(ref && ref.pts.length <= POLY_MAX && ref.pts.length > 10);
    for (let i = 1; i < ref.st.length; i++) assert.ok(ref.st[i] > ref.st[i - 1], 'stations ascend');
    const axle = ref.pts.find((p, i) => Math.abs(ref.st[i] + AXLE) < 0.05);
    assert.ok(axle && Math.abs(axle[0] + AXLE) < 0.05 && Math.abs(axle[1]) < 0.01, JSON.stringify(axle));
    assert.ok(Math.abs(ref.reach - (500 - AXLE)) < 0.1 && Math.abs(ref.back - (60 + AXLE)) < 0.1, `${ref.reach} ${ref.back}`);
    assert.equal(ref.width, null);
    assert.equal(ref.shifted, true);
    assert.equal(ref.shift, 0);
  });

  test('the lanes slide the whole map line onto the ego lane center; its shape is untouched', () => {
    // the map centerline runs at y = 1.5; the lane model says the ego lane center is at y = -0.5
    const [pts, ci] = straight(-60, 500, 20, 1.5);
    const ref = mapReference(mapOf(pts, ci), { x: 0, y: 0, h: 0 }, roadModel(-0.5), {}, AXLE);
    assert.ok(ref.pts.every(p => Math.abs(p[1] - (-0.5)) < 1e-9), 'every point moved by the same -2 m');
    assert.ok(Math.abs(ref.shift - (-2)) < 1e-9 && Math.abs(ref.centerY0 - (-0.5)) < 1e-9);
    // too far apart to be the same road: no slide
    const far = mapReference(mapOf(straight(-60, 500, 20, 9)[0], ci), { x: 0, y: 0, h: 0 }, roadModel(0), {}, AXLE);
    assert.equal(far.shift, 0);
  });

  test('a bend in the map is drawn as the map has it, right from the car', () => {
    const pts = []; let ci = 0;
    for (let x = -60; x <= 100; x += 20) { if (x === 0) ci = pts.length; pts.push([x, 0]); }
    for (let i = 1; i <= 20; i++) { const a = i * 0.05; pts.push([100 + 200 * Math.sin(a), 200 * (1 - Math.cos(a))]); }
    const ref = mapReference(mapOf(pts, ci), { x: 0, y: 0, h: 0 }, roadModel(0), {}, AXLE);
    const near = ref.pts.filter((p, i) => ref.st[i] >= 0 && ref.st[i] <= 90);
    assert.ok(near.every(p => Math.abs(p[1]) < 0.01), 'straight to the bend');
    const far = ref.pts[ref.pts.length - 1];
    assert.ok(far[1] > 50 && far[0] > 200, `bends left far out: ${far}`);
    assert.ok(ref.dense.xs.length > 100 && ref.dense.st[1] - ref.dense.st[0] <= 2.01, 'dense near sampling');
  });

  test('the lanes turn the map by a small, clamped, smoothed angle about the car', () => {
    const [pts, ci] = straight(-60, 500, 20);
    // the lanes run 2 deg left of the map line: with no smoothing state the turn is applied at once
    const t2 = Math.tan(2 * DEG);
    const ref = mapReference(mapOf(pts, ci), { x: 0, y: 0, h: 0 }, roadModel(0, t2), {}, AXLE);
    assert.ok(Math.abs(ref.rotated - 2 * DEG) < 1e-9);
    const last = ref.pts[ref.pts.length - 1];
    assert.ok(Math.abs(Math.atan2(last[1], last[0]) - 2 * DEG) < 0.002, `rotated about the car: ${last}`);
    // clamped at 4 deg
    const big = mapReference(mapOf(pts, ci), { x: 0, y: 0, h: 0 }, roadModel(0, Math.tan(10 * DEG)), {}, AXLE);
    assert.ok(Math.abs(big.rotated - 4 * DEG) < 1e-9);
    // smoothed when a state is kept: a frame moves part of the way
    const align = { dh: 0 };
    const step = mapReference(mapOf(pts, ci), { x: 0, y: 0, h: 0 }, roadModel(0, t2), {}, AXLE, align, 0.1);
    assert.ok(step.rotated > 0.05 * 2 * DEG && step.rotated < 0.2 * 2 * DEG, String(step.rotated / DEG));
    for (let i = 0; i < 100; i++) mapReference(mapOf(pts, ci), { x: 0, y: 0, h: 0 }, roadModel(0, t2), {}, AXLE, align, 0.1);
    assert.ok(Math.abs(align.dh - 2 * DEG) < 0.01 * DEG);
  });

  test('without lanes the map alone gives the carriageway width, reveal and lane structure; a two-way road leans on driving in the right half', () => {
    const [pts, ci] = straight(-60, 300, 20, 1.0);   // the map centerline 1 m left of the car (GPS); the right half's center would be 1.8 m left
    const twoWay = mapReference(mapOf(pts, ci, { lanes: 2, oneWay: false }, 0.9), { x: 0, y: 0, h: 0 }, roadModel(0, 0, 0, false), {}, AXLE);
    assert.deepEqual(twoWay.width, [-3.6, 3.6]);
    assert.ok(Math.abs(twoWay.reveal - 0.9) < 1e-9 && twoWay.shifted === false && twoWay.rotated === 0);
    assert.ok(Math.abs(twoWay.shift - 0.7 * 0.8) < 1e-9, String(twoWay.shift));   // 70% of the way to the prior
    assert.ok(twoWay.pts.every(p => Math.abs(p[1] - 1.56) < 1e-9));
    assert.deepEqual(twoWay.structure.map(l => [l.d, l.kind]), [[0, 'center'], [3.6, 'edge'], [-3.6, 'edge']]);
    const oneWay = mapReference(mapOf(pts, ci, { lanes: 3, oneWay: true }, 1), { x: 0, y: 0, h: 0 }, roadModel(0, 0, 0, false), {}, AXLE);
    assert.deepEqual(oneWay.width, [-5.4, 5.4]);
    assert.equal(oneWay.shift, 0);   // one-way: the GPS alone
    assert.deepEqual(oneWay.structure.map(l => [+l.d.toFixed(2), l.kind]), [[-1.8, 'lane'], [1.8, 'lane'], [5.4, 'edge'], [-5.4, 'edge']]);
    assert.equal(mapReference(mapOf(pts, ci), { x: 0, y: 0, h: 0 }, roadModel(0), { mapRoad: false }, AXLE), null);
    // the slide toward the prior is slow when a state is kept
    const align = { dh: 0, shift: 0 };
    const step = mapReference(mapOf(pts, ci, { lanes: 2, oneWay: false }, 0.9), { x: 0, y: 0, h: 0 }, roadModel(0, 0, 0, false), {}, AXLE, align, 0.1);
    assert.ok(step.shift > 0.02 && step.shift < 0.06, String(step.shift));
    // a road that ends fades short
    const ended = mapReference({ ...mapOf(pts, ci), ended: true }, { x: 0, y: 0, h: 0 }, roadModel(0), {}, AXLE);
    assert.ok(ended.fade < 20);
  });

  test('the car heading north: the frame turns with it', () => {
    const pts = []; let ci = 0;
    for (let y = -60; y <= 300; y += 20) { if (y === 0) ci = pts.length; pts.push([0, y]); }
    const ref = mapReference(mapOf(pts, ci), { x: 0, y: 0, h: Math.PI / 2 }, roadModel(0), {}, AXLE);
    const far = ref.pts[ref.pts.length - 1];
    assert.ok(far[0] > 250 && Math.abs(far[1]) < 0.01, `ahead along x in the car frame: ${far}`);
  });

  test('lineAlong: lines are parallel offsets of the map line at the distances measured at the car', () => {
    const pts = []; let ci = 0;
    for (let x = -60; x <= 100; x += 20) { if (x === 0) ci = pts.length; pts.push([x, 0]); }
    for (let i = 1; i <= 10; i++) { const a = i * 0.05; pts.push([100 + 200 * Math.sin(a), 200 * (1 - Math.cos(a))]); }
    const ref = mapReference(mapOf(pts, ci), { x: 0, y: 0, h: 0 }, roadModel(0), {}, AXLE);
    const inferred = lineAlong(ref, null, 1.8);
    const measured = lineAlong(ref, { y0: -1.8, t: Math.tan(3 * DEG), k: 0.01 });   // its own heading and curvature don't matter
    assert.equal(inferred.length, ref.dense.xs.length);
    for (let i = 0; i < inferred.length; i++) {
      const cx = ref.dense.xs[i], cy = ref.dense.ys[i];
      assert.ok(Math.abs(Math.hypot(inferred[i][0] - cx, inferred[i][1] - cy) - 1.8) < 1e-6, 'inferred stays 1.8 m off the center');
      assert.ok(Math.abs(Math.hypot(measured[i][0] - cx, measured[i][1] - cy) - 1.8) < 1e-6, 'measured stays 1.8 m off the center');
    }
    const straightPart = inferred.filter((p, i) => ref.dense.st[i] > 0 && ref.dense.st[i] < 90);
    assert.ok(straightPart.every(p => Math.abs(p[1] - 1.8) < 1e-6));
    assert.ok(measured[measured.length - 1][1] < inferred[inferred.length - 1][1], 'the right line stays right through the bend');
  });
});

describe('mapReference branches', () => {
  test('branches come into the car frame with the same placement, with the map width', () => {
    const pts = []; let ci = 0;
    for (let x = -60; x <= 300; x += 20) { if (x === 0) ci = pts.length; pts.push([x, 1.5]); }   // the map line 1.5 m left of the car
    const map = { way: { lanes: 2, oneWay: false }, horizon: pts, carIndex: ci, conf: 1, lateral: -1.5, coasting: false,
      branches: [{ x: 100, y: 1.5, along: 100, angle: 90, name: 'Side Road', lanes: 0, oneWay: false, className: 'residential', pts: [[100, 1.5], [100, 31.5], [100, 61.5]] },
                 { x: 200, y: 1.5, along: 200, angle: -30, name: 'Ramp', lanes: 1, oneWay: true, className: 'motorway_link', pts: [[200, 1.5], [252, -28.5]] }] };
    const AX = 4.775 - 0.93;
    // lanes shown with the ego lane center at y = -0.5: the whole map slides by -2, branches with it
    const ref = mapReference(map, { x: 0, y: 0, h: 0 }, { anchor: { c: { y0: -0.5, t: 0, k: 0 }, offset: 0 }, shown: true, surface: { reveal: 1, left: 1.8, right: -1.8, reach: 80 } }, {}, AX);
    assert.equal(ref.branches.length, 2);
    const side = ref.branches[0];
    assert.ok(Math.abs(side.pts[0][0] - (100 - AX)) < 1e-6 && Math.abs(side.pts[0][1] - (-0.5)) < 1e-6, `starts on the shifted line: ${side.pts[0]}`);
    assert.ok(Math.abs(side.pts[2][1] - 59.5) < 1e-6, 'runs off to the left');
    assert.equal(side.width, 7.2);
    assert.equal(ref.branches[1].width, 3.6);
    assert.equal(ref.lanes, 2);
    // the car heading north: a branch east of a north-south road is to the right
    const north = []; let cn = 0;
    for (let y = -60; y <= 300; y += 20) { if (y === 0) cn = north.length; north.push([0, y]); }
    const map2 = { ...map, horizon: north, carIndex: cn, branches: [{ x: 0, y: 100, along: 100, angle: -90, name: 'East', lanes: 2, oneWay: false, className: 'residential', pts: [[0, 100], [40, 100]] }] };
    const ref2 = mapReference(map2, { x: 0, y: 0, h: Math.PI / 2 }, { anchor: { c: { y0: 0, t: 0, k: 0 }, offset: 0 }, shown: true, surface: { reveal: 1, left: 1.8, right: -1.8, reach: 80 } }, {}, AX);
    const east = ref2.branches[0];
    assert.ok(Math.abs(east.pts[1][0] - (100 - AX)) < 1e-6 && Math.abs(east.pts[1][1] - (-40)) < 1e-6, `to the right in the car frame: ${east.pts[1]}`);
  });
});

describe('junctions', async () => {
  const { junctions, cutByStations } = await import('../../mapsurface.js');
  const AX = 4.775 - 0.93;
  const roadShown = { anchor: { c: { y0: 0, t: 0, k: 0 }, offset: 0 }, shown: true, surface: { reveal: 1, left: 1.8, right: -1.8, reach: 80 } };
  /** A straight road east; the car at the origin; arms given in world = car frame terms (pose at the origin heading east). */
  function refWith(branches, way = { lanes: 2, oneWay: false }) {
    const pts = []; let ci = 0;
    for (let x = -60; x <= 600; x += 20) { if (x === 0) ci = pts.length; pts.push([x, 0]); }
    return mapReference({ way, horizon: pts, carIndex: ci, conf: 1, lateral: 0, coasting: false, branches }, { x: 0, y: 0, h: 0 }, roadShown, {}, AX);
  }
  const hm = { left: 3.6, right: 3.6 };

  test('a perpendicular side street: fillets meet our edge, our edge opens across the mouth, the arm is a strip', () => {
    // a two-way residential street leaving to the left at x = 100 (world), 7.2 m wide
    const ref = refWith([{ x: 100, y: 0, along: 100 + AX, angle: 90, name: 'Side', lanes: 2, oneWay: false, className: 'residential', pts: [[100, 0], [100, 30], [100, 60]] }]);
    const jn = junctions(ref, hm);
    assert.equal(jn.arms.length, 1);
    const arm = jn.arms[0];
    assert.equal(arm.side, 1);
    assert.equal(jn.cuts.right.length, 0);
    assert.equal(jn.cuts.left.length, 1);
    const [c0, c1] = jn.cuts.left[0];
    // the mouth: half the arm (3.6) plus the fillets' tangent length (R_RIGHT / tan 45 = 6) each way, about the junction station
    const sJ = 100 - AX;
    assert.ok(Math.abs(c0 - (sJ - 3.6 - 6)) < 0.3 && Math.abs(c1 - (sJ + 3.6 + 6)) < 0.3, `${c0} ${c1} vs ${sJ}`);
    assert.equal(jn.cuts.all.length, 0);   // one-sided: our lanes carry on
    // each fillet starts on our edge (y = 3.6) and ends on the arm's edge (x = 100 - AX +- 3.6)
    for (const arc of arm.arcs) {
      assert.ok(Math.abs(arc[0][1] - 3.6) < 1e-6, `starts on our edge: ${arc[0]}`);
      const end = arc[arc.length - 1];
      assert.ok(Math.abs(Math.abs(end[0] - (100 - AX)) - 3.6) < 1e-6 && end[1] > 3.6 + 5, `ends on the arm's edge: ${end}`);
    }
    assert.equal(arm.strip.left.length, arm.strip.right.length);
    assert.ok(arm.center && arm.center.length >= 2 && arm.center[0][1] > 3.6 + 1.5, 'the centerline starts past the mouth');
    assert.ok(arm.edges.every(e => e.length >= 2));
  });

  test('a crossing (arms both sides at the same station) cuts every line of ours across the box', () => {
    const ref = refWith([
      { x: 100, y: 0, along: 100 + AX, angle: 90, name: 'Cross', lanes: 2, oneWay: false, className: 'residential', pts: [[100, 0], [100, 40]] },
      { x: 100, y: 0, along: 100 + AX, angle: -90, name: 'Cross', lanes: 2, oneWay: false, className: 'residential', pts: [[100, 0], [100, -40]] },
    ]);
    const jn = junctions(ref, hm);
    assert.equal(jn.arms.length, 2);
    assert.equal(jn.cuts.all.length, 1);
    const [a, b] = jn.cuts.all[0];
    assert.ok(a < 100 - AX - 5 && b > 100 - AX + 5);
    // cutting a line of ours by those stations leaves the parts before and after
    const line = ref.dense.xs.map((x, i) => [x, ref.dense.ys[i]]);
    const parts = cutByStations(line, ref.dense.st, jn.cuts.all);
    assert.equal(parts.length, 2);
    assert.ok(parts[0][parts[0].length - 1][0] < 100 - AX && parts[1][0][0] > 100 - AX);
  });

  test('a shallow exit: a long gore on the downstream corner, no box, our lanes untouched', () => {
    const th = -15 * Math.PI / 180;
    const ramp = { x: 200, y: 0, along: 200 + AX, angle: -15, name: '', lanes: 1, oneWay: true, className: 'motorway_link',
      pts: [[200, 0], [200 + 40 * Math.cos(th), 40 * Math.sin(th)], [200 + 80 * Math.cos(th), 80 * Math.sin(th)]] };
    const ref = refWith([ramp], { lanes: 2, oneWay: true });
    const jn = junctions(ref, hm);
    assert.equal(jn.arms.length, 1);
    assert.equal(jn.cuts.all.length, 0);
    assert.equal(jn.cuts.left.length, 0);
    const [c0, c1] = jn.cuts.right[0];
    assert.ok(c1 - c0 > 25 && c1 - c0 < 70, `a long opening: ${c1 - c0}`);   // the gore taper plus the ramp's crossing of our edge
    assert.equal(jn.arms[0].center, null);   // one lane, one way: no markings of its own
  });

  test('an arm running alongside is left alone; one behind the car is skipped', () => {
    const ref = refWith([
      { x: 100, y: 0, along: 100 + AX, angle: 2, name: 'Frontage', lanes: 1, oneWay: true, className: 'service', pts: [[100, 0], [160, 2]] },
      { x: -40, y: 0, along: -40 + AX, angle: 90, name: 'Behind', lanes: 2, oneWay: false, className: 'residential', pts: [[-40, 0], [-40, 40]] },
    ]);
    const jn = junctions(ref, hm);
    assert.equal(jn.arms.length, 0);
  });
});
