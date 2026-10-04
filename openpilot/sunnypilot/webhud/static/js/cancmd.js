// Sending to the car: the head unit's own control messages on IBUS1, through the Android app's CAN
// link (android/, CanBridge). Only the messages in TX_MESSAGES (ibus_tables.js, generated from the
// matrices) can be built here, and the app and its helper each check the same allowlist again before
// anything goes out. The messages come in two kinds:
//   event    the head unit sends them only when the driver touches something, three times 20 ms apart
//            (the matrix's OnWriteWithRepetition): a request of ours is one such touch;
//   cyclic   the head unit sends them every 100 ms with "no request" values between touches (seat
//            heat and moves, the liftgate): a request of ours goes out a few cycles and is then
//            followed by the idle frame, so the car doesn't keep acting on it. Held buttons (seat
//            adjusters) keep the request going until released.
// A frame starts from every signal's initial value (what the matrix says an untouched signal carries,
// "Inactive"/"No request"), so one frame asks for one thing.
import { TX_MESSAGES } from './ibus_tables.js';

const EVENT_REPEAT = 3, EVENT_GAP_MS = 20;   // the matrix: Nr. of repetitions 3, delay 20 ms
const PULSE_REPEAT = 3;                      // cycles a cyclic request is held before the idle frame
const HOLD_MS = 100;                         // the cyclic messages' cycle time

const BY_ADDR = new Map(TX_MESSAGES.map(m => [m.addr, { ...m, byName: new Map(m.signals.map(s => [s.name, s])) }]));

/** Physical -> raw, bounded to the signal's width. */
function rawOf(sig, value) {
  let raw = Number.isInteger(value) && sig.res === 1 && sig.off === 0 ? value : Math.round((value - sig.off) / sig.res);
  const max = 2 ** sig.len - 1;
  if (sig.signed && raw < 0) raw += 2 ** sig.len;
  return Math.max(0, Math.min(max, raw));
}

/** One frame of message `addr`: every signal at its initial value, then `values` ({name: physical}). */
export function encode(addr, values = {}) {
  const m = BY_ADDR.get(addr);
  if (!m) throw new Error(`0x${addr.toString(16)} is not a message the HUD sends`);
  const bytes = new Uint8Array(m.len);
  const put = (sig, raw) => {
    for (let i = 0; i < sig.len; i++) {   // from the LSB up: Motorola bits climb within a byte, then jump to the byte before
      const bit = (raw >>> i) & 1;
      let pos;
      if (sig.intel) pos = sig.start + i;
      else {
        const lsbLin = (sig.start >> 3) * 8 + 7 - (sig.start & 7) + sig.len - 1;   // linear index of the LSB
        const lin = lsbLin - i;
        pos = (lin >> 3) * 8 + 7 - (lin & 7);
      }
      const byte = pos >> 3, b = pos & 7;
      if (bit) bytes[byte] |= 1 << b; else bytes[byte] &= ~(1 << b);
    }
  };
  for (const sig of m.signals) put(sig, sig.init & (2 ** sig.len - 1));
  for (const [name, value] of Object.entries(values)) {
    const sig = m.byName.get(name);
    if (!sig) throw new Error(`${m.name} has no signal ${name}`);
    put(sig, rawOf(sig, value));
  }
  return bytes;
}

export const hex = (bytes) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

export class CarCommands {
  constructor(app) {
    this.app = app;
    this.holds = new Map();   // addr -> interval id, while a button is held
    this.lastError = null;
  }

  /** Whether sending is possible right now: in the app, with the car's bus awake. */
  get available() {
    const app = window.WebHudApp;
    return !!(app && typeof app.canSend === 'function' && this.app.carState && this.app.carState.live('IBUS1', 0x343, 3000));
  }

  get why() {
    if (!window.WebHudApp || typeof window.WebHudApp.canSend !== 'function') return 'Not in the car (the Android app sends to the car)';
    if (!this.app.carState || !this.app.carState.live('IBUS1', 0x343, 3000)) return 'The car is asleep, or its CAN link is down';
    return null;
  }

  _send(addr, bytes, repeat, gapMs) {
    const m = BY_ADDR.get(addr);
    let err;
    try {
      err = window.WebHudApp.canSend(JSON.stringify({ bus: m.bus, addr, data: hex(bytes), repeat, gapMs }));
    } catch (e) {
      err = String(e);
    }
    if (err) {
      this.lastError = err;
      this.app.toast(`Not sent: ${err}`);
      return false;
    }
    return true;
  }

  /** An event message: one touch. Returns false (and says why) when it couldn't go out. */
  request(addr, values) {
    if (!this.available) { this.app.toast(this.why); return false; }
    return this._send(addr, encode(addr, values), EVENT_REPEAT, EVENT_GAP_MS);
  }

  /** A cyclic message: the request for a few cycles, then its idle frame. */
  pulse(addr, values) {
    if (!this.available) { this.app.toast(this.why); return false; }
    if (!this._send(addr, encode(addr, values), PULSE_REPEAT, HOLD_MS)) return false;
    setTimeout(() => this._send(addr, encode(addr), 1, HOLD_MS), PULSE_REPEAT * HOLD_MS + 10);
    return true;
  }

  /** A cyclic message kept going while a button is held: call release() when it's let go. */
  hold(addr, values) {
    this.release(addr);
    if (!this.available) { this.app.toast(this.why); return false; }
    const bytes = encode(addr, values);
    if (!this._send(addr, bytes, 1, HOLD_MS)) return false;
    const id = setInterval(() => { if (!this._send(addr, bytes, 1, HOLD_MS)) this.release(addr); }, HOLD_MS);
    this.holds.set(addr, id);
    setTimeout(() => { if (this.holds.get(addr) === id) this.release(addr); }, 15000);   // a stuck pointer: let go anyway
    return true;
  }

  release(addr) {
    const id = this.holds.get(addr);
    if (id === undefined) return;
    clearInterval(id);
    this.holds.delete(addr);
    this._send(addr, encode(addr), 2, HOLD_MS);   // the idle frame: nothing requested
  }

  releaseAll() { for (const addr of [...this.holds.keys()]) this.release(addr); }
}
