// Realtime world model of the Fisker Ocean's own ADAS, parsed from ADASBUS (a port of the former
// Python fisker_world.py; it now runs in the page's world-model worker).
//
// The OEM ADAS module (bus 2, cam side of the splice) publishes everything its HMI draws: lane lines,
// a fused object list, ACC/TJA/LKA state, blind-spot/door-open/AEB threats (by object ID), traffic
// sign + light recognition, ultrasonic parking zones, park-assist slots and driver monitoring. The
// gateway mirrors body/HMI frames (gear, doors, lights, ICC settings) onto bus 0. FiskerWorld keeps
// the latest frame of each message and turns them into one JSON-friendly state at display rate.
//
// Coordinate frame of the returned geometry: x forward, y LEFT, meters, origin at the ego front
// bumper (where the ADAS object list and openpilot's radarState are referenced).
import { bytesEqual, bytesToHex, pyRound } from './dbc.js';
import { ADASIS_MSGS, AdasisHorizon } from './adasis.js';

export const BUS_PT = 0;    // vehicle side: gateway-mirrored body/HMI/chassis
export const BUS_CAM = 2;   // OEM ADAS module side
export const STALE_S = 1.0; // message considered absent if not received for this long

// ADAS_Obj1..8 live in non-sequential IDs
export const OBJECT_MSGS = { 1: 0x33B, 2: 0x34B, 3: 0x32D, 4: 0x33D, 5: 0x34D, 6: 0x32F, 7: 0x33F, 8: 0x34F };
// lane line id -> signal prefix. L1/R1 bound the ego lane, L2/R2 the adjacent lanes, L3/R3 the next.
const LANE_LINES = { L1: 'LeLine1', L2: 'LeLine2', L3: 'LeLine3', R1: 'RiLine1', R2: 'RiLine2', R3: 'RiLine3' };
const OBJECT_CLASSES = { 0: 'car', 1: 'truck', 2: 'motorcycle', 3: 'bicycle', 4: 'pedestrian', 5: 'animal', 6: 'unknown', 7: 'small', 8: 'large' };
const ACC_ENGAGED = new Set([3, 4, 5, 6, 11]);   // Active, Override, Standstill_active/wait, GoNotification
const USS_SECTORS = { front: 'F', rear: 'B', left: 'L', right: 'R' };
const PDC_SENSORS = ['LS', 'LC', 'LM', 'RM', 'RC', 'RS'];   // left side .. right side

// Lane line encoding (ADAS_xxLineN*): heading is 90 deg when parallel to the ego heading and grows
// as the line turns to the right (checked against the road on the car), so heading = 90 - raw is
// + to the left like y; curvature is a signed radius in 50 m steps (raw 63 -> 0 = straight,
// raw 127 -> 3200 = not displayed).
const LANE_HEADING_CENTER_DEG = 90.0;
const LANE_NO_DISPLAY = 3200.0;

// Drive motors: VCU_0x102 carries the driver's torque request per axle, MCU_F/MCU_R each motor's
// actual torque and speed. The requests are wheel torque: on the car they run ~11.5x the motors' own
// torque, the same ratio as motor rpm to wheel rpm (289 rpm per m/s on ~0.39 m tires), so request x
// motor speed / ratio is the power asked for.
export const DRIVE_RATIO = 11.5;
export const TIRE_RADIUS = 0.39;   // m
const MOTOR_SPD_INVALID = 32767.0;   // raw 65535
const MOTOR_TQ_MAX = 512.0;          // raw 2047 (512.5) = invalid

const r = (v, nd = 2) => (v == null ? null : pyRound(v, nd));
const pymod = (a, b) => ((a % b) + b) % b;
const normDeg = d => pymod(d + 180.0, 360.0) - 180.0;

/** Lookup helper over the merged {signal: value} dict of all fresh messages. */
class Sig {
  constructor(values, meta) {
    this.values = values;
    this.meta = meta;
  }

  get(name, dflt = null) {
    const v = this.values[name];
    return v === undefined ? dflt : v;
  }

  i(name, dflt = null) {
    const v = this.values[name];
    return v === undefined ? dflt : Math.trunc(v);
  }

  label(name) {
    const v = this.values[name];
    if (v === undefined) return null;
    const meta = this.meta[name];
    return meta ? meta.describe(v) : null;
  }

  /** {v: raw, n: value-table name} -- what the UI needs to show and to style a state. */
  enum(name) {
    const v = this.values[name];
    if (v === undefined) return null;
    return { v: Math.trunc(v), n: this.label(name) };
  }
}

export class FiskerWorld {
  constructor(dbc) {
    this.dbc = dbc;
    this.frames = new Map();     // addr -> [data, t, src]
    this.counts = new Map();     // frames seen per address (rates)
    this._decoded = new Map();   // addr -> [data, values]
    // ADAS-authored messages are read from the cam side, everything else from the vehicle side.
    // The other bus only fills in when the native one goes quiet (e.g. a different harness).
    this.nativeBus = new Map();
    this.signalMeta = {};
    for (const [addr, m] of dbc.messages) {
      this.nativeBus.set(addr, m.transmitter === 'ADAS' ? BUS_CAM : BUS_PT);
      for (const name in m.signals) this.signalMeta[name] = m.signals[name];
    }
    this.lastT = 0.0;
    this.horizon = new AdasisHorizon();   // the head unit's map horizon, accumulated from every frame (adasis.js)
  }

  reset() {
    this.frames.clear();
    this._decoded.clear();
    this.counts.clear();
    this.lastT = 0.0;
    this.horizon.reset();
  }

  /** frames: array of [address, data (Uint8Array), src]. */
  update(frames, t) {
    const native = this.nativeBus, store = this.frames, counts = this.counts;
    for (const [addr, data, src] of frames) {
      const nb = native.get(addr);
      // unknown message, or another bus: bus 1 is the radar's private CAN (fisker_radar.js), whose IDs
      // overlap ADASBUS ones; 128+ are TX echoes / blocked frames
      if (nb === undefined || (src !== BUS_PT && src !== BUS_CAM)) continue;
      if (src !== nb) {
        const prev = store.get(addr);
        if (prev !== undefined && prev[2] === nb && t - prev[1] < 0.5) continue;
      }
      store.set(addr, [data, t, src]);
      counts.set(addr, (counts.get(addr) || 0) + 1);
      if (ADASIS_MSGS.has(addr)) this.horizon.feed(addr, this.dbc.messages.get(addr).decode(data), t);   // every frame counts, not just the latest
    }
    this.lastT = t;
  }

  /** True once ADAS-authored traffic has been seen recently. */
  get active() {
    const f = this.frames.get(0x313) || this.frames.get(0x31C);
    return f !== undefined && this.lastT - f[1] < STALE_S;
  }

  decoded(addr, now = null) {
    const entry = this.frames.get(addr);
    now = now == null ? this.lastT : now;
    if (entry === undefined || now - entry[1] > STALE_S) return null;
    const cached = this._decoded.get(addr);
    if (cached !== undefined && bytesEqual(cached[0], entry[0])) return cached[1];
    const values = this.dbc.messages.get(addr).decode(entry[0]);
    this._decoded.set(addr, [entry[0], values]);
    return values;
  }

  /** Latest decoded values for the signal browser: {hex addr: {age, src, count, data, signals}}. */
  rawMessages(addrs, now = null) {
    const out = {};
    for (const addr of addrs) {
      const entry = this.frames.get(addr);
      if (entry === undefined) continue;
      const values = this.decoded(addr, entry[1]) || {};
      const signals = {};
      for (const k in values) signals[k] = Number.isInteger(values[k]) ? values[k] : pyRound(values[k], 4);
      out['0x' + addr.toString(16).toUpperCase().padStart(3, '0')] = {
        age: r((now == null ? this.lastT : now) - entry[1], 2), src: entry[2], count: this.counts.get(addr) || 0,
        data: bytesToHex(entry[0]), signals,
      };
    }
    return out;
  }

  // ---- semantic state --------------------------------------------------------------------------

  state(now = null) {
    const values = {};
    for (const addr of this.frames.keys()) {
      const d = this.decoded(addr, now);
      if (d !== null) Object.assign(values, d);
    }
    const s = new Sig(values, this.signalMeta);
    return {
      active: this.active,
      vehicle: FiskerWorld._vehicle(s),
      acc: FiskerWorld._acc(s),
      assist: FiskerWorld._assist(s),
      lanes: this._lanes(s),
      road: FiskerWorld._road(s),
      objects: FiskerWorld._objects(s),
      threats: FiskerWorld._threats(s),
      aeb: FiskerWorld._aeb(s),
      tsr: FiskerWorld._tsr(s),
      tlr: FiskerWorld._tlr(s),
      parking: FiskerWorld._parking(s),
      dms: FiskerWorld._dms(s),
      warnings: FiskerWorld._warnings(s),
      camera: FiskerWorld._camera(s),
      power: FiskerWorld._power(s),
      horizon: this.horizon.state(now == null ? this.lastT : now),
    };
  }

  static _vehicle(s) {
    const unit = s.i('ICC_DispVehSpdUnit');
    const temp = s.i('ECC_OutdTVld') === 1 ? s.get('ECC_OutdT') : null;
    const brk = s.get('VCU_BrkSig');
    const lock = s.get('BCM_FrntDrDoorLockSts');
    return {
      gear: s.label('VCU_GearSig'),
      ready: s.i('VCU_RdyLamp'),
      driveMode: s.label('VCU_DrvModSigFb'),
      speedKph: r(s.get('ESP_VehSpd'), 1),
      displaySpeed: s.i('ICC_DispVehSpd'),
      displayUnit: unit == null ? null : (unit === 1 ? 'mph' : 'kmh'),
      odometerKm: r(s.get('ICC_TotMilg_ODO'), 1),
      accelPedal: r(s.get('VCU_APSPerc'), 1),
      brake: brk != null ? Boolean(s.i('VCU_BrkSig') || s.i('ESP_BrkPedlSts')) : null,
      steeringAngle: r(s.get('EPS_SteerWhlAgSig'), 1),
      epsLatCtrl: s.enum('EPS_AdasLatCtrlSts'),
      yawRate: r(s.get('YRS_YawRate'), 2),
      regen: s.label('VCU_RegenLvlFb'),
      ePedal: s.label('VCU_EPedlStsFb'),
      powerMode: s.label('BCM_PwrMod'),
      outsideTempC: r(temp, 1),
      doors: {
        fl: s.i('BCM_DrFrntDoorSts'), fr: s.i('BCM_PasFrntDoorSts'),
        rl: s.i('BCM_LeReDoorSts'), rr: s.i('BCM_RiReDoorSts'),
        hood: s.i('BCM_FrntHoodLidSts'), trunk: s.i('PLGM_TrSts'),
        trunkState: s.label('PLGM_TrSwtStsIndcn'),
        locked: lock == null ? null : s.i('BCM_FrntDrDoorLockSts') === 0,
      },
      windows: {
        fl: s.i('BCM_LeFrntWinSts'), fr: s.i('BCM_RiFrntWinSts'), rl: s.i('BCM_LeReWinSts'),
        rr: s.i('BCM_RiReWinSt'), sunroof: s.i('BCM_SunroofSts'),
      },
      lights: {
        left: s.i('BCM_LeTrunLampOutpCmd'), right: s.i('BCM_RiTrunLampOutpCmd'),
        hazard: s.i('BCM_DangerAlrmLampSwtSts'), low: s.i('BCM_LoBeamOutpCmd'), high: s.i('BCM_HiBeamOutpCmd'),
        brake: s.i('BCM_BrkLampOutpCmd'), reverse: s.i('BCM_RvsLampOutpCmd'),
        fogFront: s.i('BCM_FrntFogLampOutpCmd'), fogRear: s.i('BCM_ReFogLampOutpCmd'),
        drl: s.i('BCM_LeDRLOutpCmd'), position: s.i('BCM_PosnLampOutpCmd'), switch: s.label('BCM_ExtLampSwtSts'),
        autoHighBeam: s.i('ADAS_AHBA_LiSigReq'),
      },
      wiperSpeed: s.i('BCM_FrntWiprSpd'),
      seatbelt: { driver: s.i('ACU_BucSwtStFrntDrvr'), passenger: s.i('ACU_BucSwtStFrntPass') },
    };
  }

  static _acc(s) {
    const st = s.i('ADAS_Sts_ACC_ICC');
    const disp = s.i('ADAS_AccTrgSpdDisp');
    return {
      state: s.enum('ADAS_Sts_ACC_ICC'),
      engaged: st != null ? ACC_ENGAGED.has(st) : null,
      // set speed is in the driver's cluster unit (ICC_DispVehSpdUnit), see fisker/carstate.py
      setSpeed: disp == null || disp >= 255 ? null : disp,
      timeGap: s.i('ADAS_TiGapSet_ACC'),
      gapRecommendation: s.i('ADAS_TiGapRecommendation_ACC'),
      primaryTarget: s.i('ADAS_ACCPrimTgtID'),
      secondaryTarget: s.i('ADAS_ACCScndTgtID'),
      icon: s.enum('ADAS_ACCIconDisp'),
      funcType: s.enum('ADAS_ACCFuncTyp'),
      overLimit: s.i('ADAS_AccTrgSpdOvrLmt'),
      degradeRequest: s.i('ADAS_ACCDegrdReq'),
      cc: s.enum('VCU_Sts_CC_ICC'),
    };
  }

  static _assist(s) {
    const trajX = s.get('ADAS_LCA_TrajectoryX');
    return {
      tja: s.enum('ADAS_TJA_AutoSteerSts'),
      lka: s.enum('ADAS_LKASts'),
      elka: s.enum('ADAS_ELKASts'),
      esa: s.enum('ADAS_ESAState'),
      lca: s.enum('ADAS_LCA_Sts'),
      lcaSuppressed: s.i('ADAS_LCA_Maneuver_Status'),
      lcaTrajectory: !trajX ? null : {
        x: trajX, y: r(-s.get('ADAS_LCA_TrajectoryY', 0.0), 2),   // signal is +right
        heading: s.get('ADAS_LCA_TrajectoryHeadingAngle'),
      },
      handsOnRequest: s.enum('ADAS_LaneCenteringHandsOnRew'),
      hodWarning: s.enum('ADAS_HOD_HandsOnWarnReq'),
      hod: s.enum('ADAS_HODSts'),
      haptic: s.i('ADAS_LatCtrl_HapticReq'),
      turnLampRequest: { left: s.i('ADAS_LatCtrl_LeTurnLampReq'), right: s.i('ADAS_LatCtrl_RiTurnLampReq') },
      isa: s.enum('ADAS_ISASts'),
      ahba: s.enum('ADAS_AHBA_Sts'),
      ahbaReason: s.label('ADAS_AHBA_BeamDecisRsn'),
    };
  }

  static _laneLine(s, lid, prefix) {
    const offset = s.get(`ADAS_${prefix}Offset`);
    if (offset == null) return null;
    const side = lid[0] === 'L' ? 1 : -1;   // y is +left
    const crvt = s.get(`ADAS_${prefix}Crvt`, LANE_NO_DISPLAY);
    const typ = s.i(`ADAS_${prefix}LnTyp`, 0);
    const confRaw = s.i(`ADAS_${prefix}Conf`, 0);
    const displayed = -LANE_NO_DISPLAY < crvt && crvt < LANE_NO_DISPLAY;
    const color = (s.label(`ADAS_${prefix}LnColor`) || '').toLowerCase().split('(')[0];
    return {
      id: lid,
      y0: r(side * offset, 3),
      heading: r(LANE_HEADING_CENTER_DEG - s.get(`ADAS_${prefix}Hdng`, LANE_HEADING_CENTER_DEG), 2),   // deg, + = left
      radius: (!displayed || crvt === 0) ? null : crvt,
      type: typ,
      typeName: s.label(`ADAS_${prefix}LnTyp`),
      color: color || null,
      conf: pyRound((confRaw + 1) / 8, 3),
      // Lines the ADAS hasn't found keep a default offset with Unknown type and the lowest confidence
      valid: displayed && (typ !== 0 || confRaw >= 3),
      roadEdge: typ === 8,
    };
  }

  _lanes(s) {
    const lines = [];
    for (const lid in LANE_LINES) {
      const ln = FiskerWorld._laneLine(s, lid, LANE_LINES[lid]);
      if (ln !== null) lines.push(ln);
    }
    const hmi = (side) => {
      const dst = s.get(`ADAS_${side}LineDst`);
      if (dst == null) return null;
      const raw = pyRound((dst + 6.2) / 0.1, 0);
      const color = (s.label(`ADAS_${side}LineColor`) || '').toLowerCase().split('(')[0];
      return {
        y: raw >= 125 ? null : r(side === 'Ri' ? -dst : dst, 2),
        color: color || null,
        flash: s.i(`ADAS_${side}LineFlash`),
        type: s.i(`ADAS_${side}LineTyp`),   // 0 = not drawn, 1 solid, 2 dashed
      };
    };
    const crvt = s.get('ADAS_LaneCrvt');
    return {
      lines,
      // what the cluster draws (0x340): blue = lane centering engaged, red/flash = departure
      hmi: {
        left: hmi('Le'), right: hmi('Ri'),
        radius: (crvt == null || crvt === 0 || Math.abs(crvt) >= LANE_NO_DISPLAY) ? null : crvt,
        fault: s.enum('ADAS_FltIndcr'),
      },
    };
  }

  static _road(s) {
    const width = s.get('ADAS_RealLaneWidth');
    const distItem = (typeSig, distSig) => {
      const d = s.get(distSig);
      return !d ? null : { type: s.label(typeSig), dist: d };
    };
    let hazard = null;
    if (s.i('ADAS_HzdDetected') === 0 && s.get('ADAS_HzdDst')) {   // 0 = TRUE in this DBC
      hazard = { class: s.i('ADAS_HzdClassification'), dist: s.get('ADAS_HzdDst') };
    }
    return {
      laneWidth: (width == null || width >= 6.3) ? null : r(width, 1),
      egoLane: s.label('ADAS_EgoLnTyp'),
      adjacent: {
        L1: s.label('ADAS_LeLn1Typ'), L2: s.label('ADAS_LeLn2Typ'),
        R1: s.label('ADAS_RiLn1Typ'), R2: s.label('ADAS_RiLn2Typ'),
      },
      leftLane: { width: r(s.get('ADAS_LeftLaneWidth'), 1) || null, type: s.label('ADAS_LeftLaneType') },
      rightLane: { width: r(s.get('ADAS_RightLaneWidth'), 1) || null, type: s.label('ADAS_RightLaneType') },
      oncoming: {
        L1: s.i('ADAS_LeLn1TrffcDir') === 0, L2: s.i('ADAS_LeLn2TrffcDir') === 0,
        R1: s.i('ADAS_RiLn1TrffcDir') === 0, R2: s.i('ADAS_RiLn2TrffcDir') === 0,
      },
      curbs: { left: s.enum('ADAS_WSP_LeftCurb'), right: s.enum('ADAS_WSP_RightCurb') },
      landmark: distItem('ADAS_LandmarkType', 'ADAS_LandmarkDst'),
      laneMarking: distItem('ADAS_LaneMarkingType', 'ADAS_LaneMarkingDistance'),
      construction: distItem('ADAS_ConstructionObjectType', 'ADAS_ConstructionObjectDst'),
      hazard,
      trafficSide: s.label('ADAS_Obj_TrfcStyle'),
      speedLimitEndDist: s.get('ADAS_RngIntlSpdLim') || null,
    };
  }

  static _objects(s) {
    const flagsById = new Map();
    const flag = (sig, name) => {
      const oid = s.i(sig);
      if (oid) {
        if (!flagsById.has(oid)) flagsById.set(oid, []);
        flagsById.get(oid).push(name);
      }
    };
    flag('ADAS_ACCPrimTgtID', 'accPrimary');
    flag('ADAS_ACCScndTgtID', 'accSecondary');
    flag('ADAS_LdngVhclID', 'leading');
    if ([1, 2, 3].includes(s.i('ADAS_BSD_CID_LeDispReq', 0))) flag('ADAS_BSDLeftThreatID', 'bsd');
    if ([1, 2, 3].includes(s.i('ADAS_BSD_CID_RiDispReq', 0))) flag('ADAS_BSDRightThreatID', 'bsd');
    flag('ADAS_DOW_ThreatIDLeft', 'dow');
    flag('ADAS_DOW_ThreatIDRight', 'dow');
    flag('ADAS_AEBThreatID', 'aeb');
    flag('ADAS_RAEB_ThreatID', 'raeb');
    flag('ADAS_BACMThreatID', 'bacm');
    flag('ADAS_ELKAThreatID', 'elka');

    const out = [];
    for (const n of Object.keys(OBJECT_MSGS)) {
      const oid = s.i(`ADAS_Obj${n}_ID`);
      if (!oid) continue;
      const longD = s.get(`ADAS_Obj${n}_LongDist`, 0.0);
      const latD = s.get(`ADAS_Obj${n}_LatDist`, 0.0);
      const cls = s.i(`ADAS_Obj${n}_Classification`, 6);
      out.push({
        id: oid,
        slot: Number(n),
        x: r(s.i(`ADAS_Obj${n}_LongDistSign`) === 1 ? -longD : longD, 2),
        y: r(s.i(`ADAS_Obj${n}_LatDistSign`) === 1 ? latD : -latD, 2),   // 0 = positive right
        w: r(s.get(`ADAS_Obj${n}_Width`), 2),
        l: r(s.get(`ADAS_Obj${n}_Length`), 2),
        h: r(s.get(`ADAS_Obj${n}_Height`), 2),
        heading: r(normDeg(s.get(`ADAS_VVP_ICC_Obj${n}Hdng`, 0.0)), 1),
        cls: cls in OBJECT_CLASSES ? OBJECT_CLASSES[cls] : 'unknown',
        conf: s.i(`ADAS_Obj${n}_Conf`),
        classConf: pyRound((s.i(`ADAS_Obj${n}_ClassConf`, 0) + 1) / 4, 2),
        brake: s.i(`ADAS_VVP_ICC_Obj${n}BrkLght`),
        flags: flagsById.get(oid) || [],
      });
    }
    return out;
  }

  static _threats(s) {
    const side = (leRi, left) => ({
      bsd: s.enum(`ADAS_BSD_CID_${leRi}DispReq`),
      bsdId: s.i(left ? 'ADAS_BSDLeftThreatID' : 'ADAS_BSDRightThreatID'),
      dow: s.enum(`ADAS_DOW_CID_${leRi}DispReq`),
      dowId: s.i(left ? 'ADAS_DOW_ThreatIDLeft' : 'ADAS_DOW_ThreatIDRight'),
      mirror: { req: s.i(`ADAS_${leRi}MirrWarnReq`), src: s.label(`ADAS_${leRi}MirrWarnSrc`) },
      ids: { req: s.enum(`ADAS_IDS_${leRi}WarnReq`), src: s.label(`ADAS_IDS_${leRi}WarnSrc`) },
    });
    return {
      bsdState: s.enum('ADAS_BSDSts'),
      dowState: s.enum('ADAS_DOW_Sts'),
      left: side('Le', true),
      right: side('Ri', false),
    };
  }

  static _aeb(s) {
    return {
      facm: s.enum('ADAS_FACM_Sts'),
      bacm: s.enum('ADAS_BACM_Sts'),
      rearAeb: s.enum('AEB_ReAEB_Sts'),
      warning: s.enum('ADAS_AEBWarnSts'),
      type: s.enum('ADAS_AEB_Typ'),
      brakeIntervention: s.enum('ADAS_BrakeIntrvntnSt'),
      rearWarning: s.i('ADAS_AEB_RAEB_WarnReq'),
      bacmSide: s.label('ADAS_BACM_WarnSide'),
      facmTelltale: s.enum('ADAS_FACM_TelltaleReq'),
      elkaTelltale: s.enum('ADAS_ELKA_TelltaleReq'),
      esaTelltale: s.enum('ADAS_ESA_TelltaleReq'),
      bsmTelltale: s.enum('ADAS_BSM_ELKA_TelltaleReq'),
    };
  }

  static _tsr(s) {
    const limit = s.i('ADAS_TSRSpeedLimit');
    const unit = s.i('ADAS_SpeedLimitUnit');
    const isa = s.i('ADAS_ISA_SpdLmt');
    const prohibited = s.i('ADAS_FobdSign');
    return {
      state: s.enum('ADAS_TSRSts'),
      speedLimit: (limit && limit < 255) ? limit : null,
      unit: unit == null ? null : (unit === 1 ? 'mph' : 'kmh'),
      addOn: s.i('ADAS_TSRSpeedLimitAddOn') || null,
      isaLimitKph: (isa && isa < 255) ? isa : null,    // ISA limit + user offset, always km/h
      confidence: s.enum('ADAS_TSRSpdLimConfidenceLvl'),
      condition: s.label('ADAS_TSRSignCondition'),
      noPassing: s.i('ADAS_TSRPassingCondition'),
      prohibited: prohibited ? s.label('ADAS_FobdSign') : null,
      isaWarning: s.i('ADAS_ISAWarnReq'),
      overspeed: s.enum('ADAS_ISAOverSpeedWarning'),
      changeNotice: s.i('ADAS_ISA_PerSpdLim_req'),
    };
  }

  static _tlr(s) {
    // The lit light: the ego-lane color (with arrow / supplementary combinations) when the ADAS has
    // one, else ADAS_TrafficLightShape (despite its name it carries Red/Amber/Green), else what the
    // red-light warning / green-light reminder implies.
    const ego = s.i('ADAS_TLR_EgoLaneColor', 0);
    const plain = s.i('ADAS_TrafficLightShape', 0);
    const warn = s.i('ADAS_TLR_WarnReq', 0);
    let active = null;
    if (ego >= 1 && ego <= 7) active = { color: s.label('ADAS_TLR_EgoLaneColor'), source: 'egoLane' };
    else if (plain >= 1 && plain <= 3) active = { color: s.label('ADAS_TrafficLightShape'), source: 'light' };
    else if (warn === 1 || warn === 2) active = { color: warn === 1 ? 'Red' : 'Green', source: 'warning' };
    return {
      state: s.enum('ADAS_Sts_TLR'),
      detected: active !== null,
      active,
      color: s.label('ADAS_TLR_EgoLaneColor'),
      lightColor: s.label('ADAS_TrafficLightShape'),
      shape: s.label('ADAS_TLR_EgoLaneTyp'),
      status: s.label('ADAS_TLR_EgoLaneSts'),
      warning: s.enum('ADAS_TLR_WarnReq'),
      dist: s.get('ADAS_TrafficLiDst') || null,
      lights: s.i('ADAS_TLRNumSpots'),
      orientation: s.label('ADAS_TLRStructOrient'),
    };
  }

  static _parking(s) {
    const uss = {};
    for (const side in USS_SECTORS) uss[side] = [0, 1, 2, 3].map(i => s.i(`ADAS_USS_${USS_SECTORS[side]}${i}`));
    const pdc = (front) => {
      const p = front ? 'F' : 'R';
      return PDC_SENSORS.map(sensor => {
        const v = s.i(`ADAS_ObjDst_${p}${sensor}`);
        return (v == null || v >= 255) ? null : v;
      });
    };
    const slot = (key) => {
      const sid = s.i(`ADAS_APASlot${key}ID`);
      if (!sid) return null;
      const corners = ['ReLe', 'ReRi', 'FrRi', 'FrLe'].map(corner => {
        const x = s.get(`ADAS_APASlot${key}_${corner}Crnr_x`), y = s.get(`ADAS_APASlot${key}_${corner}Crnr_y`);
        return (x == null || y == null) ? null : [r(x, 2), r(y, 2)];
      });
      return {
        id: sid, type: s.label(`ADAS_APASlot${key}Typ`), side: s.label(`ADAS_APASlot${key}Sid`),
        occupied: s.i(`ADAS_APASlot${key}Sts`), corners,
      };
    };
    const slots = [];
    for (let k = 1; k <= 6; k++) {
      const sl = slot(String(k));
      if (sl !== null) slots.push(sl);
    }
    return {
      uss,
      pdc: { front: pdc(true), rear: pdc(false) },
      apa: {
        state: s.enum('ADAS_APASts'),
        available: s.label('ADAS_APAAvailable'),
        scanning: s.label('ADAS_APAScanngSde'),
        speedWarning: s.i('ADAS_APASpdWarn'),
        slots,
        selected: slot('Sel'),
      },
      curbWarning: {
        fl: s.i('ADAS_CurbPrtcFrLeWhl'), fr: s.i('ADAS_CurbPrtcFrRiWhl'),
        rl: s.i('ADAS_CurbPrtcRrLeWhl'), rr: s.i('ADAS_CurbPrtcRrRiWhl'),
      },
      wsppa: s.enum('ADAS_WSPPASts'),
      svsView: s.label('ADASDC_SVS_ViewSts'),
      rap: s.enum('ADAS_Sts_RAP'),
      trainedParking: s.enum('ADAS_Sts_TP'),
    };
  }

  static _dms(s) {
    const blockage = s.get('ADAS_DMS_Camera_Blockage_Status');
    return {
      attentionZone: s.label('ADAS_DrvrAttention_Zone'),
      alertState: s.label('ADAS_DrvrAlert_State'),
      engagement: s.label('ADAS_DrvrEngagement_Level_Status'),
      impairment: s.label('ADAS_DrvrImpairment_Level_Stat'),
      drowsiness: s.label('ADAS_DCAA_DrvrDrowsinessLvl'),
      driver: s.label('ADAS_DMSDrvrDetn'),
      cameraBlocked: blockage != null ? s.i('ADAS_DMS_Camera_Blockage_Status') === 2 : null,
      dcaa: s.enum('ADAS_DCAASts'),
      dcaaWarning: s.enum('ADAS_DCAA_WarnLvlReq'),
    };
  }

  static _warnings(s) {
    return {
      chime: s.enum('ADAS_ChimeReq'),
      text: s.enum('ADAS_IDS_WarnTxtReq'),
      sysFault: s.enum('ADAS_SysFltWarnReq'),
      sysFaultType: s.enum('ADAS_SysFltTyp'),
      takeover: s.enum('ADAS_DrvrTakeOvrReq'),
      highPriority: s.enum('ADAS_HiPrioDegradationSts'),
      lowPriority: s.enum('ADAS_LoPrioDegradationSts'),
    };
  }

  static _camera(s) {
    return {
      state: s.enum('ADAS_CamSts'),
      objects: s.i('ADAS_ObjNr'),
      ambient: s.label('ADAS_AmbLi'),
      blind: s.i('ADAS_FrntCamBli'),
      fault: s.enum('ADAS_FrntCamFlt'),
    };
  }

  static _power(s) {
    let roadW = s.get('ESP_VehSpd');   // motor rad/s implied by road speed, when a motor's own speed is missing
    roadW = roadW == null ? null : roadW / 3.6 / TIRE_RADIUS * DRIVE_RATIO;
    const axles = {};
    let demand = null, actual = null;
    for (const [key, mcu, reqName] of [['front', 'MCU_F', 'VCU_DrvrFrntMotTqReq'], ['rear', 'MCU_R', 'VCU_DrvrReMotTqReq']]) {
      let rpm = s.get(`${mcu}_CrtSpd`);
      if (rpm == null || rpm >= MOTOR_SPD_INVALID || s.i(`${mcu}_CrtSpdSigVld`) !== 1) rpm = null;
      let tq = s.get(`${mcu}_CrtTq`);
      if (tq == null || tq > MOTOR_TQ_MAX || s.i(`${mcu}_CrtTqVld`) !== 1) tq = null;
      const req = s.i(reqName + 'Vld') === 1 ? s.get(reqName) : null;
      const w = rpm != null ? rpm * Math.PI / 30 : roadW;
      if (req != null && w != null) demand = (demand || 0.0) + req * w / DRIVE_RATIO / 1000;
      if (tq != null && rpm != null) actual = (actual || 0.0) + tq * rpm * Math.PI / 30 / 1000;
      axles[key] = { tqReq: r(req, 0), tq: r(tq, 1), rpm: r(rpm, 0) };
    }
    const reqs = Object.values(axles).map(a => a.tqReq).filter(v => v != null);
    return {
      demandKw: r(demand, 1),   // + driving, - regen
      kw: r(actual, 1),
      tqReq: reqs.length ? reqs.reduce((a, b) => a + b, 0) : null,   // wheel torque requested, both axles, Nm
      ...axles,
    };
  }
}

/** Sample a lane line as y(x) = y0 + tan(heading) x + x^2 / 2R (used by tests / tools). */
export function lanePolyline(line, xMax = 80.0, step = 4.0) {
  const tanH = Math.tan((line.heading || 0.0) * Math.PI / 180);
  const k = line.radius ? 1.0 / line.radius : 0.0;
  const pts = [];
  for (let x = 0.0; x <= xMax; x += step) pts.push([x, line.y0 + tanH * x + 0.5 * k * x * x]);
  return pts;
}
