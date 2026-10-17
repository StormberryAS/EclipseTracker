package no.stormberry.eclipsetracker.core

import no.stormberry.eclipsetracker.WebRoot
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/**
 * The Kotlin port against the web app's own vector files (spec 9.4, 9.5): the planner against
 * tests/alarm-vectors.json, recordFate against tests/record-vectors.json, and the wall-time rule
 * against every row of tests/dst-vectors.json. The TypeScript passes the same files.
 */
class PlannerVectorsTest {
    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    @Test fun everyAlarmVector() {
        val cases = JSONObject(WebRoot.text("tests/alarm-vectors.json")).getJSONArray("cases")
        assertEquals(22, cases.length())
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val name = c.getString("name")
            val specsJson = c.getJSONArray("specs")
            val specs = List(specsJson.length()) { AlarmSpec.parse(specsJson.get(it)) ?: error("$name: spec $it is not valid") }
            val got = Planner.planAlarms(c.getString("greatest"), specs, ZoneId.of(c.getString("zone")), ms(c.getString("now")))
            val want = c.getJSONArray("want")
            assertEquals(name, want.length(), got.size)
            for (k in got.indices) {
                val w = want.getJSONObject(k)
                val g = got[k]
                assertEquals("$name #$k fireAt", w.getString("fireAt"), Json.instant(g.fireAt))
                assertEquals("$name #$k localDate", w.getString("localDate"), g.localDate)
                assertEquals("$name #$k localTime", w.getString("localTime"), g.localTime)
                assertEquals("$name #$k offset", w.getInt("offsetMinutes"), g.offsetMinutes)
                assertEquals("$name #$k status", w.getString("status"), g.status)
                assertEquals("$name #$k afterGreatest", w.getBoolean("afterGreatest"), g.afterGreatest)
                assertEquals("$name #$k dst", w.getString("dst"), g.dst.wire)
            }
        }
    }

    @Test fun everyRecordVector() {
        val cases = JSONObject(WebRoot.text("tests/record-vectors.json")).getJSONArray("cases")
        assertEquals(11, cases.length())
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val name = c.getString("name")
            val e = c.optJSONObject("eclipse")?.let { Eclipse(it.getString("id"), "solar", "total", it.getString("greatest")) }
            val fate = Planner.recordFate(c.get("record"), e, ZoneId.of(c.getString("zone")), ms(c.getString("now")))
            val want = c.getJSONObject("want")
            when (want.getString("action")) {
                "arm" -> assertEquals(name, RecordFate.Arm(ms(want.getString("fireAt"))), fate)
                "delete" -> assertEquals(name, RecordFate.Delete(want.getString("reason")), fate)
                else -> error("unknown action in $name")
            }
        }
    }

    @Test fun everyClockChangeRowInNineZones() {
        val doc = JSONObject(WebRoot.text("tests/dst-vectors.json"))
        val changes = doc.getJSONObject("changes")
        var rows = 0
        for (zoneName in changes.keys()) {
            val zone = ZoneId.of(zoneName)
            val list = changes.getJSONArray(zoneName)
            for (i in 0 until list.length()) {
                val walls = list.getJSONObject(i).getJSONArray("walls")
                for (k in 0 until walls.length()) {
                    val row = walls.getJSONArray(k)
                    val (at, dst) = Planner.wallTimeToInstant(zone, LocalDate.parse(row.getString(0)), LocalTime.parse(row.getString(1)))
                    val where = "$zoneName ${row.getString(0)} ${row.getString(1)}"
                    assertEquals(where, row.getString(2), Json.instant(at))
                    assertEquals(where, row.getString(3), dst.wire)
                    rows++
                }
            }
        }
        assertEquals(doc.getInt("rows"), rows)
        assertEquals(6685, rows)
    }

    @Test fun greatestEclipseRoundsHalfAMinuteUp() {
        assertEquals(ms("2039-06-21T17:12:00Z"), Planner.greatestMinute("2039-06-21T17:11:30Z"))
        assertEquals(ms("2039-06-21T17:11:00Z"), Planner.greatestMinute("2039-06-21T17:11:29Z"))
        assertEquals(ms("2027-02-06T16:00:00Z"), Planner.greatestMinute("2027-02-06T15:59:32Z"))
        // Before the epoch too: floorDiv, never Math.round on a double (code review C-7).
        assertEquals(ms("1969-12-31T23:59:00Z"), Planner.greatestMinute("1969-12-31T23:58:30Z"))
    }

    /** Every option on every eclipse in five zones: a time, and the before-options independent of the zone. */
    @Test fun everyEclipseEveryOptionFiveZones() {
        val zones = listOf("Europe/Oslo", "America/New_York", "Australia/Sydney", "Asia/Kolkata", "Pacific/Kiritimati").map { ZoneId.of(it) }
        val specs = AlarmSpec.DAYS_BEFORE.map { AlarmSpec.Day(it, "12:00") } + AlarmSpec.MINUTES_BEFORE.map { AlarmSpec.Before(it) }
        var n = 0
        val list = JSONObject(WebRoot.text("data/eclipses.json")).getJSONArray("eclipses")
        for (i in 0 until list.length()) {
            val greatest = list.getJSONObject(i).getString("greatest")
            val g = Planner.greatestMinute(greatest)
            for (zone in zones) {
                for (spec in specs) {
                    val p = Planner.planAlarm(greatest, spec, zone, 0L)
                    if (spec is AlarmSpec.Before) assertEquals(g - spec.minutes * 60_000L, p.fireAt)
                    else assertEquals("12:00", p.localTime)
                    n++
                }
            }
        }
        assertTrue(n == 337 * 5 * 9)
    }
}
