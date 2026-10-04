#!/usr/bin/env python3
"""
Generate everything the HUD knows about the car's IBUS1/IBUS2 buses from the FM29 matrices:

  python -m openpilot.sunnypilot.webhud.tools.gen_ibus ~/Downloads/FM29_IBUS1_Matrix_CAN_V390.1_20230120.xlsx \
                                                       ~/Downloads/FM29_IBUS2_Matrix_CAN_V390.1_20230120.xlsx

Writes:
  openpilot/third_party/webhud/dbc/fisker_ocean_ibus.dbc   every message the gateway, the head unit and the
      other nodes send on the two buses, for the page's world decoder (static/js/world) when the comma isn't
      there: the gateway mirrors the ADAS bus onto IBUS2 with the same layout and signal names
  openpilot/sunnypilot/webhud/static/js/ibus_tables.js    the messages the car-state read-out decodes
      (carstate.js), the ones the HUD sends (cancmd.js) and the lists the app's CAN helper filters on
  openpilot/sunnypilot/webhud/android/app/src/main/java/ai/sunnypilot/webhud/CanIds.kt   the same lists
      for the app: what to receive, and the only IDs it may ever send

Needs openpyxl (not in the device venv): `pip install openpyxl`, or install it to a scratch dir and point
PYTHONPATH at it. The outputs are checked in, so this only runs when the matrices change.

Bit numbering: the matrices give each signal's least significant bit in Motorola numbering ("Motorola
LSB"); the DBC and the page's tables use the most significant bit (DBC "sawtooth" numbering, what opendbc
and the ADAS-bus DBC use), which for a signal spanning bytes lies in the byte before.
"""
import argparse
import os
import re
import sys

try:
  import openpyxl
except ImportError:
  sys.exit("needs openpyxl: pip install openpyxl")

from openpilot.sunnypilot.webhud.tools.gen_world_dbc import CORRECTIONS   # what the matrix gets wrong, checked on the car

HERE = os.path.dirname(os.path.abspath(__file__))
WEBHUD = os.path.dirname(HERE)
OPENPILOT = os.path.dirname(os.path.dirname(WEBHUD))
DBC_OUT = os.path.join(OPENPILOT, "third_party", "webhud", "dbc", "fisker_ocean_ibus.dbc")
JS_OUT = os.path.join(WEBHUD, "static", "js", "ibus_tables.js")
KT_OUT = os.path.join(WEBHUD, "android", "app", "src", "main", "java", "ai", "sunnypilot", "webhud", "CanIds.kt")

# What the app receives and the page decodes. IBUS2 carries the gateway's mirror of the ADAS bus (every
# ADAS_* message of the world DBC that is there), the battery and charging, the window positions and the
# odometer; IBUS1 the body, chassis, climate, seats, lamps, gear and drive.
RX = {
  "IBUS1": [0x112, 0x113, 0x114, 0x115, 0x150, 0x151, 0x1B8, 0x1C2, 0x234, 0x2F4, 0x2F5, 0x318, 0x333, 0x335, 0x343, 0x358, 0x364,
            0x373, 0x378, 0x471, 0x4F3, 0x4F5, 0x4F9, 0x512, 0x518, 0x554, 0x5EA],
  "IBUS2": [0xE9, 0x236, 0x321, 0x363, 0x369, 0x503, 0x504, 0x505, 0x580, 0x5A4, 0x630, 0x634, 0x641, 0x35B, 0x52A,
            # the ADAS mirror: lanes, objects, ACC, assist, warnings, signs and lights, parking, driver monitoring
            0x117, 0x118, 0x1C0, 0x20A, 0x20B, 0x20C, 0x20D, 0x20E, 0x20F, 0x210, 0x2C7, 0x2CA, 0x2CD, 0x2D0, 0x2D3, 0x2D6, 0x2D9, 0x2DC,
            0x2DF, 0x2E2, 0x2E5, 0x2E8, 0x2E9, 0x2EA, 0x311, 0x313, 0x314, 0x315, 0x316, 0x317, 0x31A, 0x31B, 0x31C, 0x32B, 0x32D, 0x32F,
            0x334, 0x339, 0x33B, 0x33D, 0x33F, 0x340, 0x342, 0x34B, 0x34D, 0x34F, 0x350, 0x351, 0x352, 0x353, 0x356, 0x359, 0x527],
}
# What the app may send: the head unit's own control messages that it sends only when the driver touches
# something (OnWriteWithRepetition) or, for 0x528/0x533/0x52, sends cyclically with "no request" values in
# between, so a request of ours is acted on like a touch. Never the cyclic state messages the head unit
# owns (0x610 drive mode and charging, 0x529 units and brightness, 0x336 ambient and California Mode: the
# head unit would send its own values right back, and 0x336 carries an E2E counter we can't continue). Nor
# 0x46 or 0x44: one frame of those carries every audio volume, the mute and the equalizer at once, with no
# "no request" value and no feedback to copy the current ones from, so any request in them resets the audio.
TX = {
  "IBUS1": [0x4E, 0x530, 0x534, 0x90, 0x528, 0x533, 0x52],
  "IBUS2": [],
}
# the read-out table leaves the ADAS mirror to the world decoder (it has the ADAS DBC for those)
READOUT_SKIP_PREFIX = "ADAS_"

# Pulse's CAN driver (an out-of-tree mcp251x) programs the chips' hardware acceptance filters from module
# parameters: per chip (0 = spi0.0 = can1 = IBUS1, 1 = spi0.1 = can2 = IBUS2) a mask and two filters for
# receive buffer 0, a mask and four for buffer 1; an ID passes a buffer when (id & mask) == (filter & mask)
# for one of its filters. Its defaults pass only parts of the ID range (IBUS1 ~0x200-0x3FF and 0x500-0x7FF,
# IBUS2 0x200-0x23F, 0x300-0x37F, 0x500-0x53F, 0x580-0x5BF), which blocks the steering angle, yaw rate,
# seat and liftgate positions, battery current and charging times. The app sets these instead at start
# (HwFilters.kt): the tightest masks and filters that let every ID in RX through.
def hexes(ids) -> str:
  return ", ".join(f"0x{i:X}" for i in ids)


MASKS = [0x400, 0x600, 0x700, 0x780, 0x7C0, 0x7E0, 0x7F0, 0x7F8, 0x7FC, 0x7FE, 0x7FF]


def hw_filters(ids: list[int]) -> dict:
  """{mask0, filters0 (2), mask1, filters1 (4), passes}: the plan letting every id through with the fewest other IDs."""
  best = None
  wanted = set(ids)
  for m0 in MASKS:
    for m1 in MASKS:
      # buffer 0 takes the two biggest groups under its mask, buffer 1 must cover the rest in four
      groups0: dict[int, set[int]] = {}
      for i in wanted:
        groups0.setdefault(i & m0, set()).add(i)
      for f0 in __import__("itertools").combinations(sorted(groups0, key=lambda g: -len(groups0[g]))[:6], min(2, len(groups0))):
        covered = set().union(*(groups0[g] for g in f0))
        rest = wanted - covered
        groups1 = sorted({i & m1 for i in rest})
        if len(groups1) > 4:
          continue
        filters0 = list(f0) + [f0[0]] * (2 - len(f0))
        filters1 = groups1 + [groups1[0] if groups1 else filters0[0]] * (4 - len(groups1))
        passes = sum(1 for i in range(0x800) if (i & m0) in {f & m0 for f in filters0} or (i & m1) in {f & m1 for f in filters1})
        plan = {"mask0": m0, "filters0": filters0, "mask1": m1, "filters1": filters1, "passes": passes}
        if best is None or passes < best["passes"]:
          best = plan
  assert best is not None
  for i in wanted:   # every wanted ID passes
    assert (i & best["mask0"]) in {f & best["mask0"] for f in best["filters0"]} or (i & best["mask1"]) in {f & best["mask1"] for f in best["filters1"]}, hex(i)
  return best

VALUE_RE = re.compile(r"^\s*0x([0-9A-Fa-f]+)\s*:\s*(.+?)\s*$")


def msb_sawtooth(lsb: int, n: int) -> int:
  """DBC start bit (the MSB, sawtooth numbering) of a Motorola signal whose LSB is `lsb`."""
  lsb_lin = (lsb >> 3) * 8 + 7 - (lsb & 7)
  msb_lin = lsb_lin - (n - 1)
  return (msb_lin >> 3) * 8 + 7 - (msb_lin & 7)


def values_of(text: str) -> dict[int, str]:
  out = {}
  for line in str(text or "").split("\n"):
    m = VALUE_RE.match(line)
    if m and "~" not in line.split(":")[0]:
      out[int(m.group(1), 16)] = m.group(2).replace('"', "'")
  return out


def read_matrix(path: str, bus: str) -> list[dict]:
  wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
  rows = list(wb["Matrix"].iter_rows(values_only=True))
  hdr = [str(c or "").split("\n")[0].strip() for c in rows[0]]
  nodes = {i: hdr[i] for i in range(31, len(hdr)) if hdr[i]}
  msgs, cur = [], None
  for r in rows[2:]:
    r = list(r) + [None] * (len(hdr) - len(r))
    if r[0]:
      cur = None
      try:
        addr = int(str(r[2]), 16)
      except ValueError:
        continue
      cur = {"bus": bus, "name": str(r[0]).strip(), "addr": addr, "send": str(r[3] or ""), "cycle": int(r[4] or 0), "len": int(r[5] or 8),
             "e2e": int(r[30] or 0), "tx": [nodes[i] for i in nodes if r[i] == "s"], "signals": []}
      msgs.append(cur)
    elif r[6] and cur is not None:
      order = str(r[9] or "Motorola")
      name = str(r[6]).strip()
      res, off, lo, hi = float(r[15] or 1), float(r[16] or 0), float(r[17] or 0), float(r[18] or 0)
      if name in CORRECTIONS:
        res, off, lo, hi = CORRECTIONS[name][:4]
      cur["signals"].append({
        "name": name, "desc": " ".join(str(r[8] or "").split()).replace('"', "'"), "lsb": int(r[11]), "len": int(r[13]),
        "intel": order.lower().startswith("intel"), "signed": str(r[14] or "").lower().startswith("signed"),
        "res": res, "off": off, "min": lo, "max": hi,
        "init": int(str(r[21]), 16) if r[21] not in (None, "") else 0, "unit": str(r[24] or ""), "values": values_of(r[25]),
      })
  return msgs


IDENT_RE = re.compile(r"^[A-Za-z_]\w*$")


def message_name(m: dict, taken: set[str]) -> str:
  name = m["name"]
  if not IDENT_RE.match(name) or name.startswith("0x") or name.isdigit():
    prefix = m["signals"][0]["name"].split("_")[0] if m["signals"] else "MSG"
    name = f"{prefix}_0x{m['addr']:X}"
  while name in taken:
    name += "_"
  taken.add(name)
  return name


def transmitter(m: dict) -> str:
  if m["name"].startswith("ADAS_") or all(s["name"].startswith("ADAS") for s in m["signals"]):
    return "ADAS"   # the gateway mirrors these from the ADAS bus; the world decoder reads them from the cam side
  return m["tx"][0] if m["tx"] else "GW"


def fmt(v: float) -> str:
  return f"{v:g}"


def write_dbc(msgs: list[dict], path: str) -> None:
  lines = ['VERSION "FM29 IBUS1 + IBUS2, V390.1 20230120, generated by sunnypilot/webhud/tools/gen_ibus.py"', "", "NS_ :", "", "BS_:", ""]
  nodes = sorted({transmitter(m) for m in msgs} | {"ICC", "GW"})
  lines.append("BU_: " + " ".join(nodes))
  lines.append("")
  taken: set[str] = set()
  seen_addr: set[int] = set()
  vals, cms, cycles = [], [], []
  for m in msgs:
    if m["addr"] in seen_addr or not m["signals"]:
      continue   # one ID is on both buses (the diagnostic request), identical
    seen_addr.add(m["addr"])
    name = message_name(m, taken)
    m["dbc_name"] = name
    lines.append(f"BO_ {m['addr']} {name}: {m['len']} {transmitter(m)}")
    sig_names: set[str] = set()
    for s in m["signals"]:
      sname = s["name"]
      while sname in sig_names:
        sname += "_"
      sig_names.add(sname)
      start = s["lsb"] if s["intel"] else msb_sawtooth(s["lsb"], s["len"])
      order = "1" if s["intel"] else "0"
      sign = "-" if s["signed"] else "+"
      lines.append(f' SG_ {sname} : {start}|{s["len"]}@{order}{sign} ({fmt(s["res"])},{fmt(s["off"])}) [{fmt(s["min"])}|{fmt(s["max"])}] "{s["unit"]}" ICC')
      if s["values"]:
        vals.append(f"VAL_ {m['addr']} {sname} " + " ".join(f'{k} "{v}"' for k, v in sorted(s["values"].items())) + " ;")
      if s["desc"]:
        cms.append(f'CM_ SG_ {m["addr"]} {sname} "{s["desc"]}";')
    lines.append("")
    every = f" every {m['cycle']} ms" if m["cycle"] else ""
    cms.append(f'CM_ BO_ {m["addr"]} "{m["bus"]}, {m["send"]}{every}, sent by {", ".join(m["tx"]) or "?"}";')
    if m["cycle"]:
      cycles.append(f'BA_ "GenMsgCycleTime" BO_ {m["addr"]} {m["cycle"]};')
  lines += cms + [""] + ['BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;', 'BA_DEF_DEF_ "GenMsgCycleTime" 0;'] + cycles + [""] + vals + [""]
  with open(path, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))


def js_signal(s: dict) -> str:
  start = s["lsb"] if s["intel"] else msb_sawtooth(s["lsb"], s["len"])
  parts = [f"name: '{s['name']}'", f"start: {start}", f"len: {s['len']}", f"res: {fmt(s['res'])}", f"off: {fmt(s['off'])}"]
  if s["intel"]:
    parts.append("intel: true")
  if s["signed"]:
    parts.append("signed: true")
  parts.append(f"init: {s['init']}")
  if s["values"]:
    parts.append("enum: {" + ", ".join(f'{k}: "{v}"' for k, v in sorted(s["values"].items())) + "}")
  return "    { " + ", ".join(parts) + " },"


def write_js(msgs: list[dict], path: str) -> None:
  by_key = {(m["bus"], m["addr"]): m for m in msgs}
  out = ["// Generated from the FM29 IBUS1/IBUS2 CAN matrices (V390.1) by tools/gen_ibus.py. Don't edit: re-run it.",
         "// Each signal: Motorola/big-endian unless `intel`, `start` = the most significant bit (DBC numbering), raw value =",
         "// res * raw + off. `init` is the matrix's initial value, what a request message carries for the signals it doesn't set.",
         "",
         "// The car's state the read-out decodes (carstate.js); the ADAS mirror on IBUS2 goes to the world decoder instead.",
         "export const RX_MESSAGES = ["]
  for bus, ids in RX.items():
    for addr in ids:
      m = by_key.get((bus, addr))
      if m is None:
        raise SystemExit(f"{bus} 0x{addr:X} is not in the matrix")
      if m["name"].startswith(READOUT_SKIP_PREFIX) or all(s["name"].startswith("ADAS") for s in m["signals"]):
        continue
      out.append(f"  {{ bus: '{bus}', addr: 0x{addr:X}, name: '{m.get('dbc_name', m['name'])}', cycleMs: {m['cycle']}, signals: [")
      out += [js_signal(s) for s in m["signals"] if not s["name"].endswith(("CheckSum", "Checksum", "AliveCounter"))]
      out.append("  ]},")
  out += ["];", "",
          "// What the HUD may send: the head unit's control messages. `cyclic` ones the head unit also sends every cycleMs",
          "// with 'no request' values; a request of ours goes out a few times and is then followed by that idle frame.",
          "export const TX_MESSAGES = ["]
  for bus, ids in TX.items():
    for addr in ids:
      m = by_key[(bus, addr)]
      cyclic = "true" if m["cycle"] else "false"
      name = m.get("dbc_name", m["name"])
      out.append(f"  {{ bus: '{bus}', addr: 0x{addr:X}, name: '{name}', len: {m['len']}, cyclic: {cyclic}, cycleMs: {m['cycle']}, signals: [")
      out += [js_signal(s) for s in m["signals"]]
      out.append("  ]},")
  plans = {bus: hw_filters(ids) for bus, ids in RX.items()}
  out += ["];", "",
          "// What the app's CAN helper lets through (receive) and the only IDs it may send, per bus (CanIds.kt has the same).",
          "export const RX_IDS = " + js_ids(RX) + ";",
          "export const TX_IDS = " + js_ids(TX) + ";", "",
          "// The chips' hardware acceptance filters the app sets at start so every RX ID gets through (see gen_ibus.py).",
          "export const HW_FILTERS = {",
          *[f"  {bus}: {{ mask0: 0x{p['mask0']:X}, filters0: [{hexes(p['filters0'])}], mask1: 0x{p['mask1']:X}, "
            + f"filters1: [{hexes(p['filters1'])}], passes: {p['passes']} }},"
            for bus, p in plans.items()],
          "};", ""]
  with open(path, "w", encoding="utf-8") as f:
    f.write("\n".join(out))


def js_ids(d: dict) -> str:
  return "{ " + ", ".join(f"{bus}: [{', '.join(f'0x{a:X}' for a in ids)}]" for bus, ids in d.items()) + " }"


def write_kt(path: str) -> None:
  def kt_set(ids):
    return "setOf(" + ", ".join(f"0x{a:X}" for a in ids) + ")" if ids else "emptySet()"
  plans = {bus: hw_filters(ids) for bus, ids in RX.items()}
  def kt_plan(bus, chip):
    p = plans[bus]
    return (f'HwFilter(chip = {chip}, mask0 = 0x{p["mask0"]:X}, filters0 = listOf({hexes(p["filters0"])}), '
            + f'mask1 = 0x{p["mask1"]:X}, filters1 = listOf({hexes(p["filters1"])})),   // passes {p["passes"]} of 2048 IDs')
  text = f"""package ai.sunnypilot.webhud

/**
 * Generated from the FM29 IBUS1/IBUS2 CAN matrices by webhud/tools/gen_ibus.py (the page's ibus_tables.js
 * carries the same lists). Don't edit: re-run it.
 */
object CanIds {{
    /** The IDs the CAN helper lets through on each bus. */
    val RX: Map<String, Set<Int>> = mapOf(
        "IBUS1" to {kt_set(RX["IBUS1"])},
        "IBUS2" to {kt_set(RX["IBUS2"])},
    )

    /** The only IDs the app may ever send, per bus: the head unit's own control messages. */
    val TX: Map<String, Set<Int>> = mapOf(
        "IBUS1" to {kt_set(TX["IBUS1"])},
        "IBUS2" to {kt_set(TX["IBUS2"])},
    )

    /** The chips' hardware acceptance filters that let every RX ID through (HwFilters.kt applies them at start). */
    val HW_FILTERS: Map<String, HwFilter> = mapOf(
        "IBUS1" to {kt_plan("IBUS1", 0)}
        "IBUS2" to {kt_plan("IBUS2", 1)}
    )
}}

/** One MCP2515's acceptance filters: receive buffer 0 has a mask and two filters, buffer 1 a mask and four. */
data class HwFilter(val chip: Int, val mask0: Int, val filters0: List<Int>, val mask1: Int, val filters1: List<Int>) {{
    fun passes(id: Int): Boolean = filters0.any {{ (id and mask0) == (it and mask0) }} || filters1.any {{ (id and mask1) == (it and mask1) }}
}}
"""
  with open(path, "w", encoding="utf-8") as f:
    f.write(text)


def main() -> None:
  ap = argparse.ArgumentParser()
  ap.add_argument("ibus1")
  ap.add_argument("ibus2")
  args = ap.parse_args()
  msgs = read_matrix(args.ibus1, "IBUS1") + read_matrix(args.ibus2, "IBUS2")
  msgs = [m for m in msgs if m["signals"] and not m["name"].startswith("Diag") and "_NM_" not in m["name"]]
  write_dbc(msgs, DBC_OUT)
  write_js(msgs, JS_OUT)
  write_kt(KT_OUT)
  n_sig = sum(len(m["signals"]) for m in msgs)
  print(f"{len(msgs)} messages, {n_sig} signals -> {os.path.relpath(DBC_OUT)}, {os.path.relpath(JS_OUT)}, {os.path.relpath(KT_OUT)}")


if __name__ == "__main__":
  main()
