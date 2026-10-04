"""
Copyright (c) 2021-, Haibin Wen, sunnypilot, and a number of other contributors.

This file is part of sunnypilot and is licensed under the MIT License.
See the LICENSE.md file in the root directory for more details.
"""
import base64
import gzip
import http.client
import json
import os
import socket
import tempfile
import threading
import time

from opendbc.car.fisker import values

from openpilot.common.test import OpenpilotTestCase
from openpilot.sunnypilot.selfdrive.car.can_overrides import PARAM
from openpilot.sunnypilot.webhud.server import Engine, OverridesApi, _DevParams, make_server
from openpilot.sunnypilot.webhud.websocket import OP_TEXT, encode_frame, read_frame


class TestServer(OpenpilotTestCase):
  def setUp(self):
    super().setUp()
    self.tmp = tempfile.TemporaryDirectory()
    os.environ["LOG_ROOT"] = os.path.join(self.tmp.name, "realdata")
    self.saved = (dict(values.ICC_SETTINGS_OVERRIDES), dict(values.ICC_0x35B_OVERRIDES))
    self.params = _DevParams(os.path.join(self.tmp.name, "params.json"))
    self.engine = Engine(self.params)
    api = OverridesApi(self.params, self.engine.world, self.engine.monitor)
    self.server = make_server("127.0.0.1", 0, self.engine, self.params, api, "sunnypilot-test")
    self.port = self.server.server_address[1]
    threading.Thread(target=self.server.serve_forever, daemon=True).start()
    self.engine_thread = threading.Thread(target=self.engine.run, daemon=True)
    self.engine_thread.start()

  def tearDown(self):
    self.engine.stop_event.set()
    self.server.shutdown()
    self.server.server_close()
    self.engine_thread.join(timeout=5)
    values.ICC_SETTINGS_OVERRIDES.update(self.saved[0])
    values.ICC_0x35B_OVERRIDES.update(self.saved[1])
    self.tmp.cleanup()
    super().tearDown()

  def request(self, method, path, body=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
    data = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
    conn.request(method, path, body=data, headers={"Content-Type": "application/json", **(headers or {})})
    res = conn.getresponse()
    raw = res.read()
    if res.getheader("Content-Encoding") == "gzip":
      raw = gzip.decompress(raw)
    conn.close()
    return res.status, raw, res

  def test_static_and_status(self):
    status, body, _ = self.request("GET", "/")
    assert status == 200 and b"sunnypilot HUD" in body
    status, body, res = self.request("GET", "/js/main.js", headers={"Accept-Encoding": "gzip"})
    assert status == 200 and res.getheader("Content-Encoding") == "gzip" and b"CarScene" in body
    # third-party assets are served from openpilot/third_party/webhud
    status, body, res = self.request("GET", "/vendor/OrbitControls.js")
    assert status == 200 and b"OrbitControls" in body and "max-age" in res.getheader("Cache-Control")
    status, body, res = self.request("GET", "/models/pulse_ocean_v0.10_parts.glb")
    assert status == 200 and body[:4] == b"glTF" and res.getheader("Content-Type") == "model/gltf-binary"
    for path in ("/../../server.py", "/vendor/../../../sunnypilot/webhud/server.py"):
      status, body, _ = self.request("GET", path)
      assert status == 200 and b"sunnypilot HUD" in body       # traversal falls back to the app shell
    status, body, _ = self.request("GET", "/api/status")
    st = json.loads(body)
    assert status == 200 and st["hostname"] == "sunnypilot-test.local" and st["overrides"]
    status, body, _ = self.request("GET", "/api/dbc")
    assert status == 200 and len(json.loads(body)["messages"]) > 80

  def test_static_validators(self):
    # the car model and every other file can be checked with a 304 instead of sent again
    status, body, res = self.request("GET", "/models/pulse_ocean_v0.10_parts.glb")
    etag, modified = res.getheader("ETag"), res.getheader("Last-Modified")
    assert status == 200 and etag and modified and len(body) > 1_000_000
    status, body, res = self.request("GET", "/models/pulse_ocean_v0.10_parts.glb", headers={"If-None-Match": etag})
    assert status == 304 and body == b"" and res.getheader("ETag") == etag
    assert self.request("GET", "/models/pulse_ocean_v0.10_parts.glb", headers={"If-Modified-Since": modified})[0] == 304
    assert self.request("GET", "/models/pulse_ocean_v0.10_parts.glb", headers={"If-None-Match": '"0-0"'})[0] == 200
    # gzip is its own entity; either tag matches the same file
    status, _, res = self.request("GET", "/js/main.js", headers={"Accept-Encoding": "gzip"})
    gz_tag = res.getheader("ETag")
    assert status == 200 and gz_tag.endswith('-gz"') and res.getheader("Vary") == "Accept-Encoding"
    assert self.request("GET", "/js/main.js", headers={"If-None-Match": gz_tag})[0] == 304
    assert self.request("GET", "/sw.js")[2].getheader("Cache-Control") == "no-cache"

  def test_overrides_api(self):
    status, body, _ = self.request("GET", "/api/overrides")
    data = json.loads(body)
    assert status == 200 and data["supported"] and [t["message"] for t in data["tables"]] == ["ICC_0x52A", "ICC_0x35B"]
    sig = next(s for s in data["tables"][0]["signals"] if s["name"] == "ICC_ACCSwt")
    assert sig["default"] == 1 and sig["values"]

    status, body, _ = self.request("PUT", "/api/overrides", {"ICC_0x52A": {"ICC_ACCSwt": 9}})
    assert status == 400 and b"outside" in body
    status, body, _ = self.request("PUT", "/api/overrides", {"ICC_0x35B": {"ICC_BSDSetting": 2}})
    assert status == 200 and self.params.get(PARAM) == {"ICC_0x35B": {"ICC_BSDSetting": 2}}
    assert json.loads(body)["tables"][1]["customized"]

    status, _, _ = self.request("PUT", "/api/overrides", {"ICC_0x35B": {}}, headers={"Origin": "http://evil.example"})
    assert status == 403

    status, body, _ = self.request("DELETE", "/api/overrides?message=ICC_0x35B")
    assert status == 200 and self.params.get(PARAM) is None

  def test_params_allowlist(self):
    status, body, _ = self.request("PUT", "/api/params", {"ExperimentalMode": True, "LongitudinalPersonality": 2})
    assert status == 200 and json.loads(body)["ExperimentalMode"] is True
    assert self.request("PUT", "/api/params", {"LongitudinalPersonality": 7})[0] == 400
    assert self.request("PUT", "/api/params", {"DisableUpdates": True})[0] == 400

  def test_websocket_streams_demo_state(self):
    sock = socket.create_connection(("127.0.0.1", self.port), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode()
    headers = ["GET /ws HTTP/1.1", f"Host: 127.0.0.1:{self.port}", "Upgrade: websocket", "Connection: Upgrade",
               f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13"]
    sock.sendall(("\r\n".join(headers) + "\r\n\r\n").encode())
    reader = sock.makefile("rb")
    assert b"101" in reader.readline()
    while reader.readline() not in (b"\r\n", b""):
      pass
    sock.sendall(encode_frame(json.dumps({"type": "replay", "action": "demo"}).encode(), OP_TEXT, mask=b"abcd"))
    sock.sendall(encode_frame(json.dumps({"type": "raw", "addrs": ["0x31C"]}).encode(), OP_TEXT, mask=b"abcd"))

    seen = {}
    end = time.monotonic() + 10
    while time.monotonic() < end and not ("raw" in seen and seen.get("state", {}).get("fisker", {}).get("objects")):
      _, op, payload = read_frame(reader)
      msg = json.loads(payload)
      seen[msg["type"]] = msg["data"]
    sock.close()
    assert seen["hello"]["version"]
    state = seen["state"]
    assert state["mode"] == "replay" and state["replay"]["route"] == "demo"
    assert state["fisker"]["acc"]["setSpeed"] == 60 and state["op"]["carState"]["vEgo"] > 0
    assert "0x31C" in seen["raw"]
