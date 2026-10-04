// StateBuilder folds raw CAN frames and openpilot service extracts into the single snapshot the HUD
// renders (a port of the former Python state.py; it now runs in the page's world-model worker). The
// comma's bridge streams what it reads (sources.py, extract.py) in ticks; live and replay feed this
// identically, only the clock differs. Besides each source's own view it runs the world model
// (world_model.js), which fuses the object sources in a ground-fixed frame; its ego pose comes from the
// car's wheel speed and yaw-rate gyro on CAN when it has them. The world model's sensor calibration
// (on unless the view turns it off) corrects the sources and the speed.
import { hexToBytes } from './dbc.js';
import { FiskerRadar } from './fisker_radar.js';

/** A bridge tick's frames, [[address, bus, hex], ...], as the builder takes them. */
export function wireFrames(frames) {
  return frames.map(([addr, src, hex]) => [addr, hexToBytes(hex), src]);
}
import { FiskerWorld, OBJECT_MSGS } from './fisker_world.js';
import { MEASURED_CALIBRATION, NO_CALIBRATION, OP_LATENCY_S, WorldModel, adasMeasurement, calibrationToJson, opMeasurements, radarMeasurements } from './world_model.js';

const SERVICE_STALE_S = 2.0;
const ODOMETRY_CAN_S = 0.5;   // carState stands in for the CAN odometry once that's older than this
// ADASBUS odometry: the signals carState itself uses (opendbc/car/fisker/carstate.py)
const SPEED_MSG = 0x318, YAW_MSG = 0x112, GEAR_MSG = 0x214;
const GEAR_REVERSE = 3;       // VCU_GearSig

export class StateBuilder {
  /** worldDbc: the ADASBUS DBC; radarDbc: the radar's, or null. */
  constructor(worldDbc, radarDbc = null) {
    this.world = new FiskerWorld(worldDbc);
    this.radar = new FiskerRadar(radarDbc);
    this.model = new WorldModel();
    this.services = {};
    this.serviceT = {};
    this.brand = null;
    this.t = 0.0;
    this._odoCanT = -1e9;
    this._adasFed = new Map();
    this._rsFed = null;
  }

  reset() {
    this.world.reset();
    this.radar.reset();
    this.model.reset();
    this.services = {};
    this.serviceT = {};
    this.t = 0.0;
    this._odoCanT = -1e9;
    this._adasFed.clear();
    this._rsFed = null;
  }

  get fisker() {
    // an unknown brand still parses, so logs/benches without carParams work
    return this.brand === null || this.brand === 'fisker';
  }

  /** frames: [[address, data (Uint8Array), src], ...] received at t. */
  feedCan(frames, t) {
    this.t = Math.max(this.t, t);
    if (this.fisker) {
      this.world.update(frames, t);
      this.radar.update(frames, t);
      this._odometryFromCan(t);
    }
  }

  _odometryFromCan(t) {
    const spd = this.world.frames.get(SPEED_MSG), yaw = this.world.frames.get(YAW_MSG);
    if (spd === undefined || yaw === undefined || Math.max(spd[1], yaw[1]) !== t || t - Math.min(spd[1], yaw[1]) > 0.1) return;   // nothing new in this batch, or one of the two has gone quiet
    let v = this.world.decoded(SPEED_MSG, t).ESP_VehSpd / 3.6 * this.model.calib.speedScale;
    const gear = this.world.decoded(GEAR_MSG, t);
    if (gear !== null && Math.trunc(gear.VCU_GearSig) === GEAR_REVERSE) v = -v;
    this.model.odo.update(t, v, this.world.decoded(YAW_MSG, t).YRS_YawRate * Math.PI / 180);
    this._odoCanT = t;
  }

  /** data: the service's extract (extract.py's output), published at t. */
  feedService(which, data, t) {
    this.services[which] = data;
    this.serviceT[which] = t;
    this.t = Math.max(this.t, t);
    if (which === 'carParams') {
      this.brand = data.brand || this.brand;
    } else if (which === 'carState' && t - this._odoCanT > ODOMETRY_CAN_S) {
      const v = (data.vEgo || 0.0) * this.model.calib.speedScale * (data.gear === 'reverse' ? -1 : 1);   // wheel speed too
      this.model.odo.update(t, v, data.yawRate || 0.0);
    }
  }

  setBrand(brand) { this.brand = brand || null; }

  setCalibration(on) { this.model.setCalibration(on ? MEASURED_CALIBRATION : NO_CALIBRATION); }

  _measurements(now, fisker) {
    const odo = this.model.odo, calib = this.model.calib;
    let meas = [];
    if (this.fisker) {
      for (const [t, objs] of this.radar.takeCycles(now)) meas = meas.concat(radarMeasurements(t, objs, odo.speed(t), calib));
      for (const o of (fisker && fisker.objects) || []) {
        const addr = OBJECT_MSGS[o.slot];
        const tRx = this.world.frames.get(addr)[1];
        if (this._adasFed.get(addr) !== tRx) {   // only frames not fed yet
          this._adasFed.set(addr, tRx);
          meas.push(adasMeasurement(tRx, o, calib));
        }
      }
    }
    const rs = this.services.radarState, tRs = this.serviceT.radarState;
    if (rs !== undefined && tRs !== this._rsFed && now - tRs < 1.0) {
      this._rsFed = tRs;
      const t = rs.mdMonoTime || tRs;
      meas = meas.concat(opMeasurements(t - OP_LATENCY_S, rs, odo.speed(t), calib));
      this.model.modelRan(t - OP_LATENCY_S);
    }
    return meas;
  }

  snapshot(now = null) {
    now = now == null ? this.t : now;
    const op = {};
    for (const which in this.services) {
      if (which === 'carParams' || now - (this.serviceT[which] ?? 0.0) <= SERVICE_STALE_S) op[which] = this.services[which];
    }
    const fisker = this.fisker ? this.world.state(now) : null;
    this.model.add(this._measurements(now, fisker));
    return {
      t: Math.round(now * 1000) / 1000,
      brand: this.brand,
      op,
      fisker,
      radar: this.fisker ? this.radar.state(now) : null,
      objects: this.model.step(now),   // the world model's fused objects
      calibration: calibrationToJson(this.model.calib),
    };
  }
}
