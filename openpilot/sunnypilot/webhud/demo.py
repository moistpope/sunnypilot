"""
Copyright (c) 2021-, Haibin Wen, sunnypilot, and a number of other contributors.

This file is part of sunnypilot and is licensed under the MIT License.
See the LICENSE.md file in the root directory for more details.

Synthetic drive for previewing the web HUD without a car (server --demo). It encodes real ADASBUS
frames through the DBC, so the Fisker parser is exercised end to end, and fills in the openpilot
services the HUD reads. A 60 s loop: highway cruising with ACC + steering engaged, a motorcycle
passing through the left blind spot, a red light, then a parking maneuver in reverse.
"""
import math

from openpilot.sunnypilot.webhud.fisker_world import BUS_CAM, BUS_PT
from openpilot.sunnypilot.webhud.state import StateBuilder

LOOP_S = 60.0
LANE_W = 3.6


class DemoSource:
  def __init__(self, builder: StateBuilder):
    self.builder = builder
    self.dbc = builder.world.dbc
    self.t = 0.0
    self.playing = True
    self.speed = 1.0
    self.clock = 1000.0
    builder.reset()
    builder.set_brand("fisker")

  def seek(self, t: float) -> None:
    self.t = t % LOOP_S

  def set_speed(self, speed: float) -> None:
    self.speed = speed

  @property
  def now(self) -> float:
    return self.clock

  def status(self) -> dict:
    return {"route": "demo", "segments": [0], "segment": 0, "t": round(self.t, 2), "duration": LOOP_S,
            "playing": self.playing, "speed": self.speed, "loading": False, "errors": {}}

  def _frame(self, name: str, values: dict) -> tuple[int, bytes, int]:
    msg = self.dbc.by_name[name]
    return msg.address, msg.encode(values), BUS_CAM if msg.transmitter == "ADAS" else BUS_PT

  def tick(self, dt: float) -> None:
    if self.playing:
      self.t = (self.t + dt * self.speed) % LOOP_S
    self.clock += dt
    t = self.t
    parking = t > 46
    v = max(0.0, 26.0 - 2.4 * (t - 40)) if t > 40 else 26.0
    if parking:
      v = 1.2
    radius = 900.0 * (1 if math.sin(t / 9) > 0 else -1) if not parking else 0.0
    k = 0.0 if radius == 0 else 1.0 / radius
    # steering wheel angle for that curvature (bicycle model, ratio 15); swing the wheel while parking
    steer_deg = 220 * math.sin((t - 46) * 0.8) if parking else math.degrees(math.atan(k * 2.921)) * 15
    # lamp outputs the way the BCM sends them: turn lamps flash on/off every 0.4 s
    blink_left = 30 < t < 34 and (t - 30) % 0.8 < 0.4
    braking = 40 < t < 47

    frames = []
    lanes = [  # id prefix, msg, offset, type, color
      ("LeLine1", "ADAS_0x339", LANE_W / 2, 2, 0),    # dashed white (0x339 colors: 0=White)
      ("RiLine1", "ADAS_0x20C", LANE_W / 2, 1, 1),    # solid white (0=Gray 1=White)
      ("LeLine2", "ADAS_0x20A", LANE_W * 1.5, 2, 1),
      ("RiLine2", "ADAS_0x20D", LANE_W * 1.5, 8, 1),  # road edge
      ("LeLine3", "ADAS_0x20B", LANE_W * 2.5, 7, 1),  # double solid
    ]
    for prefix, msg, offset, typ, color in lanes:
      crvt = 3200 if parking else (round(radius / 50) * 50 if radius else 0)
      frames.append(self._frame(msg, {
        f"ADAS_{prefix}Offset": offset + 0.15 * math.sin(t / 3), f"ADAS_{prefix}LnTyp": typ, f"ADAS_{prefix}LnColor": color,
        f"ADAS_{prefix}Hdng": 90.0, f"ADAS_{prefix}Crvt": crvt, f"ADAS_{prefix}Conf": 6,
      }))
    frames.append(self._frame("ADAS_0x340", {
      "ADAS_LeLineColor": 2, "ADAS_RiLineColor": 2, "ADAS_LeLineDst": LANE_W / 2, "ADAS_RiLineDst": LANE_W / 2,
      "ADAS_LeLineTyp": 2, "ADAS_RiLineTyp": 1, "ADAS_LaneCrvt": 0,
    }))
    frames.append(self._frame("ADAS_0x20F", {"ADAS_RealLaneWidth": LANE_W, "ADAS_EgoLnTyp": 0}))

    def lat_at(x: float, lane: float) -> float:
      return lane * LANE_W + 0.5 * k * x * x

    objects = [] if parking else [
      (11, "ADAS_0x33B", 1, 32 + 6 * math.sin(t / 5), 0.0, 0, 1.9, 4.7, 1.6),     # lead car (ACC target)
      (12, "ADAS_0x34B", 2, 14 + 3 * math.sin(t / 4), 1.0, 0, 1.8, 4.5, 1.5),     # left lane
      (13, "ADAS_0x32D", 3, 52.0, -1.0, 1, 2.5, 12.0, 3.6),                        # truck, right lane
      (14, "ADAS_0x33D", 4, -30 + 1.6 * ((t % 30) * 2), 1.0, 2, 0.8, 2.1, 1.5),   # motorcycle passing on the left
      (15, "ADAS_0x34D", 5, 75.0, 0.05, 0, 1.9, 4.8, 1.7),
    ]
    obj_slots = {"ADAS_0x33B": 1, "ADAS_0x34B": 2, "ADAS_0x32D": 3, "ADAS_0x33D": 4, "ADAS_0x34D": 5,
                 "ADAS_0x32F": 6, "ADAS_0x33F": 7, "ADAS_0x34F": 8}
    used = set()
    bsd_left = 0
    for oid, msg, n, x, lane, cls, w, length, h in objects:
      y = lat_at(x, lane)
      used.add(msg)
      if lane > 0.5 and -8 < x < 2:
        bsd_left = oid
      frames.append(self._frame(msg, {
        f"ADAS_Obj{n}_ID": oid, f"ADAS_Obj{n}_LongDist": min(abs(x), 125), f"ADAS_Obj{n}_LongDistSign": int(x < 0),
        f"ADAS_Obj{n}_LatDist": min(abs(y), 125), f"ADAS_Obj{n}_LatDistSign": int(y > 0),
        f"ADAS_Obj{n}_Width": w, f"ADAS_Obj{n}_Length": min(length, 50), f"ADAS_Obj{n}_Height": h,
        f"ADAS_Obj{n}_Classification": cls, f"ADAS_Obj{n}_Conf": 1, f"ADAS_Obj{n}_ClassConf": 3,
        f"ADAS_VVP_ICC_Obj{n}Hdng": 0, f"ADAS_VVP_ICC_Obj{n}BrkLght": int(oid == 11 and math.sin(t / 5) < -0.7),
      }))
    for msg, n in obj_slots.items():
      if msg not in used:
        frames.append(self._frame(msg, {f"ADAS_Obj{n}_ID": 0}))

    engaged = not parking
    # road furniture: a speed limit sign read at 6 s (65 -> 55), a no-U-turn sign at 12-15 s, a light that
    # turns green as we approach it at 20-26 s with its stop line, and a crosswalk at 32-35 s
    sign_read = 6 < t < 7 or 12 < t < 13
    limit = 55 if 6 < t < 46 else 65
    light_dist = 150 - 26 * (t - 20)
    light = 20 < t < 26
    light_color = 1 if t < 23.5 else 3   # red, then green
    stop_dist = light_dist - 18
    cross_dist = 26 * (35 - t)
    frames.append(self._frame("ADAS_0x313", {"ADAS_Sts_ACC_ICC": 3 if engaged else 2, "ADAS_TJA_AutoSteerSts": 1,
                                             "ADAS_TSRSts": 3 if sign_read else 2, "ADAS_Sts_TLR": 2 if light else 1}))
    frames.append(self._frame("ADAS_0x31C", {"ADAS_AccTrgSpdDisp": 60, "ADAS_TiGapSet_ACC": 3, "ADAS_ACCPrimTgtID": 11 if engaged else 0,
                                             "ADAS_ACCIconDisp": 2 if engaged else 1, "ADAS_ACCFuncTyp": 2}))
    frames.append(self._frame("ADAS_0x314", {"ADAS_BSDSts": 2, "ADAS_DOW_Sts": 2, "ADAS_LKASts": 3}))
    frames.append(self._frame("ADAS_0x315", {"ADAS_BSD_CID_LeDispReq": 1 if bsd_left else 0, "ADAS_BSDLeftThreatID": bsd_left}))
    frames.append(self._frame("ADAS_0x311", {"ADAS_TSRSpeedLimit": limit, "ADAS_SpeedLimitUnit": 1}))
    frames.append(self._frame("ADAS_0x334", {"ADAS_FobdSign": 3 if 12 < t < 15 else 0}))
    frames.append(self._frame("ADAS_0x210", {
      "ADAS_TLR_EgoLaneColor": light_color if light else 0, "ADAS_TLR_EgoLaneTyp": 1 if light else 0,
      "ADAS_TLR_EgoLaneSts": 2 if light else 0, "ADAS_TLRStructOrient": 1 if light else 0, "ADAS_TLRNumSpots": 3 if light else 0,
    }))
    frames.append(self._frame("ADAS_0x351", {"ADAS_TrafficLiDst": max(0, light_dist) if light else 0}))
    marking = (0, stop_dist) if light and 0 < stop_dist < 80 else (2, cross_dist) if 0 < cross_dist < 80 else (0, 0)
    frames.append(self._frame("ADAS_0x350", {"ADAS_LaneMarkingType": marking[0], "ADAS_LaneMarkingDistance": marking[1]}))
    # backing towards a wall: rear zones close in, something beside the right rear door
    zr = max(1, 4 - int(t - 46)) if parking else 9
    rear = [zr, zr, min(zr + 1, 9), 9] if parking else [9] * 4
    right = [9, 9, 3, 3] if parking else [9] * 4
    uss = {**{f"ADAS_USS_B{i}": z for i, z in enumerate(rear)}, **{f"ADAS_USS_R{i}": z for i, z in enumerate(right)}}
    uss.update({f"ADAS_USS_{p}{i}": 9 for p in "FL" for i in range(4)})
    frames.append(self._frame("ADAS_0x352", uss))
    frames.append(self._frame("ADAS_0x359", {"ADAS_ObjDst_RLC": 30 + 25 * (zr - 1) if parking else 255, "ADAS_ObjDst_RLM": 255,
                                             "ADAS_ObjDst_RLS": 255, "ADAS_ObjDst_RRS": 255, "ADAS_ObjDst_RRC": 255, "ADAS_ObjDst_RRM": 255}))
    frames.append(self._frame("ICC_0x531", {"ICC_DispVehSpd": round(v * 2.23694), "ICC_DispVehSpdUnit": 1}))
    frames.append(self._frame("VCU_0x214", {"VCU_GearSig": 3 if parking else 4, "VCU_RdyLamp": 1}))
    frames.append(self._frame("ECC_0x373", {"ECC_OutdT": 21.5, "ECC_OutdTVld": 1}))
    frames.append(self._frame("BCM_0x335", {
      "BCM_LoBeamOutpCmd": 1, "BCM_PosnLampOutpCmd": 3, "BCM_LeTrunLampOutpCmd": int(blink_left),
      "BCM_BrkLampOutpCmd": int(braking), "BCM_RvsLampOutpCmd": int(parking),
    }))
    frames.append(self._frame("EPS_0x1C2", {"EPS_SteerWhlAgSig": steer_deg}))
    self.builder.feed_can(frames, self.clock)

    # openpilot services, as the extractors would produce them
    xs = [0, 2, 5, 10, 16, 24, 34, 46, 60, 76, 94, 115]
    md_lines = [[[x, lat_at(x, o)] for x in xs] for o in (1.0, 0.5, -0.5, -1.0)]
    self._svc("carState", {
      "vEgo": v, "vEgoCluster": v, "aEgo": 0.0, "gear": "reverse" if parking else "drive", "steeringAngleDeg": steer_deg,
      "leftBlinker": blink_left, "rightBlinker": False, "leftBlindspot": bool(bsd_left), "rightBlindspot": False,
      "brakePressed": braking, "gasPressed": False, "doorOpen": False, "seatbeltUnlatched": False, "standstill": False,
      "cruise": {"enabled": engaged, "available": True, "speed": 26.8, "speedCluster": 26.8, "standstill": False},
      "vCruise": 96.6, "vCruiseCluster": 96.6,
    })
    self._svc("selfdriveState", {"state": "enabled" if engaged else "disabled", "enabled": engaged, "active": engaged, "engageable": True,
                                 "alertText1": "", "alertText2": "", "alertStatus": "normal", "alertSize": "none", "personality": "standard",
                                 "experimentalMode": False})
    self._svc("selfdriveStateSP", {"mads": {"state": "enabled", "enabled": True, "active": not parking, "available": True}})
    self._svc("carControl", {"enabled": engaged, "latActive": not parking, "longActive": engaged, "hud": {"leadDistanceBars": 2, "leadVisible": True}})
    self._svc("modelV2", {"laneLines": md_lines, "laneLineProbs": [0.6, 0.95, 0.95, 0.6], "roadEdges": [], "roadEdgeStds": [],
                          "path": [[x, lat_at(x, 0)] for x in xs], "leads": [], "laneChangeState": "off", "laneChangeDirection": "none"})
    self._svc("radarState", {"leadOne": {"present": False}, "leadTwo": {"present": False}})

  def _svc(self, which: str, data: dict) -> None:
    self.builder.services[which] = data
    self.builder.service_t[which] = self.clock
