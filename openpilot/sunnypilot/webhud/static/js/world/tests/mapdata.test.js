// The tile loader and segment index (mapdata.js) over the fixture tile.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MapData, keyOf } from '../mapdata.js';
import { decodeTile, tileFor } from '../osmtile.js';
import { FIXTURE } from './osmtile.test.js';

const bytes = new Uint8Array(fs.readFileSync(FIXTURE));
const fixtureTile = tileFor(32.1, -83.3);

/** A fetch that serves the fixture for its own tile and nothing else, counting calls. */
function fetcher() {
  const calls = [];
  const f = async (cell, file) => { calls.push(`${cell}/${file}`); return `${cell}/${file}` === keyOf(fixtureTile) ? bytes : null; };
  f.calls = calls;
  return f;
}

describe('MapData', () => {
  test('loads the tile under the point, prefetches across a near edge, indexes drivable ways', async () => {
    const f = fetcher();
    const md = new MapData(f);
    md.setOrigin({ lat: 32.125, lon: -83.375, seq: 1 });
    assert.equal(md.ensure(32.125, -83.375, 0), false);   // not there yet
    await md.settle();
    assert.equal(md.ensure(32.125, -83.375, 1), true);
    assert.deepEqual(f.calls, [keyOf(fixtureTile)]);        // mid-tile: no neighbours asked for
    assert.equal(md.loaded, 1);
    const tile = decodeTile(bytes);
    const roads = tile.ways.filter(w => w.cls > 0).length;
    assert.equal(md.tiles.get(keyOf(fixtureTile)).ways.length, roads);
    // near the north edge: the tile north of it is asked for (and fails quietly: the fetch has no such tile)
    md.ensure(32.249, -83.375, 2);
    await md.settle();
    assert.ok(f.calls.some(c => c.startsWith('32/-84/32.250000_-83.500000')), String(f.calls));
    assert.equal(md.loaded, 1);
    // a failed tile isn't retried at once
    const n = f.calls.length;
    md.ensure(32.249, -83.375, 3);
    await md.settle();
    assert.equal(f.calls.length, n);
  });

  test('near() finds the segments around a road node, with the nearest point and distance', async () => {
    const md = new MapData(fetcher());
    md.setOrigin({ lat: 32.125, lon: -83.375, seq: 1 });
    md.ensure(32.125, -83.375, 0);
    await md.settle();
    // take a node in the middle of some way and ask around it
    const e = md.tiles.get(keyOf(fixtureTile));
    const w = e.ways.find(x => x.xy.length >= 8);
    const x = w.xy[2], y = w.xy[3];
    const hits = md.near(x, y, 30);
    assert.ok(hits.length >= 2, String(hits.length));                // the two segments meeting at the node at least
    const own = hits.filter(h => h.way === w.way);
    assert.ok(own.some(h => h.d < 1e-6));                            // one of them passes through the point
    for (const h of hits) assert.ok(h.d <= 30 && h.t >= 0 && h.t <= 1 && Math.abs(Math.hypot(x - h.px, y - h.py) - h.d) < 1e-9);
    // nothing far away
    assert.equal(md.near(x + 5000, y + 5000, 10).length === 0 || md.near(x + 5000, y + 5000, 10).every(h => h.d <= 10), true);
  });

  test('waysAtNode() finds the other ways sharing an endpoint coordinate', async () => {
    const md = new MapData(fetcher());
    md.setOrigin({ lat: 32.125, lon: -83.375, seq: 1 });
    md.ensure(32.125, -83.375, 0);
    await md.settle();
    const e = md.tiles.get(keyOf(fixtureTile));
    // find a way whose end is shared with another way
    let found = null;
    for (let wi = 0; wi < e.ways.length && !found; wi++) {
      const xy = e.ways[wi].xy;
      const x = xy[xy.length - 2], y = xy[xy.length - 1];
      const others = md.waysAtNode(x, y, e.key, wi);
      if (others.length) found = { wi, others, x, y };
    }
    assert.ok(found, 'some way ends at a junction');
    for (const o of found.others) {
      assert.ok(!(o.tileKey === e.key && o.wi === found.wi));
      assert.equal(o.xy[2 * o.nodeIndex], found.x);
      assert.equal(o.xy[2 * o.nodeIndex + 1], found.y);
    }
  });

  test('a new origin re-projects the loaded tiles', async () => {
    const md = new MapData(fetcher());
    md.setOrigin({ lat: 32.125, lon: -83.375, seq: 1 });
    md.ensure(32.125, -83.375, 0);
    await md.settle();
    const e = md.tiles.get(keyOf(fixtureTile));
    const before = [e.ways[0].xy[0], e.ways[0].xy[1]];
    md.setOrigin({ lat: 32.125, lon: -83.375 + 0.01, seq: 2 });
    const after = [e.ways[0].xy[0], e.ways[0].xy[1]];
    assert.ok(Math.abs((before[0] - after[0]) - 0.01 * Math.PI / 180 * 6378137 * Math.cos(32.125 * Math.PI / 180)) < 1e-6);
    assert.equal(before[1], after[1]);
  });
});

describe('map prefetch', () => {
  test('the server is asked for the map around the car once, again after 3 km or 2 min, and at once with a new radius', async () => {
    const asks = [];
    const md = new MapData(async () => null, null, async (lat, lon, km) => { asks.push([lat, lon, km]); });
    md.setOrigin({ lat: 33.95, lon: -83.40, seq: 1 });
    md.ensure(33.95, -83.40, 0);
    await md.settle();
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(asks, [[33.95, -83.40, 25]]);
    md.ensure(33.951, -83.401, 30);          // 150 m on, half a minute later: nothing
    await new Promise(r => setTimeout(r, 0));
    assert.equal(asks.length, 1);
    md.ensure(33.98, -83.40, 60);            // 3.3 km north: asked again
    await new Promise(r => setTimeout(r, 0));
    assert.equal(asks.length, 2);
    md.ensure(33.98, -83.40, 200);           // 140 s later, same place: asked again
    await new Promise(r => setTimeout(r, 0));
    assert.equal(asks.length, 3);
    md.setPrefetchKm(50);
    md.ensure(33.98, -83.40, 201);
    await new Promise(r => setTimeout(r, 0));
    assert.equal(asks.length, 4);
    assert.equal(asks[3][2], 50);
    md.setPrefetchKm(0);                     // off: never asked
    md.ensure(34.1, -83.40, 400);
    await new Promise(r => setTimeout(r, 0));
    assert.equal(asks.length, 4);
  });
});
