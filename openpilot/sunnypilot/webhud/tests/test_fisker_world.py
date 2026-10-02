"""
Copyright (c) 2021-, Haibin Wen, sunnypilot, and a number of other contributors.

This file is part of sunnypilot and is licensed under the MIT License.
See the LICENSE.md file in the root directory for more details.
"""
import json
import random

from openpilot.common.test import OpenpilotTestCase
from openpilot.sunnypilot.webhud.fisker_world import BUS_CAM, BUS_PT, STALE_S, FiskerWorld, lane_polyline


class TestFiskerWorld(OpenpilotTestCase):
  def setUp(self):
    super().setUp()
    self.world = FiskerWorld()

  def frame(self, name: str, values: dict, src: int | None = None):
    msg = self.world.dbc.by_name[name]
    return msg.address, msg.encode(values), (BUS_CAM if msg.transmitter == "ADAS" else BUS_PT) if src is None else src

  def test_every_message_decodes_to_json(self):
    rng = random.Random(1)
    frames = [(a, bytes(rng.getrandbits(8) for _ in range(m.size)), self.world.native_bus[a]) for a, m in self.world.dbc.messages.items()]
    self.world.update(frames, 10.0)
    state = self.world.state()
    json.dumps(state)  # must be serializable
    assert state["active"]

  def test_lane_line(self):
    self.world.update([
      self.frame("ADAS_0x339", {"ADAS_LeLine1Offset": 1.75, "ADAS_LeLine1Hdng": 92.0, "ADAS_LeLine1Crvt": -500,
                                "ADAS_LeLine1LnTyp": 2, "ADAS_LeLine1LnColor": 1, "ADAS_LeLine1Conf": 7}),
      self.frame("ADAS_0x20C", {"ADAS_RiLine1Offset": 1.6, "ADAS_RiLine1Crvt": 3200, "ADAS_RiLine1LnTyp": 0}),
    ], 1.0)
    lines = {ln["id"]: ln for ln in self.world.state()["lanes"]["lines"]}
    left = lines["L1"]
    assert left["y0"] == 1.75 and left["heading"] == -2.0 and left["radius"] == -500   # raw 92 deg = 2 deg to the right
    assert left["color"] == "yellow" and left["typeName"] == "SingleLine_dashed" and left["conf"] == 1.0 and left["valid"]
    right = lines["R1"]
    assert right["y0"] == -1.6          # right lines are negative (y is +left)
    assert right["radius"] is None and not right["valid"]   # 3200 = not displayed
    pts = lane_polyline(left, x_max=20, step=10)
    assert len(pts) == 3 and pts[0] == (0.0, 1.75)

  def test_objects_and_flags(self):
    self.world.update([
      self.frame("ADAS_0x33B", {"ADAS_Obj1_ID": 42, "ADAS_Obj1_LongDist": 30.4, "ADAS_Obj1_LongDistSign": 0,
                                "ADAS_Obj1_LatDist": 3.4, "ADAS_Obj1_LatDistSign": 1, "ADAS_Obj1_Classification": 1,
                                "ADAS_Obj1_Width": 2.5, "ADAS_Obj1_Length": 10.0, "ADAS_VVP_ICC_Obj1Hdng": 357}),
      self.frame("ADAS_0x34B", {"ADAS_Obj2_ID": 7, "ADAS_Obj2_LongDist": 5, "ADAS_Obj2_LongDistSign": 1,
                                "ADAS_Obj2_LatDist": 3, "ADAS_Obj2_LatDistSign": 0}),
      self.frame("ADAS_0x32D", {"ADAS_Obj3_ID": 0}),   # empty slot
      self.frame("ADAS_0x31C", {"ADAS_ACCPrimTgtID": 42, "ADAS_AccTrgSpdDisp": 65, "ADAS_TiGapSet_ACC": 3}),
      self.frame("ADAS_0x313", {"ADAS_Sts_ACC_ICC": 3}),
      self.frame("ADAS_0x315", {"ADAS_BSD_CID_RiDispReq": 1, "ADAS_BSDRightThreatID": 7}),
    ], 2.0)
    state = self.world.state()
    objs = {o["id"]: o for o in state["objects"]}
    assert set(objs) == {42, 7}
    truck = objs[42]
    assert truck["x"] == 30.4 and truck["y"] == 3.4 and truck["cls"] == "truck" and truck["heading"] == -3.0
    assert truck["flags"] == ["accPrimary"]
    behind = objs[7]
    assert behind["x"] == -5 and behind["y"] == -3 and "bsd" in behind["flags"]
    assert state["acc"]["engaged"] and state["acc"]["setSpeed"] == 65 and state["acc"]["timeGap"] == 3
    assert state["threats"]["right"]["bsd"] == {"v": 1, "n": "Threat_present_on_right"}

  def test_object_distance_resolution(self):
    # the object list is 0.2 m/bit (corrected in the DBC subset; the OEM matrix says 0.5)
    msg = self.world.dbc.by_name["ADAS_0x33B"]
    raw = bytearray(msg.encode({"ADAS_Obj1_ID": 9}))
    raw[1], raw[2] = 202, 6          # LongDist / LatDist raw counts, as the ACC target read on the car
    self.world.update([(msg.address, bytes(raw), self.world.native_bus[msg.address])], 3.0)
    obj = self.world.state()["objects"][0]
    assert obj["x"] == 40.4 and obj["y"] == -1.2

  def test_traffic_light_active_color(self):
    def active(values):
      self.world.update([self.frame("ADAS_0x210", {"ADAS_TLR_EgoLaneColor": 0, "ADAS_TrafficLightShape": 0, "ADAS_TLR_WarnReq": 0, **values})], 4.0)
      tlr = self.world.state()["tlr"]
      return tlr["active"], tlr["detected"]
    # the ego-lane color wins, keeping its arrow / supplementary combination
    assert active({"ADAS_TLR_EgoLaneColor": 5, "ADAS_TrafficLightShape": 3}) == ({"color": "Red_With_Supp_green", "source": "egoLane"}, True)
    # no ego-lane color (none / unknown): the plain light color
    assert active({"ADAS_TLR_EgoLaneColor": 8, "ADAS_TrafficLightShape": 2}) == ({"color": "Amber", "source": "light"}, True)
    # neither: what the warning implies
    assert active({"ADAS_TLR_WarnReq": 1}) == ({"color": "Red", "source": "warning"}, True)
    assert active({}) == (None, False)

  def test_motor_power(self):
    self.world.update([
      self.frame("VCU_0x102", {"VCU_DrvrFrntMotTqReq": 1044, "VCU_DrvrFrntMotTqReqVld": 1,
                               "VCU_DrvrReMotTqReq": 1301, "VCU_DrvrReMotTqReqVld": 1}),
      self.frame("MCU_F_0x150", {"MCU_F_CrtSpd": 1500, "MCU_F_CrtSpdSigVld": 1, "MCU_F_CrtTq": 84, "MCU_F_CrtTqVld": 1}),
      self.frame("MCU_R_0x151", {"MCU_R_CrtSpd": 1500, "MCU_R_CrtSpdSigVld": 1, "MCU_R_CrtTq": 103.5, "MCU_R_CrtTqVld": 1}),
    ], 5.0)
    power = self.world.state()["power"]
    assert power["tqReq"] == 2345 and power["front"] == {"tqReq": 1044, "tq": 84.0, "rpm": 1500}
    assert power["demandKw"] == 32.0       # 2345 Nm at the wheels x 157 rad/s at the motors / 11.5
    assert power["kw"] == 29.5             # 187.5 Nm x 157 rad/s
    # an invalid request drops out; a motor without its speed falls back to road speed
    self.world.update([
      self.frame("VCU_0x102", {"VCU_DrvrFrntMotTqReq": -500, "VCU_DrvrFrntMotTqReqVld": 1, "VCU_DrvrReMotTqReqVld": 2}),
      self.frame("MCU_F_0x150", {"MCU_F_CrtSpdSigVld": 2}),
      self.frame("ESP_0x318", {"ESP_VehSpd": 36}),
    ], 5.1)
    power = self.world.state()["power"]
    assert power["tqReq"] == -500 and power["rear"]["tqReq"] is None and power["front"]["rpm"] is None
    assert power["demandKw"] == -12.8      # regen: -500 Nm x 10 m/s / 0.39 m

  def test_native_bus_preferred_and_echoes_ignored(self):
    w = self.world
    w.update([self.frame("ADAS_0x31C", {"ADAS_AccTrgSpdDisp": 50})], 1.0)
    # the same message forwarded onto bus 0 doesn't replace the fresh cam-side frame
    w.update([self.frame("ADAS_0x31C", {"ADAS_AccTrgSpdDisp": 99}, src=BUS_PT)], 1.1)
    assert w.state()["acc"]["setSpeed"] == 50
    # TX echoes (src >= 128) are never parsed
    w.update([self.frame("ADAS_0x31C", {"ADAS_AccTrgSpdDisp": 77}, src=128 + BUS_CAM)], 1.2)
    assert w.state()["acc"]["setSpeed"] == 50
    # once the native bus goes quiet the other bus fills in
    w.update([self.frame("ADAS_0x31C", {"ADAS_AccTrgSpdDisp": 61}, src=BUS_PT)], 2.0)
    assert w.state()["acc"]["setSpeed"] == 61
    # ...but never the radar's private bus (1), whose 48-byte frames reuse ADASBUS IDs
    w.update([(0x31C, bytes(range(48)), 1)], 3.0)
    assert w.state()["acc"]["setSpeed"] == 61 and w.frames[0x31C][2] == BUS_PT

  def test_stale_messages_drop_out(self):
    w = self.world
    w.update([self.frame("ADAS_0x31C", {"ADAS_AccTrgSpdDisp": 50})], 1.0)
    w.update([self.frame("ICC_0x531", {"ICC_DispVehSpd": 30, "ICC_DispVehSpdUnit": 1})], 1.0 + STALE_S + 0.5)
    state = w.state()
    assert state["acc"]["setSpeed"] is None
    assert state["vehicle"]["displaySpeed"] == 30 and state["vehicle"]["displayUnit"] == "mph"

  def test_parking_sensors(self):
    self.world.update([
      self.frame("ADAS_0x352", {"ADAS_USS_B1": 2, "ADAS_USS_F0": 9, "ADAS_USS_L3": 15}),
      self.frame("ADAS_0x359", {"ADAS_ObjDst_RLC": 45, "ADAS_ObjDst_RRC": 255}),
    ], 3.0)
    park = self.world.state()["parking"]
    assert park["uss"]["rear"][1] == 2 and park["uss"]["front"][0] == 9 and park["uss"]["left"][3] == 15
    assert park["pdc"]["rear"][1] == 45 and park["pdc"]["rear"][4] is None

  def test_raw_messages(self):
    self.world.update([self.frame("ADAS_0x31C", {"ADAS_AccTrgSpdDisp": 50})], 1.0)
    raw = self.world.raw_messages([0x31C, 0x999], now=1.5)
    assert list(raw) == ["0x31C"]
    assert raw["0x31C"]["signals"]["ADAS_AccTrgSpdDisp"] == 50 and raw["0x31C"]["age"] == 0.5
