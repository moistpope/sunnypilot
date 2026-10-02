"""
Copyright (c) 2021-, Haibin Wen, sunnypilot, and a number of other contributors.

This file is part of sunnypilot and is licensed under the MIT License.
See the LICENSE.md file in the root directory for more details.

World model for the web HUD: every object source placed in one ground-fixed frame and tracked there.

The sources see the same road with different strengths and different delays, and each measurement
is weighted by its source's noise model (the *_noise functions below), so where they overlap the
more trustworthy source dominates each quantity:
  radar  the mid-range radar (bus 1, fisker_radar.py). Range to the near face and range rate are
         excellent (checked against the road camera: boxes land on bumpers); bearing is coarse, so
         lateral error grows with range; its lateral velocity is unreliable in turns. Young tracks
         are mostly flicker (median life 0.13 s) and are left out; maturing ones count for less.
  adas   the OEM ADAS object list (FiskerWorld). Camera classification, size, heading and the widest
         coverage; range is the camera's (it read ~1.7 m farther than the radar on the drive
         checked), in 0.2 m steps, with no velocity.
  op     openpilot's radarState leads (vision-only on this car). Two leads; depth from the model,
         its error growing with distance; weighted by the model's lead probability. The least stable
         source here (in a parking lot it put a car 13 m ahead at 6 m), so an openpilot lead refines
         objects the others see but only stands alone when it's the only object source there is.
Each object is a constant-velocity Kalman filter over ground position and velocity. A measurement is
placed at the time it was taken (the radar's synced MeasTime; the others by their typical latency)
using the ego pose at that time, dead-reckoned from wheel speed and the yaw-rate gyro. Measurements
are processed FUSION_DELAY_S behind the present so every source is in before its time is passed, and
tracks are then predicted to the present. A stationary object therefore stays put on the ground
through a turn and each source's lag is undone.

Each object also carries a confidence (0..1) that it's really there, which the view fades it by
(the CONF_* constants below). The radar measures range, bearing and Doppler but no elevation, so it
tracks sign gantries, traffic lights and bridges like stopped cars in our lane until it passes under
them (track 791 on route 000000b5--bfe13ac451--12 at 45-48 s: a "car" 3.4 m wide and 0.2-1.0 m long,
dropped at 24 m). A camera positively classifying an object settles it; without one, a radar-only
object counts for little until its radar track has lasted 1.3 s (younger ones are mostly flicker),
then for more when it moves (signs and poles don't), less when it stands, less again when the radar
draws it as a wide thin strip, and least where openpilot's model would plainly see a car and doesn't:
standing in our path, within its range, with nothing nearer to hide it.

Frames: world (x, y, heading) is fixed to the ground with an arbitrary origin, reset on seek. The ego
frame is x forward from the front bumper, y left, like every other HUD object list.
"""
import bisect
import math
from dataclasses import dataclass, field

import numpy as np

FRONT_TO_REAR_AXLE = 3.85   # m: the Ocean is 4.775 m long with its rear axle 0.93 m from the back
FUSION_DELAY_S = 0.2        # radar measurements arrive ~0.10-0.13 s after they're taken
HISTORY_S = 5.0
ADAS_LATENCY_S = 0.12       # not measured: a typical camera pipeline
OP_LATENCY_S = 0.05         # radarState.mdMonoTime is when the model ran; its frame is about this older
RADAR_MIN_AGE = 8           # cycles (65 ms): younger radar tracks are left out entirely
RADAR_MATURE_AGE = 20
OP_MIN_PROB = 0.5
GATE = 16.0                 # Mahalanobis^2 (4 sigma) to associate a measurement with a track...
GATE_M = 3.0                # ...and no farther than this plus 2.5 sigma of the measurement, whatever the covariance
MERGE_GATE = 4.0            # two tracks this close (and within MERGE_M) are one object
MERGE_M = 1.5
ACCEL_SIGMA = 3.0           # m/s^2: process noise of the constant-velocity model
COAST_MOVING_S = 1.0        # a track is dropped this long after its last measurement...
COAST_STATIONARY_S = 2.5    # ...longer when it stands still (e.g. parked cars the radar stops reporting in a turn)
STATIONARY_SPEED = 0.7      # m/s over ground
CONFIRM_UPDATES = 3         # a radar-only track is shown after this many measurements...
CONFIRM_SPAN_S = 0.15       # ...spanning at least this long
HEADING_FROM_MOTION = 1.5   # m/s: faster than this, an object points where it's going
SOURCE_GONE_S = 5.0         # a source silent this long no longer counts as available

# confidence (see the module docstring); the view fades objects in between about 0.35 and 0.65
VISION_CLASSES = frozenset(("car", "truck", "motorcycle", "bicycle", "pedestrian", "animal"))
CONF_VISION = 1.0           # a camera positively classified it (ADAS list class, or an openpilot lead)...
VISION_HOLD_S = 1.0         # ...this recently
CONF_VISION_HELD = 0.9      # one did earlier, and the others still track it
CONF_YOUNG = 0.3            # radar alone, before its track has lasted RADAR_MATURE_AGE: mostly flicker
CONF_MOVING = 0.85          # radar alone, moving over the ground
CONF_STANDING = 0.6         # radar alone, standing: as often a parked car as a post
THIN_ASPECT = 4.0           # the radar has drawn it at least this many times wider than long...
THIN_MIN_W = 1.5            # ...and at least this wide: a sign or a gantry seen edge-on
THIN_FACTOR = 0.55
CONF_UNSEEN = 0.15          # standing in our path where openpilot's model would see a car, and doesn't...
UNSEEN_HOLD_S = 0.5         # ...for this long in all: then it stays that low, even once a turn takes it out of our path
UNSEEN_MIN_V = 5.0          # m/s: slower than this (parking), the model's leads are too unsteady to go by
UNSEEN_X = (8.0, 80.0)      # m ahead: where the model reliably reports a stopped car in our lane
CORRIDOR_HALF_W = 1.5       # m either side of our predicted path: our half width and half a meter
MOVING_SPEED = 1.5          # m/s over ground, plus MOVING_FRAC of our speed (the Doppler scale is known
MOVING_FRAC = 0.06          # only to ~4%, so at speed a standing object can read ~1 m/s)
CONF_RISE_S = 0.5           # confidence eases toward its target over about this long, in data time...
CONF_FALL_S = 0.25
CONF_COAST_S = 0.3          # ...but can't rise once no source has reported the object for this long


# ---- measurement noise (1 sigma) -------------------------------------------------------------------

def radar_noise(rng: float, age: int, hist: int) -> tuple[float, float, float, float, float]:
  """sx, sy (m), svx, svy (m/s) in the ego frame, and how much less a young or coasting track counts.
  ~1 deg of bearing error; range and Doppler fine. Its lateral velocity is barely usable: a young
  track's bearing converges over its first second and the radar reports that as sideways motion."""
  k = 1.0 if age >= RADAR_MATURE_AGE else 2.5
  if hist & 0b11 != 0b11:   # no detection in one of the last two cycles: the track is coasting
    k *= 2.0
  return 0.25 + 0.005 * rng, 0.15 + 0.017 * rng, 0.3, 6.0, k


def adas_noise(rng: float) -> tuple[float, float]:
  """Camera ranging (~6%) and 0.2 m quantization; bearing is the camera's strength."""
  return 0.5 + 0.06 * rng, 0.3 + 0.012 * rng


def op_noise(rng: float, prob: float, radar: bool) -> tuple[float, float, float]:
  """sx, sy, svx. openpilot leads backed by a car radar (not this port) are radar-grade."""
  if radar:
    return 0.3 + 0.01 * rng, 0.3 + 0.017 * rng, 0.4
  k = 1.0 / math.sqrt(max(prob, 0.2))
  return k * (0.6 + 0.08 * rng), k * (0.4 + 0.015 * rng), k * (0.6 + 0.04 * rng)


# ---- ego pose ---------------------------------------------------------------------------------------

class EgoOdometry:
  """Pose of the rear axle in the world frame, integrated from signed speed and yaw rate, with a
  few seconds of history so a measurement can be placed at the pose it was taken from."""

  def __init__(self):
    self.reset()

  def reset(self) -> None:
    self.ts: list[float] = []
    self.poses: list[tuple[float, float, float, float]] = []   # x, y, heading, signed speed
    self.t: float | None = None
    self.x = self.y = self.h = self.v = self.w = 0.0

  def update(self, t: float, v: float, w: float) -> None:
    """v: signed speed (m/s, negative in reverse), w: yaw rate (rad/s, + = left)."""
    if self.t is not None:
      dt = t - self.t
      if dt <= 0:
        return
      if dt < 0.5:   # a longer gap (seek, dropout) restarts the integration in place
        hm = self.h + 0.5 * w * dt
        self.x += v * math.cos(hm) * dt
        self.y += v * math.sin(hm) * dt
        self.h += w * dt
    self.t, self.v, self.w = t, v, w
    self.ts.append(t)
    self.poses.append((self.x, self.y, self.h, v))
    if len(self.ts) > 256 and t - self.ts[0] > HISTORY_S:
      cut = bisect.bisect_left(self.ts, t - HISTORY_S)
      del self.ts[:cut], self.poses[:cut]

  def pose(self, t: float) -> tuple[float, float, float]:
    if not self.ts:
      return 0.0, 0.0, 0.0
    if t >= self.ts[-1]:   # carry the last motion forward (briefly)
      dt = min(t - self.ts[-1], 0.5)
      hm = self.h + 0.5 * self.w * dt
      return self.x + self.v * math.cos(hm) * dt, self.y + self.v * math.sin(hm) * dt, self.h + self.w * dt
    i = bisect.bisect_right(self.ts, t)
    if i == 0:
      return self.poses[0][:3]
    t0, t1 = self.ts[i - 1], self.ts[i]
    a, b = self.poses[i - 1], self.poses[i]
    f = (t - t0) / (t1 - t0)
    return a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f

  def speed(self, t: float) -> float:
    if not self.ts or t >= self.ts[-1]:
      return self.v
    i = max(1, bisect.bisect_right(self.ts, t))
    return self.poses[i - 1][3]


def to_world(pose, x: float, y: float) -> tuple[float, float]:
  px, py, h = pose
  xr = x + FRONT_TO_REAR_AXLE
  c, s = math.cos(h), math.sin(h)
  return px + c * xr - s * y, py + s * xr + c * y


def to_ego(pose, wx: float, wy: float) -> tuple[float, float]:
  px, py, h = pose
  dx, dy = wx - px, wy - py
  c, s = math.cos(h), math.sin(h)
  return c * dx + s * dy - FRONT_TO_REAR_AXLE, -s * dx + c * dy


def _rot(h: float) -> np.ndarray:
  c, s = math.cos(h), math.sin(h)
  return np.array([[c, -s], [s, c]])


def _wrap(a: float) -> float:
  return (a + math.pi) % (2 * math.pi) - math.pi


# ---- measurements & tracks --------------------------------------------------------------------------

@dataclass
class Meas:
  src: str                  # 'radar' | 'adas' | 'op'
  sid: int                  # the source's own track id (op: lead index)
  t: float                  # when it was measured (log clock, s)
  x: float                  # ego frame at t: m ahead of the front bumper (near face of the object)
  y: float                  # m left
  sx: float                 # 1-sigma noise, ego axes: what the source measures to, used to gate association
  sy: float
  vx: float | None = None   # velocity over ground, ego axes at t (None: not measured)
  vy: float | None = None
  svx: float = 10.0
  svy: float = 10.0
  weight: float = 1.0       # < 1: counts for less (a young or coasting radar track); the noise is scaled by 1/weight
  cls: str | None = None
  dims: tuple[float, float, float] | None = None   # w, l, h
  heading: float | None = None   # deg, + = left of the ego heading at t
  info: dict = field(default_factory=dict)   # what the source said, for the stats view


SOURCE_RANK = {"adas": 0, "radar": 1, "op": 2}   # whose class / size / heading wins


class Track:
  def __init__(self, tid: int, t: float, z: np.ndarray, Rp: np.ndarray, v: np.ndarray | None, Rv: np.ndarray | None):
    self.id = tid
    self.t = t
    self.X = np.array([z[0], z[1], 0.0, 0.0])
    self.P = np.zeros((4, 4))
    self.P[:2, :2] = Rp
    self.P[2:, 2:] = np.eye(2) * 25.0
    if v is not None:
      self.X[2:] = v
      self.P[2:, 2:] = Rv
    self.first = t
    self.n = 0
    self.last: dict[str, float] = {}      # src -> time of its last measurement
    self.sources: dict[str, dict] = {}    # src -> {id, t, dx, dy, info}
    self.confirmed = False
    self.cls: str | None = None
    self.cls_rank = 99
    self.dims: tuple[float, float, float] | None = None
    self.heading: float | None = None     # world, rad
    self.heading_rank = 99
    self.vision_t: float | None = None    # last time a camera positively classified it
    self.thin = 0.0                       # widest-for-its-length the radar has drawn it (w/l)
    self.radar_age = 0                    # oldest radar track (cycles) that has reported it
    self.unseen_s = 0.0                   # how long openpilot's model has missed it in plain view
    self.conf = 0.0
    self.conf_t = t
    self.conf_why = ""

  @property
  def last_t(self) -> float:
    return max(self.last.values()) if self.last else self.first

  def speed(self) -> float:
    return math.hypot(self.X[2], self.X[3])

  def predict(self, t: float) -> None:
    dt = t - self.t
    if dt == 0:
      return
    F = np.eye(4)
    F[0, 2] = F[1, 3] = dt
    self.X = F @ self.X
    self.P = F @ self.P @ F.T
    if dt > 0:
      q = ACCEL_SIGMA ** 2
      a, b, c = dt ** 4 / 4, dt ** 3 / 2, dt ** 2
      self.P += q * np.array([[a, 0, b, 0], [0, a, 0, b], [b, 0, c, 0], [0, b, 0, c]])
    self.t = t

  def maha(self, z: np.ndarray, Rp: np.ndarray) -> float:
    S = self.P[:2, :2] + Rp
    d = z - self.X[:2]
    return float(d @ np.linalg.solve(S, d))

  def update(self, z: np.ndarray, Rp: np.ndarray, v: np.ndarray | None, Rv: np.ndarray | None) -> None:
    if v is None:
      H = np.zeros((2, 4))
      H[0, 0] = H[1, 1] = 1
      zz, R = z, Rp
    else:
      H = np.eye(4)
      zz = np.concatenate([z, v])
      R = np.zeros((4, 4))
      R[:2, :2], R[2:, 2:] = Rp, Rv
    S = H @ self.P @ H.T + R
    K = self.P @ H.T @ np.linalg.inv(S)
    self.X = self.X + K @ (zz - H @ self.X)
    self.P = (np.eye(4) - K @ H) @ self.P


class WorldModel:
  def __init__(self):
    self.odo = EgoOdometry()
    self.next_id = 1   # never reset: a viewer keyed by id mustn't mistake a new object for an old one after a seek
    self.reset()

  def reset(self) -> None:
    self.odo.reset()
    self.tracks: dict[int, Track] = {}
    self.pending: list[Meas] = []
    self.sticky: dict[tuple[str, int], int] = {}   # (src, source id) -> track id
    self.src_seen: dict[str, float] = {}           # src -> time of its latest measurement
    self.model_seen = -1e9                         # time of openpilot's latest model output, leads or not
    self.last_now: float | None = None

  def add(self, meas: list[Meas]) -> None:
    self.pending.extend(meas)

  def model_ran(self, t: float) -> None:
    """openpilot's model looked at t. Where it reported no lead, it saw no car."""
    self.model_seen = max(self.model_seen, t)

  def step(self, now: float) -> list[dict]:
    """Fuse everything measured up to FUSION_DELAY_S ago; return the objects as of `now`."""
    # waiting for late sources only makes sense while time moves; paused (a replay), take everything
    cutoff = now - FUSION_DELAY_S if self.last_now is None or now > self.last_now else now
    self.last_now = now
    ready = sorted((m for m in self.pending if m.t <= cutoff), key=lambda m: (m.t, m.src))
    self.pending = [m for m in self.pending if m.t > cutoff and m.t > now - HISTORY_S]
    i = 0
    while i < len(ready):   # one batch = one source's report at one time
      j = i
      while j < len(ready) and ready[j].t == ready[i].t and ready[j].src == ready[i].src:
        j += 1
      self._process(ready[i:j])
      i = j
    self._merge()
    self._prune(cutoff)
    self._confidence(cutoff)
    return self._output(now)

  # ---- fusion ----
  def _process(self, batch: list[Meas]) -> None:
    t = batch[0].t
    self.src_seen[batch[0].src] = t
    pose = self.odo.pose(t)
    rot = _rot(pose[2])
    meas = []
    for m in batch:
      z = np.array(to_world(pose, m.x, m.y))
      Rg = rot @ np.diag([m.sx ** 2, m.sy ** 2]) @ rot.T   # gates association
      k2 = 1.0 / m.weight ** 2                               # weighs the update
      v = Rv = None
      if m.vx is not None:
        v = rot @ np.array([m.vx, m.vy or 0.0])
        Rv = k2 * rot @ np.diag([m.svx ** 2, (m.svy if m.vy is not None else 10.0) ** 2]) @ rot.T
      meas.append((m, z, Rg, k2 * Rg, v, Rv))
    for tr in self.tracks.values():
      tr.predict(t)

    assigned: dict[int, int] = {}   # meas index -> track id
    used: set[int] = set()

    def near(tr: Track, m: Meas, z: np.ndarray) -> bool:
      return float(np.hypot(*(z - tr.X[:2]))) < GATE_M + 2.5 * max(m.sx, m.sy)

    # a source's own track id keeps feeding the same object while it's plausible
    for k, (m, z, Rg, _, _, _) in enumerate(meas):
      tid = self.sticky.get((m.src, m.sid))
      tr = self.tracks.get(tid) if tid is not None else None
      if tr is not None and tid not in used and near(tr, m, z) and tr.maha(z, Rg) < 4 * GATE:
        assigned[k] = tid
        used.add(tid)
    # the rest by nearest fit
    cands = []
    for k, (m, z, Rg, _, _, _) in enumerate(meas):
      if k in assigned:
        continue
      for tid, tr in self.tracks.items():
        if tid in used or not near(tr, m, z):
          continue
        d2 = tr.maha(z, Rg)
        if d2 < GATE:
          cands.append((d2, k, tid))
    for _, k, tid in sorted(cands):
      if k in assigned or tid in used:
        continue
      assigned[k] = tid
      used.add(tid)

    for k, (m, z, _, Rp, v, Rv) in enumerate(meas):
      tid = assigned.get(k)
      if tid is None:
        if m.src == "op" and m.info.get("modelProb", 1.0) < OP_MIN_PROB:
          continue
        tid = self.next_id
        self.next_id += 1
        self.tracks[tid] = Track(tid, t, z, Rp, v, Rv)
        innovation = np.zeros(2)
      else:
        innovation = z - self.tracks[tid].X[:2]
      tr = self.tracks[tid]
      tr.update(z, Rp, v, Rv)
      self._annotate(tr, m, rot.T @ innovation, pose[2])
      self.sticky[(m.src, m.sid)] = tid

  def _annotate(self, tr: Track, m: Meas, resid: np.ndarray, h: float) -> None:
    tr.n += 1
    tr.last[m.src] = m.t
    tr.sources[m.src] = {"id": m.sid, "t": m.t, "dx": float(resid[0]), "dy": float(resid[1]), "info": m.info}
    rank = SOURCE_RANK[m.src]
    if m.cls and m.cls not in ("unclassified", "unknown") and rank <= tr.cls_rank:
      tr.cls, tr.cls_rank = m.cls, rank
    elif tr.cls is None:
      tr.cls = "car" if m.src == "op" else m.cls
    if m.dims and rank <= tr.cls_rank:
      tr.dims = m.dims
    if (m.src == "adas" and m.cls in VISION_CLASSES) or (m.src == "op" and m.info.get("modelProb", 0.0) >= OP_MIN_PROB):
      tr.vision_t = m.t
    if m.src == "radar":
      tr.radar_age = max(tr.radar_age, m.info["cycles"])
      if m.dims and m.dims[0] >= THIN_MIN_W:
        tr.thin = max(tr.thin, m.dims[0] / m.dims[1])
    if m.heading is not None and rank <= tr.heading_rank:
      hw = h + math.radians(m.heading)
      tr.heading = hw if tr.heading is None or rank < tr.heading_rank else tr.heading + 0.3 * _wrap(hw - tr.heading)
      tr.heading_rank = rank
    if not tr.confirmed:
      if m.src == "op":   # alone, only once it has held for a second with neither the radar nor the ADAS around
        tr.confirmed = m.t - tr.first >= 1.0 and all(m.t - self.src_seen.get(s, -1e9) > SOURCE_GONE_S for s in ("radar", "adas"))
      else:
        tr.confirmed = m.src == "adas" or (tr.n >= CONFIRM_UPDATES and m.t - tr.first >= CONFIRM_SPAN_S)

  def _merge(self) -> None:
    ids = sorted(self.tracks)
    gone: set[int] = set()
    for a_i, a in enumerate(ids):
      if a in gone:
        continue
      A = self.tracks[a]
      for b in ids[a_i + 1:]:
        if b in gone:
          continue
        B = self.tracks[b]
        if B.t != A.t:
          B.predict(A.t)
        d = A.X[:2] - B.X[:2]
        if np.hypot(*d) > MERGE_M or np.hypot(*(A.X[2:] - B.X[2:])) > 2.5:
          continue
        if float(d @ np.linalg.solve(A.P[:2, :2] + B.P[:2, :2], d)) > MERGE_GATE:
          continue
        keep, drop = (A, B) if A.n >= B.n else (B, A)
        for src, s in drop.sources.items():
          if src not in keep.sources or s["t"] > keep.sources[src]["t"]:
            keep.sources[src] = s
            keep.last[src] = drop.last[src]
        keep.confirmed = keep.confirmed or drop.confirmed
        keep.n += drop.n
        if drop.vision_t is not None and (keep.vision_t is None or drop.vision_t > keep.vision_t):
          keep.vision_t = drop.vision_t
        keep.thin = max(keep.thin, drop.thin)
        keep.radar_age = max(keep.radar_age, drop.radar_age)
        keep.unseen_s = max(keep.unseen_s, drop.unseen_s)
        keep.conf = max(keep.conf, drop.conf)
        for key, tid in self.sticky.items():
          if tid == drop.id:
            self.sticky[key] = keep.id
        gone.add(drop.id)
        if drop is A:
          break
    for tid in gone:
      del self.tracks[tid]

  def _prune(self, cutoff: float) -> None:
    for tid in list(self.tracks):
      tr = self.tracks[tid]
      if not tr.confirmed and set(tr.last) == {"op"} and cutoff - tr.first > 1.5:
        del self.tracks[tid]   # an openpilot lead nothing else confirmed
        continue
      stale = cutoff - tr.last_t
      limit = COAST_STATIONARY_S if tr.speed() < STATIONARY_SPEED else COAST_MOVING_S
      if (not tr.confirmed and stale > 0.3) or stale > limit or tr.P[0, 0] + tr.P[1, 1] > 50:
        del self.tracks[tid]
    live = set(self.tracks)
    self.sticky = {k: v for k, v in self.sticky.items() if v in live}

  def _confidence(self, t: float) -> None:
    """Ease each track's confidence toward what its evidence supports as of t (see CONF_*)."""
    pose = self.odo.pose(t)
    v = self.odo.speed(t)
    kappa = self.odo.w / v if v > 1.0 else 0.0
    looking = v > UNSEEN_MIN_V and t - self.model_seen < 1.0
    moving = MOVING_SPEED + MOVING_FRAC * abs(v)
    seen = {tid: tr.vision_t is not None or "adas" in tr.last for tid, tr in self.tracks.items()}   # a camera has it
    # tracks in our path within the model's range (m ahead), and the nearest one a camera has or that moves:
    # past that, the model can't see
    ahead: dict[int, float] = {}
    for tid, tr in self.tracks.items():
      dt = t - tr.t
      x, y = to_ego(pose, tr.X[0] + tr.X[2] * dt, tr.X[1] + tr.X[3] * dt)
      xr = x + FRONT_TO_REAR_AXLE
      if UNSEEN_X[0] < x < UNSEEN_X[1] and abs(y - kappa * xr * xr / 2) < CORRIDOR_HALF_W:
        ahead[tid] = x
    blocker = min((x for tid, x in ahead.items() if seen[tid] or self.tracks[tid].speed() > moving), default=math.inf)

    for tid, tr in self.tracks.items():
      dt = t - tr.conf_t
      standing = tr.speed() <= moving
      if dt > 0 and standing and looking and tid in ahead and ahead[tid] < blocker + 2.0 and not seen[tid] and tr.cls != "pedestrian":
        tr.unseen_s += dt
      if tr.vision_t is not None:
        target, why = (CONF_VISION, "vision") if t - tr.vision_t < VISION_HOLD_S else (CONF_VISION_HELD, "vision earlier")
      elif "adas" not in tr.last and tr.radar_age < RADAR_MATURE_AGE:
        target, why = CONF_YOUNG, "young"
      elif not standing:
        target, why = CONF_MOVING, "moving"
      else:
        target, why = CONF_STANDING, "standing"
        if tr.thin >= THIN_ASPECT:
          target, why = target * THIN_FACTOR, "thin"
        if tr.unseen_s >= UNSEEN_HOLD_S:
          target, why = min(target, CONF_UNSEEN), "unseen"
      if t - tr.last_t > CONF_COAST_S:   # nothing reports it any more: it can only fade
        target = min(target, tr.conf)
      if dt > 0:
        tr.conf += (target - tr.conf) * (1 - math.exp(-dt / (CONF_RISE_S if target > tr.conf else CONF_FALL_S)))
        tr.conf_t = t
      tr.conf_why = why

  # ---- output ----
  def _output(self, now: float) -> list[dict]:
    pose = self.odo.pose(now)
    h = pose[2]
    rot_t = _rot(h).T
    out = []
    for tr in self.tracks.values():
      if not tr.confirmed:
        continue
      dt = now - tr.t
      wx, wy = tr.X[0] + tr.X[2] * dt, tr.X[1] + tr.X[3] * dt
      x, y = to_ego(pose, wx, wy)
      vx, vy = rot_t @ tr.X[2:]
      speed = tr.speed()
      if speed > HEADING_FROM_MOTION:
        heading, hsrc = math.atan2(tr.X[3], tr.X[2]) - h, "motion"
      elif tr.heading is not None:
        heading, hsrc = tr.heading - h, {0: "adas", 1: "radar", 2: "op"}[tr.heading_rank]
      else:
        heading, hsrc = 0.0, None
      sxy = rot_t @ tr.P[:2, :2] @ rot_t.T
      out.append({
        "id": tr.id,
        "x": round(x, 2), "y": round(y, 2),
        "vx": round(float(vx), 2), "vy": round(float(vy), 2), "speed": round(speed, 2),
        "heading": round(math.degrees(_wrap(heading)), 1), "headingSrc": hsrc,
        "cls": tr.cls or "unknown",
        "w": tr.dims[0] if tr.dims else None, "l": tr.dims[1] if tr.dims else None, "h": tr.dims[2] if tr.dims else None,
        "std": [round(math.sqrt(max(sxy[0, 0], 0)), 2), round(math.sqrt(max(sxy[1, 1], 0)), 2)],
        "age": round(now - tr.first, 1),
        "stale": round(max(0.0, now - FUSION_DELAY_S - tr.last_t), 2),
        "stationary": speed < STATIONARY_SPEED,
        "conf": round(tr.conf, 2), "confWhy": tr.conf_why,
        "sources": [
          {"src": src, "id": s["id"], "dx": round(s["dx"], 2), "dy": round(s["dy"], 2), "age": round(now - s["t"], 2), **s["info"]}
          for src, s in sorted(tr.sources.items(), key=lambda kv: SOURCE_RANK[kv[0]]) if now - s["t"] < COAST_STATIONARY_S + 1
        ],
      })
    out.sort(key=lambda o: math.hypot(o["x"], o["y"]))
    return out


# ---- source adapters -------------------------------------------------------------------------------

def radar_measurements(t: float, objects: list[dict], v_ego: float) -> list[Meas]:
  """One radar cycle (fisker_radar objects, measured at t). Relative velocity is translational, so
  over ground it's v_rel + ego speed along x."""
  out = []
  for o in objects:
    if o["age"] < RADAR_MIN_AGE:
      continue
    sx, sy, svx, svy, k = radar_noise(math.hypot(o["x"], o["y"]), o["age"], o.get("hist", 0xFF))
    out.append(Meas("radar", o["id"], t, o["x"], o["y"], sx, sy, o["vx"] + v_ego, o["vy"], svx, svy, weight=1.0 / k,
                    cls=None if o["cls"] in ("unclassified",) else o["cls"],
                    dims=(o["w"], o["l"], 1.5) if o.get("w") and o.get("l") else None, heading=o.get("heading"),
                    info={"cycles": o["age"], "state": o.get("state"), "quality": o.get("quality")}))
  return out


def adas_measurement(t_rx: float, o: dict) -> Meas:
  sx, sy = adas_noise(math.hypot(o["x"], o["y"]))
  dims = (o["w"], o["l"], o["h"]) if o.get("w") and o.get("l") else None
  return Meas("adas", o["id"], t_rx - ADAS_LATENCY_S, o["x"], o["y"], sx, sy, cls=o.get("cls"), dims=dims,
              heading=o.get("heading"), info={"flags": o.get("flags", []), "classConf": o.get("classConf")})


def op_measurements(t: float, rs: dict, v_ego: float) -> list[Meas]:
  out = []
  for i, key in enumerate(("leadOne", "leadTwo")):
    ld = rs.get(key)
    if not ld or not ld.get("present") or ld.get("dRel") is None:
      continue
    prob = ld.get("modelProb") or 0.0
    sx, sy, svx = op_noise(ld["dRel"], prob, bool(ld.get("radar")))
    v = ld["vLead"] if ld.get("vLead") is not None else (ld["vRel"] + v_ego if ld.get("vRel") is not None else None)
    out.append(Meas("op", i, t, ld["dRel"], ld.get("yRel") or 0.0, sx, sy, v, None, svx, 10.0, cls="car",
                    info={"modelProb": prob, "radar": bool(ld.get("radar")), "aLead": ld.get("aLead")}))
  return out
