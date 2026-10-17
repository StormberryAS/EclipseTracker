package no.stormberry.eclipsetracker.core

import no.stormberry.eclipsetracker.WebRoot
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** The record checks (isValidRecord, isValidRecordSet; spec 9.4) and the bundled list. */
class AlarmRecordTest {
    private val id = "0123456789abcdef0123456789abcdef"
    private fun rec(s: String) = JSONObject(s)

    @Test fun aValidRecordAndItsJson() {
        val r = AlarmRecord.parse(rec("""{"v":1,"id":"$id","eclipseId":"2027-02-06-solar","spec":{"kind":"day","daysBefore":0,"time":"12:00"}}"""))
        assertEquals(AlarmRecord(id, "2027-02-06-solar", AlarmSpec.Day(0, "12:00")), r)
        assertEquals(r, AlarmRecord.parse(r!!.toJson()))
        assertEquals(setOf("v", "id", "eclipseId", "spec"), r.toJson().keys().asSequence().toSet())
        assertNotNull(AlarmRecord.parse(rec("""{"v":1,"id":"$id","eclipseId":"2027-02-20-lunar","spec":{"kind":"before","minutes":120}}""")))
        // JavaScript reads 1.0 as 1.
        assertNotNull(AlarmRecord.parse(rec("""{"v":1.0,"id":"$id","eclipseId":"2027-02-20-lunar","spec":{"kind":"before","minutes":30.0}}""")))
    }

    @Test fun anythingElseIsInvalid() {
        val bad = listOf(
            """{"v":1,"id":"$id","eclipseId":"2027-02-06-solar","spec":{"kind":"day","daysBefore":0,"time":"12:00"},"enabled":true}""",
            """{"v":2,"id":"$id","eclipseId":"2027-02-06-solar","spec":{"kind":"before","minutes":30}}""",
            """{"v":"1","id":"$id","eclipseId":"2027-02-06-solar","spec":{"kind":"before","minutes":30}}""",
            """{"v":1,"id":"0123456789ABCDEF0123456789ABCDEF","eclipseId":"2027-02-06-solar","spec":{"kind":"before","minutes":30}}""",
            """{"v":1,"id":"0123","eclipseId":"2027-02-06-solar","spec":{"kind":"before","minutes":30}}""",
            """{"v":1,"id":"$id","eclipseId":"2027-02-06-sun","spec":{"kind":"before","minutes":30}}""",
            """{"v":1,"id":"$id","eclipseId":"2027-02-06-solar","spec":{"kind":"before","minutes":45}}""",
            """{"v":1,"id":"$id","eclipseId":"2027-02-06-solar","spec":{"kind":"before","minutes":30.5}}""",
            """{"v":1,"id":"$id","eclipseId":"2027-02-06-solar","spec":{"kind":"before","minutes":"30"}}""",
            """{"v":1,"id":"$id","eclipseId":"2027-02-06-solar","spec":{"kind":"day","daysBefore":4,"time":"12:00"}}""",
            """{"v":1,"id":"$id","eclipseId":"2027-02-06-solar","spec":{"kind":"day","daysBefore":0,"time":"24:00"}}""",
            """{"v":1,"id":"$id","eclipseId":"2027-02-06-solar","spec":{"kind":"day","daysBefore":0,"time":"9:00"}}""",
            """{"v":1,"id":"$id","eclipseId":"2027-02-06-solar","spec":{"kind":"day","daysBefore":0}}""",
            """{"v":1,"id":"$id","eclipseId":"2027-02-06-solar","spec":{"kind":"day","daysBefore":0,"time":"12:00","x":1}}""",
            """{"v":1,"id":"$id","eclipseId":"2027-02-06-solar"}""",
        )
        for (b in bad) assertNull(b, AlarmRecord.parse(rec(b)))
        assertNull(AlarmRecord.parse(null))
        assertNull(AlarmRecord.parse("text"))
        assertNull(AlarmRecord.parse(JSONArray()))
    }

    @Test fun recordSets() {
        fun r(i: Int, e: String = "2027-02-06-solar") = """{"v":1,"id":"${i.toString().padStart(32, '0')}","eclipseId":"$e","spec":{"kind":"before","minutes":30}}"""
        assertEquals(8, AlarmRecord.parseSet(JSONArray((1..8).joinToString(",", "[", "]") { r(it) }))!!.size)
        assertNull("a ninth for one eclipse", AlarmRecord.parseSet(JSONArray((1..9).joinToString(",", "[", "]") { r(it) })))
        assertEquals(9, AlarmRecord.parseSet(JSONArray(((1..8).map { r(it) } + r(9, "2027-02-20-lunar")).joinToString(",", "[", "]")))!!.size)
        assertNull("an id twice", AlarmRecord.parseSet(JSONArray("[${r(1)},${r(1, "2027-02-20-lunar")}]")))
        assertNull("one invalid", AlarmRecord.parseSet(JSONArray("[${r(1)},{}]")))
        assertEquals(0, AlarmRecord.parseSet(JSONArray())!!.size)
        assertNull(AlarmRecord.parseSet(JSONObject()))
    }

    @Test fun theBundledListAndItsNames() {
        val c = WebRoot.catalogue
        assertEquals(337, c.size)
        val first = c["2027-02-06-solar"]!!
        assertEquals("2027-02-06T15:59:32Z", first.greatest)
        assertEquals("Annular solar eclipse", Words.eclipseName(first))
        assertEquals("Penumbral lunar eclipse", Words.eclipseName(c["2027-02-20-lunar"]!!))
        assertEquals("Total solar eclipse", Words.eclipseName(c["2100-09-04-solar"]!!))
        assertNull(c["2026-08-12-solar"])
    }

    @Test fun theAlarmWordsAreThePages() {
        assertEquals("On the day of the eclipse at 12:00", Words.alarmWords(AlarmSpec.Day(0, "12:00")))
        assertEquals("1 week before at 08:30", Words.alarmWords(AlarmSpec.Day(7, "08:30")))
        assertEquals("30 minutes before greatest eclipse", Words.alarmWords(AlarmSpec.Before(30)))
        assertEquals("2 hours before greatest eclipse", Words.alarmWords(AlarmSpec.Before(120)))
        // The same words as ts/core/format.ts alarmWords (spec section 8).
        val format = WebRoot.text("ts/core/format.ts")
        for (w in listOf("On the day of the eclipse", "1 day before", "2 days before", "3 days before", "1 week before", "15 minutes", "30 minutes", "1 hour", "2 hours", "before greatest eclipse")) {
            assert(format.contains(w)) { "format.ts says $w" }
        }
    }
}
