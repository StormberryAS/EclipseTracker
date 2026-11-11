#!/usr/bin/env python3
"""The test vectors for ts/core/local.ts: an eclipse as seen from sixteen cities, worked out by a
separate implementation of the method.

    python3 -I tools/vectors/build-local-vectors.py           write tests/local-vectors.json
    python3 -I tools/vectors/build-local-vectors.py --check   change nothing; exit 1 if the file is
                                                               not what this script makes

The oracle is this file, in Python: a separate implementation of the published method (the observer
on the fundamental plane, the cone radii and the contacts for a solar eclipse; the Moon's altitude
from its right ascension, its declination, the sidereal time and the parallax for a lunar one),
written separately from the TypeScript. It reads the NASA element files in tools/nasa-elements/
(pinned by sha256, read as text, never run) with the element parser and the T0 rule of
tools/build-local-elements.py, the tool that writes ts/core/elements.ts, so the two share those
two parts and not the method. tests/local.test.ts replays the vectors against core/local.js.

For each city and each of the 337 eclipses of data/eclipses.json the file gives whether the eclipse is
seen and, when it is, its local type, start, end and maximum (to the second), and for a solar
eclipse the magnitude and the obscuration (four decimals), for a lunar eclipse the Moon's altitude
(two decimals), and `gap`: the body sets and rises again between start and end. `edge` lists the ids whose answer (seen or not, or the type) changes when the
horizon limit is moved by 0.05 degree: at a grazing horizon two correct programs may differ.

The city rows are the shared Labs catalogue's (cities.js); tests/local.test.ts checks that each is
still in the catalogue with these values.

Standard library only; run with python3 -I.
"""

import datetime as dt
import importlib.util
import json
import math
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
OUT = ROOT / "tests" / "local-vectors.json"

CITIES = [
    ("Kleppestø", "Norway", 60.4079, 5.2341, "Europe/Oslo"),
    ("Bergen", "Norway", 60.393, 5.3242, "Europe/Oslo"),
    ("Tromsø", "Norway", 69.6489, 18.9551, "Europe/Oslo"),
    ("Longyearbyen", "Svalbard and Jan Mayen", 78.2233, 15.6469, "Arctic/Longyearbyen"),
    ("Reykjavík", "Iceland", 64.1355, -21.8954, "Atlantic/Reykjavik"),
    ("Madrid", "Spain", 40.4165, -3.7026, "Europe/Madrid"),
    ("Cairo", "Egypt", 30.0626, 31.2497, "Africa/Cairo"),
    ("Luxor", "Egypt", 25.6989, 32.6421, "Africa/Cairo"),
    ("Quito", "Ecuador", -0.2298, -78.525, "America/Guayaquil"),
    ("Honolulu, HI", "USA", 21.3069, -157.8583, "Pacific/Honolulu"),
    ("Anchorage, AK", "USA", 61.2181, -149.9003, "America/Anchorage"),
    ("New York City, NY", "USA", 40.7143, -74.006, "America/New_York"),
    ("Sydney", "Australia", -33.8678, 151.2073, "Australia/Sydney"),
    ("Ushuaia", "Argentina", -54.8108, -68.3159, "America/Argentina/Ushuaia"),
    ("Santiago", "Chile", -33.4569, -70.6483, "America/Santiago"),
    ("Tokyo", "Japan", 35.6895, 139.6917, "Asia/Tokyo"),
]

RAD = math.pi / 180
FLATTENING = 0.99664719
SUN_LIMIT = -0.833
REFRACTION = 0.5667


def load_elements():
    """The element sets by id, parsed from the pinned NASA files (the parsing helpers of build-local-elements.py)."""
    sys.dont_write_bytecode = True  # importing a tool must leave no __pycache__ in the repository
    spec = importlib.util.spec_from_file_location("ble", ROOT / "tools" / "build-local-elements.py")
    ble = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ble)
    texts = ble.read_sources()
    solar = {d: t for d, t in ble.blocks(texts["JSEX_SE2001.txt"][0])}
    lunar = {d: t for d, t in ble.blocks(texts["JLEX_LE2001.txt"][0])}
    eclipses = json.loads((ROOT / "data" / "eclipses.json").read_text(encoding="utf-8"))["eclipses"]
    out = []
    for e in eclipses:
        day = tuple(int(x) for x in e["id"][:10].split("-"))
        if e["kind"] == "solar":
            f = [float(x) for x in solar[day]]
            td = ble.td_of(f[0])
            t0 = ble.t0_of(day, f[1], td)
            out.append(dict(id=e["id"], kind="solar", base=t0.timestamp() - f[4], dT=f[4], x=f[6:10], y=f[10:14], d=f[14:17],
                            mu=f[17:20], l1=f[20:23], l2=f[23:26], f1=f[26], f2=f[27]))
        else:
            f = [float(x) for x in lunar[day]]
            td = ble.td_of(f[0])
            t0 = ble.t0_of(day, f[1], td)
            has = {1: (1, 1, 1, 1, 1, 1, 1), 2: (1, 1, 0, 1, 0, 1, 1), 3: (1, 0, 0, 1, 0, 0, 1)}[int(f[5])]
            c = [v if h else None for v, h in zip(f[9:16], has)]
            out.append(dict(id=e["id"], kind="lunar", base=t0.timestamp() - f[2], dT=f[2], gst=f[6], hp=f[7], sd=f[8],
                            c=c, ra=f[16:19], dec=f[19:22]))
    return out


def poly(c, t):
    return sum(a * t ** i for i, a in enumerate(c))


def dpoly(c, t):
    return sum(i * a * t ** (i - 1) for i, a in enumerate(c) if i)


class Place:
    def __init__(self, lat, lon):
        self.lat = lat * RAD
        self.lon = lon * RAD
        u = math.atan(FLATTENING * math.tan(self.lat))
        self.rs = FLATTENING * math.sin(u)
        self.rc = math.cos(u)


def shadow(e, p, t):
    x, y = poly(e["x"], t), poly(e["y"], t)
    d = poly(e["d"], t) * RAD
    dd = dpoly(e["d"], t) * RAD
    dmu = dpoly(e["mu"], t) * RAD
    h = (poly(e["mu"], t) - 0.00417807 * e["dT"]) * RAD + p.lon
    xi = p.rc * math.sin(h)
    eta = p.rs * math.cos(d) - p.rc * math.cos(h) * math.sin(d)
    zeta = p.rs * math.sin(d) + p.rc * math.cos(h) * math.cos(d)
    u, v = x - xi, y - eta
    a = dpoly(e["x"], t) - dmu * p.rc * math.cos(h)
    b = dpoly(e["y"], t) - (dmu * xi * math.sin(d) - zeta * dd)
    return dict(u=u, v=v, a=a, b=b, n2=a * a + b * b, m=math.hypot(u, v),
                l1=poly(e["l1"], t) - zeta * e["f1"], l2=poly(e["l2"], t) - zeta * e["f2"],
                alt=math.degrees(math.asin(math.sin(d) * math.sin(p.lat) + math.cos(d) * math.cos(p.lat) * math.cos(h))))


def contact(e, p, t, which, sign):
    for _ in range(50):
        s = shadow(e, p, t)
        n = math.sqrt(s["n2"])
        k = (s["a"] * s["v"] - s["u"] * s["b"]) / (n * s[which])
        if not abs(k) <= 1:
            return None
        tau = (s["u"] * s["a"] + s["v"] * s["b"]) / s["n2"] - sign * math.sqrt(1 - k * k) * s[which] / n
        t -= tau
        if abs(tau) < 1e-7:
            return t
    return None


def obscuration(l1, l2, m):
    rs, rm = (l1 + l2) / 2, (l1 - l2) / 2
    if m >= rs + rm:
        return 0.0
    if m <= abs(rm - rs):
        return min(1.0, (rm / rs) ** 2)
    a1 = rs * rs * math.acos((m * m + rs * rs - rm * rm) / (2 * m * rs))
    a2 = rm * rm * math.acos((m * m + rm * rm - rs * rs) / (2 * m * rm))
    a3 = 0.5 * math.sqrt((-m + rs + rm) * (m + rs - rm) * (m - rs + rm) * (m + rs + rm))
    return (a1 + a2 - a3) / (math.pi * rs * rs)


def up_spans(up, lo, hi):
    """Every stretch (start, end) of [lo, hi] (epoch seconds) with up() true: a 60 s grid, then each
    edge narrowed to 1 s by halving. Empty when up() is never true on the grid."""
    grid = []
    t = lo
    while t < hi:
        grid.append(t)
        t += 60.0
    grid.append(hi)
    flags = [up(t) for t in grid]
    out = []
    i = 0
    while i < len(grid):
        if not flags[i]:
            i += 1
            continue
        j = i
        while j + 1 < len(grid) and flags[j + 1]:
            j += 1
        start = grid[i]
        if i > 0:
            a, b = grid[i - 1], start
            while b - a > 1.0:
                mid = (a + b) / 2
                if up(mid):
                    b = mid
                else:
                    a = mid
            start = b
        end = grid[j]
        if j < len(grid) - 1:
            a, b = end, grid[j + 1]
            while b - a > 1.0:
                mid = (a + b) / 2
                if up(mid):
                    a = mid
                else:
                    b = mid
            end = a
        out.append((start, end))
        i = j + 1
    return out


def merge_spans(a, b):
    """Both lists as one, in order; stretches that overlap or lie within 1 s of each other are joined."""
    out = []
    for s0, e0 in sorted(a + b):
        if out and s0 <= out[-1][1] + 1.0:
            out[-1] = (out[-1][0], max(out[-1][1], e0))
        else:
            out.append((s0, e0))
    return out


def seen_of(spans, deepest):
    """(start, end, gap, max): the first and last moment with the body up, whether it sets and rises
    again between them, and the deepest moment if the body is up then, else the end of an up stretch
    nearest to it. None when the body is never up."""
    if not spans:
        return None
    if any(s0 <= deepest <= e0 for s0, e0 in spans):
        mx = deepest
    else:
        mx = min((edge for s0, e0 in spans for edge in (s0, e0)), key=lambda edge: abs(edge - deepest))
    return spans[0][0], spans[-1][1], len(spans) > 1, mx


def solar(e, lat, lon, shift):
    p = Place(lat, lon)
    limit = SUN_LIMIT + shift
    to_t = lambda sec: (sec - e["base"]) / 3600.0
    to_s = lambda t: e["base"] + t * 3600.0
    t = 0.0
    for _ in range(50):
        s = shadow(e, p, t)
        tau = (s["u"] * s["a"] + s["v"] * s["b"]) / s["n2"]
        t -= tau
        if abs(tau) < 1e-8:
            break
    tm = t
    s = shadow(e, p, tm)
    if (s["l1"] - s["m"]) / (s["l1"] + s["l2"]) <= 0:
        return None
    c1, c4 = contact(e, p, tm, "l1", -1), contact(e, p, tm, "l1", 1)
    if c1 is None or c4 is None or c1 < -4 or c4 > 4:
        return None
    c2 = c3 = None
    if s["m"] < abs(s["l2"]):
        a, b = contact(e, p, tm, "l2", -1), contact(e, p, tm, "l2", 1)
        if a is not None and b is not None:
            c2, c3 = to_s(min(a, b)), to_s(max(a, b))
    c1s, c4s, tms = to_s(c1), to_s(c4), to_s(tm)
    sun_up = lambda sec: shadow(e, p, to_t(sec))["alt"] > limit
    seen = seen_of(up_spans(sun_up, c1s, c4s), tms)
    if not seen:
        return None
    start, end, gap, mx = seen
    sm = shadow(e, p, to_t(mx))
    in_totality = c2 is not None and c2 <= mx <= c3
    mag = (sm["l1"] - sm["l2"]) / (sm["l1"] + sm["l2"]) if in_totality else (sm["l1"] - sm["m"]) / (sm["l1"] + sm["l2"])
    typ = "partial"
    if c2 is not None and up_spans(sun_up, c2, c3):
        typ = "total" if shadow(e, p, tm)["l2"] < 0 else "annular"
    obs = 1.0 if in_totality and sm["l2"] < 0 else obscuration(sm["l1"], sm["l2"], sm["m"])
    return dict(type=typ, start=start, end=end, max=mx, gap=gap, magnitude=mag, obscuration=obs)


def moon_altitude(e, p, t):
    ra = poly(e["ra"], t)
    dec = poly(e["dec"], t) * RAD
    h = (15 * (e["gst"] + (t - e["dT"] / 3600) * 1.00273791) - ra) * RAD + p.lon
    g = math.asin(math.sin(p.lat) * math.sin(dec) + math.cos(p.lat) * math.cos(dec) * math.cos(h))
    return math.degrees(g - math.asin(math.sin(e["hp"] * RAD) * math.cos(g)))


def lunar(e, lat, lon, shift):
    p = Place(lat, lon)
    to_t = lambda sec: (sec - e["base"]) / 3600.0
    to_s = lambda t: e["base"] + t * 3600.0
    moon_up = lambda sec: moon_altitude(e, p, to_t(sec)) > -(REFRACTION + e["sd"]) + shift
    p1, u1, u2, g, u3, u4, p4 = e["c"]
    penumbral = u1 is None
    test = (to_s(p1), to_s(p4)) if penumbral else (to_s(u1), to_s(u4))
    test_spans = up_spans(moon_up, *test)
    if not test_spans:
        return None
    # The test window lies inside the penumbral one; a stretch trimmed at its very edge by the 1 s halving is joined to it.
    seen = seen_of(merge_spans(up_spans(moon_up, to_s(p1), to_s(p4)), test_spans), to_s(g))
    if not seen:
        return None
    start, end, gap, mx = seen
    typ = "penumbral"
    if not penumbral:
        typ = "total" if u2 is not None and up_spans(moon_up, to_s(u2), to_s(u3)) else "partial"
    return dict(type=typ, start=start, end=end, max=mx, gap=gap, altitude=moon_altitude(e, p, to_t(mx)))


def iso(sec):
    return dt.datetime.fromtimestamp(round(sec), dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build():
    elements = load_elements()
    out = {
        "about": "Written by tools/vectors/build-local-vectors.py, a separate implementation of the method in ts/core/local.ts. Do not edit by hand.",
        "limits": {"sunDeg": SUN_LIMIT, "refractionDeg": REFRACTION, "edgeShiftDeg": 0.05},
        "cities": [],
    }
    for name, country, lat, lon, tz in CITIES:
        seen, unseen, edge = [], [], []
        for e in elements:
            run = solar if e["kind"] == "solar" else lunar
            base = run(e, lat, lon, 0.0)
            around = [run(e, lat, lon, s) for s in (-0.05, 0.05)]
            key = lambda r: None if r is None else r["type"]
            if any(key(r) != key(base) for r in around):
                edge.append(e["id"])
            if base is None:
                unseen.append(e["id"])
                continue
            row = {"id": e["id"], "type": base["type"], "start": iso(base["start"]), "end": iso(base["end"]), "max": iso(base["max"]), "gap": base["gap"]}
            if e["kind"] == "solar":
                row["magnitude"] = round(base["magnitude"], 4)
                row["obscuration"] = round(base["obscuration"], 4)
            else:
                row["altitude"] = round(base["altitude"], 2)
            seen.append(row)
        out["cities"].append({"name": name, "country": country, "lat": lat, "lon": lon, "tz": tz, "seen": seen, "unseen": unseen, "edge": edge})
    return json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n"


def main():
    text = build()
    if "--check" in sys.argv:
        if not OUT.is_file() or OUT.read_text(encoding="utf-8") != text:
            print("build-local-vectors: tests/local-vectors.json is NOT what this script makes: run tools/vectors/build-local-vectors.py", file=sys.stderr)
            sys.exit(1)
        print("build-local-vectors: tests/local-vectors.json matches")
        return
    OUT.write_text(text, encoding="utf-8")
    data = json.loads(text)
    seen = sum(len(c["seen"]) for c in data["cities"])
    edge = sum(len(c["edge"]) for c in data["cities"])
    print(f"build-local-vectors: wrote tests/local-vectors.json ({len(data['cities'])} cities, {seen} seen cases, {edge} edge cases)")


if __name__ == "__main__":
    main()
