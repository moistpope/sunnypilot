"""
Copyright (c) 2021-, Haibin Wen, sunnypilot, and a number of other contributors.

This file is part of sunnypilot and is licensed under the MIT License.
See the LICENSE.md file in the root directory for more details.

StateBuilder folds raw CAN and openpilot service messages into the single snapshot the web UI
renders. Live and replay sources feed it identically; only the clock differs.
"""
from openpilot.sunnypilot.webhud.extract import EXTRACTORS
from openpilot.sunnypilot.webhud.fisker_world import FiskerWorld

SERVICE_STALE_S = 2.0


class StateBuilder:
  def __init__(self, world: FiskerWorld | None = None):
    self.world = world or FiskerWorld()
    self.services: dict[str, dict] = {}
    self.service_t: dict[str, float] = {}
    self.brand: str | None = None
    self.t = 0.0

  def reset(self) -> None:
    self.world.reset()
    self.services.clear()
    self.service_t.clear()
    self.t = 0.0

  @property
  def fisker(self) -> bool:
    # an unknown brand still parses, so logs/benches without carParams work
    return self.brand in (None, "fisker")

  def feed_can(self, frames, t: float) -> None:
    self.t = max(self.t, t)
    if self.fisker:
      self.world.update(frames, t)

  def feed_service(self, which: str, msg, t: float) -> None:
    extractor = EXTRACTORS.get(which)
    if extractor is None:
      return
    self.services[which] = extractor(msg)
    self.service_t[which] = t
    self.t = max(self.t, t)
    if which == "carParams":
      self.brand = self.services[which].get("brand") or self.brand

  def set_brand(self, brand: str | None) -> None:
    self.brand = brand or None

  def snapshot(self, now: float | None = None) -> dict:
    now = self.t if now is None else now
    op = {}
    for which, data in self.services.items():
      if which == "carParams" or now - self.service_t.get(which, 0.0) <= SERVICE_STALE_S:
        op[which] = data
    return {
      "t": round(now, 3),
      "brand": self.brand,
      "op": op,
      "fisker": self.world.state(now) if self.fisker else None,
    }
