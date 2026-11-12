#!/usr/bin/env python3
"""The test vectors stage B's Kotlin port must pass, checked against an independent oracle.

    python3 -I tools/vectors/build-vectors.py           write tests/record-vectors.json,
                                                        tests/dst-vectors.json,
                                                        tests/city-record-vectors.json and
                                                        tests/stored-city-vectors.json
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

  * tests/city-record-vectors.json (EclipseTracker 2.1.0, 12 November 2026): the version 2 alarm
    record, an alarm set while a city is chosen, which counts from the minute the eclipse starts at
    the city in the city's zone, wherever the phone is. For 16 cities (tests/local-vectors.json), the
    first 10 eclipses seen from each after 2026-11-12 and 9 alarm options (plus an edge wall time
    per eclipse and hand-picked clock-change days): the instant it rings, what a re-plan does at
    three moments, the words, and the default alarm the planner offers. Also the validity of
    version 2 records. The TypeScript (tests/alarms.test.ts) and the Kotlin
    (core/CityAnchorTest) replay the same file.
  * tests/stored-city-vectors.json (same date): which texts are a kept city (the page's
    parseStoredCity with anyZone, and the app's KeptCity); the independent check here is
    stored_city_valid().

Instants are written YYYY-MM-DDTHH:MM:SSZ everywhere (code review C-23). Standard library only;
adapted from the data reviewer's gen_inputs.py and harness.mjs (review-data/, 2026-10-16).
"""

import datetime as dt
import json
import pathlib
import re
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


# ---- City record vectors (version 2 records, EclipseTracker 2.1.0) ----------------------------

MAX_START_OFFSET = dt.timedelta(hours=6)   # core MAX_START_OFFSET_MS
BEFORE_WORDS = {15: "15 minutes", 30: "30 minutes", 60: "1 hour", 120: "2 hours"}
DAY_WORDS = {0: "On the day of the eclipse", 1: "1 day before", 2: "2 days before", 3: "3 days before", 7: "1 week before"}
PHONE_ZONES = ["Europe/Oslo", "Asia/Tokyo", "America/New_York", "Pacific/Kiritimati", "Australia/Sydney", "UTC"]


def plan_at(anchor: dt.datetime, spec: dict, zone: str, now: dt.datetime) -> dict:
    """plan() counting from an anchor minute (the start at a city) instead of greatest eclipse."""
    tz = ZoneInfo(zone)
    if spec["kind"] == "before":
        fire, how = anchor - dt.timedelta(minutes=spec["minutes"]), "none"
    else:
        day = anchor.astimezone(tz).date() - dt.timedelta(days=spec["daysBefore"])
        fire, how = wall_to_instant(zone, day, spec["time"])
    local = fire.astimezone(tz)
    return {
        "fireAt": iso(fire), "localDate": local.strftime("%Y-%m-%d"), "localTime": local.strftime("%H:%M"),
        "offsetMinutes": int(local.utcoffset().total_seconds() // 60), "status": "ok" if fire > now else "past",
        "afterAnchor": fire > anchor, "dst": how,
    }


def alarm_words(spec: dict, place) -> str:
    if spec["kind"] == "before":
        return f"{BEFORE_WORDS[spec['minutes']]} before greatest eclipse" if place is None else f"{BEFORE_WORDS[spec['minutes']]} before the eclipse starts in {place}"
    words = f"{DAY_WORDS[spec['daysBefore']]} at {spec['time']}"
    return words if place is None else f"{words} in {place}"


def default_spec_at(anchor: dt.datetime, zone: str) -> dict:
    """The alarm a new planner starts with at a city (Marcos, 2026-11-11): noon the day before when the eclipse starts before 12:00 there."""
    local = anchor.astimezone(ZoneInfo(zone))
    before_noon = (local.hour, local.minute) < (12, 0)
    return {"kind": "day", "daysBefore": 1 if before_noon else 0, "time": "12:00"}


def utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


BAD_CONTROL = re.compile("[\u0000-\u001f\u007f-\u009f]")


def valid_place(p) -> bool:
    return isinstance(p, str) and 1 <= utf16_len(p) <= 200 and BAD_CONTROL.search(p) is None


def valid_zone_name(z) -> bool:
    """An IANA region name, never a fixed offset: capitals at the start of each segment, and a zone the tz database knows."""
    if not isinstance(z, str) or len(z) > 200 or re.fullmatch(r"[A-Z][A-Za-z0-9_+-]*(/[A-Z][A-Za-z0-9_+-]*)*", z) is None:
        return False
    try:
        ZoneInfo(z)
        return True
    except Exception:
        return False


def valid_start(s) -> bool:
    if not isinstance(s, str) or re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z", s) is None:
        return False
    try:
        parse(s)
        return True
    except ValueError:
        return False


def valid_record_any(r) -> bool:
    """valid_record() for version 1; version 2 has exactly v, id, eclipseId, spec, start, zone, place."""
    if isinstance(r, dict) and r.get("v") == 2 and not isinstance(r.get("v"), bool):
        if sorted(r) != ["eclipseId", "id", "place", "spec", "start", "v", "zone"]:
            return False
        v1 = {"v": 1, "id": r["id"], "eclipseId": r["eclipseId"], "spec": r["spec"]}
        return valid_record(v1) and valid_start(r["start"]) and valid_zone_name(r["zone"]) and valid_place(r["place"])
    return valid_record(r)


def fate_any(case: dict) -> dict:
    r, e, zone, now = case["record"], case["eclipse"], case["zone"], parse(case["now"])
    if not valid_record_any(r):
        return {"action": "delete", "reason": "invalid"}
    if e is None or e["id"] != r["eclipseId"]:
        return {"action": "delete", "reason": "unknown-eclipse"}
    g = round_minute(parse(e["greatest"]))
    if now >= g + GRACE:
        return {"action": "delete", "reason": "expired"}
    if r["v"] == 2:
        if abs(parse(r["start"]) - g) > MAX_START_OFFSET:
            return {"action": "delete", "reason": "invalid"}
        p = plan_at(parse(r["start"]), r["spec"], r["zone"], now)
    else:
        p = plan(e["greatest"], r["spec"], zone, now)
    return {"action": "arm", "fireAt": p["fireAt"]} if parse(p["fireAt"]) > now else {"action": "delete", "reason": "passed"}


def v2(eclipse_id: str, spec: dict, start: str, zone: str, place: str, rid: str = ID) -> dict:
    return {"v": 2, "id": rid, "eclipseId": eclipse_id, "spec": spec, "start": start, "zone": zone, "place": place}


# Hand-picked version 2 cases: clock-change days in the city's zone, phone elsewhere.
# Not real eclipses: dates chosen so the city's local day is a day the clocks change.
SYDNEY_FALL = {"id": "2028-04-02-solar", "greatest": "2028-04-02T03:00:00Z"}       # the clocks go back in Sydney on Sunday 2 April 2028 at 03:00 (to 02:00)
BERGEN_FALL = {"id": "2033-10-29-lunar", "greatest": "2033-10-29T22:30:00Z"}       # AUTUMN above, as seen from Bergen: 00:30 on Sunday 30 October, the day the clocks go back


def hand_cases() -> list[dict]:
    out = []

    def add(name, eclipse, record, phone, now):
        c = {"name": name, "record": record, "eclipse": eclipse, "zone": phone, "now": now}
        c["want"] = fate_any(c)
        out.append(c)

    # Sydney sees the start at 2028-04-01 10:00 UTC = 21:00 AEDT; the clocks go back at 03:00 on Sunday 2 April 2028 (to 02:00).
    add("Sydney: on the day at 02:30 on the night the clocks go back (02:30 happens twice, the first is used); the phone is in Oslo",
        SYDNEY_FALL, v2(SYDNEY_FALL["id"], {"kind": "day", "daysBefore": 0, "time": "02:30"}, "2028-04-02T01:30:00Z", "Australia/Sydney", "Sydney, Australia"), "Europe/Oslo", "2028-03-30T00:00:00Z")
    add("Sydney: the same record while the phone is in Tokyo gives the same instant",
        SYDNEY_FALL, v2(SYDNEY_FALL["id"], {"kind": "day", "daysBefore": 0, "time": "02:30"}, "2028-04-02T01:30:00Z", "Australia/Sydney", "Sydney, Australia"), "Asia/Tokyo", "2028-03-30T00:00:00Z")
    add("Bergen: on the day at 02:30 on the night the clocks go back (the last Sunday of October; the start is 00:15 that Sunday); the phone is in New York",
        BERGEN_FALL, v2(BERGEN_FALL["id"], {"kind": "day", "daysBefore": 0, "time": "02:30"}, "2033-10-29T22:15:00Z", "Europe/Oslo", "Bergen, Norway"), "America/New_York", "2033-10-28T00:00:00Z")
    add("Bergen: 1 day before at 02:30 is the Saturday before the clocks go back, an ordinary time",
        BERGEN_FALL, v2(BERGEN_FALL["id"], {"kind": "day", "daysBefore": 1, "time": "02:30"}, "2033-10-29T22:15:00Z", "Europe/Oslo", "Bergen, Norway"), "Europe/Oslo", "2033-10-27T00:00:00Z")
    add("Sydney: a spring day, 02:30 does not exist when the clocks go forward on the first Sunday of October 2027 (02:00 to 03:00 AEST to AEDT), so it rings at 03:30",
        {"id": "2027-10-03-solar", "greatest": "2027-10-03T05:00:00Z"}, v2("2027-10-03-solar", {"kind": "day", "daysBefore": 0, "time": "02:30"}, "2027-10-03T04:00:00Z", "Australia/Sydney", "Sydney, Australia"), "Europe/Oslo", "2027-10-01T00:00:00Z")
    add("a start 6 hours after greatest eclipse is the farthest a record may be: armed",
        SOLAR, v2(SOLAR["id"], {"kind": "before", "minutes": 30}, "2027-02-06T22:00:00Z", "Europe/Oslo", "Bergen, Norway"), "Europe/Oslo", "2027-02-01T00:00:00Z")
    add("a start 6 hours and 1 minute from greatest eclipse cannot come from the page: invalid",
        SOLAR, v2(SOLAR["id"], {"kind": "before", "minutes": 30}, "2027-02-06T22:01:00Z", "Europe/Oslo", "Bergen, Norway"), "Europe/Oslo", "2027-02-01T00:00:00Z")
    add("a start 6 hours and 1 minute before greatest eclipse: invalid",
        SOLAR, v2(SOLAR["id"], {"kind": "before", "minutes": 30}, "2027-02-06T09:58:00Z", "Europe/Oslo", "Bergen, Norway"), "Europe/Oslo", "2027-02-01T00:00:00Z")
    add("a start with seconds is invalid",
        SOLAR, v2(SOLAR["id"], {"kind": "before", "minutes": 30}, "2027-02-06T15:00:30Z", "Europe/Oslo", "Bergen, Norway"), "Europe/Oslo", "2027-02-01T00:00:00Z")
    add("a start of 24:00 is not an instant: invalid",
        SOLAR, v2(SOLAR["id"], {"kind": "before", "minutes": 30}, "2027-02-06T24:00:00Z", "Europe/Oslo", "Bergen, Norway"), "Europe/Oslo", "2027-02-01T00:00:00Z")
    add("a fixed offset is not a zone: invalid",
        SOLAR, v2(SOLAR["id"], {"kind": "before", "minutes": 30}, "2027-02-06T15:00:00Z", "+01:00", "Bergen, Norway"), "Europe/Oslo", "2027-02-01T00:00:00Z")
    add("an unknown zone is invalid",
        SOLAR, v2(SOLAR["id"], {"kind": "before", "minutes": 30}, "2027-02-06T15:00:00Z", "Mars/Olympus", "Bergen, Norway"), "Europe/Oslo", "2027-02-01T00:00:00Z")
    add("an empty place is invalid",
        SOLAR, v2(SOLAR["id"], {"kind": "before", "minutes": 30}, "2027-02-06T15:00:00Z", "Europe/Oslo", ""), "Europe/Oslo", "2027-02-01T00:00:00Z")
    add("a version 2 record with a version 1 key set (no start) is invalid",
        SOLAR, {"v": 2, "id": ID, "eclipseId": SOLAR["id"], "spec": {"kind": "before", "minutes": 30}}, "Europe/Oslo", "2027-02-01T00:00:00Z")
    add("a version 1 record with the version 2 keys is invalid",
        SOLAR, {**v2(SOLAR["id"], {"kind": "before", "minutes": 30}, "2027-02-06T15:00:00Z", "Europe/Oslo", "Bergen, Norway"), "v": 1}, "Europe/Oslo", "2027-02-01T00:00:00Z")
    add("version 3 is invalid",
        SOLAR, {**v2(SOLAR["id"], {"kind": "before", "minutes": 30}, "2027-02-06T15:00:00Z", "Europe/Oslo", "Bergen, Norway"), "v": 3}, "Europe/Oslo", "2027-02-01T00:00:00Z")
    add("a place with a line break is invalid",
        SOLAR, v2(SOLAR["id"], {"kind": "before", "minutes": 30}, "2027-02-06T15:00:00Z", "Europe/Oslo", "Ber\ngen"), "Europe/Oslo", "2027-02-01T00:00:00Z")
    add("a place of 200 characters is valid",
        SOLAR, v2(SOLAR["id"], {"kind": "before", "minutes": 30}, "2027-02-06T15:00:00Z", "Europe/Oslo", "x" * 200), "Europe/Oslo", "2027-02-01T00:00:00Z")
    add("a place of 201 characters is invalid",
        SOLAR, v2(SOLAR["id"], {"kind": "before", "minutes": 30}, "2027-02-06T15:00:00Z", "Europe/Oslo", "x" * 201), "Europe/Oslo", "2027-02-01T00:00:00Z")
    add("a place with a character outside the basic plane counts two (an emoji is 2 of the 200)",
        SOLAR, v2(SOLAR["id"], {"kind": "before", "minutes": 30}, "2027-02-06T15:00:00Z", "Europe/Oslo", "x" * 199 + "\U0001F30D"), "Europe/Oslo", "2027-02-01T00:00:00Z")
    add("UTC is a region name and is valid",
        SOLAR, v2(SOLAR["id"], {"kind": "before", "minutes": 30}, "2027-02-06T15:00:00Z", "UTC", "Greenwich, United Kingdom"), "Europe/Oslo", "2027-02-01T00:00:00Z")
    add("a lower-case zone name is invalid (java.time reads names exactly)",
        SOLAR, v2(SOLAR["id"], {"kind": "before", "minutes": 30}, "2027-02-06T15:00:00Z", "europe/oslo", "Bergen, Norway"), "Europe/Oslo", "2027-02-01T00:00:00Z")
    add("48 hours after greatest eclipse a version 2 record is expired, whatever its start",
        SOLAR, v2(SOLAR["id"], {"kind": "before", "minutes": 15}, "2027-02-06T16:30:00Z", "Europe/Oslo", "Bergen, Norway"), "Europe/Oslo", "2027-02-08T16:00:00Z")
    return out


def city_vectors() -> dict:
    local = json.loads((TESTS / "local-vectors.json").read_text(encoding="utf-8"))
    eclipses = {e["id"]: e for e in json.loads((ROOT / "data" / "eclipses.json").read_text(encoding="utf-8"))["eclipses"]}
    now0 = parse("2026-11-12T00:00:00Z")
    after = "2026-11-12T00:00:00Z"
    specs = ([{"kind": "day", "daysBefore": d, "time": "12:00"} for d in (0, 1, 2, 3, 7)]
             + [{"kind": "before", "minutes": m} for m in (15, 30, 60, 120)])
    edge_times = ["00:00", "23:59", "02:30", "03:30", "00:30", "01:59"]
    cases, defaults, k, widest = [], [], 0, dt.timedelta(0)
    for city in local["cities"]:
        place = f"{city['name']}, {city['country']}"
        seen = [s for s in city["seen"] if s["start"] > after][:10]
        assert len(seen) == 10, city["name"]
        for j, s in enumerate(seen):
            e = eclipses[s["id"]]
            start = round_minute(parse(s["start"]))
            widest = max(widest, abs(start - round_minute(parse(e["greatest"]))))
            day = [{"kind": "day", "daysBefore": d, "time": edge_times[(k + j) % len(edge_times)]} for d in (((k + j) % 2) * 2 + 1,)]
            for spec in specs + day:
                phone = PHONE_ZONES[k % len(PHONE_ZONES)]
                k += 1
                record = v2(e["id"], spec, iso(start), city["tz"], place)
                p = plan_at(start, spec, city["tz"], now0)
                case = {
                    "city": place, "phone": phone, "eclipse": {"id": e["id"], "greatest": e["greatest"]}, "start": iso(start), "zone": city["tz"],
                    "spec": spec, "record": record,
                    "plan": {kk: p[kk] for kk in ("fireAt", "localDate", "localTime", "offsetMinutes", "afterAnchor", "dst")},
                    "words": alarm_words(spec, place),
                }
                fire = parse(p["fireAt"])
                moments = {"before": fire - dt.timedelta(hours=1), "at": fire, "after": fire + dt.timedelta(hours=1)}
                case["fates"] = {}
                for name, t in moments.items():
                    c = {"record": record, "eclipse": case["eclipse"], "zone": phone, "now": iso(t)}
                    case["fates"][name] = {"now": iso(t), "want": fate_any(c)}
                cases.append(case)
            d = default_spec_at(start, city["tz"])
            ring = plan_at(start, d, city["tz"], now0)
            assert ring["localTime"] == "12:00" and parse(ring["fireAt"]) <= start, (city["name"], s["id"])
            defaults.append({"city": place, "zone": city["tz"], "start": iso(start), "want": d, "ringsAt": ring["fireAt"], "ringsAtStart": parse(ring["fireAt"]) == start})
    assert widest <= dt.timedelta(hours=3, minutes=7), widest   # measured: 3.1 hours
    return {
        "about": ("Version 2 alarm records (EclipseTracker 2.1.0): an alarm set while a city is chosen counts from the minute the eclipse starts "
                  "at the city, in the city's zone, wherever the phone is. Made by tools/vectors/build-vectors.py with Python's zoneinfo as the "
                  "oracle. cases: for 16 cities, the first 10 eclipses seen after 2026-11-12 and 9 alarm options plus one edge wall time each. "
                  "plan is when it rings (the same for every phone zone) and fates is what a re-plan does one hour before, at, and one hour after "
                  "that instant, with the phone in the zone given. hand: clock-change days and records that must be refused. defaults: the alarm a "
                  "new planner starts with, and the instant it rings. widestStartOffsetMinutes is the largest distance of a start from greatest "
                  "eclipse in these cases. Instants are UTC, YYYY-MM-DDTHH:MM:SSZ."),
        "maxStartOffsetHours": 6,
        "widestStartOffsetMinutes": int(widest.total_seconds() // 60),
        "cases": cases,
        "hand": hand_cases(),
        "defaults": defaults,
    }


# ---- Stored city vectors (the kept city text) -----------------------------------------------

GOOD_CITY = {"v": 1, "name": "Bergen", "country": "Norway", "lat": 60.393, "lon": 5.3242, "tz": "Europe/Oslo"}


def stored_city_valid(text) -> bool:
    """The independent check: the page's parseStoredCity with anyZone, as the app's KeptCity reads it."""
    if not isinstance(text, str):
        return False
    try:
        o = json.loads(text, parse_constant=lambda c: (_ for _ in ()).throw(ValueError(c)))
    except ValueError:
        return False
    if not isinstance(o, dict) or sorted(o) != sorted(GOOD_CITY):
        return False

    def number(x, limit):
        return isinstance(x, (int, float)) and not isinstance(x, bool) and abs(x) <= limit and x == x

    return (o["v"] == 1 and not isinstance(o["v"], bool)
            and valid_place(o["name"]) and valid_place(o["country"]) and number(o["lat"], 90) and number(o["lon"], 180)
            and isinstance(o["tz"], str) and 1 <= utf16_len(o["tz"]) <= 200)


def stored_city_vectors() -> dict:
    def j(**kw) -> str:
        return json.dumps({**GOOD_CITY, **kw}, ensure_ascii=False, separators=(",", ":"))

    def without(key) -> str:
        return json.dumps({k: v for k, v in GOOD_CITY.items() if k != key}, separators=(",", ":"))

    cases = [
        ("the text the page writes", j(), True),
        ("an unusual zone name is kept as text; the page checks it with the WebView's zone list", j(tz="Mars/Olympus"), True),
        ("the edges: latitude -90, longitude 180, a name of 200 characters", j(lat=-90, lon=180, name="x" * 200), True),
        ("whole numbers for latitude and longitude", j(lat=60, lon=5), True),
        ("a number written 60.0 is read as 60", '{"v":1,"name":"Bergen","country":"Norway","lat":60.0,"lon":5.0,"tz":"Europe/Oslo"}', True),
        ("version 1 written as 1.0 is version 1", '{"v":1.0,"name":"Bergen","country":"Norway","lat":60.393,"lon":5.3242,"tz":"Europe/Oslo"}', True),
        ("a name with an accent and a name with a character outside the basic plane", j(name="Tromsø \U0001F30D"), True),
        ("an escaped quote in the name", j(name='Say "hi"'), True),
        ("a zone name of 200 characters", j(tz="Z" * 200), True),
        ("an extra key", j(extra=1), False),
        ("a missing key", without("tz"), False),
        ("no version", json.dumps({k: v for k, v in GOOD_CITY.items() if k != "v"}, separators=(",", ":")), False),
        ("version 2", j(v=2), False),
        ("version as text", j(v="1"), False),
        ("version true", j(v=True), False),
        ("not JSON", '{"name":', False),
        ("an array", "[]", False),
        ("a string", '"Bergen"', False),
        ("null text", "null", False),
        ("a number", "1", False),
        ("an empty text", "", False),
        ("latitude 91", j(lat=91), False),
        ("latitude -90.5", j(lat=-90.5), False),
        ("longitude 180.1", j(lon=180.1), False),
        ("longitude -181", j(lon=-181), False),
        ("longitude as text", j(lon="5.3"), False),
        ("latitude null", j(lat=None), False),
        ("latitude true", j(lat=True), False),
        ("longitude 1e999 (not finite)", '{"v":1,"name":"Bergen","country":"Norway","lat":60.393,"lon":1e999,"tz":"Europe/Oslo"}', False),
        ("zone not text", j(tz=1), False),
        ("an empty zone", j(tz=""), False),
        ("a zone of 201 characters", j(tz="Z" * 201), False),
        ("a name of 201 characters", j(name="x" * 201), False),
        ("an empty name", j(name=""), False),
        ("an empty country", j(country=""), False),
        ("name not text", j(name=5), False),
        ("a line break in the name", j(name="Ber\ngen"), False),
        ("a tab in the country", j(country="Nor\tway"), False),
        ("a NUL in the name", j(name="Ber\u0000gen"), False),
        ("a DEL in the country", j(country="Nor\u007fway"), False),
        ("a C1 control in the name", j(name="Ber\u0085gen"), False),
        ("a control character in the zone is only text here (the page then finds no such zone and cannot use the city)", j(tz="Europe/\u0001Oslo"), True),
        ("an unpaired surrogate escape is still text of one unit", '{"v":1,"name":"B\\ud800","country":"Norway","lat":1,"lon":1,"tz":"Europe/Oslo"}', True),
    ]
    out = []
    for name, text, valid in cases:
        assert stored_city_valid(text) == valid, name
        out.append({"name": name, "text": text, "valid": valid})
    return {
        "about": ("Which texts are a kept city (EclipseTracker 2.1.0). The page's parseStoredCity(text, { anyZone: true }) and the app's KeptCity "
                  "must both give valid for every case; tools/vectors/build-vectors.py checks the list against its own reading. The zone is only "
                  "checked as text of 1 to 200 characters: the page checks it with the WebView's own zone list. The app also refuses a text over "
                  "1,024 characters (KeptCityTest), which the page's rule does not."),
        "cases": out,
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
        TESTS / "city-record-vectors.json": json.dumps(city_vectors(), ensure_ascii=False, separators=(",", ":")).replace('"hand":', '\n"hand":').replace('"defaults":', '\n"defaults":').replace('{"city":', '\n{"city":') + "\n",
        TESTS / "stored-city-vectors.json": json.dumps(stored_city_vectors(), ensure_ascii=False, indent=1) + "\n",
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
