"""
Copyright (c) 2021-, Haibin Wen, sunnypilot, and a number of other contributors.

This file is part of sunnypilot and is licensed under the MIT License.
See the LICENSE.md file in the root directory for more details.
"""
from opendbc.car.fisker import fiskercan, values

from openpilot.common.test import OpenpilotTestCase
from openpilot.sunnypilot.selfdrive.car.can_overrides import PARAM, CanOverrides


class FakeParams:
  def __init__(self):
    self.store = {}

  def get(self, key, return_default=False):
    return self.store.get(key)


class TestCanOverrides(OpenpilotTestCase):
  def setUp(self):
    super().setUp()
    self.saved = dict(values.ICC_0x35B_OVERRIDES)
    self.ov = CanOverrides.for_brand("fisker")

  def tearDown(self):
    values.ICC_0x35B_OVERRIDES.clear()
    values.ICC_0x35B_OVERRIDES.update(self.saved)
    super().tearDown()

  def test_unsupported_brand(self):
    assert CanOverrides.for_brand("toyota") is None
    assert CanOverrides.for_brand(None) is None

  def test_defaults_are_the_code_values(self):
    assert "ICC_0x52A" not in self.ov.defaults
    assert self.ov.defaults["ICC_0x35B"] == self.saved

  def test_validate(self):
    clean, errors = self.ov.validate({
      "ICC_0x52A": {"ICC_ACCSwt": 1},
      "ICC_0x35B": {"ICC_ViewReq": 2, "ICC_BSDSetting": 2, "ICC_DOW_Setting": True,
                    "ICC_AHBA_Setting": 99, "NotASignal": 1, "ICC_BSD_Sensitivity": 1.25},
      "ADAS_0x31C": {"ADAS_TiGapSet_ACC": 1},
    })
    assert clean == {"ICC_0x35B": {"ICC_BSDSetting": 2}}
    text = " | ".join(errors)
    for needle in ("ICC_0x52A: not an overridable message", "ICC_AHBA_Setting: 99 outside", "NotASignal: unknown signal",
                   "ICC_BSD_Sensitivity: 1.25 outside", "ICC_ViewReq: always passed through", "ICC_DOW_Setting: value must be a number",
                   "ADAS_0x31C: not an overridable message"):
      assert needle in text, needle

  def test_resolve_replaces_per_message(self):
    resolved = self.ov.resolve({"ICC_0x35B": {"ICC_BSDSetting": 3}})
    assert resolved["ICC_0x35B"] == {"ICC_BSDSetting": 3}           # stored message fully replaces defaults
    assert self.ov.resolve(None) == {"ICC_0x35B": self.saved}

  def test_apply_mutates_the_dicts_carcontroller_reads(self):
    target = values.ICC_0x35B_OVERRIDES
    assert fiskercan.ICC_0x35B_OVERRIDES is target
    self.ov.apply({"ICC_0x35B": {"ICC_BSDSetting": 2}})
    assert fiskercan.ICC_0x35B_OVERRIDES is target
    assert target == {"ICC_BSDSetting": 2}
    self.ov.apply({"ICC_0x35B": {}})
    assert target == {}

  def test_poll_applies_only_on_change(self):
    params = FakeParams()
    assert self.ov.poll(params)              # first poll applies defaults
    assert not self.ov.poll(params)
    params.store[PARAM] = {"ICC_0x35B": {"ICC_BSDSetting": 2}}
    assert self.ov.poll(params)
    assert values.ICC_0x35B_OVERRIDES == {"ICC_BSDSetting": 2}
    assert not self.ov.poll(params)
    del params.store[PARAM]
    assert self.ov.poll(params)
    assert values.ICC_0x35B_OVERRIDES == self.saved

  def test_bad_param_falls_back_to_defaults(self):
    params = FakeParams()
    params.store[PARAM] = {"ICC_0x35B": {"ICC_BSDSetting": 2}}
    self.ov.poll(params)
    params.store[PARAM] = {"ICC_0x35B": "garbage"}   # malformed entry is dropped -> code defaults
    self.ov.poll(params)
    assert values.ICC_0x35B_OVERRIDES == self.saved
    params.store[PARAM] = {"ICC_0x35B": {"ICC_BSDSetting": 2}}
    self.ov.poll(params)
    params.store[PARAM] = ["not", "a", "dict"]
    self.ov.poll(params)
    assert values.ICC_0x35B_OVERRIDES == self.saved

  def test_overridden_frame_packs(self):
    self.ov.apply(self.ov.resolve({"ICC_0x35B": {"ICC_BSDSetting": 2}}))
    from opendbc.can import CANPacker, CANParser
    from opendbc.car.fisker.values import CAR, DBC
    from opendbc.car import Bus
    dbc = DBC[CAR.FISKER_OCEAN][Bus.pt]
    can = fiskercan.FiskerCAN(None, CANPacker(dbc))
    msg = can.create_icc_0x35b({"ICC_BSDSetting": 0, "ICC_ViewReq": 1})
    assert msg[0] == 0x35B and msg[2] == 2 and len(msg[1]) == 8
    parser = CANParser(dbc, [("ICC_0x35B", 0)], 2)
    parser.update([(0, [msg])])
    assert parser.vl["ICC_0x35B"]["ICC_BSDSetting"] == 2
    assert parser.vl["ICC_0x35B"]["ICC_ViewReq"] == 1
