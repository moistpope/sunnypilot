// Small, dependency-free DBC reader + decoder (a port of the former Python dbc.py, which the comma
// keeps only for the demo drive). The HUD needs "latest value of every signal", decoded at display
// rate, plus the metadata opendbc drops: value-table names, comments, units, ranges. Runs in the
// page's world-model worker; also in Node for the tests and tools.

const BO_RE = /^BO_\s+(\d+)\s+(\w+)\s*:\s*(\d+)\s+(\w+)/;
const SG_RE = /^\s*SG_\s+(\w+)\s*(M|m\d+)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(([^,]+),([^)]+)\)\s*\[([^|]*)\|([^\]]*)\]\s*"([^"]*)"/;
const VAL_RE = /^VAL_\s+(\d+)\s+(\w+)\s+(.*);\s*$/;
const VAL_PAIR_RE = /(-?\d+)\s+"([^"]*)"/g;
const CM_SG_RE = /^CM_\s+SG_\s+(\d+)\s+(\w+)\s+"([\s\S]*?)";/gm;
const CM_BO_RE = /^CM_\s+BO_\s+(\d+)\s+"([\s\S]*?)";/gm;
const CYCLE_RE = /^BA_\s+"GenMsgCycleTime"\s+BO_\s+(\d+)\s+(\d+);/gm;

const parseFloatOr = (s, d = 0) => { const v = parseFloat(s); return Number.isNaN(v) ? d : v; };

export class Signal {
  constructor(name, startBit, size, littleEndian, signed, factor, offset, minimum, maximum, unit) {
    this.name = name;
    this.startBit = startBit;
    this.size = size;
    this.littleEndian = littleEndian;
    this.signed = signed;
    this.factor = factor;
    this.offset = offset;
    this.minimum = minimum;
    this.maximum = maximum;
    this.unit = unit;
    this.values = {};        // raw -> value-table name
    this.comment = '';
    // precomputed for a frame of the message's size: the linear bit index (0 = MSB of byte 0 for
    // Motorola; 0 = LSB of byte 0 for Intel) of the signal's most and least significant bits
    this.msb = 0;
    this.lsb = 0;
    this.big = size > 52;    // doesn't fit a double's integer range: decoded through BigInt
  }

  rawToPhys(raw) {
    if (this.signed && raw >= 2 ** (this.size - 1)) raw -= 2 ** this.size;
    return raw * this.factor + this.offset;
  }

  /** Value-table name for a decoded value, if the DBC has one. */
  describe(value) {
    if (!this.factor || !Object.keys(this.values).length) return null;
    const key = String(pyRound((value - this.offset) / this.factor, 0));
    return key in this.values ? this.values[key] : null;
  }

  toJSON() {
    return {
      name: this.name, startBit: this.startBit, size: this.size, littleEndian: this.littleEndian, signed: this.signed,
      factor: this.factor, offset: this.offset, min: this.minimum, max: this.maximum, unit: this.unit,
      values: { ...this.values }, comment: this.comment,
    };
  }
}

export class Message {
  constructor(address, name, size, transmitter) {
    this.address = address;
    this.name = name;
    this.size = size;
    this.transmitter = transmitter;
    this.signals = {};   // name -> Signal, in DBC order
    this.comment = '';
    this.cycleMs = 0;
  }

  finalize() {
    for (const sig of Object.values(this.signals)) {
      if (sig.littleEndian) {
        sig.lsb = sig.startBit;                 // Intel: start is the LSB; bits ascend
        sig.msb = sig.startBit + sig.size - 1;
      } else {
        // Motorola: start_bit is the MSB in DBC "sawtooth" numbering. Convert to a linear big-endian
        // bit index (0 = MSB of byte 0); the LSB follows size-1 bits later.
        sig.msb = (sig.startBit >> 3) * 8 + (7 - (sig.startBit & 7));
        sig.lsb = sig.msb + sig.size - 1;
      }
    }
  }

  /** Decode every signal of a frame (Uint8Array or array of bytes) into physical values. */
  decode(data) {
    const n = this.size;
    let d = data instanceof Uint8Array ? data : Uint8Array.from(data);
    if (d.length !== n) {
      const padded = new Uint8Array(n);          // short frames are zero padded, long ones cut
      padded.set(d.length > n ? d.subarray(0, n) : d);
      d = padded;
    }
    const out = {};
    for (const name in this.signals) {
      const sig = this.signals[name];
      let raw = sig.big ? Number(extractBig(d, sig)) : extract(d, sig);
      if (sig.signed && raw >= 2 ** (sig.size - 1)) raw -= 2 ** sig.size;
      out[name] = (sig.factor !== 1 || sig.offset !== 0) ? raw * sig.factor + sig.offset : raw;
    }
    return out;
  }

  /** Pack physical values into a frame, starting from `base` (unlisted signals keep their bits). */
  encode(values, base = null) {
    const data = new Uint8Array(this.size);
    if (base) data.set(base.length > this.size ? base.subarray(0, this.size) : base);
    for (const name in values) {
      const sig = this.signals[name];
      if (!sig) throw new Error(`no signal ${name} in ${this.name}`);
      const value = values[name];
      let raw;
      if (Number.isInteger(value) && sig.factor === 1 && sig.offset === 0) raw = BigInt(value);
      else raw = BigInt(pyRound((value - sig.offset) / sig.factor, 0));
      if (raw < 0n) raw += 1n << BigInt(sig.size);
      raw &= (1n << BigInt(sig.size)) - 1n;
      for (let i = 0; i < sig.size; i++) {
        const bit = Number((raw >> BigInt(i)) & 1n);
        // position of value bit i: Intel ascends from lsb; Motorola descends from the linear lsb
        const lin = sig.littleEndian ? sig.lsb + i : sig.lsb - i;
        const byte = lin >> 3;
        const pos = sig.littleEndian ? (lin & 7) : 7 - (lin & 7);
        if (bit) data[byte] |= 1 << pos; else data[byte] &= ~(1 << pos);
      }
    }
    return data;
  }

  toJSON() {
    return {
      address: this.address, name: this.name, size: this.size, transmitter: this.transmitter,
      comment: this.comment, cycleMs: this.cycleMs, signals: Object.values(this.signals).map(s => s.toJSON()),
    };
  }
}

// bit extraction: ≤ 52 bits as a double, byte by byte
function extract(d, sig) {
  let val = 0;
  if (sig.littleEndian) {
    // from the MSB down: byte (msb>>3) holds the top bits
    let lin = sig.msb;
    let remaining = sig.size;
    while (remaining > 0) {
      const byte = lin >> 3, top = lin & 7;          // bits top..max(0, top-remaining+1) of this byte
      const take = Math.min(remaining, top + 1);
      const shift = top - take + 1;
      val = val * 2 ** take + ((d[byte] >> shift) & ((1 << take) - 1));
      remaining -= take;
      lin -= take;
    }
  } else {
    let lin = sig.msb;
    let remaining = sig.size;
    while (remaining > 0) {
      const byte = lin >> 3, top = 7 - (lin & 7);    // bits top..max(0, top-remaining+1) of this byte
      const take = Math.min(remaining, top + 1);
      const shift = top - take + 1;
      val = val * 2 ** take + ((d[byte] >> shift) & ((1 << take) - 1));
      remaining -= take;
      lin += take;
    }
  }
  return val;
}

function extractBig(d, sig) {
  let val = 0n;
  for (let i = sig.size - 1; i >= 0; i--) {
    const lin = sig.littleEndian ? sig.lsb + i : sig.lsb - i;
    const byte = lin >> 3;
    const pos = sig.littleEndian ? (lin & 7) : 7 - (lin & 7);
    val = (val << 1n) | BigInt((d[byte] >> pos) & 1);
  }
  return val;
}

/** Python's round(): nearest, ties to even on the scaled value. */
export function pyRound(v, nd = 0) {
  const k = 10 ** nd;
  const s = v * k;
  const f = Math.floor(s);
  const diff = s - f;
  let r;
  if (diff === 0.5) r = f % 2 === 0 ? f : f + 1;
  else r = Math.round(s);
  return nd ? r / k : r;
}

export class DBC {
  constructor(text) {
    this.messages = new Map();   // address -> Message, in file order
    this.byName = {};
    this._parse(text.replace(/\r\n/g, '\n'));
  }

  _parse(text) {
    let cur = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('BO_ ')) {
        const m = BO_RE.exec(line);
        cur = null;
        if (m) {
          const addr = Number(BigInt(m[1]) & 0x1FFFFFFFn);   // extended IDs carry bit 31 in DBC files
          cur = new Message(addr, m[2], parseInt(m[3], 10), m[4]);
          this.messages.set(addr, cur);
          this.byName[cur.name] = cur;
        }
      } else if (cur !== null && line.trimStart().startsWith('SG_ ')) {
        const m = SG_RE.exec(line);
        if (m) {
          cur.signals[m[1]] = new Signal(m[1], parseInt(m[3], 10), parseInt(m[4], 10), m[5] === '1', m[6] === '-',
            parseFloatOr(m[7], 1), parseFloatOr(m[8]), parseFloatOr(m[9]), parseFloatOr(m[10]), m[11]);
        }
      } else if (line.startsWith('VAL_ ')) {
        const m = VAL_RE.exec(line);
        if (m) {
          const msg = this.messages.get(Number(BigInt(m[1]) & 0x1FFFFFFFn));
          if (msg && m[2] in msg.signals) {
            const values = {};
            for (const pair of m[3].matchAll(VAL_PAIR_RE)) values[String(parseInt(pair[1], 10))] = pair[2];
            msg.signals[m[2]].values = values;
          }
        }
      }
    }
    for (const m of text.matchAll(CM_SG_RE)) {
      const msg = this.messages.get(Number(BigInt(m[1]) & 0x1FFFFFFFn));
      if (msg && m[2] in msg.signals) msg.signals[m[2]].comment = m[3].split(/\s+/).join(' ').trim();
    }
    for (const m of text.matchAll(CM_BO_RE)) {
      const msg = this.messages.get(Number(BigInt(m[1]) & 0x1FFFFFFFn));
      if (msg) msg.comment = m[2].split(/\s+/).join(' ').trim();
    }
    for (const m of text.matchAll(CYCLE_RE)) {
      const msg = this.messages.get(Number(BigInt(m[1]) & 0x1FFFFFFFn));
      if (msg) msg.cycleMs = parseInt(m[2], 10);
    }
    for (const msg of this.messages.values()) msg.finalize();
  }

  decode(address, data) {
    const msg = this.messages.get(address);
    return msg ? msg.decode(data) : null;
  }
}

export function hexToBytes(hex) {
  const n = hex.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** Same bytes? (frames are compared to skip re-decoding an unchanged one) */
export function bytesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
