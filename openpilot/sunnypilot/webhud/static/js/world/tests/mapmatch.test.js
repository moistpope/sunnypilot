// The map matcher (mapmatch.js) on a small synthetic road network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MapData, keyOf } from '../mapdata.js';
import { MapMatcher } from '../mapmatch.js';
import { tileFor } from '../osmtile.js';

const DEG = Math.PI / 180, R = 6378137.0;
const LAT0 = 33.95, LON0 = -83.40;
const ll = (x, y) => [LAT0 + y / (DEG * R), LON0 + x / (DEG * R * Math.cos(LAT0 * DEG))];

let nextId = 1;
/** A way through the given metric points. */
function way(name, className, pts, { ref = '', oneWay = false, lanes = 2 } = {}) {
  const cls = ['unknown', 'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street'].indexOf(className);
  const nodes = Float64Array.from(pts.flatMap(([x, y]) => ll(x, y)));
  let minLat = 90, minLon = 180, maxLat = -90, maxLon = -180;
  for (let i = 0; i < nodes.length; i += 2) { minLat = Math.min(minLat, nodes[i]); maxLat = Math.max(maxLat, nodes[i]); minLon = Math.min(minLon, nodes[i + 1]); maxLon = Math.max(maxLon, nodes[i + 1]); }
  return { id: nextId++, name, ref, cls, className, lanes, oneWay, maxSpeed: 0, maxSpeedForward: 0, maxSpeedBackward: 0, advisorySpeed: 0, hazard: '', minLat, minLon, maxLat, maxLon, nodes };
}

const line = (x0, y0, x1, y1, n) => Array.from({ length: n + 1 }, (_, i) => [x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]);

/** Main Street east-west with a crossing, a one-way link, a continuation and a side turn at its end, and a parallel street. */
function network() {
  const md = new MapData(async () => null);
  md.setOrigin({ lat: LAT0, lon: LON0, seq: 1 });
  const ways = [
    way('Main Street', 'secondary', line(-1000, 0, 1000, 0, 20)),                         // nodes every 100 m, through (0,0), (300,0)
    way('Cross Street', 'tertiary', line(0, -500, 0, 500, 10)),                          // crosses at (0,0)
    way('', 'primary_link', [[300, 0], [400, 60], [500, 150]], { oneWay: true, lanes: 1 }),   // leaves Main at (300,0) to the NE
    way('Main Street', 'secondary', line(1000, 0, 1500, 50, 5)),                          // continues east with a gentle bend
    way('Mill Road', 'residential', line(1000, 0, 1100, -300, 3)),                        // turns off south-east at Main's end
    way('Second Street', 'residential', line(-1000, 15, 1000, 15, 20)),                   // parallel, 15 m north
  ];
  md.addTile('test/tile', { minLat: LAT0 - 0.1, minLon: LON0 - 0.1, maxLat: LAT0 + 0.1, maxLon: LON0 + 0.1, overlap: 0, ways });
  return md;
}

describe('MapMatcher', () => {
  test('matches the road under the car with its side and direction, and follows it into the horizon', () => {
    const md = network();
    const mm = new MapMatcher(md);
    const m = mm.update([-150, 2, 0], 15, 0);   // 150 m west of the crossing, 2 m left of the centerline, heading east
    assert.equal(m.way.name, 'Main Street');
    assert.equal(m.dir, 1);
    assert.ok(Math.abs(m.lateral - 2) < 0.01 && Math.abs(m.distance - 2) < 0.01, `${m.lateral} ${m.distance}`);
    assert.ok(Math.abs(m.s - 850) < 0.5, String(m.s));   // from the way's west end
    assert.ok(m.conf > 0.7, String(m.conf));
    // the horizon: 60 m behind to ~500 m ahead along Main (the car is at x = -150, so it ends near x = 350)
    const pts = m.horizon;
    assert.ok(pts.some(p => Math.abs(p[0] - (-150)) < 0.5 && Math.abs(p[1]) < 0.01), 'has the matched point');
    assert.ok(pts[0][0] < -200 && pts[0][0] >= -220, `starts behind: ${pts[0]}`);
    assert.ok(m.horizonLength >= 500 && m.horizonLength < 600, String(m.horizonLength));
    assert.ok(pts[pts.length - 1][0] >= 350 && pts[pts.length - 1][0] <= 400, `ends ~500 m ahead: ${pts[pts.length - 1]}`);
    assert.equal(m.ended, false);
    // branches: Cross Street both ways at the crossing (150 m ahead), the one-way link at 450 m
    const cross = m.branches.filter(b => b.name === 'Cross Street');
    assert.equal(cross.length, 2);
    assert.ok(cross.every(b => Math.abs(b.along - 150) < 0.5 && Math.abs(Math.abs(b.angle) - 90) <= 1), JSON.stringify(cross));
    const link = m.branches.find(b => b.className === 'primary_link');
    assert.ok(link && Math.abs(link.along - 450) < 0.5 && link.angle > 25 && link.angle < 40 && link.oneWay, JSON.stringify(link));
  });

  test('turning at the junction ahead takes the horizon onto that branch: by the indicator, or by the yaw rate', () => {
    const md = network();
    // 30 m before the crossing, going east, left indicator on: the horizon turns north up Cross Street, Main goes on as a branch
    let m = new MapMatcher(md).update([-30, 0, 0], 8, 0, { w: 0, turn: 1 });
    let last = m.horizon[m.horizon.length - 1];
    assert.ok(Math.abs(last[0]) < 0.5 && last[1] > 300, `north up Cross Street: ${last}`);
    assert.ok(m.branches.some(b => b.name === 'Main Street' && Math.abs(b.angle) < 1), 'Main Street straight on is a branch');
    assert.ok(m.branches.some(b => b.name === 'Cross Street' && b.angle < -80), 'Cross Street south too');
    // no indicator, yawing right at 0.3 rad/s (a turn in progress): south
    m = new MapMatcher(md).update([-10, 0, -0.3], 6, 0, { w: -0.3, turn: 0 });
    last = m.horizon[m.horizon.length - 1];
    assert.ok(Math.abs(last[0]) < 0.5 && last[1] < -300, `south down Cross Street: ${last}`);
    // neither: straight on as before
    m = new MapMatcher(md).update([-30, 0, 0], 8, 0, { w: 0, turn: 0 });
    last = m.horizon[m.horizon.length - 1];
    assert.ok(last[0] > 300 && Math.abs(last[1]) < 0.5, `straight on: ${last}`);
    // too far from the junction to be a turn there
    m = new MapMatcher(md).update([-200, 0, 0], 15, 0, { w: 0, turn: 1 });
    last = m.horizon[m.horizon.length - 1];
    assert.ok(last[0] > 200, `not yet: ${last}`);
    // at a T (Main's end has a same-name continuation; use Mill Road's side): right indicator at Main's end takes Mill Road
    m = new MapMatcher(md).update([980, 0, 0], 8, 0, { w: 0, turn: -1 });
    assert.ok(m.horizon[m.horizon.length - 1][1] < -200, 'Mill Road, south-east');
  });

  test('the road behind the car is the path it drove: after a turn it runs back round the corner', () => {
    const md = network();
    const mm = new MapMatcher(md);
    // along Main, then onto the continuation past x = 1000 (which starts at the node: nothing of its own behind it)
    for (let x = 850; x <= 1040; x += 3) mm.update([x, 0.3, x > 1000 ? 0.1 : 0], 15, (x - 850) / 15);
    const m = mm.result;
    assert.equal(m.way.name, 'Main Street');
    assert.ok(m.horizon[m.carIndex][0] > 1000, 'matched on the continuation');
    const behind = m.horizon.slice(0, m.carIndex);
    assert.ok(behind.length >= 5 && behind[0][0] < 990 && Math.abs(behind[0][1]) < 0.5, `runs back along the first way: ${behind[0]}`);
  });

  test('a turn onto a crossing road keeps the path driven behind the car; a move to a parallel road drops it', () => {
    const md = network();
    let mm = new MapMatcher(md);
    let t = 0;
    for (let x = -120; x <= -6; x += 3) mm.update([x, 0.3, 0], 10, t += 0.3);               // east along Main to the crossing
    for (let a = 0; a <= 90; a += 10) mm.update([-6 + 6 * Math.sin(a * DEG), 6 - 6 * Math.cos(a * DEG), a * DEG], 5, t += 0.3);   // round the corner
    for (let y = 9; y <= 30; y += 3) mm.update([0.3, y, Math.PI / 2], 10, t += 0.3);          // 30 m north up Cross Street
    let m = mm.result;
    assert.equal(m.way.name, 'Cross Street');
    const behind = m.horizon.slice(0, m.carIndex);   // 60 m back: round the corner and 30 m west along Main
    assert.ok(behind.some(p => p[0] < -15 && Math.abs(p[1]) < 1), `the road behind comes round from Main Street: ${JSON.stringify(behind.slice(0, 3))}`);
    assert.ok(behind[behind.length - 1][1] > 10 && Math.abs(behind[behind.length - 1][0]) < 1, 'and ends just behind the car on Cross Street');
    // a drift onto Second Street (parallel, 15 m north): the trail is dropped, the road behind is Second Street's own
    mm = new MapMatcher(md);
    t = 0;
    for (let x = 100; x <= 200; x += 3) mm.update([x, 1, 0], 15, t += 0.05);
    for (let x = 203; x <= 500; x += 3) mm.update([x, 12, 0], 15, t += 0.05);
    m = mm.result;
    assert.equal(m.way.name, 'Second Street');
    assert.ok(m.horizon.slice(0, m.carIndex).every(p => Math.abs(p[1] - 15) < 0.01), 'behind runs along Second Street');
  });

  test('at the end of a way the horizon continues onto the way with the same name, the others become branches', () => {
    const md = network();
    const m = new MapMatcher(md).update([600, 0.5, 0], 20, 0);
    const pts = m.horizon, last = pts[pts.length - 1];
    assert.ok(last[0] > 1000 && last[1] > 0, `ends on the continuation: ${last}`);   // Main Street bends north-east past x = 1000
    assert.equal(m.ended, false);
    const mill = m.branches.find(b => b.name === 'Mill Road');
    assert.ok(mill && Math.abs(mill.along - 400) < 0.5 && mill.angle < -60 && mill.angle > -80, JSON.stringify(mill));
    assert.ok(!m.branches.some(b => b.className === 'primary_link'), 'the link behind the car is not ahead');
    assert.ok(!m.branches.some(b => b.name === 'Main Street'), 'the continuation is not a branch');
  });

  test('heading west on a two-way road reverses direction and horizon; a one-way road the wrong way is no candidate', () => {
    const md = network();
    const mm = new MapMatcher(md);
    const m = mm.update([500, -1, Math.PI], 12, 0);
    assert.equal(m.way.name, 'Main Street');
    assert.equal(m.dir, -1);
    assert.ok(m.lateral > 0.9 && m.lateral < 1.1, String(m.lateral));   // right of center eastbound = left of center westbound
    assert.ok(m.horizon[m.horizon.length - 1][0] < 100, 'runs west');
    // on the link, facing back down it
    const m2 = new MapMatcher(md).update([450, 105, Math.atan2(-60, -100)], 10, 0);
    assert.ok(!m2 || m2.way.className !== 'primary_link', m2 && m2.way.className);
  });

  test('a parallel road that scores better takes over only after it keeps winning', () => {
    const md = network();
    const mm = new MapMatcher(md);
    assert.equal(mm.update([100, 1, 0], 15, 0).way.name, 'Main Street');
    // drift to 10 m north: Second Street (at 15) is 5 m away, Main 10 m
    let names = [];
    for (let k = 1; k <= 24; k++) names.push(mm.update([100 + 15 * k, 10, 0], 15, k * 0.05).way.name);
    assert.equal(names[0], 'Main Street');
    assert.equal(names[names.length - 1], 'Second Street');
    const first = names.indexOf('Second Street');
    assert.ok(first >= 14 && first <= 17, JSON.stringify(names));   // SWITCH_TICKS (16) snapshots of winning
  });

  test('a junction passed stays in the branches with its distance behind until 60 m back, and its node joins the trail', () => {
    const md = network();
    const mm = new MapMatcher(md);
    let t = 0, m = null;
    for (let x = -60; x <= 45; x += 3) m = mm.update([x, 0.3, 0], 12, t += 0.25);
    const cross = m.branches.filter(b => b.name === 'Cross Street');
    assert.equal(cross.length, 2, 'both arms still listed 45 m past the crossing');
    assert.ok(cross.every(b => Math.abs(b.along + 45) < 1.5), JSON.stringify(cross.map(b => b.along)));
    assert.ok(mm.trail.some(q => Math.abs(q[0]) < 1e-9 && Math.abs(q[1]) < 1e-9), 'the crossing node itself is a trail point');
    assert.ok(m.horizon.slice(0, m.carIndex).some(q => q[0] === 0 && q[1] === 0), 'and a vertex of the road behind');
    for (let x = 48; x <= 70; x += 3) m = mm.update([x, 0.3, 0], 12, t += 0.25);
    assert.equal(m.branches.filter(b => b.name === 'Cross Street').length, 0, 'gone past 60 m');
  });

  test('crossing a junction stays on the road being driven; at the end of a way the match moves onto the continuation', () => {
    const md = network();
    const mm = new MapMatcher(md);
    for (let x = -30; x <= 30; x += 3) assert.equal(mm.update([x, 0.5, 0], 12, (x + 30) / 3 * 0.05).way.name, 'Main Street');
    const mm2 = new MapMatcher(md);
    let last = null;
    for (let x = 900; x <= 1100; x += 5) last = mm2.update([x, x > 1000 ? (x - 1000) * 0.1 : 0.3, 0.1], 12, (x - 900) / 5 * 0.05);
    assert.equal(last.way.name, 'Main Street');
    assert.ok(last.s > 90 && last.s < 110, String(last.s));   // 100 m into the continuation way
  });

  test('away from any road the match coasts briefly, then goes', () => {
    const md = network();
    const mm = new MapMatcher(md);
    assert.ok(mm.update([200, 1, 0], 15, 0));
    const c = mm.update([200, 300, 0], 15, 1.0);   // 300 m off
    assert.ok(c && c.coasting && c.distance > 250, JSON.stringify(c && { coasting: c.coasting, distance: c.distance }));
    assert.equal(mm.update([200, 300, 0], 15, 5.0), null);
  });
});

describe('MapMatcher merges', () => {
  test('a one-way road ending at a node on the horizon is a merging branch, never the way on', () => {
    const md = new MapData(async () => null);
    md.setOrigin({ lat: LAT0, lon: LON0, seq: 1 });
    const ways = [
      way('Highway', 'motorway', line(-500, 0, 1500, 0, 20), { oneWay: true, lanes: 2 }),
      way('', 'motorway_link', [[300, -80], [400, -30], [500, 0]], { oneWay: true, lanes: 1 }),   // joins at (500, 0): its last node
    ];
    md.addTile('t', { minLat: LAT0 - 0.1, minLon: LON0 - 0.1, maxLat: LAT0 + 0.1, maxLon: LON0 + 0.1, overlap: 0, ways });
    const m = new MapMatcher(md).update([100, 0.5, 0], 30, 0);
    assert.equal(m.way.name, 'Highway');
    const merge = m.branches.find(b => b.merge);
    assert.ok(merge, 'the on-ramp is listed');
    assert.ok(Math.abs(merge.along - 400) < 1 && merge.className === 'motorway_link');
    assert.ok(merge.pts.length >= 2 && merge.pts[1][0] < merge.pts[0][0], 'its geometry runs back along the ramp from the node');
    assert.ok(m.horizon[m.horizon.length - 1][0] > 500 && Math.abs(m.horizon[m.horizon.length - 1][1]) < 0.01, 'the horizon stays on the highway');
  });
});

describe('roads layer through StateBuilder', async () => {
  const { StateBuilder } = await import('../state.js');
  const { worldDbc } = await import('./helpers.js');
  const { roadNetwork } = await import('../../mapsurface.js');
  test('the snapshot carries every road within reach, rebuilt once the car has moved 40 m, and the network geometry opens lines at junctions', () => {
    const md = network();
    // the loader looks the tile up by where the car is: file the test network under that key
    const tile = md.tiles.get('test/tile').tile;
    md.tiles.delete('test/tile');
    md.addTile(keyOf(tileFor(LAT0, LON0)), tile);
    const b = new StateBuilder(worldDbc(), null, { mapData: md });
    b.setBrand('fisker');
    // a fix near the test network's origin so the pose frame and the tile frame agree
    const enc = (addr, values) => worldDbc().messages.get(addr).encode(values);
    const drive = (t0, t1, lat, lon) => {
      for (let t = t0; t <= t1 + 1e-9; t += 0.01) {
        const frames = [[0x318, enc(0x318, { ESP_VehSpd: 36, ESP_VehSpdVld: 1 }), 0], [0x112, enc(0x112, { YRS_YawRate: 0 }), 0], [0x214, enc(0x214, { VCU_GearSig: 4 }), 0]];
        if (Math.round(t * 100) % 10 === 0) frames.push([0x526, enc(0x526, { TBOX_GPSLati: lat, TBOX_GPSLongi: lon + (10 * t) / (DEG * R * Math.cos(LAT0 * DEG)) }), 0], [0x179, enc(0x179, { TBOX_Heading: 90, TBOX_HeadingStdDev: 0.2 }), 0]);   // 10 m/s east from t = 0
        b.feedCan(frames, t);
      }
    };
    // the matcher's own frame: the first fix becomes the origin; the test network is laid out from (LAT0, LON0), so start there
    md.setOrigin = () => {};   // keep the tile frame as the test built it
    drive(0, 2, LAT0, LON0);
    const s1 = b.snapshot(2);
    assert.ok(s1.map && s1.map.roads, 'the first snapshot with a map carries the layer');
    const names = new Set(s1.map.roads.ways.map(w => w.name));
    assert.ok(names.has('Main Street') && names.has('Cross Street') && names.has('Second Street'), [...names].join());
    assert.ok(s1.map.roads.ways.every(w => w.pts.length >= 2 && w.width > 0));
    const v1 = s1.map.roadsVersion;
    const s2 = b.snapshot(2.01);
    assert.equal(s2.map.roads, undefined, 'no rebuild without moving');
    assert.equal(s2.map.roadsVersion, v1);
    drive(2.01, 7, LAT0, LON0);   // ~50 m east
    const s3 = b.snapshot(7);
    assert.ok(s3.map.roads && s3.map.roadsVersion === v1 + 1, 'rebuilt after 40 m');
    // the geometry: a strip and lines for every road, edges opened where Cross Street meets Main Street between the
    // fillets' tangent points (3.6 half width + 6 m at a right angle), inner lines across the other road's width
    const net = roadNetwork(s3.map.roads);
    assert.equal(net.strips.length, s3.map.roads.ways.length);
    assert.ok(net.edges.length > 2 * net.strips.length, 'edges are split into pieces at junctions');
    const main = s3.map.roads.ways.find(w => w.name === 'Main Street' && w.pts.some(p => p[0] === 0 && p[1] === 0));
    const mainEdges = net.edges.filter(e => e.every(p => Math.abs(Math.abs(p[1]) - 3.6) < 0.01));
    const gapAtCross = mainEdges.filter(e => e[e.length - 1][0] < 0).map(e => e[e.length - 1][0]).sort((a, b) => b - a)[0];
    assert.ok(main && gapAtCross != null && Math.abs(gapAtCross - (-(3.6 + 6))) < 1.0, `Main's edge stops a fillet before Cross Street: ${gapAtCross}`);
    // the same road going on into the next way opens nothing: Main Street's centerline runs through x = 1000 unbroken
    assert.ok(!net.centers.some(c => c.some(p => Math.abs(p[0] - 1000) < 1.5 && Math.abs(p[1]) < 0.5) && c.length < 3), 'no cut at a continuation');
    const cross = s3.map.roads.ways.find(w => w.name === 'Cross Street');
    assert.ok(cross && !cross.oneWay);
    assert.ok(net.centers.length >= 2, 'two-way roads get centerlines');
  });

  test('the point features on the roads ride along with the arriving directions', () => {
    const md = network();
    const tile = md.tiles.get('test/tile').tile;
    md.tiles.delete('test/tile');
    // Oak Avenue, 100 m north: 35 mph up to x = 0, 45 mph from there on (two ways meeting end to end)
    const oak1 = way('Oak Avenue', 'residential', line(-200, 100, 0, 100, 2)), oak2 = way('Oak Avenue', 'residential', line(0, 100, 200, 100, 2));
    oak1.maxSpeed = 35 / 2.23694; oak2.maxSpeed = 45 / 2.23694;
    tile.ways.push(oak1, oak2);
    md.addTile(keyOf(tileFor(LAT0, LON0)), tile);
    // a signal at the Main / Cross crossing, a stop on Cross Street 100 m south of it for northbound traffic, a marked
    // crossing on Main 200 m east, an unmarked one 300 m east, and a stop off every road we know
    const [sLat, sLon] = ll(0, 0), [tLat, tLon] = ll(0, -100), [cLat, cLon] = ll(200, 0), [uLat, uLon] = ll(300, 0), [oLat, oLon] = ll(50, 250);
    md.addFeatures(Math.floor(LAT0 / 0.05), Math.floor(LON0 / 0.05), [
      [1, sLat, sLon, { highway: 'traffic_signals' }],
      [2, tLat, tLon, { highway: 'stop', direction: 'forward' }],
      [3, cLat, cLon, { highway: 'crossing', crossing: 'marked' }],
      [4, uLat, uLon, { highway: 'crossing', crossing: 'unmarked' }],
      [5, oLat, oLon, { highway: 'stop' }],
    ]);
    const b = new StateBuilder(worldDbc(), null, { mapData: md });
    b.setBrand('fisker');
    const enc = (addr, values) => worldDbc().messages.get(addr).encode(values);
    md.setOrigin = () => {};
    for (let t = 0; t <= 2 + 1e-9; t += 0.01) {
      const frames = [[0x318, enc(0x318, { ESP_VehSpd: 36, ESP_VehSpdVld: 1 }), 0], [0x112, enc(0x112, { YRS_YawRate: 0 }), 0], [0x214, enc(0x214, { VCU_GearSig: 4 }), 0]];
      if (Math.round(t * 100) % 10 === 0) frames.push([0x526, enc(0x526, { TBOX_GPSLati: LAT0, TBOX_GPSLongi: LON0 + (10 * t) / (DEG * R * Math.cos(LAT0 * DEG)) }), 0], [0x179, enc(0x179, { TBOX_Heading: 90, TBOX_HeadingStdDev: 0.2 }), 0]);
      b.feedCan(frames, t);
    }
    const snap = b.snapshot(2);
    const feats = snap.map.roads.features;
    const kinds = feats.map(f => f.kind);
    assert.ok(kinds.includes('signal') && kinds.includes('stop') && kinds.includes('crossing'), kinds.join());
    assert.ok(!feats.some(f => f.id === 4), 'an unmarked crossing is not drawn');
    assert.ok(!feats.some(f => f.id === 5), 'a feature on no known road is left out');
    const signal = feats.find(f => f.kind === 'signal');
    assert.equal(signal.arms.length, 4, 'a head for each of the four arriving directions');
    const hs = signal.arms.map(a => Math.round(a.h / DEG)).sort((a, b) => a - b);
    assert.deepEqual(hs, [-90, 0, 90, 180]);
    assert.ok(signal.arms.every(a => a.half === 3.6 && a.lanes === 2 && !a.oneWay));
    const stop = feats.find(f => f.kind === 'stop');
    assert.equal(stop.arms.length, 1);
    assert.ok(Math.abs(stop.arms[0].h - Math.PI / 2) < 1e-3, `northbound (in node order) traffic stops: ${stop.arms[0].h}`);
    assert.ok(Math.abs(stop.x) < 0.2 && Math.abs(stop.y + 100) < 0.2);
    assert.ok(!feats.some(f => f.kind === 'limit'), 'no speed limit signs from the map: the camera reads the real ones');
  });
});
