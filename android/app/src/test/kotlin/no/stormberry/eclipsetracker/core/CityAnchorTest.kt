package no.stormberry.eclipsetracker.core

import no.stormberry.eclipsetracker.WebRoot
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId

/**
 * Version 2 alarm records (EclipseTracker 2.1.0): an alarm set while a city is chosen counts from the
 * minute the eclipse starts at the city, in the city's zone, wherever the phone is. Replays
 * tests/city-record-vectors.json, written by tools/vectors/build-vectors.py with Python's zoneinfo as
 * the oracle; the TypeScript (tests/alarms.test.ts) passes the same file, so the page and the app
 * cannot disagree on the instant an alarm rings or on its words.
 */
class CityAnchorTest {
    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()
    private val doc = JSONObject(WebRoot.text("tests/city-record-vectors.json"))
    private val id = "0123456789abcdef0123456789abcdef"

    private fun eclipseOf(o: JSONObject?): Eclipse? = o?.let { Eclipse(it.getString("id"), if (it.getString("id").endsWith("lunar")) "lunar" else "solar", "partial", it.getString("greatest")) }

    private fun fateJson(f: RecordFate): JSONObject = when (f) {
        is RecordFate.Arm -> JSONObject().put("action", "arm").put("fireAt", Json.instant(f.fireAt))
        is RecordFate.Delete -> JSONObject().put("action", "delete").put("reason", f.reason)
    }

    private fun assertFate(where: String, want: JSONObject, got: RecordFate) {
        assertEquals(where, want.toString(), fateJson(got).toString().let { s -> JSONObject(s).toString() })
    }

    @Test fun everyCityCaseRingsWhereZoneinfoSaysWhateverTheZoneOfThePhone() {
        val cases = doc.getJSONArray("cases")
        assertEquals(1600, cases.length())
        assertEquals(6L * 3_600_000L, doc.getInt("maxStartOffsetHours") * 3_600_000L)
        assertEquals(Planner.MAX_START_OFFSET_MS, doc.getInt("maxStartOffsetHours") * 3_600_000L)
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val e = eclipseOf(c.getJSONObject("eclipse"))!!
            val where = "${c.getString("city")} ${e.id} ${c.getJSONObject("spec")}"
            val record = AlarmRecord.parse(c.getJSONObject("record")) ?: error("$where: not a valid record")
            val local = record.local!!
            assertEquals(where, ms(c.getString("start")), local.start)
            assertEquals(where, c.getString("zone"), local.zone.id)
            val phone = ZoneId.of(c.getString("phone"))
            val plan = c.getJSONObject("plan")
            val p = Planner.planAlarmAt(Planner.anchorOf(record, e), record.spec, Planner.zoneOf(record, phone), ms("2026-11-12T00:00:00Z"))
            assertEquals(where, plan.getString("fireAt"), Json.instant(p.fireAt))
            assertEquals(where, plan.getString("localDate"), p.localDate)
            assertEquals(where, plan.getString("localTime"), p.localTime)
            assertEquals(where, plan.getInt("offsetMinutes"), p.offsetMinutes)
            assertEquals(where, plan.getBoolean("afterAnchor"), p.afterGreatest)
            assertEquals(where, plan.getString("dst"), p.dst.wire)
            assertEquals(where, ms(plan.getString("fireAt")), Planner.fireInstantFor(record, e, phone))
            // The phone's zone has no effect on a version 2 record.
            for (other in listOf("Pacific/Kiritimati", "America/Los_Angeles", "Asia/Kolkata")) {
                assertEquals("$where in $other", p.fireAt, Planner.fireInstantFor(record, e, ZoneId.of(other)))
            }
            assertEquals(where, c.getString("words"), Words.alarmWords(record))
            val fates = c.getJSONObject("fates")
            for (moment in listOf("before", "at", "after")) {
                val f = fates.getJSONObject(moment)
                assertFate("$where $moment", f.getJSONObject("want"), Planner.recordFate(c.get("record"), e, phone, ms(f.getString("now"))))
            }
        }
    }

    @Test fun handPickedClockChangeDaysAndRecordsThatMustBeRefused() {
        val hand = doc.getJSONArray("hand")
        assertTrue(hand.length() >= 20)
        var arm = 0
        var invalid = 0
        for (i in 0 until hand.length()) {
            val c = hand.getJSONObject(i)
            val fate = Planner.recordFate(c.get("record"), eclipseOf(c.optJSONObject("eclipse")), ZoneId.of(c.getString("zone")), ms(c.getString("now")))
            assertFate(c.getString("name"), c.getJSONObject("want"), fate)
            if (fate is RecordFate.Arm) arm++
            if (fate == RecordFate.Delete("invalid")) invalid++
        }
        assertTrue("some armed and some refused: $arm, $invalid", arm >= 5 && invalid >= 10)
    }

    /** No Kotlin port of the page's default (the page chooses it): the result is proved, for every vector, by the ring time. */
    @Test fun theDefaultAlarmWithACityRingsAtNoonInTheCityAndNeverAfterTheStart() {
        val defaults = doc.getJSONArray("defaults")
        assertEquals(160, defaults.length())
        var atStart = 0
        for (i in 0 until defaults.length()) {
            val d = defaults.getJSONObject(i)
            val zone = ZoneId.of(d.getString("zone"))
            val start = ms(d.getString("start"))
            val spec = AlarmSpec.parse(d.getJSONObject("want")) as AlarmSpec.Day
            val where = "${d.getString("city")} ${d.getString("start")}"
            // The rule: the day before when the eclipse starts before 12:00 local time, else the day itself.
            val beforeNoon = Instant.ofEpochMilli(start).atZone(zone).toLocalTime() < LocalTime.NOON
            assertEquals(where, if (beforeNoon) 1 else 0, spec.daysBefore)
            assertEquals(where, "12:00", spec.time)
            val (at, _) = Planner.fireInstantAt(start, spec, zone)
            assertEquals(where, d.getString("ringsAt"), Json.instant(at))
            assertEquals(where, "12:00", Instant.ofEpochMilli(at).atZone(zone).toLocalTime().toString())
            assertTrue(where, at <= start)
            assertEquals(where, d.getBoolean("ringsAtStart"), at == start)
            if (at == start) atStart++
        }
        assertEquals("a start at exactly 12:00 is the one case where the default rings at the start", 0, atStart)
    }

    @Test fun aChangeOfTheZoneOfThePhoneMovesAVersion1AlarmAndNotAVersion2Alarm() {
        val e = WebRoot.catalogue["2027-07-18-lunar"]!!
        val v1 = AlarmRecord(id, e.id, AlarmSpec.Day(1, "12:00"))
        val v2 = AlarmRecord(id, e.id, AlarmSpec.Day(1, "12:00"), LocalAnchor(ms("2027-07-18T15:57:00Z"), ZoneId.of("Australia/Sydney"), "Sydney, Australia"))
        val oslo = ZoneId.of("Europe/Oslo")
        val tokyo = ZoneId.of("Asia/Tokyo")
        assertTrue(Planner.fireInstantFor(v1, e, oslo) != Planner.fireInstantFor(v1, e, tokyo))
        assertEquals(Planner.fireInstantFor(v2, e, oslo), Planner.fireInstantFor(v2, e, tokyo))
        assertEquals("2027-07-18T02:00:00Z", Json.instant(Planner.fireInstantFor(v2, e, oslo))) // 12:00 on 18 July in Sydney, UTC+10
        // A version 1 record is planned exactly as in 2.0.1: from greatest eclipse in the phone's zone.
        assertEquals(Planner.fireInstant(e.greatest, v1.spec, oslo).first, Planner.fireInstantFor(v1, e, oslo))
    }

    @Test fun aVersion2RecordAndItsJson() {
        val j = """{"v":2,"id":"$id","eclipseId":"2027-07-18-lunar","spec":{"kind":"day","daysBefore":1,"time":"12:00"},"start":"2027-07-18T15:57:00Z","zone":"Australia/Sydney","place":"Sydney, Australia"}"""
        val r = AlarmRecord.parse(JSONObject(j))!!
        assertEquals(AlarmRecord(id, "2027-07-18-lunar", AlarmSpec.Day(1, "12:00"), LocalAnchor(ms("2027-07-18T15:57:00Z"), ZoneId.of("Australia/Sydney"), "Sydney, Australia")), r)
        assertEquals(r, AlarmRecord.parse(r.toJson()))
        assertEquals(setOf("v", "id", "eclipseId", "spec", "start", "zone", "place"), r.toJson().keys().asSequence().toSet())
        assertEquals(2, r.toJson().getInt("v"))
        assertEquals("2027-07-18T15:57:00Z", r.toJson().getString("start"))
        // JavaScript reads 2.0 as 2.
        assertNotNull(AlarmRecord.parse(JSONObject(j.replace("\"v\":2", "\"v\":2.0"))))
        // A version 1 record has four keys and no local anchor, as 2.0.1 wrote it.
        val v1 = AlarmRecord(id, "2027-07-18-lunar", AlarmSpec.Day(1, "12:00"))
        assertEquals(setOf("v", "id", "eclipseId", "spec"), v1.toJson().keys().asSequence().toSet())
        assertNull(v1.local)
        assertEquals(v1, AlarmRecord.parse(v1.toJson()))
    }

    @Test fun everyWayAVersion2RecordIsRefused() {
        val base = JSONObject("""{"v":2,"id":"$id","eclipseId":"2027-07-18-lunar","spec":{"kind":"day","daysBefore":1,"time":"12:00"},"start":"2027-07-18T15:57:00Z","zone":"Australia/Sydney","place":"Sydney, Australia"}""")
        fun with(key: String, value: Any?): JSONObject = JSONObject(base.toString()).put(key, value ?: JSONObject.NULL)
        fun without(key: String): JSONObject = JSONObject(base.toString()).apply { remove(key) }
        val bad = linkedMapOf<String, JSONObject>(
            "no start" to without("start"), "no zone" to without("zone"), "no place" to without("place"),
            "eight keys" to with("extra", 1),
            "version 3" to with("v", 3), "version \"2\"" to with("v", "2"), "version 1 with the version 2 keys" to with("v", 1),
            "version 2 with four keys" to JSONObject("""{"v":2,"id":"$id","eclipseId":"2027-07-18-lunar","spec":{"kind":"day","daysBefore":1,"time":"12:00"}}"""),
            "start with seconds" to with("start", "2027-07-18T15:57:30Z"),
            "start with milliseconds" to with("start", "2027-07-18T15:57:00.000Z"),
            "start as a number" to with("start", 1_800_000_000_000L),
            "start 24:00" to with("start", "2027-07-18T24:00:00Z"),
            "start on 30 February" to with("start", "2027-02-30T15:57:00Z"),
            "start with an offset" to with("start", "2027-07-18T15:57:00+00:00"),
            "a fixed offset as the zone" to with("zone", "+10:00"),
            "Z as the zone" to with("zone", "Z"),
            "a prefix form as the zone" to with("zone", "UTC+3"),
            "GMT+1 as the zone" to with("zone", "GMT+1"),
            "an unknown zone" to with("zone", "Mars/Olympus"),
            "a lower-case zone" to with("zone", "australia/sydney"),
            "a zone with a space" to with("zone", "Australia/Sydney "),
            "a zone that is not text" to with("zone", 10),
            "an empty place" to with("place", ""),
            "a place of 201 characters" to with("place", "x".repeat(201)),
            "a place with U+0000" to with("place", "Syd\u0000ney"),
            "a place with U+001F" to with("place", "Syd\u001fney"),
            "a place with U+007F" to with("place", "Syd\u007fney"),
            "a place with U+009F" to with("place", "Syd\u009fney"),
            "a place that is not text" to with("place", 5),
            "a bad spec" to with("spec", JSONObject("""{"kind":"before","minutes":45}""")),
            "a bad id" to with("id", "x"),
            "a bad eclipse id" to with("eclipseId", "2027-07-18"),
        )
        for ((what, r) in bad) assertNull(what, AlarmRecord.parse(r))
        // The edges that are allowed.
        assertNotNull(AlarmRecord.parse(with("place", "x".repeat(200))))
        assertNotNull(AlarmRecord.parse(with("place", "x".repeat(198) + "🌍")))
        assertNull(AlarmRecord.parse(with("place", "x".repeat(199) + "🌍")))
        for (z in listOf("UTC", "Etc/GMT-10", "America/Argentina/Ushuaia", "America/Port-au-Prince")) assertNotNull(z, AlarmRecord.parse(with("zone", z)))
        // Sets: version 1 and version 2 side by side, an id twice across versions refused.
        val v1 = """{"v":1,"id":"${"b".repeat(32)}","eclipseId":"2027-07-18-lunar","spec":{"kind":"before","minutes":30}}"""
        assertEquals(2, AlarmRecord.parseSet(JSONArray("[${base},$v1]"))!!.size)
        assertNull(AlarmRecord.parseSet(JSONArray("[${base},${v1.replace("b".repeat(32), id)}]")))
        assertFalse(AlarmRecord.isPlace(""))
    }

    @Test fun everyZoneOfTheCityCatalogueIsAZoneOnThisJvmToo() {
        // cities.js packs the countries on the first line of one string and the zones on the second, tab separated
        // (tools/check-city-catalogue.py reads it the same way); \n and \t are the two-character escapes in the file.
        val js = WebRoot.text("cities.js")
        val start = js.indexOf("var D = \"") + "var D = \"".length
        val packed = js.substring(start, js.indexOf('"', start))
        val zones = packed.split("\\n")[1].split("\\t").toSet()
        assertEquals(349, zones.size)
        for (z in zones) assertNotNull(z, AlarmRecord.regionZone(z))
    }

    @Test fun theWordsNameTheCityForAVersion2Record() {
        val place = "Sydney, Australia"
        assertEquals("1 day before at 12:00 in $place", Words.alarmWords(AlarmSpec.Day(1, "12:00"), place))
        assertEquals("On the day of the eclipse at 12:00 in $place", Words.alarmWords(AlarmSpec.Day(0, "12:00"), place))
        assertEquals("1 week before at 08:30 in $place", Words.alarmWords(AlarmSpec.Day(7, "08:30"), place))
        assertEquals("30 minutes before the eclipse starts in $place", Words.alarmWords(AlarmSpec.Before(30), place))
        assertEquals("1 hour before the eclipse starts in $place", Words.alarmWords(AlarmSpec.Before(60), place))
        assertEquals("2 hours before the eclipse starts in $place", Words.alarmWords(AlarmSpec.Before(120), place))
        // Version 1 words are unchanged.
        assertEquals("30 minutes before greatest eclipse", Words.alarmWords(AlarmSpec.Before(30)))
        assertEquals("On the day of the eclipse at 12:00", Words.alarmWords(AlarmSpec.Day(0, "12:00")))
        // The same sentences as ts/core/format.ts alarmWords.
        val format = WebRoot.text("ts/core/format.ts")
        for (w in listOf("before the eclipse starts in", " in \${place}")) assertTrue(w, format.contains(w))
        // The longest text a record can give is 240 characters, which the snooze keeps.
        val longest = Words.alarmWords(AlarmSpec.Before(30), "x".repeat(200))
        assertEquals(240, longest.length)
        assertTrue(longest.length <= no.stormberry.eclipsetracker.alarm.Snooze.MAX_WORDS)
    }
}
