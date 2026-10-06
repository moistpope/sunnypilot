// The road reference placed from a map horizon (static/js/mapsurface.js): the map's shape, the car put in a lane on it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { POLY_MAX, lineAlong, mapReference, mapRoadFrame, mapAlignMatrix, laneCenters, freshPlacement, placeInLane } from '../../mapsurface.js';

const AXLE = 4.775 - 0.93;
const DEG = Math.PI / 180;

/** A horizon along a world-frame polyline, with the car at (0, 0) heading `h`. */
function mapOf(points, carIndex, way = { lanes: 2, oneWay: false }, conf = 1) {
  return { way, horizon: points, carIndex, conf, lateral: 0, coasting: false };
}
/** The cameras' road model output: the ego lane's center `y0` m left of the car, its heading slope t. */
const roadModel = (y0, t = 0, k = 0, shown = true) => ({ anchor: { c: { y0, t, k }, offset: 0 }, shown, surface: { reveal: shown ? 1 : 0, left: 1.8, right: -1.8, reach: 80 } });
const straight = (from, to, step, y = 0) => { const pts = []; let ci = 0; for (let x = from; x <= to; x += step) { if (x === 0) ci = pts.length; pts.push([x, y]); } return [pts, ci]; };
// a two-way two-lane road: the car drawn in the right lane has the centerline 1.8 m to its left when the ego lane's
// center is at the car; with the ego lane's center 1.8 m to the right of the car (the car on the centerline), the
// centerline is drawn through the car: y = 0 in the car frame, which keeps the geometry tests simple
const onCenter = roadModel(-1.8);

describe('laneCenters', () => {
  test('rightmost first, m left of the centerline; a center turn lane on an odd count; one-way across the whole width', () => {
    const near = (a, b) => assert.deepEqual(a.map(v => +v.toFixed(6)), b);
    near(laneCenters(2, false), [-1.8]);
    near(laneCenters(4, false), [-5.4, -1.8]);
    near(laneCenters(3, false), [-3.6]);               // one lane each way beside a turn lane
    near(laneCenters(5, false, 3.0), [-6, -3]);
    near(laneCenters(1, true), [0]);
    near(laneCenters(3, true), [-3.6, 0, 3.6]);
  });
});

describe('mapReference', () => {
  test('a straight road east with the car on it: stations from the bumper, map points carried into the car frame, the car in the right lane', () => {
    const [pts, ci] = straight(-60, 500, 20);
    const ref = mapReference(mapOf(pts, ci), { x: 0, y: 0, h: 0 }, roadModel(0), {}, AXLE);
    assert.ok(ref && ref.pts.length <= POLY_MAX && ref.pts.length > 10);
    for (let i = 1; i < ref.st.length; i++) assert.ok(ref.st[i] > ref.st[i - 1], 'stations ascend');
    const axle = ref.pts.find((p, i) => Math.abs(ref.st[i] + AXLE) < 0.05);
    assert.ok(axle && Math.abs(axle[0] + AXLE) < 0.05, JSON.stringify(axle));
    assert.ok(Math.abs(ref.reach - (500 - AXLE)) < 0.1 && Math.abs(ref.back - (60 + AXLE)) < 0.1, `${ref.reach} ${ref.back}`);
    assert.deepEqual(ref.width, [-3.6, 3.6]);
    // the ego lane's center is at the car: the right lane's center, 1.8 m right of the centerline, so the centerline
    // is drawn 1.8 m left of the car
    assert.equal(ref.lane, 0);
    assert.ok(Math.abs(ref.centerY0 - 1.8) < 1e-9 && Math.abs(ref.shift - 1.8) < 1e-9, `${ref.centerY0} ${ref.shift}`);
    assert.ok(ref.pts.every(p => Math.abs(p[1] - 1.8) < 1e-9));
    // the structure: the centerline is the ego lane's left line, the right edge its right line
    assert.deepEqual(ref.structure.map(l => [l.d, l.kind, l.ego]), [[0, 'center', 'L1'], [3.6, 'edge', null], [-3.6, 'edge', 'R1']]);
    assert.ok(Math.abs(ref.laneCenter + 1.8) < 1e-9 && ref.ourLeft === 0 && ref.ourRight === -3.6);
  });

  test('the lanes choose the lane and slide the whole map so its center is at the ego lane center; the shape is untouched', () => {
    // the map centerline runs at y = 1.5 (the pose says the car is 1.5 m right of it); the lane model says the ego
    // lane's center is 0.5 m right of the car: the right lane's center is drawn there, so the centerline at 1.3
    const [pts, ci] = straight(-60, 500, 20, 1.5);
    const ref = mapReference(mapOf(pts, ci), { x: 0, y: 0, h: 0 }, roadModel(-0.5), {}, AXLE);
    assert.equal(ref.lane, 0);
    assert.ok(ref.pts.every(p => Math.abs(p[1] - 1.3) < 1e-9), 'every point moved by the same -0.2 m');
    assert.ok(Math.abs(ref.shift - (-0.2)) < 1e-9 && Math.abs(ref.centerY0 - 1.3) < 1e-9);
    // a four-lane road with the pose 3 m right of the centerline: the inner of our two lanes (1.8) is nearer than the outer (5.4)
    const [pts4, ci4] = straight(-60, 500, 20, 3);
    const four = mapReference(mapOf(pts4, ci4, { lanes: 4, oneWay: false }), { x: 0, y: 0, h: 0 }, roadModel(0), {}, AXLE);
    assert.equal(four.lane, 1);
    assert.ok(Math.abs(four.centerY0 - 1.8) < 1e-9, String(four.centerY0));
    assert.deepEqual(four.structure.filter(l => l.ego).map(l => [l.d, l.ego]), [[0, 'L1'], [-3.6, 'R1']]);
    // far apart (the map 12 m left of the car): still slid, continuously, up to the limit
    const far = mapReference(mapOf(straight(-60, 500, 20, 12)[0], ci), { x: 0, y: 0, h: 0 }, roadModel(0), {}, AXLE);
    assert.ok(Math.abs(far.shift - (1.8 - 12)) < 1e-9, String(far.shift));
  });

  test('a bend in the map is drawn as the map has it, right from the car', () => {
    const pts = []; let ci = 0;
    for (let x = -60; x <= 100; x += 20) { if (x === 0) ci = pts.length; pts.push([x, 0]); }
    for (let i = 1; i <= 20; i++) { const a = i * 0.05; pts.push([100 + 200 * Math.sin(a), 200 * (1 - Math.cos(a))]); }
    const ref = mapReference(mapOf(pts, ci), { x: 0, y: 0, h: 0 }, onCenter, {}, AXLE);
    const near = ref.pts.filter((p, i) => ref.st[i] >= 0 && ref.st[i] <= 90);
    assert.ok(near.every(p => Math.abs(p[1]) < 0.01), 'straight to the bend');
    const far = ref.pts[ref.pts.length - 1];
    assert.ok(far[1] > 50 && far[0] > 200, `bends left far out: ${far}`);
    assert.ok(ref.dense.xs.length > 100 && ref.dense.st[1] - ref.dense.st[0] <= 2.01, 'dense near sampling');
  });

  test('the lanes never turn the map: the pose heading places its direction, however the lane lines run', () => {
    const [pts, ci] = straight(-60, 500, 20);
    const ref = mapReference(mapOf(pts, ci), { x: 0, y: 0, h: 0 }, roadModel(-1.8, Math.tan(10 * DEG)), {}, AXLE);
    assert.equal(ref.rotated, 0);
    const last = ref.pts[ref.pts.length - 1];
    assert.ok(Math.abs(last[1]) < 1e-9, `straight on in the car frame: ${last}`);
    const place = freshPlacement();
    for (let i = 0; i < 100; i++) mapReference(mapOf(pts, ci), { x: 0, y: 0, h: 0 }, roadModel(-1.8, Math.tan(10 * DEG)), {}, AXLE, place, 0.1);
    assert.equal(place.dh, 0);
  });

  test('a disagreement past the limit holds the slide at the limit rather than letting go', () => {
    const [pts, ci] = straight(-60, 500, 20, 20);   // the map 20 m left of the car
    const ref = mapReference(mapOf(pts, ci), { x: 0, y: 0, h: 0 }, roadModel(0), {}, AXLE);
    assert.ok(Math.abs(ref.shift - (-12)) < 1e-9, String(ref.shift));
    assert.ok(Math.abs(ref.centerY0 - 8) < 1e-9);
  });

  test('without lanes the car keeps to the right lane of a two-way road, the nearest lane of a one-way one; the slide is slow', () => {
    const [pts, ci] = straight(-60, 300, 20, 1.0);   // the map centerline 1 m left of the car by the pose
    const twoWay = mapReference(mapOf(pts, ci, { lanes: 2, oneWay: false }), { x: 0, y: 0, h: 0 }, roadModel(0, 0, 0, false), {}, AXLE, null, 1 / 60, 0.9);
    assert.deepEqual(twoWay.width, [-3.6, 3.6]);
    assert.ok(Math.abs(twoWay.reveal - 0.9) < 1e-9 && twoWay.lanesShown === false && twoWay.rotated === 0);
    assert.equal(twoWay.lane, 0);
    assert.ok(Math.abs(twoWay.shift - 0.8) < 1e-9 && Math.abs(twoWay.centerY0 - 1.8) < 1e-9, String(twoWay.shift));   // centered in the right lane
    assert.deepEqual(twoWay.structure.map(l => [l.d, l.kind]), [[0, 'center'], [3.6, 'edge'], [-3.6, 'edge']]);
    const oneWay = mapReference(mapOf(pts, ci, { lanes: 3, oneWay: true }), { x: 0, y: 0, h: 0 }, roadModel(0, 0, 0, false), {}, AXLE);
    assert.deepEqual(oneWay.width, [-5.4, 5.4]);
    assert.equal(oneWay.lane, 1);   // the middle lane is the nearest to where the pose puts us
    assert.ok(Math.abs(oneWay.shift + 1) < 1e-9 && Math.abs(oneWay.centerY0) < 1e-9);
    assert.deepEqual(oneWay.structure.map(l => [+l.d.toFixed(2), l.kind, l.ego]), [[-1.8, 'lane', 'R1'], [1.8, 'lane', 'L1'], [5.4, 'edge', null], [-5.4, 'edge', null]]);
    assert.equal(mapReference(mapOf(pts, ci), { x: 0, y: 0, h: 0 }, roadModel(0), { mapRoad: false }, AXLE), null);
    // with a state the slide is rate-limited (0.4 m/s)
    const place = freshPlacement();
    const step = mapReference(mapOf(pts, ci, { lanes: 2, oneWay: false }), { x: 0, y: 0, h: 0 }, roadModel(0, 0, 0, false), {}, AXLE, place, 0.1);
    assert.ok(Math.abs(step.shift - 0.04) < 1e-9, String(step.shift));
    // a road that ends fades short
    const ended = mapReference({ ...mapOf(pts, ci), ended: true }, { x: 0, y: 0, h: 0 }, roadModel(0), {}, AXLE);
    assert.ok(ended.fade < 20);
  });

  test('the car heading north: the frame turns with it', () => {
    const pts = []; let ci = 0;
    for (let y = -60; y <= 300; y += 20) { if (y === 0) ci = pts.length; pts.push([0, y]); }
    const ref = mapReference(mapOf(pts, ci), { x: 0, y: 0, h: Math.PI / 2 }, onCenter, {}, AXLE);
    const far = ref.pts[ref.pts.length - 1];
    assert.ok(far[0] > 250 && Math.abs(far[1]) < 0.01, `ahead along x in the car frame: ${far}`);
  });

  test('lineAlong: lines are parallel offsets of the map line at the distances measured at the car', () => {
    const pts = []; let ci = 0;
    for (let x = -60; x <= 100; x += 20) { if (x === 0) ci = pts.length; pts.push([x, 0]); }
    for (let i = 1; i <= 10; i++) { const a = i * 0.05; pts.push([100 + 200 * Math.sin(a), 200 * (1 - Math.cos(a))]); }
    const ref = mapReference(mapOf(pts, ci), { x: 0, y: 0, h: 0 }, onCenter, {}, AXLE);
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

  test('the station origin is the car itself, not the matched point: a pose that moved on still puts the bumper at 0', () => {
    const [pts, ci] = straight(-60, 500, 20);
    // the matcher's point (carIndex) is 3 m behind where the pose is now
    const ref = mapReference(mapOf(pts, ci), { x: 3, y: 0, h: 0 }, onCenter, {}, AXLE);
    for (let i = 0; i < ref.pts.length; i++) assert.ok(Math.abs(ref.st[i] - ref.pts[i][0]) < 1e-6, `station = x ahead of the bumper at ${i}: ${ref.st[i]} vs ${ref.pts[i][0]}`);
  });
});

describe('placeInLane', () => {
  const frame = (yMap0, lanes = 4, oneWay = false) => ({ yMap0, hMap: 0, lanes, oneWay, wayId: 1 });
  test('a lane change moves the lane index, not the map', () => {
    const place = freshPlacement();
    // four lanes two-way: ours at -5.4 (right) and -1.8; the car centered in the right lane, the centerline 5.4 m left
    let r = placeInLane(place, frame(5.4), roadModel(0), 1 / 20);
    assert.equal(r.lane, 0);
    for (let i = 0; i < 100; i++) r = placeInLane(place, frame(5.4), roadModel(0), 1 / 20);
    assert.ok(Math.abs(r.shift) < 1e-6, String(r.shift));
    // the car moves 3.6 m left: just before the cameras flip the ego lane, its center is 3.6 m to the right
    r = placeInLane(place, frame(1.8), roadModel(-3.6), 1 / 20);
    assert.equal(r.lane, 0);
    assert.ok(Math.abs(r.shift) < 1e-6, 'nothing to slide: the car moved, the map did not');
    // the flip: the new ego lane's center is at the car
    r = placeInLane(place, frame(1.8), roadModel(0), 1 / 20);
    assert.equal(r.lane, 1);
    assert.ok(Math.abs(r.shift) < 1e-6, String(r.shift));
    assert.ok(Math.abs(r.laneCenter + 1.8) < 1e-9);
  });

  test('the GPS alone insisting we are a lane over moves the drawn lane only after seconds; a brief disagreement does not', () => {
    const place = freshPlacement();
    const noLanes = roadModel(0, 0, 0, false);
    let r = placeInLane(place, frame(1.8, 2, true), noLanes, 0.1);   // one-way, two lanes: the pose has us in the right one
    assert.equal(r.lane, 0);
    for (let i = 0; i < 30; i++) r = placeInLane(place, frame(-1.8, 2, true), noLanes, 0.1);   // 3 s of "you are in the left lane"
    assert.equal(r.lane, 0);
    for (let i = 0; i < 25; i++) r = placeInLane(place, frame(-1.8, 2, true), noLanes, 0.1);   // past 5 s
    assert.equal(r.lane, 1);
    // the slide toward the new lane is rate-limited: nothing jumps
    let prev = r.shift;
    for (let i = 0; i < 20; i++) { r = placeInLane(place, frame(-1.8, 2, true), noLanes, 0.1); assert.ok(Math.abs(r.shift - prev) <= 0.04 + 1e-9); prev = r.shift; }
  });

});

describe('mapRoadFrame', () => {
  test('places s down the road and d left of the ego lane center; lane edges from our carriageway bounds', () => {
    const [pts, ci] = straight(-60, 300, 20);
    const ref = mapReference(mapOf(pts, ci), { x: 0, y: 0, h: 0 }, onCenter, {}, AXLE);   // the centerline through the car, lane center 1.8 m right
    const fr = mapRoadFrame(ref, 123);
    assert.equal(fr.odo, 123);
    const p = fr.place(10, 0);
    assert.ok(Math.abs(p.x - 10) < 1e-6 && Math.abs(p.y + 1.8) < 1e-6 && Math.abs(p.h) < 1e-9, JSON.stringify(p));
    assert.ok(Math.abs(fr.place(10, 1).y - (-0.8)) < 1e-6);
    assert.ok(Math.abs(fr.laneEdge(-1) + 1.8) < 1e-9 && Math.abs(fr.laneEdge(1) - 1.8) < 1e-9);
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
    // lanes shown with the ego lane center at y = -0.5: the map slides by -0.2 (see above), branches with it
    const ref = mapReference(map, { x: 0, y: 0, h: 0 }, roadModel(-0.5), {}, AX);
    assert.equal(ref.branches.length, 2);
    const side = ref.branches[0];
    assert.ok(Math.abs(side.pts[0][0] - (100 - AX)) < 1e-6 && Math.abs(side.pts[0][1] - 1.3) < 1e-6, `starts on the shifted line: ${side.pts[0]}`);
    assert.ok(Math.abs(side.pts[2][1] - 61.3) < 1e-6, 'runs off to the left');
    assert.equal(side.width, 7.2);
    assert.equal(ref.branches[1].width, 3.6);
    assert.equal(ref.lanes, 2);
    // the car heading north: a branch east of a north-south road is to the right
    const north = []; let cn = 0;
    for (let y = -60; y <= 300; y += 20) { if (y === 0) cn = north.length; north.push([0, y]); }
    const map2 = { ...map, horizon: north, carIndex: cn, branches: [{ x: 0, y: 100, along: 100, angle: -90, name: 'East', lanes: 2, oneWay: false, className: 'residential', pts: [[0, 100], [40, 100]] }] };
    const ref2 = mapReference(map2, { x: 0, y: 0, h: Math.PI / 2 }, onCenter, {}, AX);
    const east = ref2.branches[0];
    assert.ok(Math.abs(east.pts[1][0] - (100 - AX)) < 1e-6 && Math.abs(east.pts[1][1] - (-40)) < 1e-6, `to the right in the car frame: ${east.pts[1]}`);
  });
});

describe('junctions', async () => {
  const { junctions, cutByStations } = await import('../../mapsurface.js');
  const AX = 4.775 - 0.93;
  /** A straight road east; the car at the origin; arms given in world = car frame terms (pose at the origin heading east). */
  function refWith(branches, way = { lanes: 2, oneWay: false }) {
    const pts = []; let ci = 0;
    for (let x = -60; x <= 600; x += 20) { if (x === 0) ci = pts.length; pts.push([x, 0]); }
    // the ego lane's center where it puts the reference line through the car: 1.8 m right on a two-way road, the
    // middle lane of a one-way one
    const road = way.oneWay ? roadModel(way.lanes % 2 ? 0 : -1.8) : onCenter;
    return mapReference({ way, horizon: pts, carIndex: ci, conf: 1, lateral: 0, coasting: false, branches }, { x: 0, y: 0, h: 0 }, road, {}, AX);
  }
  const hm = { left: 3.6, right: 3.6 };

  test('a perpendicular side street: fillets meet our edge, our edge opens across the mouth, the arm is a strip', () => {
    // a two-way residential street leaving to the left at x = 100 (world), 7.2 m wide
    const ref = refWith([{ x: 100, y: 0, along: 100 + AX, angle: 90, name: 'Side', lanes: 2, oneWay: false, className: 'residential', pts: [[100, 0], [100, 30], [100, 60]] }]);
    assert.ok(Math.abs(ref.centerY0) < 1e-9, 'the reference line runs through the car');
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
    assert.ok(Math.abs(ref.centerY0) < 1e-9, String(ref.centerY0));
    const jn = junctions(ref, hm);
    assert.equal(jn.arms.length, 1);
    assert.equal(jn.cuts.all.length, 0);
    assert.equal(jn.cuts.left.length, 0);
    const [c0, c1] = jn.cuts.right[0];
    assert.ok(c1 - c0 > 25 && c1 - c0 < 70, `a long opening: ${c1 - c0}`);   // the gore taper plus the ramp's crossing of our edge
    assert.equal(jn.arms[0].center, null);   // one lane, one way: no markings of its own
  });

  test('at a T where our road ends, an arm has one real corner: a fillet on our side, its far edge straight from the node', () => {
    const pts = []; let ci = 0;
    for (let x = -60; x <= 100; x += 20) { if (x === 0) ci = pts.length; pts.push([x, 0]); }
    for (let y = 20; y <= 300; y += 20) pts.push([100, y]);   // the horizon turns left (north) at x = 100: our road ends there
    const branches = [
      { x: 100, y: 0, along: 100 + AX, angle: -90, name: 'Right', lanes: 2, oneWay: false, className: 'residential', pts: [[100, 0], [100, -30], [100, -60]], end: true },
      { x: 100, y: 0, along: 100 + AX, angle: 90, name: 'Left', lanes: 2, oneWay: false, className: 'residential', pts: [[100, 0], [100, 30], [100, 60]], end: true, continuation: true },
    ];
    const ref = mapReference({ way: { lanes: 2, oneWay: false }, horizon: pts, carIndex: ci, conf: 1, lateral: 0, coasting: false, branches }, { x: 0, y: 0, h: 0 }, onCenter, {}, AX);
    const jn = junctions(ref, hm);
    assert.equal(jn.arms.length, 2);
    for (const arm of jn.arms) {
      assert.equal(arm.arcs.length, 1, `${arm.name}: one fillet`);
      const T1 = arm.arcs[0][0];
      assert.ok(T1[0] < 100 - AX && Math.abs(Math.abs(T1[1]) - 3.6) < 1e-6, `${arm.name}: starts on our edge before the node: ${T1}`);
      // the far bound runs straight along the arm's far edge from the node (x = 100 - AX +- 3.6)
      const far = arm.strip[arm.side > 0 ? 'right' : 'left'];
      assert.ok(far.every(p => Math.abs(Math.abs(p[0] - (100 - AX)) - 3.6) < 1e-6), `${arm.name}: far edge straight: ${far[0]} ${far[far.length - 1]}`);
    }
    // our edge opens from the fillet to the node, not beyond
    assert.ok(jn.cuts.right[0][1] < 100 - AX + 1 && jn.cuts.left[0][1] < 100 - AX + 1, JSON.stringify(jn.cuts));
  });

  test('an arm running alongside is left alone; one just behind the car keeps its fillets, one far behind is dropped', () => {
    const ref = refWith([
      { x: 100, y: 0, along: 100 + AX, angle: 2, name: 'Frontage', lanes: 1, oneWay: true, className: 'service', pts: [[100, 0], [160, 2]] },
      { x: -40, y: 0, along: -40 + AX, angle: 90, name: 'Behind', lanes: 2, oneWay: false, className: 'residential', pts: [[-40, 0], [-40, 40]] },
      { x: -80, y: 0, along: -80 + AX, angle: 90, name: 'Gone', lanes: 2, oneWay: false, className: 'residential', pts: [[-80, 0], [-80, 40]] },
    ]);
    const jn = junctions(ref, hm);
    assert.deepEqual(jn.arms.map(a => a.name), ['Behind']);
    assert.ok(jn.arms[0].s0 < -30 && jn.arms[0].s0 > -50, String(jn.arms[0].s0));
  });

  test('the fillets hang off the node as a vertex of the reference and its arriving segment, not the resampled line', () => {
    // a road that bends 20 deg at the node where the side street leaves: the arm is measured against the segment we arrive on
    const pts = []; let ci = 0;
    for (let x = -60; x <= 100; x += 20) { if (x === 0) ci = pts.length; pts.push([x, 0]); }
    const th = 20 * Math.PI / 180;
    for (let d = 20; d <= 300; d += 20) pts.push([100 + d * Math.cos(th), d * Math.sin(th)]);
    const branches = [{ x: 100, y: 0, along: 100 + AX, angle: -90, name: 'Side', lanes: 2, oneWay: false, className: 'residential', pts: [[100, 0], [100, -30], [100, -60]] }];
    const ref = mapReference({ way: { lanes: 2, oneWay: false }, horizon: pts, carIndex: ci, conf: 1, lateral: 0, coasting: false, branches }, { x: 0, y: 0, h: 0 }, onCenter, {}, AX);
    const jn = junctions(ref, hm);
    assert.equal(jn.arms.length, 1);
    const arm = jn.arms[0];
    assert.ok(Math.abs(arm.s0 - (100 - AX)) < 1e-6, `at the node's own station: ${arm.s0}`);
    // the upstream fillet starts on our right edge before the node (y = -3.6, the straight part), the downstream one on the
    // departing segment's right edge (the road bends 20 deg at the node) past it
    const up = arm.arcs[0][0], down = arm.arcs[1][0];
    assert.ok(Math.abs(up[1] + 3.6) < 1e-6 && up[0] < 100 - AX, String(up));
    const N = [100 - AX, 0], u = [Math.cos(th), Math.sin(th)];
    const offDown = -(u[0] * (down[1] - N[1]) - u[1] * (down[0] - N[0]));   // m right of the departing centerline
    assert.ok(Math.abs(offDown - 3.6) < 1e-6 && down[0] > 100 - AX, `${down} (${offDown} m right of the bent road's line)`);
  });
});

describe('mapAlignMatrix', () => {
  // the group's axes: X = -y, Y = up, Z = -x of the pose frame
  const toLocal = (x, y, up = 0) => [-y, up, -x];
  const apply = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
  test('a slide to the car\'s left moves the map sideways in the pose frame, never up or down', () => {
    // the car at (100, 50) heading north: its left is west (-x)
    const pose = { x: 100, y: 50, h: Math.PI / 2 };
    const m = mapAlignMatrix({ shift: 2, rotated: 0, yMap0: 0 }, pose, 3.8);
    const p = apply(m, toLocal(100, 80, -0.004));          // a point 30 m ahead on the centerline
    assert.ok(Math.abs(p[0] - (-80)) < 1e-9 && Math.abs(p[2] - (-98)) < 1e-9, `moved 2 m west: ${p}`);
    assert.ok(Math.abs(p[1] - (-0.004)) < 1e-12, `stays at its height: ${p[1]}`);
    // heading east: left is north
    const m2 = mapAlignMatrix({ shift: 2, rotated: 0, yMap0: 0 }, { x: 0, y: 0, h: 0 }, 3.8);
    const q = apply(m2, toLocal(30, 0));
    assert.ok(Math.abs(q[0] - (-2)) < 1e-9 && Math.abs(q[2] - (-30)) < 1e-9 && Math.abs(q[1]) < 1e-12, String(q));
  });
  test('a turn is about the car\'s spot on the map line and keeps its sense', () => {
    const pose = { x: 0, y: 0, h: 0 };
    const ref = { shift: 0, rotated: 10 * DEG, yMap0: 0 };
    const m = mapAlignMatrix(ref, pose, 3.8);
    const center = apply(m, toLocal(3.8, 0));
    assert.ok(Math.abs(center[0]) < 1e-9 && Math.abs(center[2] + 3.8) < 1e-9, 'the center stays');
    const ahead = apply(m, toLocal(103.8, 0));             // 100 m ahead turns 10 deg to the left (north: -X)
    assert.ok(Math.abs(ahead[0] - (-100 * Math.sin(10 * DEG))) < 1e-9 && Math.abs(ahead[2] - (-(3.8 + 100 * Math.cos(10 * DEG)))) < 1e-9, String(ahead));
    assert.equal(mapAlignMatrix({ shift: 0, rotated: 0, yMap0: 0 }, pose, 3.8), null);
  });
});
