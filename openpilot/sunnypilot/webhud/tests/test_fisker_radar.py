"""
Copyright (c) 2021-, Haibin Wen, sunnypilot, and a number of other contributors.

This file is part of sunnypilot and is licensed under the MIT License.
See the LICENSE.md file in the root directory for more details.
"""
import json

from openpilot.common.test import OpenpilotTestCase
from openpilot.sunnypilot.webhud.fisker_radar import BUS_RADAR, HEADER, SLOTS, STALE_S, FiskerRadar
from openpilot.sunnypilot.webhud.state import StateBuilder

# A real slot frame from the drive the DBC was decoded from: track 0x6F4, a stationary target
# straight ahead while closing at ~7 m/s.
REAL_SLOT = bytes.fromhex("29000006f47ffff400cb9b7008040af3c30302c83cfcc48005beafe03f800000000000a9c15000000000000000000000")


class TestFiskerRadar(OpenpilotTestCase):
  def setUp(self):
    super().setUp()
    self.radar = FiskerRadar()
    self.dbc = self.radar.dbc

  def header(self, n=1, cycle=5):
    return HEADER, self.dbc.messages[HEADER].encode({"MRR_NumObjects": n, "MRR_CycleCounter": cycle}), BUS_RADAR

  def slot(self, i, **values):
    msg = self.dbc.messages[SLOTS[i]]
    return msg.address, msg.encode({f"MRR_Obj{i:02d}_{k}": v for k, v in values.items()}), BUS_RADAR

  def empty(self, i):
    return SLOTS[i], bytes(5) + b"\x40" + bytes(42), BUS_RADAR   # ID 0, as the radar sends unused slots

  def test_object_frame(self):
    self.radar.update([
      self.header(n=1, cycle=9),
      self.slot(0, ID=1780, Age=40, DistLong=50.0, DistLat=1.5, VrelLong=-7.2, VrelLat=0.6, ArelLong=-0.3,
                Heading=10.0, Class=1, DynProp=5, Width=2.0, Length=4.6),
      self.empty(1),
    ], 1.0)
    st = self.radar.state(1.0)
    json.dumps(st)
    assert st["count"] == 1 and st["cycle"] == 9
    (o,) = st["objects"]
    assert o["id"] == 1780 and o["x"] == 50.0 and o["age"] == 40
    assert o["y"] == -1.5 and o["vy"] == -0.6       # the radar's lateral axis is +right; ours is +left
    assert o["vx"] == -7.2 and o["ax"] == -0.3
    assert o["heading"] == -9.8                      # 10 deg clockwise, on the 360/256 deg grid
    assert o["cls"] == "car" and o["dyn"] == 5 and o["w"] == 2.0 and o["l"] == 4.6

  def test_real_frame(self):
    self.radar.update([self.header(), (SLOTS[0], REAL_SLOT, BUS_RADAR)], 1.0)
    (o,) = self.radar.state(1.0)["objects"]
    assert o["id"] == 0x6F4 and o["age"] == 50 and o["x"] == 87.8 and o["y"] == -0.4 and o["vx"] == -7.32
    assert o["heading"] == 1.4 and o["cls"] == "unclassified" and o["dyn"] == 5 and o["w"] is None

  def test_heading_unavailable(self):
    self.radar.update([self.header(), self.slot(0, ID=5, DistLong=20, Heading=178.6)], 1.0)   # raw 255
    assert self.radar.state(1.0)["objects"][0]["heading"] is None

  def test_track_caught_in_two_slots_keeps_newer(self):
    self.radar.update([self.header(n=2), self.slot(0, ID=7, DistLong=30.0), self.slot(1, ID=8, DistLong=40.0)], 1.0)
    # next cycle: track 7 moved to slot 1 and the snapshot ran before slot 0 was rewritten
    self.radar.update([self.slot(1, ID=7, DistLong=29.5)], 1.065)
    objs = self.radar.state(1.07)["objects"]
    assert [(o["id"], o["x"]) for o in objs] == [(7, 29.5)]

  def test_resent_cycle_is_handed_out_once(self):
    # the radar now and then sends a cycle again with the same MeasTime and counter (000000b5--bfe13ac451--13);
    # handed out twice, every track in it would be measured twice at once
    def cycle(t, c, meas_ns, x):
      hdr = self.dbc.messages[HEADER].encode({"MRR_NumObjects": 1, "MRR_CycleCounter": c, "MRR_MeasTime_Sec": 100, "MRR_MeasTime_NSec": meas_ns})
      self.radar.update([(HEADER, hdr, BUS_RADAR), self.slot(0, ID=7, Age=40, DistLong=x, CycleCounter=c)], t)
      return self.radar.take_cycles(t + 0.05)
    cycles = cycle(1.0, 5, 0, 30.0) + cycle(1.065, 5, 0, 30.0) + cycle(1.13, 6, 65_000_000, 29.5)
    assert [objs[0]["x"] for _, objs in cycles] == [30.0, 29.5]

  def test_silent_or_stale_bus(self):
    assert self.radar.state(1.0) is None
    self.radar.update([self.slot(0, ID=3, DistLong=10)], 1.0)
    assert self.radar.state(1.0) is None             # no header: not a radar cycle
    self.radar.update([self.header()], 1.0)
    assert len(self.radar.state(1.0)["objects"]) == 1
    assert self.radar.state(1.0 + STALE_S + 0.1) is None

  def test_only_bus_1(self):
    addr, data, _ = self.slot(0, ID=3, DistLong=10)
    self.radar.update([(HEADER, self.header()[1], 0), (addr, data, 2), (addr, data, 128 + BUS_RADAR)], 1.0)
    assert self.radar.state(1.0) is None

  def test_snapshot(self):
    b = StateBuilder()
    b.feed_can([self.header(), self.slot(0, ID=3, DistLong=10)], 1.0)
    assert b.snapshot(1.0)["radar"]["objects"][0]["id"] == 3
    b.set_brand("toyota")
    assert b.snapshot(1.0)["radar"] is None
