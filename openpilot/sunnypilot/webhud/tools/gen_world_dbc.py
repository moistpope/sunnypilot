#!/usr/bin/env python3
"""
Generate the web HUD's Fisker DBC subset from the full ADASBUS matrix DBC.

  python -m openpilot.sunnypilot.webhud.tools.gen_world_dbc FM29_ADASBUS_Matrix_CANFD_V390.8_20230524.dbc

Keeps every ADAS-authored message (world model, HMI, warnings, parking, DMS) plus the
gateway-mirrored vehicle/body messages the HUD shows, with their comments, cycle times and
value tables, and applies CORRECTIONS for signals the matrix gets wrong. Add names to
EXTRA_MESSAGES and re-run to expose more in the signal browser.
"""
import argparse
import os
import re

from openpilot.sunnypilot.webhud.paths import DBC_PATH as OUT

# Non-ADAS messages to keep (everything opendbc's fisker_ocean_adas.dbc uses, plus body/HMI state and
# the drive motors' torque requests and actual torque / speed for the power trails).
EXTRA_MESSAGES = {
  "GW_Syn_All", "VCU_0x102", "MCU_F_0x150", "MCU_R_0x151", "YRS_0x112", "YRS_0x113", "ESP_0x114", "ESP_0x115", "ESP_0x116", "ESP_0x120",
  "ACU_0x159", "EPS_0x1C2", "EPS_0x1C4", "VCU_0x214", "VCU_0x219", "ESP_0x318", "BCM_0x321",
  "BCM_0x333", "BCM_0x335", "BCM_0x343", "VCU_0x358", "ICC_0x35B", "BCM_0x364", "ECC_0x373",
  "PLGM_0x471", "FCM_0x487", "MFS_0x514", "ICC_0x52A", "ICC_0x531",
}


# Signals the matrix gets wrong, checked against the car: name -> (factor, offset, min, max, note).
# The ADAS object list's distances are 0.2 m/bit, not 0.5: the ACC target read raw 202 while
# openpilot's camera had the same car at ~42 m (0.2 -> 40.4 m, 0.5 -> 101 m), parked cars "closed in"
# at 2-3x the car's own speed at 0.5, and raw values top out near 200 (a ~40 m list, not 100 m).
# Paired with the radar's tracks (60 cars, 2026-10-02), the range fits ~0.25 m/bit from about the rear axle and
# the lateral reads ~1.35x wide; the world model corrects for both (world_model.MEASURED_CALIBRATION) until a
# tape-measured check settles them here.
CORRECTIONS = {
  f"ADAS_Obj{n}_{sig}": (0.2, 0, 0, 51, "0.2 m/bit measured on the car; the matrix says 0.5")
  for n in range(1, 9) for sig in ("LongDist", "LatDist")
}


def correct(line: str) -> str:
  m = re.match(r"^( SG_ (\w+) : \S+ )\([^)]*\) \[[^]]*\]( .*)$", line)
  if not m or m.group(2) not in CORRECTIONS:
    return line
  factor, offset, lo, hi, _ = CORRECTIONS[m.group(2)]
  return f"{m.group(1)}({factor:g},{offset:g}) [{lo:g}|{hi:g}]{m.group(3)}"


def keep_message(name: str, transmitter: str) -> bool:
  if name in EXTRA_MESSAGES:
    return True
  # ADAS-authored payload messages; skip network management and diagnostic frames
  return transmitter == "ADAS" and name.startswith("ADAS_") and not name.startswith("ADAS_NM")


def generate(src: str) -> str:
  with open(src, encoding="latin-1") as f:
    text = f.read().replace("\r\n", "\n")

  lines = text.split("\n")
  header: list[str] = []
  blocks: dict[int, list[str]] = {}
  keep: set[int] = set()

  i = 0
  # header: everything before the first BO_
  while i < len(lines) and not lines[i].startswith("BO_ "):
    header.append(lines[i])
    i += 1

  while i < len(lines):
    line = lines[i]
    m = re.match(r"^BO_ (\d+) (\w+)\s*:\s*\d+ (\w+)", line)
    if m:
      addr = int(m.group(1))
      block = [line]
      i += 1
      while i < len(lines) and lines[i].startswith(" SG_"):
        block.append(correct(lines[i]))
        i += 1
      blocks[addr] = block
      if keep_message(m.group(2), m.group(3)):
        keep.add(addr)
      continue
    i += 1

  out = [*header]
  for addr in sorted(keep):
    out.extend(blocks[addr])
    out.append("")

  # attribute definitions keep the file loadable by other tools (cabana, cantools)
  out.extend(re.findall(r"^BA_DEF_ .*?;$|^BA_DEF_DEF_ .*?;$", text, re.M))
  out.append("")

  def addr_of(stmt: str, kind: str) -> int | None:
    m = re.match(rf"^{kind} (\d+) ", stmt)
    return int(m.group(1)) if m else None

  for stmt in re.findall(r"^CM_ BO_ \d+ \".*?\";", text, re.M | re.S):
    if addr_of(stmt[4:], "BO_") in keep:
      out.append(" ".join(stmt.split()))
  for stmt in re.findall(r"^CM_ SG_ \d+ \w+ \".*?\";", text, re.M | re.S):
    if addr_of(stmt[4:], "SG_") in keep:
      stmt = " ".join(stmt.split())
      name = stmt.split(" ")[3]
      if name in CORRECTIONS:
        stmt = stmt[:-2] + f" ({CORRECTIONS[name][4]})\";"
      out.append(stmt)
  for stmt in re.findall(r"^BA_ \"GenMsgCycleTime\" BO_ \d+ \d+;", text, re.M):
    if addr_of(stmt.split(" ", 2)[2], "BO_") in keep:
      out.append(stmt)
  for stmt in re.findall(r"^VAL_ \d+ .*?;\s*$", text, re.M):
    if addr_of(stmt, "VAL_") in keep:
      out.append(stmt.rstrip())
  out.append("")

  # merge runs of blank lines
  result = re.sub(r"\n{3,}", "\n\n", "\n".join(out))
  return result.rstrip("\n") + "\n"


def main():
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument("source", help="full FM29 ADASBUS matrix DBC")
  parser.add_argument("--out", default=OUT)
  args = parser.parse_args()

  dbc = generate(args.source)
  os.makedirs(os.path.dirname(args.out), exist_ok=True)
  with open(args.out, "w") as f:
    f.write(dbc)
  print(f"wrote {args.out}: {dbc.count(chr(10) + 'BO_ ') + dbc.startswith('BO_ ')} messages")


if __name__ == "__main__":
  main()
