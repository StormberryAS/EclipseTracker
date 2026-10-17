#!/usr/bin/env python3
"""Build ts/core/data.ts, the eclipse list, from NASA's eclipse pages archived in tools/nasa/.

    python3 -I tools/build-eclipse-data.py           write ts/core/data.ts
    python3 -I tools/build-eclipse-data.py --check   change nothing; exit 1 if ts/core/data.ts is
                                                     not exactly what the archived pages give

Sources (Fred Espenak, NASA Goddard Space Flight Center, eclipse.gsfc.nasa.gov; public domain).
Each page is archived byte for byte in tools/nasa/, and tools/nasa/FETCHLOG.tsv records its URL,
the moment it was fetched (UTC), the HTTP status and its SHA-256. This script refuses to run when a
page no longer matches its recorded hash, so the list can only ever come from the pages as fetched.

  * SEcat5/SE2001-2100.html and LEcat5/LE2001-2100.html, the Five Millennium Canon catalogues:
    the time of greatest eclipse in Terrestrial Dynamical Time (TD), Delta T, the type, the Saros
    series, gamma and the magnitudes. These are the values the list carries.
  * SEdecade/SEdecadeYYY1.html and LEdecade/LEdecadeYYY1.html, the "Eclipses During" decade
    tables: the visibility region (and, for central solar eclipses, the path in brackets). Every
    eclipse is also cross-checked against them: the same date, type, Saros series and magnitude
    (to the 0.001 the table prints), a time of greatest eclipse within 2 seconds (the tables round
    differently from the catalogue, and once print 17:44:60), and the same number of eclipses in
    every decade.

UTC = TD - Delta T, with the catalogue's own Delta T for that eclipse. Delta T for future years is
an extrapolation (the canon gives 75 s for 2026 and 204 s for 2100), so a time late in the list
may be off by a minute or more. The page shows times to the minute.

The regions are NASA's text, rewritten in British English with the abbreviations spelt out
(REGION_WORDS) and NASA's typing slips corrected (FIXES); every rewrite is listed below, and the
tests check the output for the house style (no em or en dashes, no double hyphens).
"""

import decimal
import hashlib
import html
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
NASA = ROOT / "tools" / "nasa"
OUT = ROOT / "ts" / "core" / "data.ts"
# The same list as JSON, for stage B's native side (spec section 9). Published with the site.
OUT_JSON = ROOT / "data" / "eclipses.json"

FIRST = "2026-10-16"      # the list starts here: the day the data was built (stage A)
LAST_YEAR = 2100          # and ends at 2100-12-31 (Marcos, 2026-10-16: first 2052, then 2089, then 2100)
DECADES = [2021, 2031, 2041, 2051, 2061, 2071, 2081, 2091]

MONTHS = {m: i + 1 for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split())}

SOLAR_TYPES = {"T": "total", "A": "annular", "H": "hybrid", "P": "partial"}
LUNAR_TYPES = {"T": "total", "P": "partial", "N": "penumbral"}
DECADE_TYPES = {"Total": "total", "Annular": "annular", "Hybrid": "hybrid", "Partial": "partial", "Penumbral": "penumbral"}

# NASA's typing slips in the decade tables, corrected before anything else. Each is a plain
# misspelling or a stray character; nothing here changes where an eclipse is seen.
FIXES = [
    ("Scandanavia", "Scandinavia"),
    ("Indondesia", "Indonesia"),
    ("Afganistan", "Afghanistan"),
    ("Nambia", "Namibia"),
    ("Philippines. N.Z.", "Philippines, N.Z."),
    ("Egypt. Saudi Arabia", "Egypt, Saudi Arabia"),
    ("Asia. Middle East", "Asia, Middle East"),
    ("Carribean", "Caribbean"),
    ("Chile Argentina", "Chile, Argentina"),
    ("Quatar", "Qatar"),
    ("U.S,", "U.S.,"),
    (", ,", ","),
    (",,", ","),
    ("Total:", "Total: "),
    ("Annular:", "Annular: "),
    ("Hybrid:", "Hybrid: "),
]

# Whole names first (longest first), then the direction prefixes NASA writes in lower case.
NAMES = [
    ("N. & C. America", "North and Central America"),
    ("C & S America", "Central and South America"),
    ("C. & S. America", "Central and South America"),
    ("N. America", "North America"),
    ("S. America", "South America"),
    ("C. America", "Central America"),
    ("N America", "North America"),
    ("S America", "South America"),
    ("Western North America", "western North America"),
    ("N.A.", "North America"),
    ("N. Z.", "New Zealand"),
    ("N.Z.", "New Zealand"),
    ("E. Indies", "East Indies"),
    ("Mid East", "Middle East"),
    ("Indian Oc.", "Indian Ocean"),
    ("Central Indian", "central Indian Ocean"),
    ("Southern Indian", "southern Indian Ocean"),
    ("Southern Atlantic", "southern Atlantic"),
    ("Central Pacific", "central Pacific"),
    ("Central Atlantic", "central Atlantic"),
    ("South Pacific", "South Pacific"),
    ("Dom.Rep.", "Dominican Republic"),
    ("Dominican Rep.", "Dominican Republic"),
    ("Fr. Guyana", "French Guiana"),
    ("Cote d'Ivoire", "Côte d'Ivoire"),
    ("Ivory Coast", "Côte d'Ivoire"),
    ("S. Africa", "South Africa"),
    ("N. Dakota", "North Dakota"),
    ("U.S.", "United States"),
    ("U.K.", "United Kingdom"),
    ("CAR", "Central African Republic"),
    ("US", "United States"),
    # Countries NASA names by an older name: the current English short names.
    ("Swaziland", "Eswatini"),
    ("Zaire", "DR Congo"),
    ("UAE", "United Arab Emirates"),
    ("midwest", "Midwest"),
]

DIRECTIONS = {
    "n": "northern", "s": "southern", "e": "eastern", "w": "western", "c": "central",
    "ne": "north-eastern", "nw": "north-western", "se": "south-eastern", "sw": "south-western",
    "n.": "northern", "s.": "southern",
}

# Region phrases that read better as the usual proper names.
PROPER = {
    "south-eastern Asia": "South-East Asia",
    "SE Asia": "South-East Asia",
    "southern Pacific": "South Pacific",
    "northern Pacific": "North Pacific",
    "southern Atlantic": "South Atlantic",
    "eastern Asia": "East Asia",
    "Indies": "East Indies",
    # NASA's "e Indies" (lunar eclipses of 2059-05-27 and 2064-07-28): the eastern islands, which
    # today is eastern Indonesia, as "w Indies" below (K-1, approved by Marcos 2026-10-16).
    "eastern Indies": "eastern Indonesia",
    # NASA's "w Indies" (2052-09-22): the western islands of the East Indies, which today is
    # western Indonesia; "western East Indies" read oddly (data review D-10, 2026-10-16).
    "western Indies": "western Indonesia",
}


def check_hashes() -> dict[str, str]:
    """Every archived page must still match the SHA-256 recorded when it was fetched."""
    rows = {}
    for line in (NASA / "FETCHLOG.tsv").read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        fetched, url, status, name, sha = line.split("\t")
        if status != "200":
            sys.exit(f"build-eclipse-data: {url} was not fetched (HTTP {status})")
        got = hashlib.sha256((NASA / name).read_bytes()).hexdigest()
        if got != sha:
            sys.exit(f"build-eclipse-data: tools/nasa/{name} does not match its recorded SHA-256")
        rows[name] = f"{url} (fetched {fetched})"
    return rows


def read(name: str) -> str:
    return (NASA / name).read_text(encoding="latin-1")


def text(cell: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", cell))).strip()


def expand_part(part: str) -> str:
    part = part.strip()
    for old, new in NAMES:
        part = re.sub(rf"(?<![\w.]){re.escape(old)}(?![\w])", new, part)
    # "w & s Africa" -> "western and southern Africa"; "s Argentina & Chile" -> "southern Argentina and Chile"
    words = part.split(" ")
    out = []
    for w in words:
        if w in DIRECTIONS:
            out.append(DIRECTIONS[w])
        elif w == "&":
            out.append("and")
        else:
            out.append(w)
    part = " ".join(out)
    return PROPER.get(part, part)


def expand(region: str) -> str:
    parts = [expand_part(p) for p in region.split(",") if p.strip()]
    return ", ".join(parts)


def decade_rows(kind: str, decade: int):
    """(date, td, type, saros, magnitude, region, path) from one decade table."""
    t = read(f"{kind}decade_{kind}decade{decade}.html")
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", t, re.S):
        tds = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)
        if len(tds) != 7:
            continue
        cells = [text(c) for c in tds]
        m = re.fullmatch(r"(\d{4}) (\w{3}) (\d{2})", cells[0])
        if not m:
            continue
        date = f"{m[1]}-{MONTHS[m[2]]:02d}-{m[3]}"
        raw = cells[6]
        original = raw
        for old, new in FIXES:
            raw = raw.replace(old, new)
        path = ""
        pm = re.search(r"\[(?:Total|Annular|Hybrid): *(.*?)\]", raw)
        if pm:
            path = pm[1].strip()
            raw = raw[: pm.start()].strip()
        yield {
            "date": date,
            "td": cells[1],
            "type": DECADE_TYPES[cells[2]],
            "saros": int(cells[3]),
            "magnitude": float(cells[4]),
            "magnitude_text": cells[4],
            "region_raw": raw,
            "path_raw": path,
            "original": original,
        }


def catalogue_rows(kind: str):
    name = "SEcat5_SE2001-2100.html" if kind == "SE" else "LEcat5_LE2001-2100.html"
    for line in read(name).splitlines():
        line = text(line)
        m = re.match(r"^(\d{5}) +(-?\d{4}) (\w{3}) (\d{2}) +(\d{2}:\d{2}:\d{2}) +(-?\d+) +(-?\d+) +(\d+) +(\w[\w+-]*) +(\S+) +(-?\d+\.\d+) +(-?\d+\.\d+)(?: +(-?\d+\.\d+))?", line)
        if not m:
            continue
        date = f"{m[2]}-{MONTHS[m[3]]:02d}-{m[4]}"
        row = {
            "catalog": m[1],
            "date": date,
            "td": m[5],
            "deltaT": int(m[6]),
            "saros": int(m[8]),
            "code": m[9],
            "gamma": float(m[11]),
        }
        if kind == "SE":
            row["type"] = SOLAR_TYPES[m[9][0]]
            row["magnitude"] = float(m[12])
        else:
            row["type"] = LUNAR_TYPES[m[9][0]]
            row["penMagnitude"] = float(m[12])
            row["penMagnitude_text"] = m[12]
            row["magnitude"] = float(m[13])          # umbral
        yield row


def seconds(hms: str) -> int:
    h, mi, s = (int(x) for x in hms.split(":"))
    return h * 3600 + mi * 60 + s


def utc(date: str, td: str, delta_t: int) -> str:
    import datetime as dt
    y, mo, d = (int(x) for x in date.split("-"))
    t = dt.datetime(y, mo, d, tzinfo=dt.timezone.utc) + dt.timedelta(seconds=seconds(td) - delta_t)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def shown_magnitude(c: dict, r: dict) -> str:
    """The magnitude the page shows, to 3 decimals, as text (data review D-5, 2026-10-16).

    Solar eclipses and umbral lunar eclipses: the decade table's own value, exactly as NASA prints
    it. NASA rounds from more digits than the catalogue prints, so where the catalogue's fourth
    decimal is a 5 the table goes either way; JavaScript's toFixed(3) on the 4-decimal number
    disagreed with the table 8 times (1.2995 shown as 1.300 where NASA prints 1.299, for one).
    Penumbral lunar eclipses show the penumbral magnitude, which the decade table does not print:
    the catalogue's 4-decimal text rounded half up in decimal arithmetic (Kotlin: BigDecimal with
    RoundingMode.HALF_UP), so it never depends on how a binary float happens to round.
    """
    if c["type"] == "penumbral":
        value = decimal.Decimal(c["penMagnitude_text"]).quantize(decimal.Decimal("0.001"), rounding=decimal.ROUND_HALF_UP)
        return f"{value:.3f}"
    if not re.fullmatch(r"-?\d+\.\d{3}", r["magnitude_text"]):
        sys.exit(f"build-eclipse-data: {r['date']}: the decade table's magnitude {r['magnitude_text']!r} is not 3 decimals")
    return r["magnitude_text"]


def build() -> str:
    sources = check_hashes()
    eclipses = []
    counts = {}
    for kind, family in (("SE", "solar"), ("LE", "lunar")):
        cat = {r["date"]: r for r in catalogue_rows(kind)}
        for decade in DECADES:
            rows = list(decade_rows(kind, decade))
            in_cat = [d for d in cat if decade <= int(d[:4]) <= decade + 9]
            if len(rows) != len(in_cat):
                sys.exit(f"build-eclipse-data: {kind} {decade}s: decade table has {len(rows)}, catalogue {len(in_cat)}")
            for r in rows:
                c = cat.get(r["date"])
                if c is None:
                    sys.exit(f"build-eclipse-data: {kind} {r['date']} is in the decade table but not the catalogue")
                if c["type"] != r["type"] or c["saros"] != r["saros"]:
                    sys.exit(f"build-eclipse-data: {kind} {r['date']}: type or Saros differ")
                if abs(round(c["magnitude"], 3) - r["magnitude"]) > 0.0011:
                    sys.exit(f"build-eclipse-data: {kind} {r['date']}: magnitude {c['magnitude']} vs {r['magnitude']}")
                if abs(seconds(c["td"]) - seconds(r["td"])) > 2:
                    sys.exit(f"build-eclipse-data: {kind} {r['date']}: TD {c['td']} vs {r['td']}")
                if not (FIRST <= r["date"] and int(r["date"][:4]) <= LAST_YEAR):
                    continue
                e = {
                    "id": f"{r['date']}-{family}",
                    "kind": family,
                    "type": c["type"],
                    "greatest": utc(c["date"], c["td"], c["deltaT"]),
                    "td": c["td"],
                    "deltaT": c["deltaT"],
                    "saros": c["saros"],
                    "gamma": c["gamma"],
                    "magnitude": c["magnitude"],
                    "region": expand(r["region_raw"]),
                    "path": expand(r["path_raw"]) if r["path_raw"] else "",
                    "nasa": r["original"],
                }
                if family == "lunar":
                    e["penMagnitude"] = c["penMagnitude"]
                e["shownMagnitude"] = shown_magnitude(c, r)
                eclipses.append(e)
                key = f"{decade}-{decade + 9}"  # NASA's own decade table
                counts.setdefault(key, {"solar": 0, "lunar": 0})[family] += 1
    eclipses.sort(key=lambda e: e["greatest"])

    def js(v):
        if isinstance(v, str):
            return "'" + v.replace("\\", "\\\\").replace("'", "\\'") + "'"
        if isinstance(v, float):
            return repr(v)
        return str(v)

    lines = [
        "// GENERATED by tools/build-eclipse-data.py from NASA's eclipse pages archived in tools/nasa/.",
        "// Do not edit by hand: change the script and run it again (its --check mode fails on any drift).",
        "//",
        "// Fred Espenak, NASA Goddard Space Flight Center, eclipse.gsfc.nasa.gov (public domain).",
    ]
    for name in sorted(sources):
        lines.append(f"//   {sources[name]}")
    lines += [
        "//",
        "// greatest: the instant of greatest eclipse in UTC, the catalogue's TD minus its Delta T.",
        "// magnitude: solar, the eclipse magnitude; lunar, the umbral magnitude (negative for a",
        "// penumbral eclipse). penMagnitude: lunar only. shownMagnitude: what the page shows, to 3",
        "// decimals: the decade table's own value, or for a penumbral eclipse the penumbral magnitude",
        "// rounded half up. region: where it can be seen; path: for a",
        "// total, annular or hybrid solar eclipse, the countries and seas on the central path.",
        "// nasa: the decade table's own words, kept so the rewrite can always be compared.",
        "",
        "import type { Eclipse } from './types.js';",
        "",
        f"export const DATA_FIRST_DAY = '{FIRST}';",
        f"export const DATA_LAST_YEAR = {LAST_YEAR};",
        "",
        "/** Eclipses per NASA decade table (2021-2030 and so on), solar and lunar, from DATA_FIRST_DAY on. */",
        "export const DECADE_COUNTS: Readonly<Record<string, { solar: number; lunar: number }>> = {",
    ]
    for k in sorted(counts):
        lines.append(f"  '{k}': {{ solar: {counts[k]['solar']}, lunar: {counts[k]['lunar']} }},")
    lines += ["};", "", "export const ECLIPSES: readonly Eclipse[] = ["]
    order = ["id", "kind", "type", "greatest", "td", "deltaT", "saros", "gamma", "magnitude", "penMagnitude", "shownMagnitude", "region", "path", "nasa"]
    for e in eclipses:
        body = ", ".join(f"{k}: {js(e[k])}" for k in order if k in e)
        lines.append(f"  {{ {body} }},")
    lines += ["];", ""]
    doc = {
        "source": "Fred Espenak, NASA Goddard Space Flight Center, eclipse.gsfc.nasa.gov (public domain)",
        "pages": [sources[n] for n in sorted(sources)],
        "firstDay": FIRST,
        "lastYear": LAST_YEAR,
        "eclipses": [{k: e[k] for k in order if k in e} for e in eclipses],
    }
    return "\n".join(lines), json.dumps(doc, ensure_ascii=False, indent=1) + "\n"


def main() -> None:
    out, out_json = build()
    if "--check" in sys.argv:
        bad = False
        for path, want in ((OUT, out), (OUT_JSON, out_json)):
            if not path.is_file() or path.read_text(encoding="utf-8") != want:
                print(f"build-eclipse-data: {path.relative_to(ROOT)} is NOT what tools/nasa/ gives: run tools/build-eclipse-data.py", file=sys.stderr)
                bad = True
            else:
                print(f"build-eclipse-data: {path.relative_to(ROOT)} matches tools/nasa/")
        sys.exit(1 if bad else 0)
    for path, text in ((OUT, out), (OUT_JSON, out_json)):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    print(f"build-eclipse-data: wrote {OUT.relative_to(ROOT)} ({out.count(chr(10) + '  { id:')} eclipses)")


if __name__ == "__main__":
    main()
