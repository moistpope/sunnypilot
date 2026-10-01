"""
Copyright (c) 2021-, Haibin Wen, sunnypilot, and a number of other contributors.

This file is part of sunnypilot and is licensed under the MIT License.
See the LICENSE.md file in the root directory for more details.

Compact, JSON-friendly views of the openpilot/sunnypilot services the web HUD draws. Each extractor
takes a capnp reader (live SubMaster data or a replayed log event) and returns plain dicts, so live
and replay share one code path. Fields are read defensively: a log recorded by a different
openpilot version may lack some of them.
"""
from collections.abc import Callable

# services the HUD consumes (besides raw `can`)
SERVICES = [
  "carState", "carParams", "selfdriveState", "selfdriveStateSP", "carControl", "radarState", "modelV2",
  "longitudinalPlan", "longitudinalPlanSP", "driverMonitoringState", "deviceState", "liveMapDataSP",
  "gpsLocationExternal",
]

# modelV2 has 33 points per line out to ~190 m; keep every other one up to MODEL_MAX_X
MODEL_POINT_STRIDE = 2
MODEL_MAX_X = 120.0


def _g(obj, name: str, default=None):
  try:
    return getattr(obj, name)
  except Exception:  # missing field (AttributeError) or union mismatch (KjException)
    return default


def _f(v, nd: int = 2):
  try:
    return round(float(v), nd)
  except (TypeError, ValueError):
    return None


def _enum(v) -> str | None:
  return None if v is None else str(v)


def car_state(cs) -> dict:
  cruise = _g(cs, "cruiseState")
  return {
    "vEgo": _f(_g(cs, "vEgo"), 3),
    "vEgoCluster": _f(_g(cs, "vEgoCluster"), 3),
    "aEgo": _f(_g(cs, "aEgo")),
    "yawRate": _f(_g(cs, "yawRate"), 3),
    "gear": _enum(_g(cs, "gearShifter")),
    "steeringAngleDeg": _f(_g(cs, "steeringAngleDeg"), 1),
    "steeringTorque": _f(_g(cs, "steeringTorque")),
    "steeringPressed": bool(_g(cs, "steeringPressed", False)),
    "gasPressed": bool(_g(cs, "gasPressed", False)),
    "brakePressed": bool(_g(cs, "brakePressed", False)),
    "leftBlinker": bool(_g(cs, "leftBlinker", False)),
    "rightBlinker": bool(_g(cs, "rightBlinker", False)),
    "leftBlindspot": bool(_g(cs, "leftBlindspot", False)),
    "rightBlindspot": bool(_g(cs, "rightBlindspot", False)),
    "doorOpen": bool(_g(cs, "doorOpen", False)),
    "seatbeltUnlatched": bool(_g(cs, "seatbeltUnlatched", False)),
    "standstill": bool(_g(cs, "standstill", False)),
    "vCruise": _f(_g(cs, "vCruise"), 1),
    "vCruiseCluster": _f(_g(cs, "vCruiseCluster"), 1),
    "cruise": None if cruise is None else {
      "enabled": bool(_g(cruise, "enabled", False)),
      "available": bool(_g(cruise, "available", False)),
      "speed": _f(_g(cruise, "speed")),
      "speedCluster": _f(_g(cruise, "speedCluster")),
      "standstill": bool(_g(cruise, "standstill", False)),
    },
  }


def car_params(cp) -> dict:
  return {
    "brand": _g(cp, "brand"),
    "fingerprint": _g(cp, "carFingerprint"),
    "openpilotLongitudinalControl": bool(_g(cp, "openpilotLongitudinalControl", False)),
    "steerControlType": _enum(_g(cp, "steerControlType")),
  }


def selfdrive_state(ss) -> dict:
  return {
    "state": _enum(_g(ss, "state")),
    "enabled": bool(_g(ss, "enabled", False)),
    "active": bool(_g(ss, "active", False)),
    "engageable": bool(_g(ss, "engageable", False)),
    "alertText1": _g(ss, "alertText1", ""),
    "alertText2": _g(ss, "alertText2", ""),
    "alertStatus": _enum(_g(ss, "alertStatus")),
    "alertSize": _enum(_g(ss, "alertSize")),
    "alertType": _g(ss, "alertType", ""),
    "experimentalMode": bool(_g(ss, "experimentalMode", False)),
    "personality": _enum(_g(ss, "personality")),
  }


def selfdrive_state_sp(ss) -> dict:
  mads = _g(ss, "mads")
  return {
    "mads": None if mads is None else {
      "state": _enum(_g(mads, "state")),
      "enabled": bool(_g(mads, "enabled", False)),
      "active": bool(_g(mads, "active", False)),
      "available": bool(_g(mads, "available", False)),
    },
  }


def car_control(cc) -> dict:
  hud = _g(cc, "hudControl")
  return {
    "enabled": bool(_g(cc, "enabled", False)),
    "latActive": bool(_g(cc, "latActive", False)),
    "longActive": bool(_g(cc, "longActive", False)),
    "hud": None if hud is None else {
      "setSpeed": _f(_g(hud, "setSpeed")),
      "leadVisible": bool(_g(hud, "leadVisible", False)),
      "leadDistanceBars": _g(hud, "leadDistanceBars"),
      "visualAlert": _enum(_g(hud, "visualAlert")),
      "leftLaneDepart": bool(_g(hud, "leftLaneDepart", False)),
      "rightLaneDepart": bool(_g(hud, "rightLaneDepart", False)),
    },
  }


def _lead(lead) -> dict | None:
  if lead is None:
    return None
  present = _g(lead, "present")
  if present is None:
    present = _g(lead, "status", False)  # older logs
  if not present:
    return {"present": False}
  return {
    "present": True,
    "dRel": _f(_g(lead, "dRel")),
    "yRel": _f(_g(lead, "yRel")),
    "vRel": _f(_g(lead, "vRel")),
    "vLead": _f(_g(lead, "vLead")),
    "modelProb": _f(_g(lead, "modelProb")),
    "radar": bool(_g(lead, "radar", False)),
  }


def radar_state(rs) -> dict:
  return {"leadOne": _lead(_g(rs, "leadOne")), "leadTwo": _lead(_g(rs, "leadTwo"))}


def _xy(line, max_x: float = MODEL_MAX_X) -> list[list[float]]:
  """Model frame is x forward, y right; the HUD uses y left."""
  xs, ys = _g(line, "x"), _g(line, "y")
  if xs is None or ys is None:
    return []
  pts = []
  for i in range(0, min(len(xs), len(ys)), MODEL_POINT_STRIDE):
    x = xs[i]
    if x > max_x:
      break
    pts.append([round(x, 2), round(-ys[i], 3)])
  return pts


def model_v2(md) -> dict:
  lines = _g(md, "laneLines") or []
  edges = _g(md, "roadEdges") or []
  meta = _g(md, "meta")
  leads = []
  leads_v3 = _g(md, "leadsV3") or []
  for i in range(min(2, len(leads_v3))):  # capnp lists don't slice
    ld = leads_v3[i]
    prob = _g(ld, "prob", 0.0)
    xs, ys, vs = _g(ld, "x"), _g(ld, "y"), _g(ld, "v")
    if xs and ys and prob > 0.5:
      leads.append({"prob": _f(prob), "x": _f(xs[0]), "y": _f(-ys[0]), "v": _f(vs[0]) if vs else None})
  return {
    "laneLines": [_xy(ln) for ln in lines],
    "laneLineProbs": [_f(p) for p in (_g(md, "laneLineProbs") or [])],
    "roadEdges": [_xy(e) for e in edges],
    "roadEdgeStds": [_f(p) for p in (_g(md, "roadEdgeStds") or [])],
    "path": _xy(_g(md, "position")),
    "leads": leads,
    "laneChangeState": _enum(_g(meta, "laneChangeState")) if meta is not None else None,
    "laneChangeDirection": _enum(_g(meta, "laneChangeDirection")) if meta is not None else None,
    "confidence": _enum(_g(md, "confidence")),
  }


def longitudinal_plan(lp) -> dict:
  return {
    "hasLead": bool(_g(lp, "hasLead", False)),
    "aTarget": _f(_g(lp, "aTarget")),
    "shouldStop": bool(_g(lp, "shouldStop", False)),
    "source": _enum(_g(lp, "longitudinalPlanSource")),
  }


def longitudinal_plan_sp(lp) -> dict:
  sl = _g(lp, "speedLimit")
  resolver = _g(sl, "resolver") if sl is not None else None
  assist = _g(sl, "assist") if sl is not None else None
  dec = _g(lp, "dec")
  return {
    "speedLimit": None if resolver is None else {
      "value": _f(_g(resolver, "speedLimit")),       # m/s
      "valid": bool(_g(resolver, "speedLimitValid", False)),
      "offset": _f(_g(resolver, "speedLimitOffset")),
      "source": _enum(_g(resolver, "source")),
      "distance": _f(_g(resolver, "distToSpeedLimit"), 1),
    },
    "speedLimitAssist": None if assist is None else {
      "state": _enum(_g(assist, "state")), "active": bool(_g(assist, "active", False)),
    },
    "dec": None if dec is None else {"state": _enum(_g(dec, "state")), "active": bool(_g(dec, "active", False))},
    "source": _enum(_g(lp, "longitudinalPlanSource")),
  }


def driver_monitoring_state(dm) -> dict:
  vision = _g(dm, "visionPolicyState")
  return {
    "alertLevel": _enum(_g(dm, "alertLevel")),
    "activePolicy": _enum(_g(dm, "activePolicy")),
    "awareness": _f(_g(vision, "awarenessPercent")) if vision is not None else None,
    "distracted": bool(_g(vision, "isDistracted", False)) if vision is not None else None,
    "faceDetected": bool(_g(vision, "faceDetected", False)) if vision is not None else None,
    "lockout": bool(_g(dm, "lockout", False)),
  }


def device_state(ds) -> dict:
  return {
    "started": bool(_g(ds, "started", False)),
    "thermalStatus": _enum(_g(ds, "thermalStatus")),
    "maxTempC": _f(_g(ds, "maxTempC"), 1),
    "freeSpacePercent": _f(_g(ds, "freeSpacePercent"), 1),
    "networkType": _enum(_g(ds, "networkType")),
    "deviceType": _enum(_g(ds, "deviceType")),
  }


def live_map_data_sp(lm) -> dict:
  return {
    "speedLimit": _f(_g(lm, "speedLimit")) if _g(lm, "speedLimitValid", False) else None,   # m/s
    "speedLimitAhead": _f(_g(lm, "speedLimitAhead")) if _g(lm, "speedLimitAheadValid", False) else None,
    "speedLimitAheadDistance": _f(_g(lm, "speedLimitAheadDistance"), 0),
    "roadName": _g(lm, "roadName", ""),
  }


def gps_location(gps) -> dict:
  return {
    "lat": _f(_g(gps, "latitude"), 6),
    "lon": _f(_g(gps, "longitude"), 6),
    "bearing": _f(_g(gps, "bearingDeg"), 1),
    "speed": _f(_g(gps, "speed")),
    "fix": bool(_g(gps, "hasFix", False)),
  }


EXTRACTORS: dict[str, Callable] = {
  "carState": car_state,
  "carParams": car_params,
  "selfdriveState": selfdrive_state,
  "selfdriveStateSP": selfdrive_state_sp,
  "carControl": car_control,
  "radarState": radar_state,
  "modelV2": model_v2,
  "longitudinalPlan": longitudinal_plan,
  "longitudinalPlanSP": longitudinal_plan_sp,
  "driverMonitoringState": driver_monitoring_state,
  "deviceState": device_state,
  "liveMapDataSP": live_map_data_sp,
  "gpsLocationExternal": gps_location,
}
assert set(EXTRACTORS) == set(SERVICES)
