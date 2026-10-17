#!/usr/bin/env python3
"""The test vectors stage B's Kotlin port must pass, checked against an independent oracle.

    python3 -I tools/vectors/build-vectors.py           write tests/record-vectors.json and
                                                        tests/dst-vectors.json
    python3 -I tools/vectors/build-vectors.py --check   change nothing; exit 1 if either file is not
                                                        what this script makes, or if any case of
                                                        tests/alarm-vectors.json disagrees with the
                                                        oracle

The oracle is Python's zoneinfo with the system's tz database, not the app's own code: a wall time
with fold=0 takes, in a gap, the offset in force before the change (so it lands the length of the
gap later on the clock) and, in an overlap, the first of the two instants. That is java.time's
ZonedDateTime.of(...).withEarlierOffsetAtOverlap(), which stage B uses, and what core/zoned.js does
with Intl. The Node tests (tests/alarms.test.mjs, tests/zoned.test.mjs) then check core/ against the
same files, so the app, the oracle and the Kotlin port all agree on one set of answers.

  * tests/record-vectors.json (code review C-1, 2026-10-16): what a re-plan does with a stored
    alarm record (spec 9.4, core recordFate): arm it, or delete it and why. Hand-chosen cases.
  * tests/dst-vectors.json (data review D-9, 2026-10-16): every day the clocks change from
    2026-10-16 to the end of 2100 in ZONES, with wall times across each change, and what each
    becomes. Generated from the zones' rules; Africa/Casablanca is left out on purpose, because the
    tz database releases disagree about Morocco's future changes (data review D-8).

Instants are written YYYY-MM-DDTHH:MM:SSZ everywhere (code review C-23). Standard library only;
adapted from the data reviewer's gen_inputs.py and harness.mjs (review-data/, 2026-10-16).
"""

import datetime as dt
import json
import pathlib
import sys
from zoneinfo import ZoneInfo

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
TESTS = ROOT / "tests"
UTC = dt.timezone.utc
FIRST = dt.date(2026, 10, 16)
LAST = dt.date(2100, 12, 31)

# North and south, east and west of UTC; whole-hour, half-hour and 45-minute offsets; a half-hour
# change (Lord Howe), a two-hour change (Troll), changes at midnight (Santiago, Havana).
ZONES = [
    "Europe/Oslo", "America/New_York", "America/St_Johns", "America/Santiago", "America/Havana",
    "Australia/Sydney", "Australia/Lord_Howe", "Pacific/Chatham", "Antarctica/Troll",
]
# Wall times tried on each day the clocks change. The clock skips or repeats the wall times from
# LO to just before HI: in a gap (spring) from the wall time the change happens at, W, to W + G
# (its length); in an overlap (autumn) from W - G to W. Tried: LO - 1 min, LO, the middle, HI - 1
# min, HI: either side of each edge, and inside.
GRACE = dt.timedelta(hours=48)   # core RECORD_GRACE_MS


def iso(t: dt.datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse(s: str) -> dt.datetime:
    return dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def round_minute(t: dt.datetime) -> dt.datetime:
    ms = round(t.timestamp() * 1000)
    return dt.datetime.fromtimestamp(((ms + 30_000) // 60_000) * 60, UTC)


def wall_to_instant(zone: str, day: dt.date, hm: str) -> tuple[dt.datetime, str]:
    tz = ZoneInfo(zone)
    h, m = (int(x) for x in hm.split(":"))
    naive = dt.datetime(day.year, day.month, day.day, h, m)
    first = naive.replace(tzinfo=tz, fold=0).astimezone(UTC)
    second = naive.replace(tzinfo=tz, fold=1).astimezone(UTC)
    if first.astimezone(tz).replace(tzinfo=None) != naive:
        return first, "gap"
    if first != second:
        return min(first, second), "overlap"
    return first, "none"


def plan(greatest: str, spec: dict, zone: str, now: dt.datetime) -> dict:
    tz = ZoneInfo(zone)
    g = round_minute(parse(greatest))
    if spec["kind"] == "before":
        fire, how = g - dt.timedelta(minutes=spec["minutes"]), "none"
    else:
        day = g.astimezone(tz).date() - dt.timedelta(days=spec["daysBefore"])
        fire, how = wall_to_instant(zone, day, spec["time"])
    local = fire.astimezone(tz)
    return {
        "fireAt": iso(fire), "localDate": local.strftime("%Y-%m-%d"), "localTime": local.strftime("%H:%M"),
        "offsetMinutes": int(local.utcoffset().total_seconds() // 60), "status": "ok" if fire > now else "past",
        "afterGreatest": fire > g, "dst": how,
    }


def plan_case(case: dict) -> list[dict]:
    now = parse(case["now"])
    seen, out = set(), []
    for spec in case["specs"]:
        p = plan(case["greatest"], spec, case["zone"], now)
        if p["status"] == "ok":
            if p["fireAt"] in seen:
                p["status"] = "duplicate"
            seen.add(p["fireAt"])
        out.append(p)
    return out


# ---- Record vectors (core recordFate) --------------------------------------------------------

def valid_record(r) -> bool:
    import re
    if not isinstance(r, dict) or sorted(r) != ["eclipseId", "id", "spec", "v"] or r["v"] != 1:
        return False
    if not isinstance(r["id"], str) or not re.fullmatch(r"[0-9a-f]{32}", r["id"]):
        return False
    if not isinstance(r["eclipseId"], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}-(solar|lunar)", r["eclipseId"]):
        return False
    s = r["spec"]
    if not isinstance(s, dict):
        return False
    if s.get("kind") == "before":
        return sorted(s) == ["kind", "minutes"] and s["minutes"] in (15, 30, 60, 120) and not isinstance(s["minutes"], bool)
    if s.get("kind") == "day":
        return (sorted(s) == ["daysBefore", "kind", "time"] and s["daysBefore"] in (0, 1, 2, 3, 7)
                and isinstance(s["time"], str) and re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", s["time"]) is not None)
    return False


def fate(case: dict) -> dict:
    r, e, zone, now = case["record"], case["eclipse"], case["zone"], parse(case["now"])
    if not valid_record(r):
        return {"action": "delete", "reason": "invalid"}
    if e is None or e["id"] != r["eclipseId"]:
        return {"action": "delete", "reason": "unknown-eclipse"}
    if now >= round_minute(parse(e["greatest"])) + GRACE:
        return {"action": "delete", "reason": "expired"}
    p = plan(e["greatest"], r["spec"], zone, now)
    return {"action": "arm", "fireAt": p["fireAt"]} if parse(p["fireAt"]) > now else {"action": "delete", "reason": "passed"}


ID = "0123456789abcdef0123456789abcdef"
LUNAR = {"id": "2027-02-20-lunar", "greatest": "2027-02-20T23:12:50Z"}
SOLAR = {"id": "2027-02-06-solar", "greatest": "2027-02-06T15:59:32Z"}
# Not a real eclipse: greatest eclipse at 00:30 Oslo summer time on the night the clocks go back,
# so 23:59 that local day is 24 hours 29 minutes after it.
AUTUMN = {"id": "2033-10-29-lunar", "greatest": "2033-10-29T22:30:00Z"}


def rec(eclipse_id: str, spec: dict) -> dict:
    return {"v": 1, "id": ID, "eclipseId": eclipse_id, "spec": spec}


RECORD_CASES = [
    ("C-1: the phone restarts after greatest eclipse (00:13 in Oslo) but before an alarm set for noon that day: the record is armed, not deleted",
     rec(LUNAR["id"], {"kind": "day", "daysBefore": 0, "time": "12:00"}), LUNAR, "Europe/Oslo", "2027-02-21T01:00:00Z"),
    ("the same alarm at the moment it rings: its time has passed, so the re-plan after the ring deletes it",
     rec(LUNAR["id"], {"kind": "day", "daysBefore": 0, "time": "12:00"}), LUNAR, "Europe/Oslo", "2027-02-21T11:00:00Z"),
    ("a before-alarm after greatest eclipse has passed and is deleted",
     rec(LUNAR["id"], {"kind": "before", "minutes": 30}), LUNAR, "Europe/Oslo", "2027-02-21T01:00:00Z"),
    ("an alarm still to come is armed",
     rec(SOLAR["id"], {"kind": "day", "daysBefore": 7, "time": "08:30"}), SOLAR, "Europe/Oslo", "2026-10-16T12:00:00Z"),
    ("missed: the phone was off at 12:00, so at the next re-plan the alarm is deleted, never rung late",
     rec(SOLAR["id"], {"kind": "day", "daysBefore": 0, "time": "12:00"}), SOLAR, "Europe/Oslo", "2027-02-06T11:30:00Z"),
    ("travel (B-2): in Tokyo the same record rings at 12:00 Tokyo time on the Tokyo day of greatest eclipse, 7 February",
     rec(SOLAR["id"], {"kind": "day", "daysBefore": 0, "time": "12:00"}), SOLAR, "Asia/Tokyo", "2027-02-06T00:00:00Z"),
    ("more than 24 hours after greatest eclipse and still to ring: the clocks go back that day, so 23:59 is 24 hours 29 minutes after it; armed",
     rec(AUTUMN["id"], {"kind": "day", "daysBefore": 0, "time": "23:59"}), AUTUMN, "Europe/Oslo", "2033-10-30T22:40:00Z"),
    ("48 hours after greatest eclipse every record is deleted, without working out a time",
     rec(SOLAR["id"], {"kind": "before", "minutes": 15}), SOLAR, "Europe/Oslo", "2027-02-08T16:00:00Z"),
    ("a record whose eclipse is not in the list is deleted",
     rec("2027-02-07-solar", {"kind": "before", "minutes": 15}), None, "Europe/Oslo", "2026-10-16T12:00:00Z"),
    ("a record with a key this version does not know (the old on/off flag) is invalid and deleted",
     {**rec(SOLAR["id"], {"kind": "before", "minutes": 15}), "enabled": True}, SOLAR, "Europe/Oslo", "2026-10-16T12:00:00Z"),
    ("a record with an option this version does not offer is invalid and deleted",
     rec(SOLAR["id"], {"kind": "before", "minutes": 45}), SOLAR, "Europe/Oslo", "2026-10-16T12:00:00Z"),
]


def record_vectors() -> dict:
    cases = []
    for name, record, eclipse, zone, now in RECORD_CASES:
        case = {"name": name, "record": record, "eclipse": eclipse, "zone": zone, "now": now}
        case["want"] = fate(case)
        cases.append(case)
    return {
        "about": ("What a re-plan does with one stored alarm record (spec section 9.4; core/alarms.js recordFate), "
                  "made by tools/vectors/build-vectors.py with Python's zoneinfo as the oracle. stage B's Kotlin port must give the same answer for "
                  "every case. eclipse is the bundled eclipse with the record's eclipseId (null: none); want is {action: arm, fireAt} or "
                  "{action: delete, reason: invalid | unknown-eclipse | expired | passed}. Instants are UTC, YYYY-MM-DDTHH:MM:SSZ."),
        "graceHours": 48,
        "cases": cases,
    }


# ---- Clock-change vectors -------------------------------------------------------------------

def change_instants(zone: str):
    """Every instant the zone's offset changes from FIRST to LAST, with the offsets either side."""
    tz = ZoneInfo(zone)
    t = dt.datetime(FIRST.year, FIRST.month, FIRST.day, tzinfo=UTC)
    end = dt.datetime(LAST.year, LAST.month, LAST.day, 23, 59, tzinfo=UTC)
    step = dt.timedelta(hours=6)
    prev = t.astimezone(tz).utcoffset()
    while t < end:
        n = t + step
        off = n.astimezone(tz).utcoffset()
        if off != prev:
            lo, hi = t, n
            while hi - lo > dt.timedelta(minutes=1):
                mid = lo + (hi - lo) / 2
                mid = mid.replace(second=0, microsecond=0)
                if mid == lo:
                    mid = lo + dt.timedelta(minutes=1)
                if mid.astimezone(tz).utcoffset() == prev:
                    lo = mid
                else:
                    hi = mid
            yield hi, prev, off
            prev = off
        t = n


def dst_vectors() -> dict:
    out = {}
    count = 0
    for zone in ZONES:
        tz = ZoneInfo(zone)
        changes = []
        for at, before, after in change_instants(zone):
            wall = (at + before).replace(tzinfo=None)   # the wall time the change happens at, before it
            g = abs(after - before)
            m = dt.timedelta(minutes=1)
            lo = wall if after > before else wall - g
            hi = lo + g
            times = sorted({lo - m, lo, lo + g / 2, hi - m, hi})
            rows = []
            for w in times:
                fire, how = wall_to_instant(zone, w.date(), w.strftime("%H:%M"))
                rows.append([w.strftime("%Y-%m-%d"), w.strftime("%H:%M"), iso(fire), how])
            changes.append({"at": iso(at), "offsetBefore": int(before.total_seconds() // 60), "offsetAfter": int(after.total_seconds() // 60), "walls": rows})
            count += len(rows)
        out[zone] = changes
    return {
        "about": ("Every clock change from 2026-10-16 to the end of 2100 in these zones, and what a wall time near each change becomes "
                  "(spec 6.2, ALARM-6): a time that does not exist moves forward by the length of the gap ('gap'), a time that happens "
                  "twice takes the first instant ('overlap'). Made by tools/vectors/build-vectors.py from the tz database with Python's "
                  "zoneinfo; core/zoned.js wallTimeToInstant must give the same instant and the same word for every row, and so must "
                  "stage B's java.time port (ZonedDateTime.of then withEarlierOffsetAtOverlap). Each row: [local date, wall time, "
                  "instant UTC, none | gap | overlap]. Africa/Casablanca is left out: tz releases disagree about Morocco's future changes. "
                  "A device whose tz database is older or newer than the one recorded here may differ where a zone's rules changed."),
        "tzdata": tzdata_version(),
        "zones": ZONES,
        "rows": count,
        "changes": out,
    }


def tzdata_version() -> str:
    for p in ("/usr/share/zoneinfo/tzdata.zi",):
        try:
            first = pathlib.Path(p).read_text(encoding="utf-8").splitlines()[0]
            return first.replace("# version", "").strip()
        except OSError:
            pass
    return "unknown"


def dump(doc: dict) -> str:
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":")).replace('"changes":{', '"changes":{\n').replace('],"', '],\n"') + "\n"


def main() -> None:
    files = {
        TESTS / "record-vectors.json": json.dumps(record_vectors(), ensure_ascii=False, indent=1) + "\n",
        TESTS / "dst-vectors.json": dump(dst_vectors()),
    }
    bad = False
    alarm = json.loads((TESTS / "alarm-vectors.json").read_text(encoding="utf-8"))
    for case in alarm["cases"]:
        if plan_case(case) != case["want"]:
            print(f"build-vectors: alarm-vectors.json case {case['name']!r} disagrees with zoneinfo", file=sys.stderr)
            bad = True
    if "--check" in sys.argv:
        for path, want in files.items():
            if not path.is_file() or path.read_text(encoding="utf-8") != want:
                print(f"build-vectors: {path.relative_to(ROOT)} is NOT what this script makes: run tools/vectors/build-vectors.py", file=sys.stderr)
                bad = True
            else:
                print(f"build-vectors: {path.relative_to(ROOT)} matches")
        print(f"build-vectors: alarm-vectors.json, {len(alarm['cases'])} cases, {'DISAGREES' if bad else 'agrees'} with zoneinfo")
        sys.exit(1 if bad else 0)
    if bad:
        sys.exit(1)
    for path, text in files.items():
        path.write_text(text, encoding="utf-8")
        print(f"build-vectors: wrote {path.relative_to(ROOT)} ({len(text.encode())} bytes)")


if __name__ == "__main__":
    main()
