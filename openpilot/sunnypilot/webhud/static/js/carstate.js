// The car's real state, decoded from the IBUS1/IBUS2 frames the Android app forwards (android/,
// CanBridge). The gateway broadcasts these status messages all the time; the app reads them and hands
// them here as `webhud:can` events, a batch of { bus, addr, data(hex) }. This decodes the car-state
// messages with the table generated from the vendor matrices (ibus_tables.js) and keeps the latest value
// of each signal, so the car-control menus can show and follow what the car is actually doing. The ADAS
// mirror on IBUS2 isn't decoded here: main.js hands every frame to the world-model worker, which reads
// them with the IBUS DBC when the comma isn't there. In a plain browser, or until a frame of a message
// arrives, its signals are absent and the menus fall back to the mockup. A demo feeds synthetic frames
// for working without the car.
//
// The app's helper repeats every message's current frame once a second even when it hasn't changed, so
// a signal still goes stale (STALE_MS) only when its message really stops: the car asleep, or the link down.
import { RX_MESSAGES } from './ibus_tables.js';

export const STALE_MS = 4000;

// signal name -> its definition and which (bus,addr) carries it; (bus,addr) -> its message
export const SIGNALS = new Map();
export const BY_MSG = new Map();
for (const msg of RX_MESSAGES) {
  BY_MSG.set(msg.bus + '/' + msg.addr, msg);
  for (const s of msg.signals) SIGNALS.set(s.name, { ...s, bus: msg.bus, addr: msg.addr });
}

/** One field out of a frame: Motorola (start = the MSB, DBC numbering) unless `intel` (start = the LSB). */
export function extract(data, sig) {
  let val = 0;
  if (sig.intel) {
    for (let i = sig.len - 1; i >= 0; i--) {
      const pos = sig.start + i;
      val = val * 2 + ((data[pos >> 3] >> (pos & 7)) & 1);
    }
  } else {
    let lin = (sig.start >> 3) * 8 + 7 - (sig.start & 7);   // linear big-endian index of the MSB
    for (let i = 0; i < sig.len; i++, lin++) {
      const byte = lin >> 3;
      val = val * 2 + (byte < data.length ? (data[byte] >> (7 - (lin & 7))) & 1 : 0);
    }
  }
  if (sig.signed && val >= 2 ** (sig.len - 1)) val -= 2 ** sig.len;
  return val;
}

/** Every signal of a frame, decoded to physical values ({name: value}); null for an unknown message. */
export function decodeFrame(bus, addr, data) {
  const msg = BY_MSG.get(bus + '/' + addr);
  if (!msg) return null;
  const out = {};
  for (const s of msg.signals) out[s.name] = extract(data, s) * (s.res ?? 1) + (s.off ?? 0);
  return out;
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
      if (now) window.dispatchEvent(new CustomEvent('webhud:can', { detail: JSON.parse(now) }));   // this and the worker both listen
    } catch { /* not in the app, or an older one */ }
  }

  // a batch of frames: [{ bus, addr, data }]; data is hex
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
        this.raw.set(s.name, extract(bytes, s));
        this.at.set(s.name, now);
      }
    }
  }

  // raw integer of a signal, or undefined if we've never decoded it (or it's gone stale)
  rawOf(name, maxAgeMs = STALE_MS) {
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
  live(bus, addr, maxAgeMs = STALE_MS) {
    const t = this.msgAt.get(bus + '/' + addr);
    return t !== undefined && performance.now() - t < maxAgeMs;
  }

  // is any car data arriving (the app's CAN link is up)?
  get connected() {
    const now = performance.now();
    for (const t of this.msgAt.values()) if (now - t < STALE_MS) return true;
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

/** A frame of message (bus, addr) with the given raw signal values (the rest 0), as hex; for the demo and tests. */
export function packFrame(bus, addr, sigs) {
  const msg = BY_MSG.get(bus + '/' + addr);
  const bytes = new Uint8Array(8);
  for (const [name, raw] of Object.entries(sigs)) {
    const s = msg.signals.find(x => x.name === name);
    let lin = (s.start >> 3) * 8 + 7 - (s.start & 7);
    for (let i = s.len - 1; i >= 0; i--, lin++) {
      if ((raw >> i) & 1) bytes[lin >> 3] |= 1 << (7 - (lin & 7));
    }
  }
  return { bus, addr, data: [...bytes].map(b => b.toString(16).padStart(2, '0')).join('') };
}

// ---- demo: synthesize a few messages so the read-out works without the car ----
class Demo {
  constructor(cs) { this.cs = cs; this.t = 0; }
  frame() {
    this.t = (this.t || 0) + 1;
    // a parked car: unlocked, driver door open, driver window half down, Normal mode, climate on at 21C, SOC 72, charging at 7 kW
    const f = [
      packFrame('IBUS1', 0x343, { BCM_CenLockSwtSts: 1, BCM_FrntDrDoorLockSts: 1, BCM_DrFrntDoorSts: 1, BCM_LeFrntWinSts: 1, BCM_SunroofSts: 0, BCM_SunroofPosnInfo: 0, BCM_LeDRLOutpCmd: 1, BCM_RiDRLOutpCmd: 1 }),
      packFrame('IBUS1', 0x234, { VCU_GearSig: 1, VCU_DrvModSigFb: 1, VCU_RdyLamp: 1, VCU_VehSt: 5 }),
      packFrame('IBUS1', 0x373, { ECC_ACSts: 1, ECC_WindSpdSts: 3, ECC_DrvrTSetSts: 42, ECC_PassTSetSts: 44, ECC_AUTOSts: 1, ECC_OutdT: (18 + 48) * 2, ECC_OutdTVld: 1, ECC_DrvrAirOutlMod: 1, ECC_CircSts: 1 }),
      packFrame('IBUS1', 0x358, { VCU_RegenLvlFb: 1, VCU_EPedlStsFb: 2, VCU_AccelModFb: 1, VCU_CcTrgSpdDisp: 255 }),
      packFrame('IBUS1', 0x2F5, { BMS_Bat_SoC_usable: 72, BMS_Bat_SOC_Real: 70, BMS_Bat_SOH: 97, BMS_Bat_Actual_Pack_Capacity: 10600 }),
      packFrame('IBUS1', 0x335, { BCM_ExtLampSwtSts: 1, BCM_HiBeamOutpCmd: 0, BCM_FrntFogLampSwtSts: 0, BCM_VehAmbBri: 180, BCM_IntLampTiSetSts: 3, BCM_PosnLampOutpCmd: 3 }),
      packFrame('IBUS1', 0x518, { DSMC_DrvrSeatHeatgSts: 2, DSMC_RearLeSeatHeatgSts: 4, DSMC_RearRiSeatHeatgSts: 4 }),
      packFrame('IBUS1', 0x512, { PSM_PassSeatHeatgSts: 4 }),
      packFrame('IBUS1', 0x4F5, { DSMC_DrvrSeatTrackPosn: 40, DSMC_DrvrSeatHeiPosn: 50, DSMC_DrvrSeatBackPosn: 30 }),
      packFrame('IBUS1', 0x554, { VCU_HVBattActPwr: 6000 + 72, VCU_ACChrgDchaIndcrLampSts: 3 }),
      packFrame('IBUS1', 0x471, { PLGM_TrSts: 0, PLGM_LeTrPosn: 0, PLGM_TrSwtStsIndcn: 0 }),
      packFrame('IBUS2', 0x321, { BCM_AP_FL_LeFrntWinPosnInfo: 100, BCM_AP_FL_RiFrntWinPosnInfo: 0 }),
      packFrame('IBUS2', 0x369, { BCM_AP_RW_WinPosnInfo: 0 }),
      packFrame('IBUS2', 0x236, { VCU_ACChrgDchaGunCnctnSts: 2, VCU_VcuState: 7 }),
      packFrame('IBUS2', 0xE9, { BMS_Bat_HVmeasure_Current: 380, BMS_Bat_Hvmeasure_V_Pack: 38500 }),
      packFrame('IBUS2', 0x634, { VCU_ACChrgShttrSts: 1, VCU_ACChrgCrtUpprLmt: 32 }),
      packFrame('IBUS2', 0x630, { VCU_ACRmngChrgTi: 95 }),
      packFrame('IBUS2', 0x580, { VCU_PwrBattAvlEgy: 7600 }),
    ];
    this.cs.feed(f);
  }
}
