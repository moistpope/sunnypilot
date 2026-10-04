// The Fisker Ocean's mid-range radar (MRR), read from its private CAN-FD link on panda bus 1 (a port
// of the former Python fisker_radar.py; it now runs in the page's world-model worker).
//
// The radar's messages aren't in the FM29 matrix; opendbc/dbc/fisker_ocean_mrr.dbc is
// reverse-engineered from a drive (its comments say how each scale was checked). Every 65 ms radar
// cycle brings a header (0x300) and 32 object slots (0x310..0x32F), filled from the first slot up;
// an object has a persistent track ID, position, relative velocity and acceleration, and for tracks
// the radar has classified, heading, size and class. The slot IDs overlap ADASBUS IDs but are
// unrelated 48-byte frames, so this bus is kept apart from FiskerWorld.
//
// Coordinate frame of the returned objects: x forward, y LEFT, meters, origin at the radar (front
// bumper), like FiskerWorld's object list. The radar's own lateral axis is +right; it's flipped here.
import { bytesEqual, pyRound } from './dbc.js';

export const BUS_RADAR = 1;
export const TIME_SYNC = 0x100;
export const HEADER = 0x300;
export const EGO_MOTION = 0x400;
export const SLOTS = Array.from({ length: 32 }, (_, i) => 0x310 + i);
const SLOT_SET = new Set(SLOTS);
export const STALE_S = 0.5;
const CYCLE_SETTLE_S = 0.03;   // a cycle's frames arrive within a few ms; it's complete once quiet this long
const MEAS_LATENCY_S = 0.10;   // measured -> received, when the bus's time sync is missing
const HEADING_NA = 178.0;      // raw 255 (178.6 deg) = no heading
// Class values seen on the drive (tentative): point targets the radar hasn't classified are 0.
const RADAR_CLASSES = { 0: 'unclassified', 1: 'car', 6: 'pedestrian', 8: 'small' };

const r = (v, nd = 2) => (v == null ? null : pyRound(v, nd));
const u32be = (d, i) => ((d[i] << 24) >>> 0) + (d[i + 1] << 16) + (d[i + 2] << 8) + d[i + 3];

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

export class FiskerRadar {
  /** dbc: the radar DBC, or null (no radar DBC: the radar view is disabled). */
  constructor(dbc) {
    this.dbc = dbc || null;
    this.wanted = new Set(dbc ? dbc.messages.keys() : []);
    this.frames = new Map();     // addr -> [data, t]
    this._decoded = new Map();   // addr -> [data, values]
    this._slotSig = new Map();
    SLOTS.forEach((addr, n) => {
      const nn = String(n).padStart(2, '0');
      const sig = {};
      for (const k of ['ID', 'Age', 'DistLong', 'DistLat', 'VrelLong', 'VrelLat', 'ArelLong', 'DynProp', 'Heading', 'Width', 'Length', 'Class',
        'State', 'Quality', 'MeasHistory']) sig[k] = `MRR_Obj${nn}_${k}`;
      this._slotSig.set(addr, sig);
    });
    this.reset();
  }

  reset() {
    this.frames.clear();
    this._decoded.clear();
    this._cycles = new Map();   // cycle counter -> {first, last, hdr, slots}, until complete
    this._sync = null;          // [t, seconds] of the last SYNC
    this._offsets = [];         // recent (global time - log time) from the bus's time sync
    this._lastMeas = null;      // "sec,ns,counter" of the last cycle handed out
  }

  /** frames: array of [address, data (Uint8Array), src]. */
  update(frames, t) {
    const wanted = this.wanted;
    for (const [addr, data, src] of frames) {
      if (src !== BUS_RADAR || !wanted.has(addr)) continue;
      this.frames.set(addr, [data, t]);
      if (SLOT_SET.has(addr)) {
        this._cycle(((data[36] & 0x3) << 4) | (data[37] >> 4), t).slots.set(addr, data);   // MRR_ObjNN_CycleCounter
      } else if (addr === HEADER) {
        this._cycle(data[21] >> 2, t).hdr = data;                                            // MRR_CycleCounter
      } else if (addr === TIME_SYNC && data.length >= 8) {
        // AUTOSAR CanTSyn: SYNC (0x20) carries the seconds of the global time at its send, FUP (0x28) the ns
        if (data[0] === 0x20) {
          this._sync = [t, u32be(data, 4)];
        } else if (data[0] === 0x28 && this._sync !== null && t - this._sync[0] < 0.1) {
          this._offsets.push(this._sync[1] + u32be(data, 4) * 1e-9 - this._sync[0]);
          if (this._offsets.length > 15) this._offsets = this._offsets.slice(-15);
        }
      }
    }
  }

  _cycle(c, t) {
    let cyc = this._cycles.get(c);
    if (cyc === undefined || t - cyc.last > 1.0) {   // the 6-bit counter wraps every 4.2 s
      cyc = { first: t, last: t, hdr: null, slots: new Map() };
      this._cycles.set(c, cyc);
    }
    cyc.last = t;
    return cyc;
  }

  /** Every radar cycle completed since the last call: [time it was measured, its objects]. */
  takeCycles(now) {
    const out = [];
    const g2m = this._offsets.length ? median(this._offsets) : null;
    const done = [];
    for (const c of [...this._cycles.keys()]) {
      const cyc = this._cycles.get(c);
      if (now - cyc.last < CYCLE_SETTLE_S) continue;
      this._cycles.delete(c);
      if (cyc.hdr !== null && this.dbc !== null) done.push(cyc);
    }
    done.sort((a, b) => a.first - b.first);
    for (const cyc of done) {
      const hdr = this.dbc.messages.get(HEADER).decode(cyc.hdr);
      const measRaw = `${Math.trunc(hdr.MRR_MeasTime_Sec)},${Math.trunc(hdr.MRR_MeasTime_NSec)},${Math.trunc(hdr.MRR_CycleCounter)}`;
      // the radar now and then sends a cycle's header again (same MeasTime and counter, 124 of 923 cycles on
      // 000000b5--bfe13ac451--13), sometimes with its objects too: a cycle measured once is handed out once
      if (measRaw === this._lastMeas) continue;
      this._lastMeas = measRaw;
      let t = cyc.first - MEAS_LATENCY_S;
      if (g2m !== null) {
        const meas = Math.trunc(hdr.MRR_MeasTime_Sec) + Math.trunc(hdr.MRR_MeasTime_NSec) * 1e-9 - g2m;
        if (-0.5 < cyc.first - meas && cyc.first - meas < 1.0) t = meas;
      }
      const objs = [];
      for (const [addr, data] of cyc.slots) {
        if (data[3] || data[4]) objs.push(this._slotObject(addr, this.dbc.messages.get(addr).decode(data)));
      }
      out.push([t, objs]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out;
  }

  _slotObject(addr, v) {
    const sig = this._slotSig.get(addr);
    const heading = v[sig.Heading];
    const cls = Math.trunc(v[sig.Class]);
    return {
      id: Math.trunc(v[sig.ID]),
      x: r(v[sig.DistLong]),
      y: r(-v[sig.DistLat]),
      vx: r(v[sig.VrelLong]),
      vy: r(-v[sig.VrelLat]),
      ax: r(v[sig.ArelLong]),
      heading: heading > HEADING_NA ? null : r(-heading, 1),   // radar heading is clockwise-positive
      cls: cls in RADAR_CLASSES ? RADAR_CLASSES[cls] : `class ${cls}`,
      dyn: Math.trunc(v[sig.DynProp]),
      age: Math.trunc(v[sig.Age]),
      state: Math.trunc(v[sig.State]),
      quality: Math.trunc(v[sig.Quality]),
      hist: Math.trunc(v[sig.MeasHistory]),
      w: r(v[sig.Width]) || null,
      l: r(v[sig.Length]) || null,
    };
  }

  _decode(addr, now) {
    const entry = this.frames.get(addr);
    if (entry === undefined || now - entry[1] > STALE_S) return null;
    const cached = this._decoded.get(addr);
    if (cached !== undefined && bytesEqual(cached[0], entry[0])) return cached[1];
    const values = this.dbc.messages.get(addr).decode(entry[0]);
    this._decoded.set(addr, [entry[0], values]);
    return values;
  }

  /** null while the radar bus is silent (or this harness doesn't tap it). */
  state(now) {
    if (this.dbc === null) return null;
    const hdr = this._decode(HEADER, now);
    if (hdr === null) return null;
    const byId = new Map();   // id -> [t, object]
    for (const addr of SLOTS) {
      const entry = this.frames.get(addr);
      // empty slots carry ID 0 (bytes 3-4); skip them before decoding all ~35 signals
      if (entry === undefined || !(entry[0][3] || entry[0][4])) continue;
      const v = this._decode(addr, now);
      if (v === null) continue;
      const o = this._slotObject(addr, v);
      // a track can change slots between cycles; if a snapshot catches it in both, keep the newer
      const prev = byId.get(o.id);
      if (prev !== undefined && prev[0] >= entry[1]) continue;
      byId.set(o.id, [entry[1], o]);
    }
    const ego = this._decode(EGO_MOTION, now);
    const objects = [...byId.values()].map(e => e[1]).sort((a, b) => a.x - b.x);
    return {
      count: Math.trunc(hdr.MRR_NumObjects),
      cycle: Math.trunc(hdr.MRR_CycleCounter),
      egoSpeed: ego === null ? null : r(ego.MRR_EgoSpeed),
      objects,
    };
  }
}
