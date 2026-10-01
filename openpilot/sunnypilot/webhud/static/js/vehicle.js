// What the ego car is doing right now, distilled from a state snapshot for the 3D view and the HUD:
// signed speed for animation (frozen while a replay is paused or data goes stale), steering angle,
// and lamp states that mirror the car's own lamp outputs.

export const STEER_RATIO = 15.0;   // opendbc/car/fisker/values.py CarSpecs
export const WHEELBASE = 2.921;    // m

const FISKER_GEAR = { gear_P: 'park', gear_N: 'neutral', R_gear: 'reverse', D_gear: 'drive', gear_D: 'drive', gear_E: 'drive', gear_S: 'drive' };
const STALE_MS = 1500;

// The Fisker BCM's turn-lamp outputs (and carState blinkers, which copy them) already flash on/off
// every 0.4 s, so they are mirrored as-is. A source that reports a solid "on" instead gets a local
// flash after a second, so the HUD still blinks.
class Flasher {
  constructor() { this.raw = false; this.since = 0; }
  update(raw, t, live) {
    if (raw !== this.raw) { this.raw = raw; this.since = t; }
    if (raw && live && t - this.since > 1.0) return (t - this.since) % 0.8 < 0.4;
    return raw;
  }
}

export class VehicleState {
  constructor() {
    this.t = 0;
    this.flash = { left: new Flasher(), right: new Flasher() };
    this.speed = 0;      // m/s, display (unsigned)
    this.v = 0;          // m/s, signed animation speed (negative in reverse, x replay rate, 0 when paused)
    this.steerDeg = 0;   // steering wheel angle, + = left
    this.gear = null;
    this.lamps = { left: false, right: false, brake: false, reverse: false, low: false, high: false, drl: false, position: false };
  }

  update(state, ageMs, dt) {
    this.t += dt;
    const op = (state && state.op) || {};
    const cs = op.carState;
    const fv = state && state.fisker && state.fisker.vehicle;
    const L = (fv && fv.lights) || {};

    this.speed = cs ? cs.vEgo || 0 : (fv && fv.speedKph != null ? fv.speedKph / 3.6 : 0);
    this.gear = (cs && cs.gear) || (fv && FISKER_GEAR[fv.gear]) || null;
    const replay = state && state.mode === 'replay' ? state.replay : null;
    const live = !(replay && !replay.playing) && ageMs < STALE_MS;
    const rate = replay ? replay.speed || 1 : 1;
    this.v = live ? this.speed * (this.gear === 'reverse' ? -1 : 1) * rate : 0;

    const steer = cs && cs.steeringAngleDeg != null ? cs.steeringAngleDeg : fv && fv.steeringAngle;
    this.steerDeg = steer || 0;

    const hazard = !!L.hazard && L.left == null;   // only when the lamp outputs themselves are missing
    const rawLeft = L.left != null ? !!L.left : !!(cs && cs.leftBlinker) || hazard;
    const rawRight = L.right != null ? !!L.right : !!(cs && cs.rightBlinker) || hazard;
    const carOn = !!cs || !!(fv && fv.ready);
    this.lamps = {
      left: this.flash.left.update(rawLeft, this.t, live),
      right: this.flash.right.update(rawRight, this.t, live),
      // the BCM brake-lamp output also lights for regen/one-pedal braking, not just the pedal
      brake: L.brake != null ? !!L.brake : !!(cs && cs.brakePressed),
      reverse: L.reverse != null ? !!L.reverse : this.gear === 'reverse',
      low: !!L.low,
      high: !!L.high,
      drl: L.drl != null ? !!L.drl : carOn,
      position: L.position != null ? L.position > 0 : !!L.low,
    };
  }

  // path curvature implied by the steering angle (bicycle model), 1/m, + = left
  get curvature() {
    return Math.tan((this.steerDeg / STEER_RATIO) * Math.PI / 180) / WHEELBASE;
  }
}
