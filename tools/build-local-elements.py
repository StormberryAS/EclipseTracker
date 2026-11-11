#!/usr/bin/env python3
"""Write ts/core/elements.ts: the element sets that give an eclipse as seen from one place.

    python3 -I tools/build-local-elements.py           write ts/core/elements.ts
    python3 -I tools/build-local-elements.py --check   change nothing; exit 1 when the file is not
                                                        what this script makes

Sources (vendored in tools/nasa-elements/, byte for byte as NASA serves them; the names end in .txt
so that GitHub tracks no JavaScript; each is pinned by sha256 below and recorded in FETCHLOG.tsv):

  JSEX_SE2001.txt Besselian elements of the 224 solar eclipses of 2001 to 2100, "Five Millennium
                  Canon of Solar Eclipses: -1999 to +3000", Fred Espenak and Jean Meeus,
                  NASA/TP-2006-214141
  JLEX_LE2001.txt Lunar eclipse elements (contact times, Moon position) of the 228 lunar eclipses of
                  2001 to 2100, Fred Espenak and Jean Meeus

Eclipse Predictions by Fred Espenak and Chris O'Byrne (NASA's GSFC). NASA allows the data to be
reproduced with that acknowledgment. The JSEX and JLEX program code is GPL; it is not copied: the
files are read as text, never run, and the numbers are the only thing taken.

Only the 168 solar and 169 lunar eclipses of data/eclipses.json are written. Every number is copied
as the text in the source file (no float round trip). The script stops on any difference between
the element sets and the list (section 4.1 of the design): date, time of greatest eclipse, Delta T,
type, magnitudes, contacts and the durations in the archived LEcat5 page.

Standard library only; run with python3 -I.
"""

import datetime as dt
import hashlib
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIR = ROOT / "tools" / "nasa-elements"
OUT = ROOT / "ts" / "core" / "elements.ts"
LIST = ROOT / "data" / "eclipses.json"
CATALOGUE = ROOT / "tools" / "nasa" / "LEcat5_LE2001-2100.html"

SOURCES = {
    "JSEX_SE2001.txt": ("a51d44b5e4c1e2b1465ba86580e90f12fc60857c6c6465cab6e792fbcb9f23dd", "https://eclipse.gsfc.nasa.gov/JSEX/SE2001.js"),
    "JLEX_LE2001.txt": ("bf167ab3ac1cdb69c9c5e9a60e7a59c8419a10d8b665bc91a1eca08e2bab3690", "https://eclipse.gsfc.nasa.gov/JLEX/LE2001.js"),
}
J2000 = dt.datetime(2000, 1, 1, 12, tzinfo=dt.timezone.utc)
UTC = dt.timezone.utc
NUMBER = re.compile(r"^-?\d+(?:\.\d+)?(?:e[-+]\d+)?$")


def fail(message: str):
    sys.exit(f"build-local-elements: {message}")


def read_sources() -> dict:
    """Both files, after the sha256 pins and the FETCHLOG rows have been checked."""
    log = {}
    for line in (DIR / "FETCHLOG.tsv").read_text(encoding="utf-8").splitlines():
        if line.strip():
            fetched, url, status, name, sha = line.split("\t")
            log[name] = (fetched, url, status, sha)
    texts = {}
    for name, (pin, url) in SOURCES.items():
        raw = (DIR / name).read_bytes()
        got = hashlib.sha256(raw).hexdigest()
        if got != pin:
            fail(f"tools/nasa-elements/{name}: sha256 {got} is not the pinned {pin}")
        row = log.get(name)
        if row is None or row[1] != url or row[2] != "200" or row[3] != pin:
            fail(f"tools/nasa-elements/FETCHLOG.tsv has no matching row for {name}")
        texts[name] = (raw.decode("ascii"), row[0])
    return texts


def blocks(text: str):
    """(year, month, day), [number texts] for each element set; the text is only read."""
    parts = re.split(r"^// (\d{4})\s+(\d+)\s+(\d+)\s*$", text, flags=re.M)
    for i in range(1, len(parts), 4):
        body = parts[i + 3].split("));")[0]
        body = "\n".join(line for line in body.splitlines() if not line.lstrip().startswith("//"))
        tokens = [t.strip().strip('"').strip() for t in body.replace("\n", " ").split(",")]
        tokens = [t for t in tokens if t]
        for t in tokens:
            if not NUMBER.match(t):
                fail(f"{parts[i]}-{parts[i + 1]}-{parts[i + 2]}: not a number: {t!r}")
        yield (int(parts[i]), int(parts[i + 1]), int(parts[i + 2])), tokens


def td_of(jd: float) -> dt.datetime:
    return J2000 + dt.timedelta(days=jd - 2451545.0)


def t0_of(day: tuple, hours: float, td: dt.datetime) -> dt.datetime:
    """The reference instant: the date at 00:00 plus t0 hours, moved a day if more than 12 h from greatest eclipse."""
    base = dt.datetime(day[0], day[1], day[2], tzinfo=UTC) + dt.timedelta(hours=hours)
    if (base - td).total_seconds() > 12 * 3600:
        base -= dt.timedelta(days=1)
    if (td - base).total_seconds() > 12 * 3600:
        base += dt.timedelta(days=1)
    return base


def secs(hms: str) -> int:
    h, m, s = (int(x) for x in hms.split(":"))
    return h * 3600 + m * 60 + s


def catalogue_durations() -> dict:
    """{(y, m, d): (penumbral, partial, total) minutes or None} from the archived LEcat5 page."""
    out = {}
    text = re.sub(r"<[^>]+>", "", CATALOGUE.read_text(encoding="latin-1"))
    months = "JanFebMarAprMayJunJulAugSepOctNovDec"
    pat = re.compile(r"\s*\d+\s+(\d{4}) (\w{3}) (\d\d)\s+(\d\d:\d\d:\d\d)\s+\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+(-?\d\.\d+)\s+(-?\d\.\d+)\s+(-?\d\.\d+)\s+(\S+)\s+(\S+)\s+(\S+)")
    for line in text.splitlines():
        m = pat.match(line)
        if m:
            f = lambda s: None if s == "-" else float(s)
            out[(int(m[1]), months.index(m[2]) // 3 + 1, int(m[3]))] = (f(m[8]), f(m[9]), f(m[10]))
    return out


def build() -> str:
    texts = read_sources()
    eclipses = json.loads(LIST.read_text(encoding="utf-8"))["eclipses"]
    durations = catalogue_durations()
    solar_sets = {d: t for d, t in blocks(texts["JSEX_SE2001.txt"][0])}
    lunar_sets = {d: t for d, t in blocks(texts["JLEX_LE2001.txt"][0])}
    solar_rows, lunar_rows = [], []
    for e in eclipses:
        day = tuple(int(x) for x in e["id"][:10].split("-"))
        listed_td = dt.datetime(*day, tzinfo=UTC) + dt.timedelta(seconds=secs(e["td"]))
        listed_greatest = dt.datetime.fromisoformat(e["greatest"].replace("Z", "+00:00"))
        if e["kind"] == "solar":
            n = solar_sets.get(day)
            if n is None or len(n) != 28:
                fail(f"{e['id']}: no solar element set of 28 numbers")
            f = [float(x) for x in n]
            td = td_of(f[0])
            dT = f[4]
            if abs((td - listed_td).total_seconds()) > 1.0:
                fail(f"{e['id']}: TD of greatest eclipse differs from the list by more than 1 s")
            if abs((td - dt.timedelta(seconds=dT) - listed_greatest).total_seconds()) > 1.0:
                fail(f"{e['id']}: TD minus Delta T differs from the list's greatest eclipse by more than 1 s")
            if abs(dT - e["deltaT"]) > 1.0:
                fail(f"{e['id']}: Delta T differs from the list by more than 1 s")
            if f[2] != -4.0 or f[3] != 4.0:
                fail(f"{e['id']}: tmin and tmax are not -4.0 and 4.0")
            if n[4] != n[5]:
                fail(f"{e['id']}: the two Delta T copies differ")
            t0 = t0_of(day, f[1], td)
            if abs((t0 - td).total_seconds()) > 1800:
                fail(f"{e['id']}: t0 is more than 1800 s from greatest eclipse")
            solar_rows.append((e["id"], t0, n))
        else:
            n = lunar_sets.get(day)
            if n is None or len(n) != 22:
                fail(f"{e['id']}: no lunar element set of 22 numbers")
            f = [float(x) for x in n]
            td = td_of(f[0])
            dT = f[2]
            if abs((td - listed_td).total_seconds()) > 1.0:
                fail(f"{e['id']}: TD of greatest eclipse differs from the list by more than 1 s")
            if abs((td - dt.timedelta(seconds=dT) - listed_greatest).total_seconds()) > 1.0:
                fail(f"{e['id']}: TD minus Delta T differs from the list's greatest eclipse by more than 1 s")
            if abs(dT - e["deltaT"]) > 1.0:
                fail(f"{e['id']}: Delta T differs from the list by more than 1 s")
            kind = {1: "total", 2: "partial", 3: "penumbral"}.get(int(f[5]))
            if kind != e["type"]:
                fail(f"{e['id']}: type {kind} is not the list's {e['type']}")
            if abs(f[3] - e["penMagnitude"]) > 0.001 or abs(f[4] - e["magnitude"]) > 0.001:
                fail(f"{e['id']}: magnitudes differ from the list by more than 0.001")
            t0 = t0_of(day, f[1], td)
            if abs((t0 - td).total_seconds()) > 1800:
                fail(f"{e['id']}: t0 is more than 1800 s from greatest eclipse")
            c = f[9:16]  # P1 U1 U2 greatest U3 U4 P4
            has = {"total": (1, 1, 1, 1, 1, 1, 1), "partial": (1, 1, 0, 1, 0, 1, 1), "penumbral": (1, 0, 0, 1, 0, 0, 1)}[kind]
            for name, value, want in zip(("P1", "U1", "U2", "greatest", "U3", "U4", "P4"), c, has):
                if name == "greatest":
                    continue
                if want and value == 0.0:
                    fail(f"{e['id']}: contact {name} is 0.0 but the type {kind} has it")
                if not want and value != 0.0:
                    fail(f"{e['id']}: contact {name} is not 0.0 but the type {kind} lacks it")
            cat = durations.get(day)
            if cat is None:
                fail(f"{e['id']}: not in the archived LEcat5 page")
            mine = ((c[6] - c[0]) * 60, (c[5] - c[1]) * 60 if kind != "penumbral" else None, (c[4] - c[2]) * 60 if kind == "total" else None)
            for label, a, b in zip(("penumbral", "partial", "total"), mine, cat):
                if (a is None) != (b is None) or (a is not None and abs(a - b) > 0.1):
                    fail(f"{e['id']}: the {label} duration differs from LEcat5 by more than 0.1 min")
            lunar_rows.append((e["id"], t0, n, kind))
    if len(solar_rows) != sum(1 for e in eclipses if e["kind"] == "solar") or len(lunar_rows) != sum(1 for e in eclipses if e["kind"] == "lunar"):
        fail("the number of element sets differs from the list")

    def arr(tokens):
        return "[" + ", ".join(tokens) + "]"

    out = [
        "// GENERATED by tools/build-local-elements.py from the NASA element files archived in tools/nasa-elements/.",
        "// Do not edit by hand: change the script and run it again (its --check mode fails on any drift).",
        "//",
        "// Eclipse Predictions by Fred Espenak and Chris O'Byrne (NASA's GSFC), eclipse.gsfc.nasa.gov.",
        "// Besselian elements of solar eclipses: Fred Espenak and Jean Meeus, Five Millennium Canon of Solar",
        "// Eclipses: -1999 to +3000, NASA/TP-2006-214141, 2006. Lunar eclipse elements: Fred Espenak and",
        "// Jean Meeus, Five Millennium Canon of Lunar Eclipses (NASA/TP-2009-214172). NASA allows the data to",
        "// be reproduced with an acknowledgment; the numbers below are the data, not the JSEX and JLEX program code.",
    ]
    for name, (pin, url) in SOURCES.items():
        out.append(f"//   {url} (fetched {texts[name][1]}, sha256 {pin})")
    out += [
        "//",
        "// Only the eclipses of ts/core/data.ts are here (168 solar, 169 lunar). Every number is the text of the",
        "// source file. t0 is the reference instant of the polynomials, in Terrestrial Dynamical Time (TD): the",
        "// trailing Z only lets Date.parse read it without a local zone. dT is Delta T in seconds, so",
        "// UT = TD minus dT. Solar x and y are in Earth equatorial radii per hour^n, d and mu in degrees, l1,",
        "// l2 in Earth radii, f1 and f2 are tan f1 and tan f2. Lunar c holds P1, U1, U2, greatest, U3, U4, P4",
        "// in hours from t0 (TD), null where the type has no such contact; gst is the Greenwich sidereal time",
        "// at t0 in hours, hp the horizontal parallax and sd the semi-diameter of the Moon in degrees, and ra",
        "// and dec the Moon's right ascension and declination as polynomials in degrees.",
        "",
        "export interface SolarElements {",
        "  readonly id: string;",
        "  readonly t0: string;",
        "  readonly dT: number;",
        "  readonly x: readonly [number, number, number, number];",
        "  readonly y: readonly [number, number, number, number];",
        "  readonly d: readonly [number, number, number];",
        "  readonly mu: readonly [number, number, number];",
        "  readonly l1: readonly [number, number, number];",
        "  readonly l2: readonly [number, number, number];",
        "  readonly f1: number;",
        "  readonly f2: number;",
        "}",
        "",
        "export interface LunarElements {",
        "  readonly id: string;",
        "  readonly t0: string;",
        "  readonly dT: number;",
        "  readonly gst: number;",
        "  readonly hp: number;",
        "  readonly sd: number;",
        "  readonly c: readonly [number, number | null, number | null, number, number | null, number | null, number];",
        "  readonly ra: readonly [number, number, number];",
        "  readonly dec: readonly [number, number, number];",
        "}",
        "",
        "export const SOLAR_ELEMENTS: readonly SolarElements[] = [",
    ]
    for id_, t0, n in solar_rows:
        out.append(
            f"  {{ id: '{id_}', t0: '{t0.strftime('%Y-%m-%dT%H:00:00Z')}', dT: {n[4]}, x: {arr(n[6:10])}, y: {arr(n[10:14])}, "
            f"d: {arr(n[14:17])}, mu: {arr(n[17:20])}, l1: {arr(n[20:23])}, l2: {arr(n[23:26])}, f1: {n[26]}, f2: {n[27]} }},"
        )
    out += ["];", "", "export const LUNAR_ELEMENTS: readonly LunarElements[] = ["]
    for id_, t0, n, kind in lunar_rows:
        has = {"total": (1, 1, 1, 1, 1, 1, 1), "partial": (1, 1, 0, 1, 0, 1, 1), "penumbral": (1, 0, 0, 1, 0, 0, 1)}[kind]
        c = [v if h else "null" for v, h in zip(n[9:16], has)]
        out.append(
            f"  {{ id: '{id_}', t0: '{t0.strftime('%Y-%m-%dT%H:00:00Z')}', dT: {n[2]}, gst: {n[6]}, hp: {n[7]}, sd: {n[8]}, "
            f"c: {arr(c)}, ra: {arr(n[16:19])}, dec: {arr(n[19:22])} }},"
        )
    out += ["];", ""]
    return "\n".join(out)


def main() -> None:
    text = build()
    if "--check" in sys.argv:
        if not OUT.is_file() or OUT.read_text(encoding="utf-8") != text:
            print("build-local-elements: ts/core/elements.ts is NOT what tools/nasa-elements/ gives: run tools/build-local-elements.py", file=sys.stderr)
            sys.exit(1)
        print("build-local-elements: ts/core/elements.ts matches tools/nasa-elements/")
        return
    OUT.write_text(text, encoding="utf-8")
    print(f"build-local-elements: wrote ts/core/elements.ts ({text.count(chr(10) + '  { id:')} element sets)")


if __name__ == "__main__":
    main()
