// Reader for the OpenStreetMap road tiles sunnypilot's mapd uses (pfeiferj/mapd, `cereal/offline/offline.capnp`):
// one file per 0.25 deg tile, a *packed* Cap'n Proto message whose root is Offline {bounds, overlap, ways},
// each Way with its OSM id, name/ref, highway class, lanes, one-way flag, speed limits and node coordinates.
// Cells of 2 x 2 deg come as `offline/<lat>/<lon>.tar.gz` from map-data.pfeifer.dev (named by the cell's
// south-west corner on the even grid), 64 tiles each; the comma keeps the same files under
// /data/media/0/osm/offline/. Ways carry coordinates, not node ids: two ways meet where a coordinate pair
// is identical, which the generator guarantees since both copy the same OSM node.
//
// Only what this schema needs of Cap'n Proto is implemented: the packing, the segment table, struct and
// list pointers (including composite lists and far pointers), text, and fixed-width fields. Fields a
// shorter (older) struct lacks read as their defaults.

export const HIGHWAY_CLASSES = ['unknown', 'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary',
  'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street'];

/** Cap'n Proto packing: a tag byte per word marks its non-zero bytes; 0x00 tags run zero words, 0xFF tags run literal words. */
export function unpack(src) {
  const n = src.length;
  // first pass: output size
  let size = 0;
  for (let i = 0; i < n;) {
    const tag = src[i++];
    if (tag === 0) { size += 8 * (1 + src[i++]); continue; }
    let bits = 0;
    for (let b = tag; b; b >>= 1) bits += b & 1;
    i += bits; size += 8;
    if (tag === 0xff) { const words = src[i++]; i += 8 * words; size += 8 * words; }
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (let i = 0; i < n;) {
    const tag = src[i++];
    if (tag === 0) { o += 8 * (1 + src[i++]); continue; }
    for (let b = 0; b < 8; b++) if (tag & (1 << b)) out[o + b] = src[i++];
    o += 8;
    if (tag === 0xff) { const words = src[i++]; out.set(src.subarray(i, i + 8 * words), o); i += 8 * words; o += 8 * words; }
  }
  return out;
}

class Message {
  constructor(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = dv.getUint32(0, true) + 1;
    let off = 4 * (count + 1);
    off = (off + 7) & ~7;
    this.segments = [];
    for (let i = 0; i < count; i++) {
      const words = dv.getUint32(4 + 4 * i, true);
      this.segments.push(new DataView(bytes.buffer, bytes.byteOffset + off, 8 * words));
      off += 8 * words;
    }
  }

  /** Resolve the pointer at word `pos` of segment `seg`: {seg, pos (word of the object), lo, hi (the pointer's halves)} or null. */
  deref(seg, pos) {
    const dv = this.segments[seg];
    let lo = dv.getUint32(pos * 8, true), hi = dv.getUint32(pos * 8 + 4, true);
    if (lo === 0 && hi === 0) return null;
    let kind = lo & 3;
    if (kind === 2) {   // far pointer: the landing pad is in another segment
      const two = (lo >>> 2) & 1, padPos = lo >>> 3, padSeg = hi;
      const pdv = this.segments[padSeg];
      const plo = pdv.getUint32(padPos * 8, true), phi = pdv.getUint32(padPos * 8 + 4, true);
      if (!two) return this._object(padSeg, padPos, plo, phi);
      // double-far: the pad's far pointer gives the object's segment and word, its tag word the pointer type
      const tlo = pdv.getUint32(padPos * 8 + 8, true), thi = pdv.getUint32(padPos * 8 + 12, true);
      return { seg: phi, pos: plo >>> 3, lo: tlo, hi: thi, kind: tlo & 3 };
    }
    return this._object(seg, pos, lo, hi);
  }

  _object(seg, pos, lo, hi) {
    const kind = lo & 3;
    const offset = (lo >> 2);   // signed 30-bit, in words from the end of the pointer
    return { seg, pos: pos + 1 + offset, lo, hi, kind };
  }

  /** A struct reader for the pointer at (seg, pos). */
  struct(seg, pos) {
    const p = this.deref(seg, pos);
    if (p === null || p.kind !== 0) return null;
    return new Struct(this, p.seg, p.pos, p.hi & 0xffff, p.hi >>> 16);
  }

  text(seg, pos) {
    const p = this.deref(seg, pos);
    if (p === null || p.kind !== 1) return '';
    const size = p.hi & 7, count = p.hi >>> 3;
    if (size !== 2 || count === 0) return '';
    const dv = this.segments[p.seg];
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset + p.pos * 8, count - 1);   // minus the NUL
    return utf8.decode(bytes);
  }

  /** A list of structs: calls fn(Struct) for each element. */
  structList(seg, pos, fn) {
    const p = this.deref(seg, pos);
    if (p === null || p.kind !== 1) return 0;
    const size = p.hi & 7;
    const dv = this.segments[p.seg];
    if (size === 7) {   // composite: a tag word, then the elements inline
      const tlo = dv.getUint32(p.pos * 8, true), thi = dv.getUint32(p.pos * 8 + 4, true);
      const count = tlo >>> 2, dataWords = thi & 0xffff, ptrWords = thi >>> 16, stride = dataWords + ptrWords;
      for (let i = 0; i < count; i++) fn(new Struct(this, p.seg, p.pos + 1 + i * stride, dataWords, ptrWords), i);
      return count;
    }
    // a list of single words (size 5) or pointers (6) can also hold structs with one field
    const count = p.hi >>> 3;
    for (let i = 0; i < count; i++) fn(new Struct(this, p.seg, p.pos + i, size === 5 ? 1 : 0, size === 6 ? 1 : 0), i);
    return count;
  }
}

const utf8 = new TextDecoder();

class Struct {
  constructor(msg, seg, pos, dataWords, ptrWords) {
    this.msg = msg; this.dv = msg.segments[seg]; this.seg = seg;
    this.base = pos * 8; this.dataBytes = dataWords * 8; this.ptrBase = pos + dataWords; this.ptrWords = ptrWords;
  }
  f64(byte) { return byte + 8 <= this.dataBytes ? this.dv.getFloat64(this.base + byte, true) : 0.0; }
  i64(byte) { return byte + 8 <= this.dataBytes ? Number(this.dv.getBigInt64(this.base + byte, true)) : 0; }
  u16(byte) { return byte + 2 <= this.dataBytes ? this.dv.getUint16(this.base + byte, true) : 0; }
  u8(byte) { return byte < this.dataBytes ? this.dv.getUint8(this.base + byte) : 0; }
  bit(n) { return (n >> 3) < this.dataBytes ? ((this.dv.getUint8(this.base + (n >> 3)) >> (n & 7)) & 1) === 1 : false; }
  text(i) { return i < this.ptrWords ? this.msg.text(this.seg, this.ptrBase + i) : ''; }
  list(i, fn) { return i < this.ptrWords ? this.msg.structList(this.seg, this.ptrBase + i, fn) : 0; }
}

/** Decode one tile file (packed unless {packed: false}) into plain objects:
 *  {minLat, minLon, maxLat, maxLon, overlap, ways: [{id, name, ref, cls, className, lanes, oneWay, maxSpeed,
 *   maxSpeedForward, maxSpeedBackward, advisorySpeed, hazard, minLat, minLon, maxLat, maxLon, nodes: Float64Array [lat0, lon0, lat1, lon1, ...]}]}.
 *  Speeds are as the generator wrote them (m/s). */
export function decodeTile(bytes, { packed = true } = {}) {
  const msg = new Message(packed ? unpack(bytes) : bytes);
  const root = msg.struct(0, 0);
  if (root === null) throw new Error('osm tile: no root struct');
  const tile = { minLat: root.f64(0), minLon: root.f64(8), maxLat: root.f64(16), maxLon: root.f64(24), overlap: root.f64(32), ways: [] };
  root.list(0, (w) => {
    const way = {
      id: w.i64(72), name: w.text(0), ref: w.text(1), cls: w.u16(42), lanes: w.u8(40), oneWay: w.bit(328),
      maxSpeed: w.f64(0), minLat: w.f64(8), minLon: w.f64(16), maxLat: w.f64(24), maxLon: w.f64(32),
      advisorySpeed: w.f64(48), maxSpeedForward: w.f64(56), maxSpeedBackward: w.f64(64), hazard: w.text(3),
      nodes: null,
    };
    way.className = HIGHWAY_CLASSES[way.cls] || 'unknown';
    const coords = [];
    w.list(2, (c) => { coords.push(c.f64(0), c.f64(8)); });
    way.nodes = Float64Array.from(coords);
    tile.ways.push(way);
  });
  return tile;
}

/** The 0.25 deg tile that holds (lat, lon): its file name inside a cell, and the cell's name. */
export function tileFor(lat, lon) {
  const tLat = Math.floor(lat * 4) / 4, tLon = Math.floor(lon * 4) / 4;
  const cLat = Math.floor(lat / 2) * 2, cLon = Math.floor(lon / 2) * 2;
  return { cell: `${cLat}/${cLon}`, file: `${tLat.toFixed(6)}_${tLon.toFixed(6)}_${(tLat + 0.25).toFixed(6)}_${(tLon + 0.25).toFixed(6)}`, tLat, tLon, cLat, cLon };
}
