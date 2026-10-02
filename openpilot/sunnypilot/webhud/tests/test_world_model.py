"""
Copyright (c) 2021-, Haibin Wen, sunnypilot, and a number of other contributors.

This file is part of sunnypilot and is licensed under the MIT License.
See the LICENSE.md file in the root directory for more details.
"""
import math

from openpilot.common.test import OpenpilotTestCase
from openpilot.sunnypilot.webhud.world_model import (CONF_STANDING, FUSION_DELAY_S, RADAR_MIN_AGE, EgoOdometry, WorldModel, adas_measurement,
                                                     op_measurements, radar_measurements, to_ego, to_world)

SHOWN, HIDDEN = 0.65, 0.35   # the view's fade (scene.js CONF_FULL / CONF_HIDE)


def radar_obj(oid, x, y, vx=0.0, vy=0.0, age=40, cls="unclassified", w=None, l=None):
  return {"id": oid, "x": x, "y": y, "vx": vx, "vy": vy, "age": age, "hist": 0x3FFF, "state": 3, "quality": 13,
          "cls": cls, "heading": None, "w": w, "l": l}


class TestEgoOdometry(OpenpilotTestCase):
  def test_circle(self):
    odo = EgoOdometry()
    v, w = 5.0, 0.5   # a 10 m radius left turn
    for i in range(int(math.pi / w / 0.01) + 1):
      odo.update(i * 0.01, v, w)
    x, y, h = odo.pose(math.pi / w)   # half a lap: 20 m to the left, facing back
    assert abs(x) < 0.1 and abs(y - 20) < 0.1 and abs(h - math.pi) < 0.01
    xm, ym, _ = odo.pose(math.pi / w / 2)   # interpolated quarter lap
    assert abs(xm - 10) < 0.1 and abs(ym - 10) < 0.1

  def test_frames_round_trip(self):
    pose = (3.0, -2.0, 0.7)
    assert all(abs(a - b) < 1e-9 for a, b in zip(to_ego(pose, *to_world(pose, 12.0, -1.5)), (12.0, -1.5), strict=True))


class TestWorldModel(OpenpilotTestCase):
  def setUp(self):
    super().setUp()
    self.model = WorldModel()

  def drive(self, t_end, v, w, see=None, dt=0.01, cycle=0.065):
    """Drive at (v, w); every radar cycle `see(t, pose)` returns what's measured then."""
    odo = self.model.odo
    next_cycle, out = 0.0, []
    for i in range(int(t_end / dt) + 1):
      t = i * dt
      odo.update(t, v, w)
      if see is not None and t >= next_cycle:
        self.model.add(see(t, odo))
        next_cycle += cycle
      if i % 5 == 0:   # 20 Hz snapshots
        out.append((t, self.model.step(t)))
    return out

  def test_stationary_object_stays_put_through_a_turn(self):
    wx, wy = 25.0, 6.0   # a parked car, in world coordinates

    def see(t, odo):   # reported at t, measured 0.1 s earlier (the radar's latency)
      x, y = to_ego(odo.pose(t - 0.1), wx, wy)
      return radar_measurements(t - 0.1, [radar_obj(7, x, y, vx=-4.0)], 4.0) if x > 0 else []
    snaps = self.drive(3.0, 4.0, 0.35, see)
    errs = []
    for t, objs in snaps[20:]:
      if objs:
        o = objs[0]
        ox, oy = to_world(self.model.odo.pose(t), o["x"], o["y"])
        errs.append(math.hypot(ox - wx, oy - wy))
        assert o["stationary"] and o["sources"][0]["src"] == "radar"
    assert errs and max(errs) < 0.5, max(errs)

  def test_sources_weighted_by_what_they_measure_well(self):
    # the same car 30 m ahead: the radar has its range right, the ADAS camera reads 1.7 m long and a bit
    # off laterally; openpilot reads 3 m short
    for i in range(40):
      t = i * 0.05
      self.model.odo.update(t, 0.0, 0.0)
      self.model.add(radar_measurements(t, [radar_obj(5, 30.0, 0.8)], 0.0))
      self.model.add([adas_measurement(t + 0.12, {"id": 9, "x": 31.7, "y": 0.5, "cls": "car", "w": 1.9, "l": 4.7, "h": 1.5})])
      self.model.add(op_measurements(t, {"leadOne": {"present": True, "dRel": 27.0, "yRel": 0.4, "vLead": 0.0, "modelProb": 0.9}}, 0.0))
    (o,) = self.model.step(2.0 + FUSION_DELAY_S)
    assert abs(o["x"] - 30.0) < 0.3, o["x"]                 # range from the radar
    assert 0.45 < o["y"] < 0.8, o["y"]                       # lateral leans to the camera
    assert o["cls"] == "car" and o["w"] == 1.9               # class and size from the camera
    assert {s["src"] for s in o["sources"]} == {"radar", "adas", "op"}
    adas = next(s for s in o["sources"] if s["src"] == "adas")
    assert 1.4 < adas["dx"] < 2.0                            # the camera's range offset shows in its residual

  def test_young_radar_tracks_and_lone_openpilot_leads_are_left_out(self):
    assert radar_measurements(0.0, [radar_obj(1, 20.0, 0.0, age=RADAR_MIN_AGE - 1)], 0.0) == []
    for i in range(40):
      t = i * 0.05
      self.model.odo.update(t, 0.0, 0.0)
      self.model.add(radar_measurements(t, [radar_obj(2, 40.0, 3.0)], 0.0))   # the radar is there...
      self.model.add(op_measurements(t, {"leadOne": {"present": True, "dRel": 6.0, "yRel": 0.0, "vLead": 0.0, "modelProb": 0.95}}, 0.0))
    objs = self.model.step(2.0 + FUSION_DELAY_S)
    assert [round(o["x"]) for o in objs] == [40]   # ...so a lead nothing else sees isn't shown

  def test_openpilot_alone_still_shows(self):
    for i in range(40):   # held for a second with nothing else around (other makes have no radar here)
      t = i * 0.05
      self.model.odo.update(t, 10.0, 0.0)
      self.model.add(op_measurements(t, {"leadOne": {"present": True, "dRel": 30.0, "yRel": 0.0, "vLead": 9.0, "modelProb": 0.9}}, 10.0))
      objs = self.model.step(t)
    (o,) = objs
    assert o["sources"][0]["src"] == "op" and abs(o["speed"] - 9.0) < 1.0

  def test_moving_car_velocity_and_heading(self):
    # a car crossing left to right 20 m ahead at 8 m/s while we stand still
    def see(t, odo):
      return radar_measurements(t, [radar_obj(3, 20.0, 10.0 - 8.0 * t, vx=0.0, vy=-8.0)], 0.0)
    snaps = self.drive(1.5, 0.0, 0.0, see)
    o = snaps[-1][1][0]
    assert abs(o["vy"] + 8.0) < 1.0 and abs(o["heading"] + 90) < 10, (o["vy"], o["heading"])
    assert abs(o["y"] - (10.0 - 8.0 * 1.5)) < 0.6     # predicted to now, past the fusion delay

  def test_paused_time_takes_everything(self):
    # right after a seek a paused replay asks again and again for the same moment: the camera's
    # latest reading (newer than the fusion delay) must still get in
    self.model.odo.update(0.0, 0.0, 0.0)
    self.model.add([adas_measurement(1.0, {"id": 4, "x": 12.0, "y": 0.0, "cls": "car"})])
    assert self.model.step(1.0) == []
    (o,) = self.model.step(1.0)
    assert o["cls"] == "car" and o["sources"][0]["src"] == "adas"

  def test_reset(self):
    self.model.odo.update(0.0, 1.0, 0.0)
    self.model.add([adas_measurement(0.2, {"id": 4, "x": 12.0, "y": 0.0, "cls": "car"})])
    self.model.step(0.2)
    (before,) = self.model.step(0.2)
    self.model.reset()
    assert self.model.step(1.0) == [] and self.model.odo.pose(1.0) == (0.0, 0.0, 0.0)
    self.model.add([adas_measurement(1.0, {"id": 4, "x": 12.0, "y": 0.0, "cls": "car"})])
    self.model.step(1.0)
    (after,) = self.model.step(1.0)
    assert after["id"] != before["id"]   # ids keep counting, so a viewer never mixes the two up


class TestConfidence(OpenpilotTestCase):
  """At 22 m/s on a straight road, with openpilot's model running; `world` maps each radar id to a
  ground-fixed (x, y, w, l, cls), `leads` the openpilot leads to report (dRel, yRel, vLead)."""
  V = 22.0

  def setUp(self):
    super().setUp()
    self.model = WorldModel()

  def run_for(self, t_end, world, leads=lambda t: [], moving=None, age=lambda t: 40):
    odo, model, out = self.model.odo, self.model, []
    next_cycle = 0.0
    for i in range(int(t_end / 0.01) + 1):
      t = i * 0.01
      odo.update(t, self.V, 0.0)
      if t >= next_cycle:
        objs = []
        for rid, (wx, wy, w, l, cls) in world.items():
          wx = wx + (moving or {}).get(rid, 0.0) * t
          x, y = to_ego(odo.pose(t), wx, wy)
          if 0 < x < 170:
            objs.append(radar_obj(rid, x, y, vx=(moving or {}).get(rid, 0.0) - self.V, age=age(t), cls=cls, w=w, l=l))
        model.add(radar_measurements(t, objs, self.V))
        rs = {k: {"present": True, "dRel": d, "yRel": y, "vLead": v, "modelProb": 0.9} for k, (d, y, v) in zip(("leadOne", "leadTwo"), leads(t), strict=False)}
        model.add(op_measurements(t, rs, self.V))
        model.model_ran(t)
        next_cycle += 0.065
      if i % 5 == 0:
        out.append((t, model.step(t)))
    return out

  def conf(self, snaps, x_range):
    """(conf, why) of every object reported within x_range ahead."""
    return [(o["conf"], o["confWhy"]) for _, objs in snaps for o in objs if x_range[0] < o["x"] < x_range[1]]

  def test_overhead_sign_in_our_path_stays_hidden(self):
    # route 000000b5--bfe13ac451--12, radar track 791: a traffic light the radar calls a car, 3 m wide and 0.6 m long,
    # standing in our lane; openpilot's model sees no lead there
    snaps = self.run_for(3.5, {791: (110.0, 0.3, 3.0, 0.6, "car")})
    seen = self.conf(snaps, (8.0, 90.0))
    assert seen and max(c for c, _ in seen) < HIDDEN, max(seen)
    assert seen[-1][1] == "unseen"

  def test_a_stopped_car_the_camera_sees_shows(self):
    snaps = self.run_for(3.5, {5: (110.0, 0.3, 2.0, 1.0, "car")}, leads=lambda t: [(106.2 - self.V * t, -0.3, 0.0)] if t > 1.0 else [])
    assert snaps[-1][1][0]["confWhy"] == "vision" and snaps[-1][1][0]["conf"] > SHOWN

  def test_a_stopped_car_behind_a_lead_isnt_doubted(self):
    # the model can't see past the car ahead of us; the radar sees under it
    snaps = self.run_for(3.0, {1: (20.0, 0.0, 2.0, 4.0, "car"), 2: (60.0, 0.2, 2.0, 1.0, "car")}, moving={1: self.V, 2: 0.0},
                         leads=lambda t: [(20.0 - 3.8, 0.0, self.V)])
    stopped = [o for o in snaps[-1][1] if o["sources"][0]["id"] == 2]
    assert stopped and stopped[0]["confWhy"] == "standing" and stopped[0]["conf"] > HIDDEN

  def test_parked_car_beside_the_road_shows_softer(self):
    (o,) = self.run_for(3.0, {3: (60.0, 5.0, 2.0, 4.2, "car")})[-1][1]
    assert o["confWhy"] == "standing" and abs(o["conf"] - CONF_STANDING) < 0.05

  def test_wide_thin_strip_beside_the_road_is_doubted(self):
    (o,) = self.run_for(3.0, {4: (60.0, 5.0, 3.0, 0.6, "car")})[-1][1]
    assert o["confWhy"] == "thin" and o["conf"] < HIDDEN

  def test_young_radar_tracks_wait_to_show(self):
    # radar track 783 on the same drive: a 0.8 s "pedestrian" sprinting across our lane at 50 mph, really its bearing settling
    snaps = self.run_for(2.0, {7: (60.0, 0.0, 2.0, 4.0, "car")}, moving={7: 15.0}, age=lambda t: 8 + int(t / 0.065))
    young = [o for t, objs in snaps if t < 0.8 for o in objs]
    assert young and all(o["confWhy"] == "young" and o["conf"] < HIDDEN for o in young)
    assert snaps[-1][1][0]["confWhy"] == "moving"   # past RADAR_MATURE_AGE (1.3 s of radar track)

  def test_moving_car_is_trusted_without_the_camera(self):
    snaps = self.run_for(3.0, {6: (40.0, 0.0, 2.0, 4.0, "car")}, moving={6: 15.0})
    (o,) = snaps[-1][1]
    assert o["confWhy"] == "moving" and o["conf"] > SHOWN
