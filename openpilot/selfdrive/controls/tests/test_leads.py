from openpilot.common.test import OpenpilotTestCase
import openpilot.cereal.messaging as messaging

from opendbc.car.toyota.values import CAR as TOYOTA
from openpilot.selfdrive.test.process_replay import replay_process_with_name


class TestLeads(OpenpilotTestCase):
  def test_radar_fault(self):
    # if there's no radar-related can traffic, radard should either not respond or respond with an error
    # this is tightly coupled with underlying car radar_interface implementation, but it's a good sanity check
    def single_iter_pkg():
      # single iter package, with meaningless cans and empty carState/modelV2
      msgs = []
      for _ in range(500):
        can = messaging.new_message("can", 1)
        cs = messaging.new_message("carState")
        cp = messaging.new_message("carParams")
        msgs.append(can.as_reader())
        msgs.append(cs.as_reader())
        msgs.append(cp.as_reader())
      model = messaging.new_message("modelV2")
      msgs.append(model.as_reader())

      return msgs

    msgs = [m for _ in range(3) for m in single_iter_pkg()]
    out = replay_process_with_name("card", msgs, fingerprint=TOYOTA.TOYOTA_COROLLA_TSS2)
    states = [m for m in out if m.which() == "radarTracks"]
    failures = [not state.valid for state in states]

    assert len(states) == 0 or all(failures)

  def test_fisker_no_radar_only_low_speed_lead(self):
    # the Fisker MRR has no elevation: a stationary in-lane track (an overhead light) must not become a lead without the model
    from types import SimpleNamespace
    from openpilot.cereal import log
    from opendbc.car import structs
    from openpilot.selfdrive.controls.radard import RadarD

    class SM(dict):
      seen = {"modelV2": True}
      recv_frame = {"carState": 1}
      logMonoTime = {"modelV2": 0}

      def all_checks(self):
        return True

    def lead_one(brand):
      CP = structs.CarParams()
      CP.brand = brand
      rd = RadarD(CP, structs.CarParamsSP(), 0.0)
      sm = SM()
      sm["carState"] = SimpleNamespace(vEgo=3.0)
      model = log.ModelDataV2.new_message()
      model.init("leadsV3", 2)
      sm["modelV2"] = model.as_reader()
      pt = structs.RadarData.RadarPoint()
      pt.trackId, pt.dRel, pt.yRel, pt.vRel = 1, 20.0, 0.0, -3.0
      rd.update(sm, structs.RadarData(points=[pt]))
      return rd.radar_state.leadOne

    assert lead_one("toyota").present      # openpilot's usual radar low speed lead
    assert not lead_one("fisker").present
