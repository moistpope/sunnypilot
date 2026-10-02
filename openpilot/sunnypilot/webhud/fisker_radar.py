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
from statistics import median

from openpilot.common.swaglog import cloudlog
from openpilot.sunnypilot.webhud.dbc import DBC
from openpilot.sunnypilot.webhud.paths import RADAR_DBC_PATH

BUS_RADAR = 1
TIME_SYNC = 0x100
HEADER = 0x300
EGO_MOTION = 0x400
SLOTS = tuple(range(0x310, 0x330))
SLOT_SET = frozenset(SLOTS)
STALE_S = 0.5
CYCLE_SETTLE_S = 0.03   # a cycle's frames arrive within a few ms; it's complete once quiet this long
MEAS_LATENCY_S = 0.10   # measured -> received, when the bus's time sync is missing
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
      "State", "Quality", "MeasHistory",
    )} for n, addr in enumerate(SLOTS)}
    self.reset()

  def reset(self) -> None:
    self.frames.clear()
    self._decoded.clear()
    self._cycles: dict[int, dict] = {}   # cycle counter -> {first, last, hdr, slots}, until complete
    self._sync: tuple[float, int] | None = None
    self._offsets: list[float] = []      # recent (global time - log time) from the bus's time sync
    self._last_meas: tuple[int, int, int] | None = None   # MeasTime (sec, ns) and counter of the last cycle handed out

  def update(self, frames, t: float) -> None:
    """frames: iterable of (address, data, src) as produced by can_capnp_to_list."""
    wanted = self.wanted
    for addr, data, src in frames:
      if src != BUS_RADAR or addr not in wanted:
        continue
      self.frames[addr] = (data, t)
      if addr in SLOT_SET:
        self._cycle(((data[36] & 0x3) << 4) | (data[37] >> 4), t)["slots"][addr] = data   # MRR_ObjNN_CycleCounter
      elif addr == HEADER:
        self._cycle(data[21] >> 2, t)["hdr"] = data                                         # MRR_CycleCounter
      elif addr == TIME_SYNC and len(data) >= 8:
        # AUTOSAR CanTSyn: SYNC (0x20) carries the seconds of the global time at its send, FUP (0x28) the ns
        if data[0] == 0x20:
          self._sync = (t, int.from_bytes(data[4:8], "big"))
        elif data[0] == 0x28 and self._sync is not None and t - self._sync[0] < 0.1:
          self._offsets = (self._offsets + [self._sync[1] + int.from_bytes(data[4:8], "big") * 1e-9 - self._sync[0]])[-15:]

  def _cycle(self, c: int, t: float) -> dict:
    cyc = self._cycles.get(c)
    if cyc is None or t - cyc["last"] > 1.0:   # the 6-bit counter wraps every 4.2 s
      cyc = self._cycles[c] = {"first": t, "last": t, "hdr": None, "slots": {}}
    cyc["last"] = t
    return cyc

  def take_cycles(self, now: float) -> list[tuple[float, list[dict]]]:
    """Every radar cycle completed since the last call: (time it was measured, its objects)."""
    out = []
    g2m = median(self._offsets) if self._offsets else None
    done = []
    for c in list(self._cycles):
      cyc = self._cycles[c]
      if now - cyc["last"] < CYCLE_SETTLE_S:
        continue
      del self._cycles[c]
      if cyc["hdr"] is not None and self.dbc is not None:
        done.append(cyc)
    for cyc in sorted(done, key=lambda cyc: cyc["first"]):
      hdr = self.dbc.messages[HEADER].decode(cyc["hdr"])
      meas_raw = (int(hdr["MRR_MeasTime_Sec"]), int(hdr["MRR_MeasTime_NSec"]), int(hdr["MRR_CycleCounter"]))
      # the radar now and then sends a cycle's header again (same MeasTime and counter, 124 of 923 cycles on
      # 000000b5--bfe13ac451--13), sometimes with its objects too: a cycle measured once is handed out once
      if meas_raw == self._last_meas:
        continue
      self._last_meas = meas_raw
      t = cyc["first"] - MEAS_LATENCY_S
      if g2m is not None:
        meas = meas_raw[0] + meas_raw[1] * 1e-9 - g2m
        if -0.5 < cyc["first"] - meas < 1.0:
          t = meas
      objs = [self._slot_object(addr, self.dbc.messages[addr].decode(data)) for addr, data in cyc["slots"].items() if data[3] or data[4]]
      out.append((t, objs))
    out.sort(key=lambda c: c[0])
    return out

  def _slot_object(self, addr: int, v: dict[str, float]) -> dict:
    sig = self._slot_sig[addr]
    heading = v[sig["Heading"]]
    cls = int(v[sig["Class"]])
    return {
      "id": int(v[sig["ID"]]),
      "x": _r(v[sig["DistLong"]]),
      "y": _r(-v[sig["DistLat"]]),
      "vx": _r(v[sig["VrelLong"]]),
      "vy": _r(-v[sig["VrelLat"]]),
      "ax": _r(v[sig["ArelLong"]]),
      "heading": None if heading > HEADING_NA else _r(-heading, 1),   # radar heading is clockwise-positive
      "cls": RADAR_CLASSES.get(cls, f"class {cls}"),
      "dyn": int(v[sig["DynProp"]]),
      "age": int(v[sig["Age"]]),
      "state": int(v[sig["State"]]),
      "quality": int(v[sig["Quality"]]),
      "hist": int(v[sig["MeasHistory"]]),
      "w": _r(v[sig["Width"]]) or None,
      "l": _r(v[sig["Length"]]) or None,
    }

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
      o = self._slot_object(addr, v)
      # a track can change slots between cycles; if a snapshot catches it in both, keep the newer
      if o["id"] in by_id and by_id[o["id"]][0] >= entry[1]:
        continue
      by_id[o["id"]] = (entry[1], o)
    ego = self._decode(EGO_MOTION, now)
    return {
      "count": int(hdr["MRR_NumObjects"]),
      "cycle": int(hdr["MRR_CycleCounter"]),
      "egoSpeed": None if ego is None else _r(ego["MRR_EgoSpeed"]),
      "objects": [o for _, o in sorted(by_id.values(), key=lambda e: e[1]["x"])],
    }
