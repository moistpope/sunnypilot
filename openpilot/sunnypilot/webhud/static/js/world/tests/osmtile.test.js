// The OSM tile reader (osmtile.js) against a real mapd tile (a rural one from the Athens, GA cell; ODbL, (c) OpenStreetMap contributors).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HIGHWAY_CLASSES, decodeTile, tileFor, unpack } from '../osmtile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE = path.join(here, 'fixtures/osm_32.000000_-83.500000_32.250000_-83.250000');

describe('osmtile', () => {
  test('unpacking: zero runs, literal runs and mixed words', () => {
    // one word with bytes 1 and 8 set, then two zero words, then a literal run of one word
    const packed = Uint8Array.from([0x81, 0x11, 0x22, 0x00, 0x01, 0xff, 1, 2, 3, 4, 5, 6, 7, 8, 1, 9, 9, 9, 9, 9, 9, 9, 9]);
    const out = unpack(packed);
    assert.deepEqual([...out], [0x11, 0, 0, 0, 0, 0, 0, 0x22, ...new Array(16).fill(0), 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 9, 9, 9, 9, 9]);
  });

  test('a real tile decodes: bounds, classes, boxes, coordinates', () => {
    const tile = decodeTile(new Uint8Array(fs.readFileSync(FIXTURE)));
    assert.deepEqual([tile.minLat, tile.minLon, tile.maxLat, tile.maxLon], [32.0, -83.5, 32.25, -83.25]);
    assert.ok(tile.overlap > 0 && tile.overlap < 0.01);
    assert.ok(tile.ways.length > 100, String(tile.ways.length));
    let nodes = 0, named = 0;
    for (const w of tile.ways) {
      assert.ok(w.id > 0 && Number.isInteger(w.id));
      assert.ok(w.cls >= 0 && w.cls < HIGHWAY_CLASSES.length && w.className === HIGHWAY_CLASSES[w.cls]);
      assert.ok(w.lanes >= 0 && w.lanes < 16);
      assert.ok(w.nodes.length >= 4 && w.nodes.length % 2 === 0);
      for (let i = 0; i < w.nodes.length; i += 2) {
        assert.ok(w.nodes[i] >= w.minLat - 1e-9 && w.nodes[i] <= w.maxLat + 1e-9 && w.nodes[i + 1] >= w.minLon - 1e-9 && w.nodes[i + 1] <= w.maxLon + 1e-9);
      }
      // the way touches the tile (or its overlap)
      assert.ok(w.maxLat >= tile.minLat - tile.overlap && w.minLat <= tile.maxLat + tile.overlap);
      nodes += w.nodes.length / 2;
      if (w.name) named++;
      assert.ok(w.maxSpeed >= 0 && w.maxSpeed < 60);   // m/s
    }
    assert.ok(nodes > 1000 && named > 50);
  });

  test('tile and cell names', () => {
    assert.deepEqual(tileFor(33.9883, -83.3427), { cell: '32/-84', file: '33.750000_-83.500000_34.000000_-83.250000', tLat: 33.75, tLon: -83.5, cLat: 32, cLon: -84 });
    assert.equal(tileFor(32.1, -83.3).file, path.basename(FIXTURE).replace(/^osm_/, ''));
    assert.equal(tileFor(34.0, -84.0).cell, '34/-84');
    assert.equal(tileFor(-33.9, 151.2).cell, '-34/150');
  });
});
