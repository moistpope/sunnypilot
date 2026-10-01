"""
Copyright (c) 2021-, Haibin Wen, sunnypilot, and a number of other contributors.

This file is part of sunnypilot and is licensed under the MIT License.
See the LICENSE.md file in the root directory for more details.

Realtime world model of the Fisker Ocean's own ADAS, parsed from ADASBUS.

The OEM ADAS module (bus 2, cam side of the splice) publishes everything its HMI draws: lane lines,
a fused object list, ACC/TJA/LKA state, blind-spot/door-open/AEB threats (by object ID), traffic
sign + light recognition, ultrasonic parking zones, park-assist slots and driver monitoring. The
gateway mirrors body/HMI frames (gear, doors, lights, ICC settings) onto bus 0. FiskerWorld keeps
the latest frame of each message and turns them into one JSON-friendly state at display rate.

Coordinate frame of the returned geometry: x forward, y LEFT, meters, origin at the ego front
bumper (where the ADAS object list and openpilot's radarState are referenced).
"""
import math
from collections import Counter

from openpilot.sunnypilot.webhud.dbc import DBC, Signal
from openpilot.sunnypilot.webhud.paths import DBC_PATH

BUS_PT = 0    # vehicle side: gateway-mirrored body/HMI/chassis
BUS_CAM = 2   # OEM ADAS module side
STALE_S = 1.0  # message considered absent if not received for this long

# ADAS_Obj1..8 live in non-sequential IDs
OBJECT_MSGS = {1: 0x33B, 2: 0x34B, 3: 0x32D, 4: 0x33D, 5: 0x34D, 6: 0x32F, 7: 0x33F, 8: 0x34F}
# lane line id -> signal prefix. L1/R1 bound the ego lane, L2/R2 the adjacent lanes, L3/R3 the next.
LANE_LINES = {"L1": "LeLine1", "L2": "LeLine2", "L3": "LeLine3", "R1": "RiLine1", "R2": "RiLine2", "R3": "RiLine3"}
OBJECT_CLASSES = {0: "car", 1: "truck", 2: "motorcycle", 3: "bicycle", 4: "pedestrian", 5: "animal",
                  6: "unknown", 7: "small", 8: "large"}
ACC_ENGAGED = {3, 4, 5, 6, 11}   # Active, Override, Standstill_active/wait, GoNotification
USS_SECTORS = {"front": "F", "rear": "B", "left": "L", "right": "R"}
PDC_SENSORS = ("LS", "LC", "LM", "RM", "RC", "RS")  # left side .. right side

# Lane line encoding (ADAS_xxLineN*): heading is 90 deg when parallel to the ego heading and grows
# as the line turns to the right (checked against the road on the car), so heading = 90 - raw is
# + to the left like y; curvature is a signed radius in 50 m steps (raw 63 -> 0 = straight,
# raw 127 -> 3200 = not displayed).
LANE_HEADING_CENTER_DEG = 90.0
LANE_NO_DISPLAY = 3200.0


def _r(v, nd=2):
  return None if v is None else round(float(v), nd)


def _norm_deg(d: float) -> float:
  return (d + 180.0) % 360.0 - 180.0


class _Sig:
  """Lookup helper over the merged {signal: value} dict of all fresh messages."""
  def __init__(self, values: dict[str, float], meta: dict[str, Signal]):
    self.values = values
    self.meta = meta

  def __call__(self, name: str, default=None):
    return self.values.get(name, default)

  def i(self, name: str, default=None):
    v = self.values.get(name)
    return default if v is None else int(v)

  def label(self, name: str) -> str | None:
    v = self.values.get(name)
    if v is None:
      return None
    meta = self.meta.get(name)
    return meta.describe(v) if meta is not None else None

  def enum(self, name: str) -> dict | None:
    """{v: raw, n: value-table name} -- what the UI needs to show and to style a state."""
    v = self.values.get(name)
    if v is None:
      return None
    return {"v": int(v), "n": self.label(name)}


class FiskerWorld:
  def __init__(self, dbc: DBC | None = None):
    self.dbc = dbc or DBC(DBC_PATH)
    self.frames: dict[int, tuple[bytes, float, int]] = {}   # addr -> (data, t, src)
    self.counts: Counter[int] = Counter()                     # frames seen per address (rates)
    self._decoded: dict[int, tuple[bytes, dict[str, float]]] = {}
    # ADAS-authored messages are read from the cam side, everything else from the vehicle side.
    # The other bus only fills in when the native one goes quiet (e.g. a different harness).
    self.native_bus = {addr: (BUS_CAM if m.transmitter == "ADAS" else BUS_PT) for addr, m in self.dbc.messages.items()}
    self.signal_meta: dict[str, Signal] = {name: sig for m in self.dbc.messages.values() for name, sig in m.signals.items()}
    self.last_t = 0.0

  def reset(self) -> None:
    self.frames.clear()
    self._decoded.clear()
    self.counts.clear()
    self.last_t = 0.0

  def update(self, frames, t: float) -> None:
    """frames: iterable of (address, data, src) as produced by can_capnp_to_list."""
    native = self.native_bus
    store = self.frames
    counts = self.counts
    for addr, data, src in frames:
      nb = native.get(addr)
      if nb is None or src >= 128:  # unknown message, or a TX echo / blocked frame
        continue
      if src != nb:
        prev = store.get(addr)
        if prev is not None and prev[2] == nb and t - prev[1] < 0.5:
          continue
      store[addr] = (data, t, src)
      counts[addr] += 1
    self.last_t = t

  @property
  def active(self) -> bool:
    """True once ADAS-authored traffic has been seen recently."""
    f = self.frames.get(0x313) or self.frames.get(0x31C)
    return f is not None and self.last_t - f[1] < STALE_S

  def decoded(self, addr: int, now: float | None = None) -> dict[str, float] | None:
    entry = self.frames.get(addr)
    now = self.last_t if now is None else now
    if entry is None or now - entry[1] > STALE_S:
      return None
    cached = self._decoded.get(addr)
    if cached is not None and cached[0] == entry[0]:
      return cached[1]
    values = self.dbc.messages[addr].decode(entry[0])
    self._decoded[addr] = (entry[0], values)
    return values

  def raw_messages(self, addrs, now: float | None = None) -> dict[str, dict]:
    """Latest decoded values for the signal browser: {hex addr: {t, src, count, signals}}."""
    out = {}
    for addr in addrs:
      entry = self.frames.get(addr)
      if entry is None:
        continue
      values = self.decoded(addr, now=entry[1])
      out[f"0x{addr:03X}"] = {
        "age": _r((self.last_t if now is None else now) - entry[1], 2), "src": entry[2], "count": self.counts[addr],
        "data": entry[0].hex(), "signals": {k: (v if isinstance(v, int) else round(v, 4)) for k, v in (values or {}).items()},
      }
    return out

  # ---- semantic state --------------------------------------------------------------------------

  def state(self, now: float | None = None) -> dict:
    values: dict[str, float] = {}
    for addr in self.frames:
      d = self.decoded(addr, now)
      if d is not None:
        values.update(d)
    s = _Sig(values, self.signal_meta)

    return {
      "active": self.active,
      "vehicle": self._vehicle(s),
      "acc": self._acc(s),
      "assist": self._assist(s),
      "lanes": self._lanes(s),
      "road": self._road(s),
      "objects": self._objects(s),
      "threats": self._threats(s),
      "aeb": self._aeb(s),
      "tsr": self._tsr(s),
      "tlr": self._tlr(s),
      "parking": self._parking(s),
      "dms": self._dms(s),
      "warnings": self._warnings(s),
      "camera": self._camera(s),
    }

  @staticmethod
  def _vehicle(s: _Sig) -> dict:
    unit = s.i("ICC_DispVehSpdUnit")
    temp = s("ECC_OutdT") if s.i("ECC_OutdTVld") == 1 else None
    return {
      "gear": s.label("VCU_GearSig"),
      "ready": s.i("VCU_RdyLamp"),
      "driveMode": s.label("VCU_DrvModSigFb"),
      "speedKph": _r(s("ESP_VehSpd"), 1),
      "displaySpeed": s.i("ICC_DispVehSpd"),
      "displayUnit": None if unit is None else ("mph" if unit == 1 else "kmh"),
      "odometerKm": _r(s("ICC_TotMilg_ODO"), 1),
      "accelPedal": _r(s("VCU_APSPerc"), 1),
      "brake": bool(s.i("VCU_BrkSig") or s.i("ESP_BrkPedlSts")) if s("VCU_BrkSig") is not None else None,
      "steeringAngle": _r(s("EPS_SteerWhlAgSig"), 1),
      "epsLatCtrl": s.enum("EPS_AdasLatCtrlSts"),
      "yawRate": _r(s("YRS_YawRate"), 2),
      "regen": s.label("VCU_RegenLvlFb"),
      "ePedal": s.label("VCU_EPedlStsFb"),
      "powerMode": s.label("BCM_PwrMod"),
      "outsideTempC": _r(temp, 1),
      "doors": {
        "fl": s.i("BCM_DrFrntDoorSts"), "fr": s.i("BCM_PasFrntDoorSts"),
        "rl": s.i("BCM_LeReDoorSts"), "rr": s.i("BCM_RiReDoorSts"),
        "hood": s.i("BCM_FrntHoodLidSts"), "trunk": s.i("PLGM_TrSts"),
        "trunkState": s.label("PLGM_TrSwtStsIndcn"),
        "locked": None if s("BCM_FrntDrDoorLockSts") is None else s.i("BCM_FrntDrDoorLockSts") == 0,
      },
      "windows": {
        "fl": s.i("BCM_LeFrntWinSts"), "fr": s.i("BCM_RiFrntWinSts"), "rl": s.i("BCM_LeReWinSts"),
        "rr": s.i("BCM_RiReWinSt"), "sunroof": s.i("BCM_SunroofSts"),
      },
      "lights": {
        "left": s.i("BCM_LeTrunLampOutpCmd"), "right": s.i("BCM_RiTrunLampOutpCmd"),
        "hazard": s.i("BCM_DangerAlrmLampSwtSts"), "low": s.i("BCM_LoBeamOutpCmd"), "high": s.i("BCM_HiBeamOutpCmd"),
        "brake": s.i("BCM_BrkLampOutpCmd"), "reverse": s.i("BCM_RvsLampOutpCmd"),
        "fogFront": s.i("BCM_FrntFogLampOutpCmd"), "fogRear": s.i("BCM_ReFogLampOutpCmd"),
        "drl": s.i("BCM_LeDRLOutpCmd"), "position": s.i("BCM_PosnLampOutpCmd"), "switch": s.label("BCM_ExtLampSwtSts"),
        "autoHighBeam": s.i("ADAS_AHBA_LiSigReq"),
      },
      "wiperSpeed": s.i("BCM_FrntWiprSpd"),
      "seatbelt": {"driver": s.i("ACU_BucSwtStFrntDrvr"), "passenger": s.i("ACU_BucSwtStFrntPass")},
    }

  @staticmethod
  def _acc(s: _Sig) -> dict:
    st = s.i("ADAS_Sts_ACC_ICC")
    disp = s.i("ADAS_AccTrgSpdDisp")
    return {
      "state": s.enum("ADAS_Sts_ACC_ICC"),
      "engaged": st in ACC_ENGAGED if st is not None else None,
      # set speed is in the driver's cluster unit (ICC_DispVehSpdUnit), see fisker/carstate.py
      "setSpeed": None if disp is None or disp >= 255 else disp,
      "timeGap": s.i("ADAS_TiGapSet_ACC"),
      "gapRecommendation": s.i("ADAS_TiGapRecommendation_ACC"),
      "primaryTarget": s.i("ADAS_ACCPrimTgtID"),
      "secondaryTarget": s.i("ADAS_ACCScndTgtID"),
      "icon": s.enum("ADAS_ACCIconDisp"),
      "funcType": s.enum("ADAS_ACCFuncTyp"),
      "overLimit": s.i("ADAS_AccTrgSpdOvrLmt"),
      "degradeRequest": s.i("ADAS_ACCDegrdReq"),
      "cc": s.enum("VCU_Sts_CC_ICC"),
    }

  @staticmethod
  def _assist(s: _Sig) -> dict:
    traj_x = s("ADAS_LCA_TrajectoryX")
    return {
      "tja": s.enum("ADAS_TJA_AutoSteerSts"),
      "lka": s.enum("ADAS_LKASts"),
      "elka": s.enum("ADAS_ELKASts"),
      "esa": s.enum("ADAS_ESAState"),
      "lca": s.enum("ADAS_LCA_Sts"),
      "lcaSuppressed": s.i("ADAS_LCA_Maneuver_Status"),
      "lcaTrajectory": None if not traj_x else {
        "x": traj_x, "y": _r(-s("ADAS_LCA_TrajectoryY", 0.0), 2),  # signal is +right
        "heading": s("ADAS_LCA_TrajectoryHeadingAngle"),
      },
      "handsOnRequest": s.enum("ADAS_LaneCenteringHandsOnRew"),
      "hodWarning": s.enum("ADAS_HOD_HandsOnWarnReq"),
      "hod": s.enum("ADAS_HODSts"),
      "haptic": s.i("ADAS_LatCtrl_HapticReq"),
      "turnLampRequest": {"left": s.i("ADAS_LatCtrl_LeTurnLampReq"), "right": s.i("ADAS_LatCtrl_RiTurnLampReq")},
      "isa": s.enum("ADAS_ISASts"),
      "ahba": s.enum("ADAS_AHBA_Sts"),
      "ahbaReason": s.label("ADAS_AHBA_BeamDecisRsn"),
    }

  @staticmethod
  def _lane_line(s: _Sig, lid: str, prefix: str) -> dict | None:
    offset = s(f"ADAS_{prefix}Offset")
    if offset is None:
      return None
    side = 1 if lid[0] == "L" else -1   # y is +left
    crvt = s(f"ADAS_{prefix}Crvt", LANE_NO_DISPLAY)
    typ = s.i(f"ADAS_{prefix}LnTyp", 0)
    conf_raw = s.i(f"ADAS_{prefix}Conf", 0)
    displayed = -LANE_NO_DISPLAY < crvt < LANE_NO_DISPLAY
    return {
      "id": lid,
      "y0": _r(side * offset, 3),
      "heading": _r(LANE_HEADING_CENTER_DEG - s(f"ADAS_{prefix}Hdng", LANE_HEADING_CENTER_DEG), 2),   # deg, + = left
      "radius": None if (not displayed or crvt == 0) else crvt,
      "type": typ,
      "typeName": s.label(f"ADAS_{prefix}LnTyp"),
      "color": (s.label(f"ADAS_{prefix}LnColor") or "").lower().split("(")[0] or None,
      "conf": round((conf_raw + 1) / 8, 3),
      # Lines the ADAS hasn't found keep a default offset with Unknown type and the lowest confidence
      "valid": displayed and (typ != 0 or conf_raw >= 3),
      "roadEdge": typ == 8,
    }

  def _lanes(self, s: _Sig) -> dict:
    lines = [ln for lid, prefix in LANE_LINES.items() if (ln := self._lane_line(s, lid, prefix)) is not None]

    def hmi(side: str) -> dict | None:
      dst = s(f"ADAS_{side}LineDst")
      if dst is None:
        return None
      raw = round((dst + 6.2) / 0.1)
      return {
        "y": None if raw >= 125 else _r(-dst if side == "Ri" else dst, 2),
        "color": (s.label(f"ADAS_{side}LineColor") or "").lower().split("(")[0] or None,
        "flash": s.i(f"ADAS_{side}LineFlash"),
        "type": s.i(f"ADAS_{side}LineTyp"),   # 0 = not drawn, 1 solid, 2 dashed
      }

    crvt = s("ADAS_LaneCrvt")
    return {
      "lines": lines,
      # what the cluster draws (0x340): blue = lane centering engaged, red/flash = departure
      "hmi": {
        "left": hmi("Le"), "right": hmi("Ri"),
        "radius": None if crvt is None or crvt == 0 or abs(crvt) >= LANE_NO_DISPLAY else crvt,
        "fault": s.enum("ADAS_FltIndcr"),
      },
    }

  @staticmethod
  def _road(s: _Sig) -> dict:
    width = s("ADAS_RealLaneWidth")

    def dist_item(type_sig: str, dist_sig: str) -> dict | None:
      d = s(dist_sig)
      return None if not d else {"type": s.label(type_sig), "dist": d}

    hazard = None
    if s.i("ADAS_HzdDetected") == 0 and s("ADAS_HzdDst"):  # 0 = TRUE in this DBC
      hazard = {"class": s.i("ADAS_HzdClassification"), "dist": s("ADAS_HzdDst")}
    return {
      "laneWidth": None if width is None or width >= 6.3 else _r(width, 1),
      "egoLane": s.label("ADAS_EgoLnTyp"),
      "adjacent": {
        "L1": s.label("ADAS_LeLn1Typ"), "L2": s.label("ADAS_LeLn2Typ"),
        "R1": s.label("ADAS_RiLn1Typ"), "R2": s.label("ADAS_RiLn2Typ"),
      },
      "leftLane": {"width": _r(s("ADAS_LeftLaneWidth"), 1) or None, "type": s.label("ADAS_LeftLaneType")},
      "rightLane": {"width": _r(s("ADAS_RightLaneWidth"), 1) or None, "type": s.label("ADAS_RightLaneType")},
      "oncoming": {
        "L1": s.i("ADAS_LeLn1TrffcDir") == 0, "L2": s.i("ADAS_LeLn2TrffcDir") == 0,
        "R1": s.i("ADAS_RiLn1TrffcDir") == 0, "R2": s.i("ADAS_RiLn2TrffcDir") == 0,
      },
      "curbs": {"left": s.enum("ADAS_WSP_LeftCurb"), "right": s.enum("ADAS_WSP_RightCurb")},
      "landmark": dist_item("ADAS_LandmarkType", "ADAS_LandmarkDst"),
      "laneMarking": dist_item("ADAS_LaneMarkingType", "ADAS_LaneMarkingDistance"),
      "construction": dist_item("ADAS_ConstructionObjectType", "ADAS_ConstructionObjectDst"),
      "hazard": hazard,
      "trafficSide": s.label("ADAS_Obj_TrfcStyle"),
      "speedLimitEndDist": s("ADAS_RngIntlSpdLim") or None,
    }

  @staticmethod
  def _objects(s: _Sig) -> list[dict]:
    flags_by_id: dict[int, list[str]] = {}

    def flag(sig: str, name: str):
      oid = s.i(sig)
      if oid:
        flags_by_id.setdefault(oid, []).append(name)

    flag("ADAS_ACCPrimTgtID", "accPrimary")
    flag("ADAS_ACCScndTgtID", "accSecondary")
    flag("ADAS_LdngVhclID", "leading")
    if s.i("ADAS_BSD_CID_LeDispReq", 0) in (1, 2, 3):
      flag("ADAS_BSDLeftThreatID", "bsd")
    if s.i("ADAS_BSD_CID_RiDispReq", 0) in (1, 2, 3):
      flag("ADAS_BSDRightThreatID", "bsd")
    flag("ADAS_DOW_ThreatIDLeft", "dow")
    flag("ADAS_DOW_ThreatIDRight", "dow")
    flag("ADAS_AEBThreatID", "aeb")
    flag("ADAS_RAEB_ThreatID", "raeb")
    flag("ADAS_BACMThreatID", "bacm")
    flag("ADAS_ELKAThreatID", "elka")

    out = []
    for n in OBJECT_MSGS:
      oid = s.i(f"ADAS_Obj{n}_ID")
      if not oid:
        continue
      long_d = s(f"ADAS_Obj{n}_LongDist", 0.0)
      lat_d = s(f"ADAS_Obj{n}_LatDist", 0.0)
      cls = s.i(f"ADAS_Obj{n}_Classification", 6)
      out.append({
        "id": oid,
        "slot": n,
        "x": _r(-long_d if s.i(f"ADAS_Obj{n}_LongDistSign") == 1 else long_d, 2),
        "y": _r(lat_d if s.i(f"ADAS_Obj{n}_LatDistSign") == 1 else -lat_d, 2),   # 0 = positive right
        "w": _r(s(f"ADAS_Obj{n}_Width"), 2),
        "l": _r(s(f"ADAS_Obj{n}_Length"), 2),
        "h": _r(s(f"ADAS_Obj{n}_Height"), 2),
        "heading": _r(_norm_deg(s(f"ADAS_VVP_ICC_Obj{n}Hdng", 0.0)), 1),
        "cls": OBJECT_CLASSES.get(cls, "unknown"),
        "conf": s.i(f"ADAS_Obj{n}_Conf"),
        "classConf": round((s.i(f"ADAS_Obj{n}_ClassConf", 0) + 1) / 4, 2),
        "brake": s.i(f"ADAS_VVP_ICC_Obj{n}BrkLght"),
        "flags": flags_by_id.get(oid, []),
      })
    return out

  @staticmethod
  def _threats(s: _Sig) -> dict:
    def side(le_ri: str, left: bool) -> dict:
      return {
        "bsd": s.enum(f"ADAS_BSD_CID_{le_ri}DispReq"),
        "bsdId": s.i("ADAS_BSDLeftThreatID" if left else "ADAS_BSDRightThreatID"),
        "dow": s.enum(f"ADAS_DOW_CID_{le_ri}DispReq"),
        "dowId": s.i("ADAS_DOW_ThreatIDLeft" if left else "ADAS_DOW_ThreatIDRight"),
        "mirror": {"req": s.i(f"ADAS_{le_ri}MirrWarnReq"), "src": s.label(f"ADAS_{le_ri}MirrWarnSrc")},
        "ids": {"req": s.enum(f"ADAS_IDS_{le_ri}WarnReq"), "src": s.label(f"ADAS_IDS_{le_ri}WarnSrc")},
      }

    return {
      "bsdState": s.enum("ADAS_BSDSts"),
      "dowState": s.enum("ADAS_DOW_Sts"),
      "left": side("Le", True),
      "right": side("Ri", False),
    }

  @staticmethod
  def _aeb(s: _Sig) -> dict:
    return {
      "facm": s.enum("ADAS_FACM_Sts"),
      "bacm": s.enum("ADAS_BACM_Sts"),
      "rearAeb": s.enum("AEB_ReAEB_Sts"),
      "warning": s.enum("ADAS_AEBWarnSts"),
      "type": s.enum("ADAS_AEB_Typ"),
      "brakeIntervention": s.enum("ADAS_BrakeIntrvntnSt"),
      "rearWarning": s.i("ADAS_AEB_RAEB_WarnReq"),
      "bacmSide": s.label("ADAS_BACM_WarnSide"),
      "facmTelltale": s.enum("ADAS_FACM_TelltaleReq"),
      "elkaTelltale": s.enum("ADAS_ELKA_TelltaleReq"),
      "esaTelltale": s.enum("ADAS_ESA_TelltaleReq"),
      "bsmTelltale": s.enum("ADAS_BSM_ELKA_TelltaleReq"),
    }

  @staticmethod
  def _tsr(s: _Sig) -> dict:
    limit = s.i("ADAS_TSRSpeedLimit")
    unit = s.i("ADAS_SpeedLimitUnit")
    isa = s.i("ADAS_ISA_SpdLmt")
    prohibited = s.i("ADAS_FobdSign")
    return {
      "state": s.enum("ADAS_TSRSts"),
      "speedLimit": limit if limit and limit < 255 else None,
      "unit": None if unit is None else ("mph" if unit == 1 else "kmh"),
      "addOn": s.i("ADAS_TSRSpeedLimitAddOn") or None,
      "isaLimitKph": isa if isa and isa < 255 else None,    # ISA limit + user offset, always km/h
      "confidence": s.enum("ADAS_TSRSpdLimConfidenceLvl"),
      "condition": s.label("ADAS_TSRSignCondition"),
      "noPassing": s.i("ADAS_TSRPassingCondition"),
      "prohibited": s.label("ADAS_FobdSign") if prohibited else None,
      "isaWarning": s.i("ADAS_ISAWarnReq"),
      "overspeed": s.enum("ADAS_ISAOverSpeedWarning"),
      "changeNotice": s.i("ADAS_ISA_PerSpdLim_req"),
    }

  @staticmethod
  def _tlr(s: _Sig) -> dict:
    # The lit light: the ego-lane color (with arrow / supplementary combinations) when the ADAS has
    # one, else ADAS_TrafficLightShape (despite its name it carries Red/Amber/Green), else what the
    # red-light warning / green-light reminder implies.
    ego = s.i("ADAS_TLR_EgoLaneColor", 0)
    plain = s.i("ADAS_TrafficLightShape", 0)
    warn = s.i("ADAS_TLR_WarnReq", 0)
    active = None
    if 1 <= ego <= 7:
      active = {"color": s.label("ADAS_TLR_EgoLaneColor"), "source": "egoLane"}
    elif 1 <= plain <= 3:
      active = {"color": s.label("ADAS_TrafficLightShape"), "source": "light"}
    elif warn in (1, 2):
      active = {"color": "Red" if warn == 1 else "Green", "source": "warning"}
    return {
      "state": s.enum("ADAS_Sts_TLR"),
      "detected": active is not None,
      "active": active,
      "color": s.label("ADAS_TLR_EgoLaneColor"),
      "lightColor": s.label("ADAS_TrafficLightShape"),
      "shape": s.label("ADAS_TLR_EgoLaneTyp"),
      "status": s.label("ADAS_TLR_EgoLaneSts"),
      "warning": s.enum("ADAS_TLR_WarnReq"),
      "dist": s("ADAS_TrafficLiDst") or None,
      "lights": s.i("ADAS_TLRNumSpots"),
      "orientation": s.label("ADAS_TLRStructOrient"),
    }

  @staticmethod
  def _parking(s: _Sig) -> dict:
    uss = {side: [s.i(f"ADAS_USS_{p}{i}") for i in range(4)] for side, p in USS_SECTORS.items()}

    def pdc(front: bool) -> list:
      p = "F" if front else "R"
      out = []
      for sensor in PDC_SENSORS:
        v = s.i(f"ADAS_ObjDst_{p}{sensor}")
        out.append(None if v is None or v >= 255 else v)
      return out

    def slot(key: str) -> dict | None:
      sid = s.i(f"ADAS_APASlot{key}ID")
      if not sid:
        return None
      corners = []
      for corner in ("ReLe", "ReRi", "FrRi", "FrLe"):
        x, y = s(f"ADAS_APASlot{key}_{corner}Crnr_x"), s(f"ADAS_APASlot{key}_{corner}Crnr_y")
        corners.append(None if x is None or y is None else [_r(x, 2), _r(y, 2)])
      return {
        "id": sid, "type": s.label(f"ADAS_APASlot{key}Typ"), "side": s.label(f"ADAS_APASlot{key}Sid"),
        "occupied": s.i(f"ADAS_APASlot{key}Sts"), "corners": corners,
      }

    slots = [sl for k in range(1, 7) if (sl := slot(str(k))) is not None]
    return {
      "uss": uss,
      "pdc": {"front": pdc(True), "rear": pdc(False)},
      "apa": {
        "state": s.enum("ADAS_APASts"),
        "available": s.label("ADAS_APAAvailable"),
        "scanning": s.label("ADAS_APAScanngSde"),
        "speedWarning": s.i("ADAS_APASpdWarn"),
        "slots": slots,
        "selected": slot("Sel"),
      },
      "curbWarning": {
        "fl": s.i("ADAS_CurbPrtcFrLeWhl"), "fr": s.i("ADAS_CurbPrtcFrRiWhl"),
        "rl": s.i("ADAS_CurbPrtcRrLeWhl"), "rr": s.i("ADAS_CurbPrtcRrRiWhl"),
      },
      "wsppa": s.enum("ADAS_WSPPASts"),
      "svsView": s.label("ADASDC_SVS_ViewSts"),
      "rap": s.enum("ADAS_Sts_RAP"),
      "trainedParking": s.enum("ADAS_Sts_TP"),
    }

  @staticmethod
  def _dms(s: _Sig) -> dict:
    return {
      "attentionZone": s.label("ADAS_DrvrAttention_Zone"),
      "alertState": s.label("ADAS_DrvrAlert_State"),
      "engagement": s.label("ADAS_DrvrEngagement_Level_Status"),
      "impairment": s.label("ADAS_DrvrImpairment_Level_Stat"),
      "drowsiness": s.label("ADAS_DCAA_DrvrDrowsinessLvl"),
      "driver": s.label("ADAS_DMSDrvrDetn"),
      "cameraBlocked": s.i("ADAS_DMS_Camera_Blockage_Status") == 2 if s("ADAS_DMS_Camera_Blockage_Status") is not None else None,
      "dcaa": s.enum("ADAS_DCAASts"),
      "dcaaWarning": s.enum("ADAS_DCAA_WarnLvlReq"),
    }

  @staticmethod
  def _warnings(s: _Sig) -> dict:
    return {
      "chime": s.enum("ADAS_ChimeReq"),
      "text": s.enum("ADAS_IDS_WarnTxtReq"),
      "sysFault": s.enum("ADAS_SysFltWarnReq"),
      "sysFaultType": s.enum("ADAS_SysFltTyp"),
      "takeover": s.enum("ADAS_DrvrTakeOvrReq"),
      "highPriority": s.enum("ADAS_HiPrioDegradationSts"),
      "lowPriority": s.enum("ADAS_LoPrioDegradationSts"),
    }

  @staticmethod
  def _camera(s: _Sig) -> dict:
    return {
      "state": s.enum("ADAS_CamSts"),
      "objects": s.i("ADAS_ObjNr"),
      "ambient": s.label("ADAS_AmbLi"),
      "blind": s.i("ADAS_FrntCamBli"),
      "fault": s.enum("ADAS_FrntCamFlt"),
    }


def lane_polyline(line: dict, x_max: float = 80.0, step: float = 4.0) -> list[tuple[float, float]]:
  """Sample a lane line as y(x) = y0 + tan(heading) x + x^2 / 2R (used by tests / tools)."""
  tan_h = math.tan(math.radians(line["heading"] or 0.0))
  k = 1.0 / line["radius"] if line.get("radius") else 0.0
  pts = []
  x = 0.0
  while x <= x_max:
    pts.append((x, line["y0"] + tan_h * x + 0.5 * k * x * x))
    x += step
  return pts
