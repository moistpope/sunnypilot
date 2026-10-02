"""
Copyright (c) 2021-, Haibin Wen, sunnypilot, and a number of other contributors.

This file is part of sunnypilot and is licensed under the MIT License.
See the LICENSE.md file in the root directory for more details.

Where the web HUD's files live. Third-party assets (three.js, the Ocean 3D model, the Fisker DBC
subset) sit under openpilot/third_party/webhud so they stay out of lint/spellcheck and size limits.
"""
import os

WEBHUD_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(WEBHUD_DIR, "static")
THIRD_PARTY_DIR = os.path.join(os.path.dirname(os.path.dirname(WEBHUD_DIR)), "third_party", "webhud")
DBC_PATH = os.path.join(THIRD_PARTY_DIR, "dbc", "fisker_ocean_adas_world.dbc")
RADAR_DBC_PATH = os.path.join(THIRD_PARTY_DIR, "dbc", "fisker_ocean_mrr.dbc")   # reverse-engineered, see its comments

# URL prefix -> directory served under it ("" = the app itself)
STATIC_ROOTS = {
  "vendor/": os.path.join(THIRD_PARTY_DIR, "three"),
  "models/": os.path.join(THIRD_PARTY_DIR, "models"),
  "": STATIC_DIR,
}
