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
// the roads around the car for the view's map layer: every drivable way within ROADS_R, rebuilt once the car has
// moved ROADS_STEP from the last build (or the tiles changed), and sent only then
const ROADS_R = 320, ROADS_STEP = 40;
const LANE_W = 3.6;
// the map's point features (mapdata.js feature cells) that ride along in the layer, by their OSM tag
const FEATURE_KINDS = { traffic_signals: 'signal', stop: 'stop', give_way: 'yield', crossing: 'crossing', mini_roundabout: 'miniRoundabout' };
const FEAT_MAX = 160;         // nearest first
const INDICATOR_HOLD_S = 1.0; // a flashing turn lamp counts as indicating this long after it was last lit
const NODE_SNAP_M = 0.4;      // a feature this close to a way's node sits on that node (the same OSM node, through two datasets)
const RANK = { motorway: 0, motorway_link: 0, trunk: 0, trunk_link: 0, primary: 1, primary_link: 1, secondary: 2, secondary_link: 2, tertiary: 3, tertiary_link: 3, unclassified: 4, residential: 4, living_street: 4 };
const wrapA = (a) => (((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const r1 = (v) => Math.round(v * 10) / 10;

/** A way's lane count when OSM doesn't say: two for a two-way road, two for a one-way road of a kind that is usually a
 *  carriageway of a divided road (motorway, trunk, primary and their links), one for any other one-way street. */
export function lanesOf(way) {
  if (way.lanes > 0) return way.lanes;
  if (!way.oneWay) return 2;
  return /^(motorway|trunk|primary)/.test(way.className || '') ? 2 : 1;
}

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
    this._roads = null;   // {version, cx, cy, mapVersion, layer}
    this._roadsSeq = 0;   // layer versions count on across resets: a layer built in an old pose frame must never pass for a new one
    this.services = {};
    this.serviceT = {};
    this.brand = null;
    this.t = 0.0;
    this._odoCanT = -1e9;
    this._gpsCanT = -1e9;
    this._adasFed = new Map();
    this._rsFed = null;
    this._turnAt = null;
  }

  reset() {
    this.world.reset();
    this.radar.reset();
    this.model.reset();
    this.pose.reset();
    if (this.matcher) this.matcher.reset();
    this._roads = null;
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
    this._indicator(now, fisker);
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

  /** Match the pose onto the map once there is a fix; tiles load in the background the first time. The roads
   *  around the car ride along as a layer (`roads`) whenever it has been rebuilt, else just its version. */
  _map(now) {
    if (!this.map || !this.pose.origin || !this.pose.fixes) return null;
    this.map.setOrigin({ lat: this.pose.origin.lat, lon: this.pose.origin.lon, seq: this.pose.seq });
    const p = this.pose.poseAt(now);
    const [lat, lon] = this.pose.toGeodetic(p[0], p[1]);
    if (!this.map.ensure(lat, lon, now)) return { loading: true, tiles: this.map.loaded };
    const m = this.matcher.update(p, Math.abs(this.pose.v), now, { w: this.pose.w, turn: this._turn(now) });
    const out = m === null ? { loading: false, tiles: this.map.loaded } : { ...m, tiles: this.map.loaded };
    const fresh = this._roadsLayer(p[0], p[1]);
    out.roadsVersion = this._roads.version;
    if (fresh) out.roads = this._roads.layer;
    return out;
  }

  /** Remember the turn indicator (the BCM's lamp outputs flash, so it is latched for a second). */
  _indicator(now, fisker) {
    const L = fisker && fisker.lights, cs = this.services.carState;
    const left = L && L.left != null ? !!L.left : !!(cs && cs.leftBlinker);
    const right = L && L.right != null ? !!L.right : !!(cs && cs.rightBlinker);
    if (left !== right) this._turnAt = { side: left ? 1 : -1, t: now };
    else if (left && right) this._turnAt = null;   // hazards
  }

  _turn(now) { return this._turnAt && now - this._turnAt.t < INDICATOR_HOLD_S ? this._turnAt.side : 0; }

  /** The roads within ROADS_R of (x, y), as polylines in the pose frame, with the point features on them;
   *  true when rebuilt this call. */
  _roadsLayer(x, y) {
    const r = this._roads;
    const mapVersion = this.map.version + ':' + this.map.featVersion;
    if (r && r.mapVersion === mapVersion && Math.hypot(x - r.cx, y - r.cy) < ROADS_STEP) return false;
    const R = ROADS_R, x0 = x - R, x1 = x + R, y0 = y - R, y1 = y + R;
    const ways = [];
    const near = this.map.waysNear(x, y, R);
    for (const w of near) {
      const xy = w.xy, n = xy.length >> 1, pts = [];
      // the points inside the box, plus one beyond on each side so the road runs out of view rather than stopping
      let lastIn = false;
      for (let i = 0; i < n; i++) {
        const px = xy[2 * i], py = xy[2 * i + 1];
        const inside = px >= x0 && px <= x1 && py >= y0 && py <= y1;
        if (inside || lastIn || (i + 1 < n && xy[2 * i + 2] >= x0 && xy[2 * i + 2] <= x1 && xy[2 * i + 3] >= y0 && xy[2 * i + 3] <= y1)) {
          pts.push([Math.round(px * 10) / 10, Math.round(py * 10) / 10]);
        } else if (pts.length) break;
        lastIn = inside;
      }
      if (pts.length < 2) continue;
      const way = w.way;
      const lanes = lanesOf(way);
      ways.push({ id: way.id, cls: way.cls, className: way.className, name: way.name, ref: way.ref, lanes, oneWay: !!way.oneWay, width: Math.round(lanes * LANE_W * 10) / 10, pts });
    }
    const features = this._features(x, y, R, near);
    const version = ++this._roadsSeq;
    this._roads = { version, cx: x, cy: y, mapVersion, layer: { version, cx: Math.round(x), cy: Math.round(y), r: R, ways, features } };
    return true;
  }

  /** The point features within R of (x, y) that sit on a known road, each with the roads' directions of travel
   *  that arrive at it ({h, half, lanes, oneWay, wayId, forward}), plus the speed limit changes where one way
   *  continues into the next: [{id, kind, x, y, arms, ...}] nearest first (mapfeatures.js draws them). */
  _features(x, y, R, near) {
    const out = [];
    const widthOf = (way) => lanesOf(way) * LANE_W;
    const arm = (w, h, forward) => ({ h: Math.round(h * 1000) / 1000, half: r1(widthOf(w.way) / 2), lanes: lanesOf(w.way), oneWay: !!w.way.oneWay, wayId: w.way.id, forward });
    // the ways with a node at a point: [{w, i}]
    const at = (px, py) => {
      const hits = [];
      for (const w of near) {
        if (px < w.minX - NODE_SNAP_M || px > w.maxX + NODE_SNAP_M || py < w.minY - NODE_SNAP_M || py > w.maxY + NODE_SNAP_M) continue;
        const xy = w.xy;
        for (let i = 0; 2 * i + 1 < xy.length; i++) {
          if (Math.abs(xy[2 * i] - px) <= NODE_SNAP_M && Math.abs(xy[2 * i + 1] - py) <= NODE_SNAP_M) { hits.push({ w, i }); break; }
        }
      }
      return hits;
    };
    // the directions of travel arriving at node i of a way, as headings: [{h, forward}] (forward: in node order)
    const arrivals = (w, i, allow) => {
      const xy = w.xy, n = xy.length >> 1, arr = [];
      if (i > 0 && allow !== 'backward') arr.push({ h: Math.atan2(xy[2 * i + 1] - xy[2 * i - 1], xy[2 * i] - xy[2 * i - 2]), forward: true });
      if (i < n - 1 && !w.way.oneWay && allow !== 'forward') arr.push({ h: Math.atan2(xy[2 * i + 1] - xy[2 * i + 3], xy[2 * i] - xy[2 * i + 2]), forward: false });
      return arr;
    };
    for (const f of this.map.featuresNear(x, y, R)) {
      const t = f.tags || {};
      const kind = t.railway === 'level_crossing' ? 'rail' : t.traffic_calming ? 'calming' : FEATURE_KINDS[t.highway];
      if (!kind) continue;
      if (kind === 'crossing' && (t.crossing === 'unmarked' || t.crossing === 'informal' || t['crossing:markings'] === 'no')) continue;
      let hits = at(f.x, f.y);
      if (!hits.length) continue;   // on no road we know (a footway's crossing, a cyclists' signal)
      const dir = t['traffic_signals:direction'] || t.direction || null;
      // a stop or give-way on an intersection node holds the minor roads unless it says all of them
      if ((kind === 'stop' || kind === 'yield') && hits.length > 1 && t.stop !== 'all') {
        const worst = Math.max(...hits.map(h => RANK[h.w.way.className] ?? 4));
        hits = hits.filter(h => (RANK[h.w.way.className] ?? 4) === worst);
      }
      const arms = [];
      // the widest road crossing at this node, per way: a stop line goes at its edge, not at the node (the crossing's center)
      const crossOf = (w) => { let c = 0; for (const o of at(f.x, f.y)) if (o.w !== w) c = Math.max(c, widthOf(o.w.way) / 2); return r1(c); };
      for (const { w, i } of hits) {
        const n = w.xy.length >> 1;
        let allow = dir === 'forward' || dir === 'backward' ? dir : null;
        // a stop or give-way at a way's end, with no direction given, holds the traffic reaching that end
        if (!allow && (kind === 'stop' || kind === 'yield') && hits.length === 1 && (i === 0 || i === n - 1)) allow = i === n - 1 ? 'forward' : 'backward';
        const across = kind === 'crossing' || kind === 'calming' || kind === 'rail' || kind === 'miniRoundabout';   // one per road, not per direction
        const cross = crossOf(w);
        for (const a of (across ? arrivals(w, i, null).slice(0, 1) : arrivals(w, i, allow))) arms.push({ ...arm(w, a.h, a.forward), cross });
      }
      if (!arms.length) continue;
      const feat = { id: f.id, kind, x: r1(f.x), y: r1(f.y), arms };
      if (t.stop === 'all') feat.all = true;
      if (kind === 'crossing' && /traffic_signals/.test(t.crossing || '')) feat.signals = true;
      out.push(feat);
    }
    // (no speed limit signs from the map: the camera's read of the real sign is the one shown)
    out.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
    return out.slice(0, FEAT_MAX);
  }
}
