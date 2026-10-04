// The car's real state, decoded from the IBUS1/IBUS2 frames the Android app forwards (android/,
// CanBridge). The gateway broadcasts these status messages all the time; the app reads them (receive
// only, never sends) and hands them here as `webhud:can` events, a batch of { bus, addr, data(hex) }.
// This decodes them with the table in carsignals.js and keeps the latest value of each signal, so the
// car-control menus can show what the car is actually doing. In a plain browser, or until a frame of a
// message arrives, its signals are absent and the menus fall back to the mockup. A demo feeds synthetic
// frames for working without the car.
//
// Decoding matches the vendor matrices: every signal is Motorola / big-endian, `start` is the position
// of its most significant bit in the usual DBC numbering. Validated against opendbc's CANParser.
import { CAN_MESSAGES } from './carsignals.js';

// signal name -> its definition and which (bus,addr) carries it; (bus,addr) -> its signals
const SIGNALS = new Map();
const BY_MSG = new Map();
for (const msg of CAN_MESSAGES) {
  const key = msg.bus + '/' + msg.addr;
  BY_MSG.set(key, msg);
  for (const s of msg.signals) SIGNALS.set(s.name, { ...s, bus: msg.bus, addr: msg.addr });
}

// one big-endian field out of up to 8 data bytes
function extract(data, start, len, signed) {
  let val = 0, bit = start;
  for (let i = 0; i < len; i++) {
    const byte = bit >> 3, pos = bit & 7;
    val = val * 2 + ((data[byte] >> pos) & 1);
    bit = pos === 0 ? bit + 15 : bit - 1;
  }
  if (signed && val >= 2 ** (len - 1)) val -= 2 ** len;
  return val;
}

export class CarState {
  constructor(app) {
    this.app = app;
    this.raw = new Map();     // signal name -> raw integer
    this.at = new Map();      // signal name -> performance.now() when last decoded
    this.msgAt = new Map();   // bus/addr -> when that message last arrived
    this.demo = null;
    window.addEventListener('webhud:can', (e) => { if (!this.demo) this.feed(e.detail); });
    this.apply();
  }

  apply() {
    const on = this.app.settings.demoCarState;
    if (on && !this.demo) this.demo = new Demo(this);
    else if (!on && this.demo) { this.demo = null; this.raw.clear(); this.at.clear(); this.msgAt.clear(); this._pull(); }
    else this._pull();
  }

  // whatever the app already had (it sends the current value of every message when the page starts)
  _pull() {
    if (this.demo) return;
    try {
      const now = window.WebHudApp?.canState?.();
      if (now) this.feed(JSON.parse(now));
    } catch { /* not in the app, or an older one */ }
  }

  // a batch of frames: [{ bus, addr, data }]; data is hex, little matters but the ID must be known
  feed(frames) {
    if (!Array.isArray(frames)) return;
    const now = performance.now();
    for (const f of frames) {
      const msg = BY_MSG.get(f.bus + '/' + f.addr);
      if (!msg) continue;
      const bytes = hexBytes(f.data);
      if (bytes.length < 1) continue;
      this.msgAt.set(f.bus + '/' + f.addr, now);
      for (const s of msg.signals) {
        if ((s.start >> 3) >= bytes.length) continue;
        this.raw.set(s.name, extract(bytes, s.start, s.len, s.signed));
        this.at.set(s.name, now);
      }
    }
  }

  // raw integer of a signal, or undefined if we've never decoded it (or it's gone stale)
  rawOf(name, maxAgeMs = 4000) {
    const t = this.at.get(name);
    if (t === undefined || performance.now() - t > maxAgeMs) return undefined;
    return this.raw.get(name);
  }

  // physical value (raw * res + off), or undefined
  value(name, maxAgeMs) {
    const r = this.rawOf(name, maxAgeMs);
    if (r === undefined) return undefined;
    const s = SIGNALS.get(name);
    return r * (s.res ?? 1) + (s.off ?? 0);
  }

  // the enum label of a signal's current raw value, or undefined
  label(name, maxAgeMs) {
    const r = this.rawOf(name, maxAgeMs);
    const s = SIGNALS.get(name);
    return r === undefined || !s?.enum ? undefined : s.enum[r];
  }

  // are we getting this message from the car right now?
  live(bus, addr, maxAgeMs = 4000) {
    const t = this.msgAt.get(bus + '/' + addr);
    return t !== undefined && performance.now() - t < maxAgeMs;
  }

  // is any car data arriving (the app's CAN link is up)?
  get connected() {
    const now = performance.now();
    for (const t of this.msgAt.values()) if (now - t < 4000) return true;
    return false;
  }

  frame() { if (this.demo) this.demo.frame(); }
}

function hexBytes(h) {
  if (!h) return new Uint8Array(0);
  const n = h.length >> 1, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

// ---- demo: synthesize a few messages so the read-out works without the car ----
class Demo {
  constructor(cs) { this.cs = cs; this.t = 0; }
  frame() {
    this.t = (this.t || 0) + 1;
    // a parked car: unlocked, driver window half down, Normal mode, climate on at 21C, SOC 72
    const f = [];
    const pack = (bus, addr, sigs) => {
      const msg = BY_MSG.get(bus + '/' + addr);
      const bytes = new Uint8Array(8).fill(0);
      for (const [name, raw] of Object.entries(sigs)) {
        const s = msg.signals.find(x => x.name === name);
        let bit = s.start;
        for (let i = s.len - 1; i >= 0; i--) {
          const b = (raw >> i) & 1, byte = bit >> 3, pos = bit & 7;
          bytes[byte] |= b << pos;
          bit = pos === 0 ? bit + 15 : bit - 1;
        }
      }
      f.push({ bus, addr, data: [...bytes].map(b => b.toString(16).padStart(2, '0')).join('') });
    };
    pack('IBUS1', 0x343, { BCM_CenLockSwtSts: 1, BCM_DrFrntDoorSts: 0, BCM_LeFrntWinSts: 1, BCM_SunroofSts: 0 });
    pack('IBUS1', 0x234, { VCU_GearSig: 1, VCU_DrvModSigFb: 1, VCU_RdyLamp: 1 });
    pack('IBUS1', 0x373, { ECC_ACSts: 1, ECC_WindSpdSts: 3, ECC_DrvrTSetSts: 42, ECC_AUTOSts: 1, ECC_OutdT: (18 + 48) * 2 });
    pack('IBUS1', 0x358, { VCU_RegenLvlFb: 1, VCU_EPedlStsFb: 0, VCU_AccelModFb: 1 });
    pack('IBUS1', 0x2F5, { BMS_Bat_SoC_usable: 72 });
    pack('IBUS1', 0x335, { BCM_ExtLampSwtSts: 1, BCM_HiBeamOutpCmd: 0, BCM_FrntFogLampSwtSts: 0, BCM_VehAmbBri: 180 });
    pack('IBUS1', 0x518, { DSMC_DrvrSeatHeatgSts: 2, DSMC_RearLeSeatHeatgSts: 4, DSMC_RearRiSeatHeatgSts: 4 });
    pack('IBUS1', 0x512, { PSM_PassSeatHeatgSts: 4 });
    pack('IBUS2', 0x321, { BCM_AP_FL_LeFrntWinPosnInfo: 100, BCM_AP_FL_RiFrntWinPosnInfo: 0 });
    this.cs.feed(f);
  }
}
