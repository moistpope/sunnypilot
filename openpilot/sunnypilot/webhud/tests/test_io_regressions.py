"""Regression coverage for bounded inputs and interrupted WebHUD I/O."""
import io
import math
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from openpilot.sunnypilot.webhud import server, websocket
from openpilot.sunnypilot.webhud.maptiles import MapFeatures, MapPrefetch, MapTiles
from openpilot.sunnypilot.webhud.websocket import WebSocketClosed, encode_frame, read_frame


class ShortReader(io.BytesIO):
  def read(self, n=-1):
    return super().read(min(n, 1))


class TestIORegressions(unittest.TestCase):
  def test_websocket_short_reads(self):
    payload = b"payload" * 100
    frame = encode_frame(payload, mask=b"abcd")
    assert read_frame(ShortReader(frame))[2] == payload
    with self.assertRaises(WebSocketClosed):
      read_frame(ShortReader(frame[:-1]))

  def test_fragmented_websocket_message_limit(self):
    first = bytearray(encode_frame(b"12345", mask=b"abcd"))
    first[0] &= 0x7F
    last = encode_frame(b"6789", opcode=websocket.OP_CONT, mask=b"abcd")
    sock = Mock()
    ws = websocket.WebSocket(sock, io.BytesIO(first + last))
    with patch.object(websocket, "MAX_MESSAGE", 8):
      assert ws.recv() is None
    assert ws.closed
    sock.shutdown.assert_called_once()

  def test_negative_http_length_rejected_before_read(self):
    handler = SimpleNamespace(headers={"Content-Length": "-1"}, rfile=Mock())
    with self.assertRaises(ValueError):
      server.HudHandler._body(handler)
    handler.rfile.read.assert_not_called()

  def test_upload_collision_and_truncation(self):
    with tempfile.TemporaryDirectory() as root, patch.object(server, "data_roots", return_value=(root, root)):
      def upload(data, length):
        handler = SimpleNamespace(headers={"Content-Length": str(length)}, rfile=io.BytesIO(data),
                                  server=SimpleNamespace(engine=Mock()), _json=Mock())
        server.api_upload(handler, {})
        return handler
      with patch.object(server.time, "strftime", return_value="fixed-second"):
        first, second = upload(b"first", 5), upload(b"second", 6)
      routes = [h._json.call_args.args[0]["route"] for h in (first, second)]
      assert routes[0] != routes[1]
      for route, expected in zip(routes, (b"first", b"second"), strict=True):
        with open(os.path.join(root, route + "--0", "rlog"), "rb") as f:
          assert f.read() == expected
      before = set(os.listdir(root))
      with self.assertRaisesRegex(ValueError, "incomplete upload"):
        upload(b"partial", 100)
      assert set(os.listdir(root)) == before

  def test_tile_name_rejects_trailing_newline(self):
    with tempfile.TemporaryDirectory() as root:
      tiles = MapTiles(root, download=False)
      name = "50.000000_0.000000_50.250000_0.250000"
      assert tiles.tile_path(50, 0, name) is None
      with self.assertRaises(ValueError):
        tiles.tile_path(50, 0, name + "\n")

  def test_nonfinite_prefetch_radius_does_not_start_worker(self):
    with tempfile.TemporaryDirectory() as root:
      prefetch = MapPrefetch(MapTiles(root, download=False), MapFeatures(root, download=False))
      for radius in (math.nan, math.inf, -math.inf):
        with self.assertRaises(ValueError):
          prefetch.request(51.5, -0.1, radius)
      assert prefetch._thread is None
