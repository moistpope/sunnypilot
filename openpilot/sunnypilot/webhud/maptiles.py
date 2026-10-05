"""
Copyright (c) 2021-, Haibin Wen, sunnypilot, and a number of other contributors.

This file is part of sunnypilot and is licensed under the MIT License.
See the LICENSE.md file in the root directory for more details.

The OSM road tiles the page's map matcher reads (static/js/world/osmtile.js, mapdata.js): the same files
sunnypilot's mapd keeps under <mapd root>/offline/<lat>/<lon>/<minLat>_<minLon>_<maxLat>_<maxLon>, one
packed Cap'n Proto message per 0.25 deg tile, in 2 x 2 deg cells named by their south-west corner on the
even grid. The page asks for GET /map/tile/<lat>/<lon>/<name>; a tile that isn't on disk has its cell
downloaded from pfeiferj's server (what mapd does too) and unpacked next to mapd's own, so the two share.
"""
import os
import re
import tarfile
import tempfile
import threading
import time
import urllib.request

from openpilot.common.hardware.hw import Paths
from openpilot.common.swaglog import cloudlog

CELL_URL = "https://map-data.pfeifer.dev/offline/{lat}/{lon}.tar.gz"
NAME_RE = re.compile(r"^-?\d{1,3}\.\d{6}_-?\d{1,3}\.\d{6}_-?\d{1,3}\.\d{6}_-?\d{1,3}\.\d{6}$")
RETRY_S = 60.0       # after a failed download of a cell
TIMEOUT_S = 120.0


class MapTiles:
  def __init__(self, root: str | None = None, download: bool = True):
    self.root = root or os.path.join(Paths.mapd_root(), "offline")
    self.download = download
    self._locks: dict[tuple[int, int], threading.Lock] = {}
    self._failed: dict[tuple[int, int], float] = {}
    self._guard = threading.Lock()

  def tile_path(self, lat: int, lon: int, name: str) -> str | None:
    """The tile's file, downloading its cell first if needed; None when it can't be had."""
    if not NAME_RE.match(name) or not (-90 <= lat < 90 and -180 <= lon < 180) or lat % 2 or lon % 2:
      raise ValueError("not a tile name")
    path = os.path.join(self.root, str(lat), str(lon), name)
    if os.path.isfile(path):
      return path
    if not self.download:
      return None
    with self._guard:
      lock = self._locks.setdefault((lat, lon), threading.Lock())
    with lock:
      if os.path.isfile(path):   # another request fetched it meanwhile
        return path
      if time.monotonic() - self._failed.get((lat, lon), -1e9) < RETRY_S:
        return None
      try:
        self._fetch_cell(lat, lon)
      except Exception:
        cloudlog.exception(f"webhud: map cell {lat}/{lon} download failed")
        self._failed[(lat, lon)] = time.monotonic()
        return None
    return path if os.path.isfile(path) else None

  def _fetch_cell(self, lat: int, lon: int) -> None:
    dest = os.path.join(self.root, str(lat), str(lon))
    os.makedirs(dest, exist_ok=True)
    url = CELL_URL.format(lat=lat, lon=lon)
    cloudlog.info(f"webhud: downloading map cell {url}")
    fd, tmp = tempfile.mkstemp(suffix=".tar.gz", dir=self.root)
    try:
      with os.fdopen(fd, "wb") as f, urllib.request.urlopen(url, timeout=TIMEOUT_S) as r:
        while True:
          chunk = r.read(1 << 20)
          if not chunk:
            break
          f.write(chunk)
      prefix = f"offline/{lat}/{lon}/"
      with tarfile.open(tmp, "r:gz") as tar:
        for m in tar.getmembers():
          if not m.isfile() or not m.name.startswith(prefix):
            continue
          name = m.name[len(prefix):]
          if not NAME_RE.match(name):
            continue
          src = tar.extractfile(m)
          if src is None:
            continue
          out = os.path.join(dest, name + ".part")
          with open(out, "wb") as f:
            while True:
              chunk = src.read(1 << 20)
              if not chunk:
                break
              f.write(chunk)
          os.replace(out, os.path.join(dest, name))
      cloudlog.info(f"webhud: map cell {lat}/{lon} ready in {dest}")
    finally:
      try:
        os.remove(tmp)
      except OSError:
        pass


def parse_tile_path(path: str) -> tuple[int, int, str]:
  """'/map/tile/<lat>/<lon>/<name>' -> (lat, lon, name); ValueError when it isn't one."""
  parts = path.split("/")
  if len(parts) != 6 or parts[1] != "map" or parts[2] != "tile":
    raise ValueError("not a tile path")
  return int(parts[3]), int(parts[4]), parts[5]
