// The road map around the car: OSM tiles (osmtile.js) fetched from the page's own server, kept in a small
// cache, projected into the pose estimator's east/north frame and indexed on a grid so the map matcher
// (mapmatch.js) can ask for the road segments near a point. Runs in the worker.
//
// Tiles are 0.25 deg (~28 x 23 km here); the car's horizon is under a kilometer, so the tile under the car
// is loaded and the neighbour across an edge is fetched once the car comes within PREFETCH_M of it. The
// page's server (the APK's LocalServer, or server.py on the comma / a PC) answers GET /map/tile/<cell>/<file>
// from its copy of the cell, downloading the cell from map-data.pfeifer.dev the first time (the comma's
// mapd already keeps the same files, which it serves directly).
import { decodeTile, tileFor } from './osmtile.js';

const DEG = Math.PI / 180;
const EARTH_R = 6378137.0;
const TILE_DEG = 0.25;
const PREFETCH_M = 2000;      // start loading the next tile this far before its edge
const CACHE_TILES = 6;
const GRID_M = 250;           // index cell size
const RETRY_S = 15;           // after a failed fetch

/** Index into the drivable road segments of the loaded tiles, in the frame of `origin`. */
export class MapData {
  /** fetchTile(cell, file) resolves to the tile's bytes (Uint8Array) or null when it isn't available. */
  constructor(fetchTile) {
    this.fetchTile = fetchTile;
    this.tiles = new Map();      // key -> {key, tile, ways: [{way, xy: Float64Array}], at (last use), loading, failedAt}
    this.grid = new Map();       // "gx,gy" -> [[tileKey, wayIndex, segmentIndex], ...]
    this.origin = null;          // {lat, lon, cosLat, seq}
    this.pending = new Map();    // key -> Promise
    this.version = 0;            // bumps when the index changes
  }

  // ---- frame ------------------------------------------------------------------------------------

  /** Follow the pose estimator's origin; a new origin re-projects what is loaded. */
  setOrigin(origin) {
    if (!origin) return;
    const o = this.origin;
    if (o && o.seq === origin.seq && o.lat === origin.lat && o.lon === origin.lon) return;
    this.origin = { lat: origin.lat, lon: origin.lon, cosLat: Math.cos(origin.lat * DEG), seq: origin.seq };
    for (const e of this.tiles.values()) if (e.tile) this._project(e);
    this._reindex();
  }

  toLocal(lat, lon) {
    const o = this.origin;
    return [(lon - o.lon) * DEG * EARTH_R * o.cosLat, (lat - o.lat) * DEG * EARTH_R];
  }

  toGeodetic(x, y) {
    const o = this.origin;
    return [o.lat + y / (DEG * EARTH_R), o.lon + x / (DEG * EARTH_R * o.cosLat)];
  }

  // ---- loading ----------------------------------------------------------------------------------

  /** Make sure the tiles around (lat, lon) are loaded or loading. Returns true when the tile under the point is ready. */
  ensure(lat, lon, now) {
    const here = tileFor(lat, lon);
    const wanted = [here];
    // neighbours within PREFETCH_M of the point (one lat step ~ 27.8 km, one lon step ~ 23 km here)
    const mLat = DEG * EARTH_R, mLon = DEG * EARTH_R * Math.cos(lat * DEG);
    const dS = (lat - here.tLat) * mLat, dN = (here.tLat + TILE_DEG - lat) * mLat;
    const dW = (lon - here.tLon) * mLon, dE = (here.tLon + TILE_DEG - lon) * mLon;
    const near = [];
    if (dS < PREFETCH_M) near.push([-1, 0]); if (dN < PREFETCH_M) near.push([1, 0]);
    if (dW < PREFETCH_M) near.push([0, -1]); if (dE < PREFETCH_M) near.push([0, 1]);
    if (dS < PREFETCH_M && dW < PREFETCH_M) near.push([-1, -1]); if (dS < PREFETCH_M && dE < PREFETCH_M) near.push([-1, 1]);
    if (dN < PREFETCH_M && dW < PREFETCH_M) near.push([1, -1]); if (dN < PREFETCH_M && dE < PREFETCH_M) near.push([1, 1]);
    for (const [di, dj] of near) wanted.push(tileFor(here.tLat + di * TILE_DEG + 0.01, here.tLon + dj * TILE_DEG + 0.01));
    for (const t of wanted) this._want(t, now);
    const e = this.tiles.get(keyOf(here));
    if (e) e.at = now;
    return !!(e && e.tile);
  }

  _want(t, now) {
    const key = keyOf(t);
    let e = this.tiles.get(key);
    if (e && (e.tile || e.loading || (e.failedAt != null && now - e.failedAt < RETRY_S))) { e.at = now; return; }
    if (!e) { e = { key, cell: t.cell, file: t.file, tile: null, ways: null, at: now, loading: false, failedAt: null }; this.tiles.set(key, e); }
    e.loading = true;
    const p = Promise.resolve().then(() => this.fetchTile(t.cell, t.file)).then((bytes) => {
      e.loading = false;
      if (!bytes) { e.failedAt = now; return; }
      e.tile = decodeTile(bytes);
      e.failedAt = null;
      if (this.origin) { this._project(e); this._reindex(); }
      this._evict();
    }, (err) => { e.loading = false; e.failedAt = now; e.error = String(err && err.message || err); });
    this.pending.set(key, p);
    p.finally(() => this.pending.delete(key));
  }

  /** Put an already decoded tile in (tests and tools); key as keyOf() gives it. */
  addTile(key, tile, now = 0) {
    const e = { key, tile, ways: null, at: now, loading: false, failedAt: null };
    this.tiles.set(key, e);
    if (this.origin) { this._project(e); this._reindex(); }
  }

  /** Resolves once every tile asked for so far has loaded or failed (for tests and tools). */
  async settle() { while (this.pending.size) await Promise.all([...this.pending.values()]); }

  _evict() {
    while (this.tiles.size > CACHE_TILES) {
      let oldest = null;
      for (const e of this.tiles.values()) if (!e.loading && (oldest === null || e.at < oldest.at)) oldest = e;
      if (oldest === null) return;
      this.tiles.delete(oldest.key);
      this._reindex();
    }
  }

  /** Project a tile's drivable ways into the frame: ways[i].xy = [x0, y0, x1, y1, ...]. */
  _project(e) {
    const ways = [];
    for (const way of e.tile.ways) {
      if (way.cls === 0) continue;   // not a road
      const n = way.nodes, xy = new Float64Array(n.length);
      for (let i = 0; i < n.length; i += 2) { const [x, y] = this.toLocal(n[i], n[i + 1]); xy[i] = x; xy[i + 1] = y; }
      ways.push({ way, xy });
    }
    e.ways = ways;
  }

  _reindex() {
    const grid = new Map();
    for (const e of this.tiles.values()) {
      if (!e.ways) continue;
      e.ways.forEach((w, wi) => {
        const xy = w.xy;
        for (let s = 0; s + 3 < xy.length; s += 2) {
          const gx0 = Math.floor(Math.min(xy[s], xy[s + 2]) / GRID_M), gx1 = Math.floor(Math.max(xy[s], xy[s + 2]) / GRID_M);
          const gy0 = Math.floor(Math.min(xy[s + 1], xy[s + 3]) / GRID_M), gy1 = Math.floor(Math.max(xy[s + 1], xy[s + 3]) / GRID_M);
          for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
            const k = gx + ',' + gy;
            let arr = grid.get(k);
            if (!arr) { arr = []; grid.set(k, arr); }
            arr.push([e.key, wi, s >> 1]);
          }
        }
      });
    }
    this.grid = grid;
    this.version++;
  }

  // ---- queries ----------------------------------------------------------------------------------

  get loaded() { return [...this.tiles.values()].filter(e => e.tile).length; }

  /** The road segments within r of (x, y): [{tileKey, wi, si, way, xy, ax, ay, bx, by, d, t, px, py}] (t: 0..1 along the segment, p: nearest point). */
  near(x, y, r) {
    const out = [], seen = new Set();
    const g0x = Math.floor((x - r) / GRID_M), g1x = Math.floor((x + r) / GRID_M), g0y = Math.floor((y - r) / GRID_M), g1y = Math.floor((y + r) / GRID_M);
    for (let gx = g0x; gx <= g1x; gx++) for (let gy = g0y; gy <= g1y; gy++) {
      const arr = this.grid.get(gx + ',' + gy);
      if (!arr) continue;
      for (const [key, wi, si] of arr) {
        const id = key + ':' + wi + ':' + si;
        if (seen.has(id)) continue;
        seen.add(id);
        const e = this.tiles.get(key);
        if (!e || !e.ways) continue;
        const w = e.ways[wi], xy = w.xy;
        const ax = xy[2 * si], ay = xy[2 * si + 1], bx = xy[2 * si + 2], by = xy[2 * si + 3];
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        let t = L2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
        t = Math.max(0, Math.min(1, t));
        const px = ax + t * dx, py = ay + t * dy;
        const d = Math.hypot(x - px, y - py);
        if (d <= r) out.push({ tileKey: key, wi, si, way: w.way, xy, ax, ay, bx, by, d, t, px, py });
      }
    }
    return out;
  }

  /** The projected way record for (tileKey, wi). */
  wayAt(tileKey, wi) { const e = this.tiles.get(tileKey); return e && e.ways ? e.ways[wi] : null; }

  /** Ways (other than the given one) with a node exactly at (x, y): [{tileKey, wi, way, xy, nodeIndex}]. */
  waysAtNode(x, y, exceptKey = null, exceptWi = -1) {
    const out = [];
    for (const c of this.near(x, y, 0.5)) {
      if (c.tileKey === exceptKey && c.wi === exceptWi) continue;
      const xy = c.xy;
      for (const ni of [c.si, c.si + 1]) {
        if (xy[2 * ni] === x && xy[2 * ni + 1] === y && !out.some(o => o.tileKey === c.tileKey && o.wi === c.wi && o.nodeIndex === ni)) {
          out.push({ tileKey: c.tileKey, wi: c.wi, way: c.way, xy, nodeIndex: ni });
        }
      }
    }
    return out;
  }
}

export const keyOf = (t) => `${t.cell}/${t.file}`;
