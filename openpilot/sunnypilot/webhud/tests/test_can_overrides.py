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
    self.saved = (dict(values.ICC_SETTINGS_OVERRIDES), dict(values.ICC_0x35B_OVERRIDES))
    self.ov = CanOverrides.for_brand("fisker")

  def tearDown(self):
    values.ICC_SETTINGS_OVERRIDES.clear()
    values.ICC_SETTINGS_OVERRIDES.update(self.saved[0])
    values.ICC_0x35B_OVERRIDES.clear()
    values.ICC_0x35B_OVERRIDES.update(self.saved[1])
    super().tearDown()

  def test_unsupported_brand(self):
    assert CanOverrides.for_brand("toyota") is None
    assert CanOverrides.for_brand(None) is None

  def test_defaults_are_the_code_values(self):
    assert self.ov.defaults["ICC_0x52A"] == self.saved[0]
    assert self.ov.defaults["ICC_0x35B"] == self.saved[1]

  def test_validate(self):
    clean, errors = self.ov.validate({
      "ICC_0x52A": {"ICC_ACCSwt": 1, "ICC_ACCFuncTyp": 99, "ICC_0x52A_CheckSum": 3, "NotASignal": 1, "ICC_ACCSpdLimOffs": 1.25},
      "ICC_0x35B": {"ICC_ViewReq": 2, "ICC_BSDSetting": 2, "ICC_DOW_Setting": True},
      "ADAS_0x31C": {"ADAS_TiGapSet_ACC": 1},
    })
    assert clean == {"ICC_0x52A": {"ICC_ACCSwt": 1}, "ICC_0x35B": {"ICC_BSDSetting": 2}}
    text = " | ".join(errors)
    for needle in ("ICC_ACCFuncTyp: 99 outside", "CheckSum: always passed through", "NotASignal: unknown signal",
                   "ICC_ACCSpdLimOffs: 1.25 outside", "ICC_ViewReq: always passed through", "ICC_DOW_Setting: value must be a number",
                   "ADAS_0x31C: not an overridable message"):
      assert needle in text, needle

  def test_resolve_replaces_per_message(self):
    resolved = self.ov.resolve({"ICC_0x35B": {"ICC_BSDSetting": 3}})
    assert resolved["ICC_0x35B"] == {"ICC_BSDSetting": 3}           # stored message fully replaces defaults
    assert resolved["ICC_0x52A"] == self.saved[0]                    # missing message keeps code defaults
    assert self.ov.resolve(None) == {"ICC_0x52A": self.saved[0], "ICC_0x35B": self.saved[1]}

  def test_apply_mutates_the_dicts_carcontroller_reads(self):
    target = values.ICC_SETTINGS_OVERRIDES
    assert fiskercan.ICC_SETTINGS_OVERRIDES is target
    self.ov.apply({"ICC_0x52A": {"ICC_ACCSwt": 1, "ICC_LKA_Setting": 1}, "ICC_0x35B": {}})
    assert fiskercan.ICC_SETTINGS_OVERRIDES is target
    assert target == {"ICC_ACCSwt": 1, "ICC_LKA_Setting": 1}
    assert values.ICC_0x35B_OVERRIDES == {}

  def test_poll_applies_only_on_change(self):
    params = FakeParams()
    assert self.ov.poll(params)              # first poll applies defaults
    assert not self.ov.poll(params)
    params.store[PARAM] = {"ICC_0x52A": {"ICC_ACCSwt": 1}}
    assert self.ov.poll(params)
    assert values.ICC_SETTINGS_OVERRIDES == {"ICC_ACCSwt": 1}
    assert values.ICC_0x35B_OVERRIDES == self.saved[1]
    assert not self.ov.poll(params)
    del params.store[PARAM]
    assert self.ov.poll(params)
    assert values.ICC_SETTINGS_OVERRIDES == self.saved[0]

  def test_bad_param_falls_back_to_defaults(self):
    params = FakeParams()
    params.store[PARAM] = {"ICC_0x52A": {"ICC_ACCSwt": 1}}
    self.ov.poll(params)
    params.store[PARAM] = {"ICC_0x52A": "garbage"}   # malformed entry is dropped -> code defaults
    self.ov.poll(params)
    assert values.ICC_SETTINGS_OVERRIDES == self.saved[0]
    params.store[PARAM] = {"ICC_0x52A": {"ICC_ACCSwt": 1}}
    self.ov.poll(params)
    params.store[PARAM] = ["not", "a", "dict"]
    self.ov.poll(params)
    assert values.ICC_SETTINGS_OVERRIDES == self.saved[0]

  def test_overridden_frame_packs(self):
    self.ov.apply(self.ov.resolve({"ICC_0x52A": {"ICC_ACCSwt": 1, "ICC_ACCSpdLimOffs": 2.5}}))
    from opendbc.can import CANPacker
    from opendbc.car.fisker.values import CAR, DBC
    from opendbc.car import Bus
    can = fiskercan.FiskerCAN(None, CANPacker(DBC[CAR.FISKER_OCEAN][Bus.pt]))
    addr, data, bus = can.create_icc_settings({"ICC_ACCSwt": 0, "ICC_0x52A_AliveCounter": 5})
    assert addr == 0x52A and bus == 2 and len(data) == 8
