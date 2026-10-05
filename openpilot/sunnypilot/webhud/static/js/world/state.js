// StateBuilder folds raw CAN frames and openpilot service extracts into the single snapshot the HUD
// renders (a port of the former Python state.py; it now runs in the page's world-model worker). The
// comma's bridge streams what it reads (sources.py, extract.py) in ticks; live and replay feed this
// identically, only the clock differs. Besides each source's own view it runs the world model
// (world_model.js), which fuses the object sources in a ground-fixed frame; its ego pose comes from the
// car's wheel speed and yaw-rate gyro on CAN when it has them. The world model's sensor calibration
// (on unless the view turns it off) corrects the sources and the speed.
import { hexToBytes } from './dbc.js';
import { FiskerRadar } from './fisker_radar.js';
import { PoseEstimator } from './pose.js';
import { MapMatcher } from './mapmatch.js';

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
// The telematics box's GPS and heading (pose.js): the gateway mirrors them onto the ADAS bus and IBUS2/IBUS1,
// the fix quality (0x46F/0x472) only onto IBUS1
const GPS_MSG = 0x526, HEADING_MSG = 0x179, INS_MSG = 0x174, GPS_FIX_MSG = 0x46F, GPS_ACC_MSG = 0x472;
const GPS_CAN_S = 1.0;        // the comma's GPS stands in once the car's own hasn't been seen for this long
const GPS_SERVICES = new Set(['gpsLocationExternal', 'gpsLocation']);

export class StateBuilder {
  /** worldDbc: the ADASBUS DBC (or the IBUS one, which carries the same signals); radarDbc: the radar's, or
   *  null; gearMsg: where VCU_GearSig comes from (0x214 on the ADAS bus, 0x234 on IBUS1); mapData: the road
   *  map (mapdata.js) for the map matcher, or null for none. */
  constructor(worldDbc, radarDbc = null, { gearMsg = GEAR_MSG, mapData = null } = {}) {
    this.world = new FiskerWorld(worldDbc);
    this.radar = new FiskerRadar(radarDbc);
    this.gearMsg = gearMsg;
    this.model = new WorldModel();
    this.pose = new PoseEstimator({ speedScale: this.model.calib.speedScale });
    this.map = mapData;
    this.matcher = mapData ? new MapMatcher(mapData) : null;
    this.services = {};
    this.serviceT = {};
    this.brand = null;
    this.t = 0.0;
    this._odoCanT = -1e9;
    this._gpsCanT = -1e9;
    this._adasFed = new Map();
    this._rsFed = null;
  }

  reset() {
    this.world.reset();
    this.radar.reset();
    this.model.reset();
    this.pose.reset();
    if (this.matcher) this.matcher.reset();
    this.services = {};
    this.serviceT = {};
    this.t = 0.0;
    this._odoCanT = -1e9;
    this._gpsCanT = -1e9;
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
      this._gpsFromCan(t);
    }
  }

  _odometryFromCan(t) {
    const spd = this.world.frames.get(SPEED_MSG), yaw = this.world.frames.get(YAW_MSG);
    if (spd === undefined || yaw === undefined || Math.max(spd[1], yaw[1]) !== t || t - Math.min(spd[1], yaw[1]) > 0.1) return;   // nothing new in this batch, or one of the two has gone quiet
    let vRaw = this.world.decoded(SPEED_MSG, t).ESP_VehSpd / 3.6;
    const gear = this.world.decoded(this.gearMsg, t);
    if (gear !== null && Math.trunc(gear.VCU_GearSig) === GEAR_REVERSE) vRaw = -vRaw;
    const w = this.world.decoded(YAW_MSG, t).YRS_YawRate * Math.PI / 180;
    this.model.odo.update(t, vRaw * this.model.calib.speedScale, w);
    this.pose.predict(t, vRaw, w);
    this._odoCanT = t;
  }

  /** The car's own GPS fixes and heading, as they arrive (the pose estimator removes their lag). */
  _gpsFromCan(t) {
    const g = this.world.frames.get(GPS_MSG);
    if (g !== undefined && g[1] === t) {
      const d = this.world.decoded(GPS_MSG, t);
      const q = this.world.decoded(GPS_FIX_MSG, t), a = this.world.decoded(GPS_ACC_MSG, t);   // null on the comma's buses
      if (d !== null && (q === null || Math.trunc(q.TBOX_GPSFixOK) === 1)) {
        this.pose.gps(t, d.TBOX_GPSLati, d.TBOX_GPSLongi, { accuracy: a !== null && a.TBOX_HorzAccuracy > 0 ? a.TBOX_HorzAccuracy : null });
        this._gpsCanT = t;
      }
    }
    const h = this.world.frames.get(HEADING_MSG);
    if (h !== undefined && h[1] === t) {
      const d = this.world.decoded(HEADING_MSG, t);
      if (d !== null && d.TBOX_HeadingStdDev < 10.0) this.pose.heading(t, d.TBOX_Heading, d.TBOX_HeadingStdDev);
    }
    const i = this.world.frames.get(INS_MSG);   // the TBOX's forward velocity (cm/s): calibrates the wheel speed
    if (i !== undefined && i[1] === t) {
      const d = this.world.decoded(INS_MSG, t);
      if (d !== null) this.pose.speedObs(t, d.TBOX_XVelocity / 100);
    }
  }

  /** data: the service's extract (extract.py's output), published at t. */
  feedService(which, data, t) {
    this.services[which] = data;
    this.serviceT[which] = t;
    this.t = Math.max(this.t, t);
    if (which === 'carParams') {
      this.brand = data.brand || this.brand;
    } else if (which === 'carState' && t - this._odoCanT > ODOMETRY_CAN_S) {
      const vRaw = (data.vEgo || 0.0) * (data.gear === 'reverse' ? -1 : 1), w = data.yawRate || 0.0;   // wheel speed too
      this.model.odo.update(t, vRaw * this.model.calib.speedScale, w);
      this.pose.predict(t, vRaw, w);
    } else if (GPS_SERVICES.has(which) && t - this._gpsCanT > GPS_CAN_S && data.fix && data.lat != null) {
      this.pose.gps(t, data.lat, data.lon, { accuracy: data.acc ?? null, speed: data.speed ?? null, bearing: data.bearing ?? null });
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
      pose: this.pose.state(now),      // where the car is (pose.js): east/north from the first fix, heading, lat/lon
      map: this._map(now),             // the road it's on and the road ahead (mapmatch.js), null without a map or a fix
      calibration: calibrationToJson(this.model.calib),
    };
  }

  /** Match the pose onto the map once there is a fix; tiles load in the background the first time. */
  _map(now) {
    if (!this.map || !this.pose.origin || !this.pose.fixes) return null;
    this.map.setOrigin({ lat: this.pose.origin.lat, lon: this.pose.origin.lon, seq: this.pose.seq });
    const p = this.pose.poseAt(now);
    const [lat, lon] = this.pose.toGeodetic(p[0], p[1]);
    if (!this.map.ensure(lat, lon, now)) return { loading: true, tiles: this.map.loaded };
    const m = this.matcher.update(p, Math.abs(this.pose.v), now);
    return m === null ? { loading: false, tiles: this.map.loaded } : { ...m, tiles: this.map.loaded };
  }
}
