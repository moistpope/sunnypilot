"""
Copyright (c) 2021-, Haibin Wen, sunnypilot, and a number of other contributors.

This file is part of sunnypilot and is licensed under the MIT License.
See the LICENSE.md file in the root directory for more details.

The Fisker Ocean's mid-range radar (MRR), read from its private CAN-FD link on panda bus 1.

The radar's messages aren't in the FM29 matrix; third_party/webhud/dbc/fisker_ocean_mrr.dbc is
reverse-engineered from a drive (its comments say how each scale was checked). Every 65 ms radar
cycle brings a header (0x300) and 32 object slots (0x310..0x32F), filled from the first slot up;
an object has a persistent track ID, position, relative velocity and acceleration, and for tracks
the radar has classified, heading, size and class. The slot IDs overlap ADASBUS IDs but are
unrelated 48-byte frames, so this bus is kept apart from FiskerWorld.

Coordinate frame of the returned objects: x forward, y LEFT, meters, origin at the radar (front
bumper), like FiskerWorld's object list. The radar's own lateral axis is +right; it's flipped here.
"""
import os

from openpilot.common.swaglog import cloudlog
from openpilot.sunnypilot.webhud.dbc import DBC
from openpilot.sunnypilot.webhud.paths import RADAR_DBC_PATH

BUS_RADAR = 1
HEADER = 0x300
EGO_MOTION = 0x400
SLOTS = tuple(range(0x310, 0x330))
STALE_S = 0.5
HEADING_NA = 178.0    # raw 255 (178.6 deg) = no heading
# Class values seen on the drive (tentative): point targets the radar hasn't classified are 0.
RADAR_CLASSES = {0: "unclassified", 1: "car", 6: "pedestrian", 8: "small"}


def _r(v, nd=2):
  return None if v is None else round(float(v), nd)


class FiskerRadar:
  def __init__(self, dbc: DBC | None = None):
    if dbc is None and os.path.isfile(RADAR_DBC_PATH):
      dbc = DBC(RADAR_DBC_PATH)
    if dbc is None:
      cloudlog.warning(f"webhud: no radar DBC at {RADAR_DBC_PATH}, radar view disabled")
    self.dbc = dbc
    self.wanted = frozenset(dbc.messages) if dbc is not None else frozenset()
    self.frames: dict[int, tuple[bytes, float]] = {}   # addr -> (data, t)
    self._decoded: dict[int, tuple[bytes, dict[str, float]]] = {}
    self._slot_sig = {addr: {k: f"MRR_Obj{n:02d}_{k}" for k in (
      "ID", "Age", "DistLong", "DistLat", "VrelLong", "VrelLat", "ArelLong", "DynProp", "Heading", "Width", "Length", "Class",
    )} for n, addr in enumerate(SLOTS)}

  def reset(self) -> None:
    self.frames.clear()
    self._decoded.clear()

  def update(self, frames, t: float) -> None:
    """frames: iterable of (address, data, src) as produced by can_capnp_to_list."""
    wanted = self.wanted
    for addr, data, src in frames:
      if src == BUS_RADAR and addr in wanted:
        self.frames[addr] = (data, t)

  def _decode(self, addr: int, now: float) -> dict[str, float] | None:
    entry = self.frames.get(addr)
    if entry is None or now - entry[1] > STALE_S:
      return None
    cached = self._decoded.get(addr)
    if cached is not None and cached[0] == entry[0]:
      return cached[1]
    values = self.dbc.messages[addr].decode(entry[0])
    self._decoded[addr] = (entry[0], values)
    return values

  def state(self, now: float) -> dict | None:
    """None while the radar bus is silent (or this harness doesn't tap it)."""
    if self.dbc is None:
      return None
    hdr = self._decode(HEADER, now)
    if hdr is None:
      return None
    by_id: dict[int, tuple[float, dict]] = {}
    for addr in SLOTS:
      entry = self.frames.get(addr)
      # empty slots carry ID 0 (bytes 3-4); skip them before decoding all ~35 signals
      if entry is None or not (entry[0][3] or entry[0][4]):
        continue
      v = self._decode(addr, now)
      if v is None:
        continue
      sig = self._slot_sig[addr]
      oid = int(v[sig["ID"]])
      # a track can change slots between cycles; if a snapshot catches it in both, keep the newer
      if oid in by_id and by_id[oid][0] >= entry[1]:
        continue
      heading = v[sig["Heading"]]
      cls = int(v[sig["Class"]])
      by_id[oid] = (entry[1], {
        "id": oid,
        "x": _r(v[sig["DistLong"]]),
        "y": _r(-v[sig["DistLat"]]),
        "vx": _r(v[sig["VrelLong"]]),
        "vy": _r(-v[sig["VrelLat"]]),
        "ax": _r(v[sig["ArelLong"]]),
        "heading": None if heading > HEADING_NA else _r(-heading, 1),   # radar heading is clockwise-positive
        "cls": RADAR_CLASSES.get(cls, f"class {cls}"),
        "dyn": int(v[sig["DynProp"]]),
        "age": int(v[sig["Age"]]),
        "w": _r(v[sig["Width"]]) or None,
        "l": _r(v[sig["Length"]]) or None,
      })
    ego = self._decode(EGO_MOTION, now)
    return {
      "count": int(hdr["MRR_NumObjects"]),
      "cycle": int(hdr["MRR_CycleCounter"]),
      "egoSpeed": None if ego is None else _r(ego["MRR_EgoSpeed"]),
      "objects": [o for _, o in sorted(by_id.values(), key=lambda e: e[1]["x"])],
    }
