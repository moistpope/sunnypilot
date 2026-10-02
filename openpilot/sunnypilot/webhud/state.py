"""
Copyright (c) 2021-, Haibin Wen, sunnypilot, and a number of other contributors.

This file is part of sunnypilot and is licensed under the MIT License.
See the LICENSE.md file in the root directory for more details.

StateBuilder folds raw CAN and openpilot service messages into the single snapshot the web UI
renders. Live and replay sources feed it identically; only the clock differs. Besides each source's
own view it runs the world model (world_model.py), which fuses the object sources in a ground-fixed
frame; its ego pose comes from the car's wheel speed and yaw-rate gyro on CAN when it has them. The
world model's sensor calibration (on unless the view turns it off) corrects the sources and the speed.
"""
import math

from openpilot.sunnypilot.webhud.extract import EXTRACTORS
from openpilot.sunnypilot.webhud.fisker_radar import FiskerRadar
from openpilot.sunnypilot.webhud.fisker_world import OBJECT_MSGS, FiskerWorld
from openpilot.sunnypilot.webhud.world_model import (MEASURED_CALIBRATION, NO_CALIBRATION, OP_LATENCY_S, WorldModel, adas_measurement,
                                                     op_measurements, radar_measurements)

SERVICE_STALE_S = 2.0
ODOMETRY_CAN_S = 0.5     # carState stands in for the CAN odometry once that's older than this
# ADASBUS odometry: the signals carState itself uses (opendbc/car/fisker/carstate.py)
SPEED_MSG, YAW_MSG, GEAR_MSG = 0x318, 0x112, 0x214
GEAR_REVERSE = 3          # VCU_GearSig


class StateBuilder:
  def __init__(self, world: FiskerWorld | None = None, radar: FiskerRadar | None = None, model: WorldModel | None = None):
    self.world = world or FiskerWorld()
    self.radar = radar or FiskerRadar()
    self.model = model or WorldModel()
    self.services: dict[str, dict] = {}
    self.service_t: dict[str, float] = {}
    self.brand: str | None = None
    self.t = 0.0
    self._odo_can_t = -1e9
    self._adas_fed: dict[int, float] = {}
    self._rs_fed: float | None = None

  def reset(self) -> None:
    self.world.reset()
    self.radar.reset()
    self.model.reset()
    self.services.clear()
    self.service_t.clear()
    self.t = 0.0
    self._odo_can_t = -1e9
    self._adas_fed.clear()
    self._rs_fed = None

  @property
  def fisker(self) -> bool:
    # an unknown brand still parses, so logs/benches without carParams work
    return self.brand in (None, "fisker")

  def feed_can(self, frames, t: float) -> None:
    self.t = max(self.t, t)
    if self.fisker:
      self.world.update(frames, t)
      self.radar.update(frames, t)
      self._odometry_from_can(t)

  def _odometry_from_can(self, t: float) -> None:
    spd, yaw = self.world.frames.get(SPEED_MSG), self.world.frames.get(YAW_MSG)
    if spd is None or yaw is None or max(spd[1], yaw[1]) != t or t - min(spd[1], yaw[1]) > 0.1:
      return   # nothing new in this batch, or one of the two has gone quiet
    v = self.world.decoded(SPEED_MSG, t)["ESP_VehSpd"] / 3.6 * self.model.calib.speed_scale
    gear = self.world.decoded(GEAR_MSG, t)
    if gear is not None and int(gear["VCU_GearSig"]) == GEAR_REVERSE:
      v = -v
    self.model.odo.update(t, v, math.radians(self.world.decoded(YAW_MSG, t)["YRS_YawRate"]))
    self._odo_can_t = t

  def feed_service(self, which: str, msg, t: float) -> None:
    extractor = EXTRACTORS.get(which)
    if extractor is None:
      return
    self.services[which] = extractor(msg)
    self.service_t[which] = t
    self.t = max(self.t, t)
    if which == "carParams":
      self.brand = self.services[which].get("brand") or self.brand
    elif which == "carState" and t - self._odo_can_t > ODOMETRY_CAN_S:
      cs = self.services[which]
      v = (cs.get("vEgo") or 0.0) * self.model.calib.speed_scale * (-1 if cs.get("gear") == "reverse" else 1)   # wheel speed too
      self.model.odo.update(t, v, cs.get("yawRate") or 0.0)

  def set_brand(self, brand: str | None) -> None:
    self.brand = brand or None

  def set_calibration(self, on: bool) -> None:
    self.model.set_calibration(MEASURED_CALIBRATION if on else NO_CALIBRATION)

  def _measurements(self, now: float, fisker: dict | None) -> list:
    odo, calib = self.model.odo, self.model.calib
    meas = []
    if self.fisker:
      for t, objs in self.radar.take_cycles(now):
        meas += radar_measurements(t, objs, odo.speed(t), calib)
      for o in (fisker or {}).get("objects", []):
        addr = OBJECT_MSGS[o["slot"]]
        t_rx = self.world.frames[addr][1]
        if self._adas_fed.get(addr) != t_rx:   # only frames not fed yet
          self._adas_fed[addr] = t_rx
          meas.append(adas_measurement(t_rx, o, calib))
    rs, t_rs = self.services.get("radarState"), self.service_t.get("radarState")
    if rs is not None and t_rs != self._rs_fed and now - t_rs < 1.0:
      self._rs_fed = t_rs
      t = rs.get("mdMonoTime") or t_rs
      meas += op_measurements(t - OP_LATENCY_S, rs, odo.speed(t), calib)
      self.model.model_ran(t - OP_LATENCY_S)
    return meas

  def snapshot(self, now: float | None = None) -> dict:
    now = self.t if now is None else now
    op = {}
    for which, data in self.services.items():
      if which == "carParams" or now - self.service_t.get(which, 0.0) <= SERVICE_STALE_S:
        op[which] = data
    fisker = self.world.state(now) if self.fisker else None
    self.model.add(self._measurements(now, fisker))
    return {
      "t": round(now, 3),
      "brand": self.brand,
      "op": op,
      "fisker": fisker,
      "radar": self.radar.state(now) if self.fisker else None,
      "objects": self.model.step(now),   # the world model's fused objects
      "calibration": self.model.calib.to_json(),
    }
