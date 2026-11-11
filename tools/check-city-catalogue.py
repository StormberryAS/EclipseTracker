#!/usr/bin/env python3
"""Checks cities.js, the shared Labs city catalogue, which SunApp's update_cities.py writes byte for
byte into every app with a city picker. Standard library only; run with python3 -I.

  1. The file starts with the two GENERATED FILE header lines.
  2. Its packed literal (var D = "...";) decodes to 25,007 rows of 7 fields, every country and zone
     index inside its palette.
  3. When ../SunApp/cities.js exists (the layout of the Stormberry checkouts), or the path given as
     the one argument, the two files are byte for byte the same; when it does not (a fresh clone)
     this prints "skipped" and passes.

There is no sha256 pin on purpose: a new run of update_cities.py writes every app in one pass, and a
pin here would fail until someone edited it. Check 3 catches an edit to one copy only.
"""

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILE = ROOT / "cities.js"
SUNAPP = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "SunApp" / "cities.js"
ROWS = 25007


def main() -> None:
    raw = FILE.read_bytes()
    text = raw.decode("utf-8")
    bad = []
    if not text.startswith("// Stormberry Labs shared city catalogue.\n// GENERATED FILE, DO NOT EDIT BY HAND.\n"):
        bad.append("cities.js does not start with the two GENERATED FILE header lines")
    m = re.search(r'var D = ("(?:[^"\\]|\\.)*");', text)
    if not m:
        bad.append("cities.js has no packed literal (var D = ...)")
    else:
        packed = json.loads(m.group(1))
        lines = packed.split("\n")
        countries, zones = lines[0].split("\t"), lines[1].split("\t")
        rows = [r.split("\t") for r in lines[2:]]
        if len(rows) != ROWS:
            bad.append(f"cities.js holds {len(rows)} rows, not {ROWS}")
        for i, r in enumerate(rows):
            if len(r) != 7:
                bad.append(f"row {i} has {len(r)} fields, not 7")
                break
            if not (0 <= int(r[2]) < len(countries) and 0 <= int(r[5]) < len(zones)):
                bad.append(f"row {i} ({r[0]}) has a country or zone index outside its palette")
                break
        else:
            print(f"check-city-catalogue: {len(rows)} rows of 7 fields, {len(countries)} countries, {len(zones)} zones")
    if SUNAPP.is_file():
        if SUNAPP.read_bytes() != raw:
            bad.append(f"cities.js differs from {SUNAPP}: only SunApp's update_cities.py may change it")
        else:
            print(f"check-city-catalogue: cities.js is byte for byte {SUNAPP}")
    else:
        print(f"check-city-catalogue: {SUNAPP} not found: parity check skipped")
    for line in bad:
        print(f"check-city-catalogue: {line}", file=sys.stderr)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
