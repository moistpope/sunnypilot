// The map matcher (mapmatch.js) on a small synthetic road network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MapData } from '../mapdata.js';
import { MapMatcher } from '../mapmatch.js';

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
    for (let k = 1; k <= 12; k++) names.push(mm.update([100 + 15 * k, 10, 0], 15, k * 0.05).way.name);
    assert.equal(names[0], 'Main Street');
    assert.equal(names[names.length - 1], 'Second Street');
    const first = names.indexOf('Second Street');
    assert.ok(first >= 6 && first <= 9, JSON.stringify(names));
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
