// The road map around the car: OSM tiles (osmtile.js) fetched from the page's own server, kept in a small
// cache, projected into the pose estimator's east/north frame and indexed on a grid so the map matcher
// (mapmatch.js) can ask for the road segments near a point. Runs in the worker.
//
// Tiles are 0.25 deg (~28 x 23 km here); the car's horizon is under a kilometer, so the tile under the car
// is loaded and the neighbour across an edge is fetched once the car comes within PREFETCH_M of it. The
// page's server (the APK's LocalServer, or server.py on the comma / a PC) answers GET /map/tile/<cell>/<file>
// from its copy of the cell, downloading the cell from map-data.pfeifer.dev the first time (the comma's
// mapd already keeps the same files, which it serves directly).
//
// The tiles hold roads only. The point features along them -- traffic signals, stop and give-way signs,
// crossings, level crossings, traffic calming -- come separately as *feature cells* of FEAT_DEG square
// (GET /map/features/<klat>/<klon>, the cell's south-west corner in units of FEAT_DEG), which the server
// fills from the Overpass API once and keeps. They are kept here in the same frame; a feature sits on a
// road where its coordinate is a node of the road's way (the same OSM node), which state.js matches up.
import { decodeTile, tileFor } from './osmtile.js';

const DEG = Math.PI / 180;
const EARTH_R = 6378137.0;
const TILE_DEG = 0.25;
const PREFETCH_M = 2000;      // start loading the next tile this far before its edge
const CACHE_TILES = 12;       // decoded tiles kept in memory (the disk keeps everything: the server never drops a tile)
const GRID_M = 250;           // index cell size
const RETRY_S = 15;           // after a failed fetch
export const FEAT_DEG = 0.05; // feature cells: ~5.5 x 4.6 km here
const FEAT_PREFETCH_M = 1500; // load the feature cells within this of the car
const FEAT_CACHE = 40;
// the server is asked to download the whole map within `prefetchKm` of the car (road tiles and features, kept on
// disk) whenever the car has moved PREFETCH_MOVE_M since the last ask, or PREFETCH_EVERY_S have passed
const PREFETCH_EVERY_S = 120, PREFETCH_MOVE_M = 3000;

/** Index into the drivable road segments of the loaded tiles, in the frame of `origin`. */
export class MapData {
  /** fetchTile(cell, file) resolves to the tile's bytes (Uint8Array) or null when it isn't available;
   *  fetchFeatures(klat, klon) to a feature cell ({nodes: [[id, lat, lon, tags], ...]}) or null, or is omitted;
   *  prefetch(lat, lon, km) asks the server to download the map within km of the point, or is omitted. */
  constructor(fetchTile, fetchFeatures = null, prefetch = null) {
    this.fetchTile = fetchTile;
    this.fetchFeatures = fetchFeatures;
    this.prefetch = prefetch;
    this.prefetchKm = 25;
    this._prefetchAt = null;     // {lat, lon, now} of the last ask
    this.tiles = new Map();      // key -> {key, tile, ways: [{way, xy: Float64Array}], at (last use), loading, failedAt}
    this.grid = new Map();       // "gx,gy" -> [[tileKey, wayIndex, segmentIndex], ...]
    this.origin = null;          // {lat, lon, cosLat, seq}
    this.pending = new Map();    // key -> Promise
    this.version = 0;            // bumps when the index changes
    this.featureCells = new Map(); // "klat,klon" -> {key, nodes: [{id, lat, lon, tags, x, y}], at, loading, failedAt}
    this.featVersion = 0;        // bumps when the loaded features change
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
    for (const c of this.featureCells.values()) if (c.nodes) this._projectFeatures(c);
    this.featVersion++;
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
    this._wantFeatures(lat, lon, now);
    this._askPrefetch(lat, lon, now);
    return !!(e && e.tile);
  }

  /** How far around the car the server should download the map (km; 0 for nothing beyond what is in view). */
  setPrefetchKm(km) {
    if (km === this.prefetchKm) return;
    this.prefetchKm = km;
    this._prefetchAt = null;
  }

  _askPrefetch(lat, lon, now) {
    if (!this.prefetch || !(this.prefetchKm > 0)) return;
    const a = this._prefetchAt;
    if (a && now - a.now < PREFETCH_EVERY_S && Math.hypot((lat - a.lat) * DEG * EARTH_R, (lon - a.lon) * DEG * EARTH_R * Math.cos(lat * DEG)) < PREFETCH_MOVE_M) return;
    this._prefetchAt = { lat, lon, now };
    Promise.resolve().then(() => this.prefetch(lat, lon, this.prefetchKm)).catch(() => {});
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

  // ---- features ---------------------------------------------------------------------------------

  /** The feature cells within FEAT_PREFETCH_M of the point, loaded or loading. */
  _wantFeatures(lat, lon, now) {
    if (!this.fetchFeatures) return;
    const dLat = FEAT_PREFETCH_M / (DEG * EARTH_R), dLon = FEAT_PREFETCH_M / (DEG * EARTH_R * Math.cos(lat * DEG));
    const k0 = Math.floor((lat - dLat) / FEAT_DEG), k1 = Math.floor((lat + dLat) / FEAT_DEG);
    const l0 = Math.floor((lon - dLon) / FEAT_DEG), l1 = Math.floor((lon + dLon) / FEAT_DEG);
    for (let k = k0; k <= k1; k++) for (let l = l0; l <= l1; l++) {
      const key = k + ',' + l;
      let c = this.featureCells.get(key);
      if (c && (c.nodes || c.loading || (c.failedAt != null && now - c.failedAt < RETRY_S))) { c.at = now; continue; }
      if (!c) { c = { key, klat: k, klon: l, nodes: null, at: now, loading: false, failedAt: null }; this.featureCells.set(key, c); }
      c.loading = true;
      const p = Promise.resolve().then(() => this.fetchFeatures(k, l)).then((cell) => {
        c.loading = false;
        if (!cell || !Array.isArray(cell.nodes)) { c.failedAt = now; return; }
        c.nodes = cell.nodes.map(([id, la, lo, tags]) => ({ id, lat: la, lon: lo, tags: tags || {}, x: 0, y: 0 }));
        c.failedAt = null;
        if (this.origin) { this._projectFeatures(c); this.featVersion++; }
        this._evictFeatures();
      }, (err) => { c.loading = false; c.failedAt = now; c.error = String(err && err.message || err); });
      this.pending.set('features:' + key, p);
      p.finally(() => this.pending.delete('features:' + key));
    }
  }

  /** Put a feature cell in directly (tests and tools): nodes as [[id, lat, lon, tags], ...]. */
  addFeatures(klat, klon, nodes, now = 0) {
    const key = klat + ',' + klon;
    const c = { key, klat, klon, nodes: nodes.map(([id, la, lo, tags]) => ({ id, lat: la, lon: lo, tags: tags || {}, x: 0, y: 0 })), at: now, loading: false, failedAt: null };
    this.featureCells.set(key, c);
    if (this.origin) { this._projectFeatures(c); this.featVersion++; }
  }

  _projectFeatures(c) {
    for (const n of c.nodes) { const [x, y] = this.toLocal(n.lat, n.lon); n.x = x; n.y = y; }
  }

  _evictFeatures() {
    while (this.featureCells.size > FEAT_CACHE) {
      let oldest = null;
      for (const c of this.featureCells.values()) if (!c.loading && (oldest === null || c.at < oldest.at)) oldest = c;
      if (oldest === null) return;
      this.featureCells.delete(oldest.key);
      this.featVersion++;
    }
  }

  /** The point features within r of (x, y): [{id, lat, lon, tags, x, y}]. */
  featuresNear(x, y, r) {
    const out = [];
    for (const c of this.featureCells.values()) {
      if (!c.nodes) continue;
      for (const n of c.nodes) if (Math.abs(n.x - x) <= r && Math.abs(n.y - y) <= r) out.push(n);
    }
    return out;
  }

  get featuresLoaded() { return [...this.featureCells.values()].filter(c => c.nodes).length; }

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

  /** Project a tile's drivable ways into the frame: ways[i].xy = [x0, y0, x1, y1, ...], with its box. */
  _project(e) {
    const ways = [];
    for (const way of e.tile.ways) {
      if (way.cls === 0) continue;   // not a road
      const n = way.nodes, xy = new Float64Array(n.length);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < n.length; i += 2) {
        const [x, y] = this.toLocal(n[i], n[i + 1]);
        xy[i] = x; xy[i + 1] = y;
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      ways.push({ way, xy, minX, minY, maxX, maxY });
    }
    e.ways = ways;
  }

  /** Every projected way whose box comes within r of (x, y): [{tileKey, wi, way, xy}]. */
  waysNear(x, y, r) {
    const out = [];
    for (const e of this.tiles.values()) {
      if (!e.ways) continue;
      e.ways.forEach((w, wi) => {
        if (w.maxX < x - r || w.minX > x + r || w.maxY < y - r || w.minY > y + r) return;
        out.push({ tileKey: e.key, wi, way: w.way, xy: w.xy });
      });
    }
    return out;
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
