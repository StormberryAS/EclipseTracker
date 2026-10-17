package no.stormberry.eclipsetracker.web

import no.stormberry.eclipsetracker.WebRoot
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The bridge messages (spec 9.6) and the calendar handover checks (C-13). */
class BridgeTest {
    @Test fun theMessagesThePageSends() {
        assertEquals(BridgeMessage.Hello, BridgeMessage.parse("""{"v":1,"type":"hello"}"""))
        assertEquals(BridgeMessage.ListAlarms(null), BridgeMessage.parse("""{"v":1,"type":"alarms.list"}"""))
        assertEquals(BridgeMessage.ListAlarms(7), BridgeMessage.parse("""{"v":1,"type":"alarms.list","id":7}"""))
        val set = BridgeMessage.parse("""{"v":1,"type":"alarms.set","id":2,"eclipseId":"2027-02-06-solar","records":[]}""") as BridgeMessage.SetAlarms
        assertEquals("2027-02-06-solar", set.eclipseId)
        assertEquals(0, set.records.length())
        val cal = BridgeMessage.parse("""{"v":1,"type":"calendar.add","fileName":"eclipse-2027-02-06-solar.ics","ics":"x"}""") as BridgeMessage.Calendar
        assertEquals(false, cal.save)
        assertEquals(true, (BridgeMessage.parse("""{"v":1,"type":"calendar.save","id":3,"fileName":"a","ics":"x"}""") as BridgeMessage.Calendar).save)
        assertEquals(BridgeMessage.FixProblem("notifications-denied"), BridgeMessage.parse("""{"v":1,"type":"problem.fix","problem":"notifications-denied"}"""))
        assertEquals(BridgeMessage.BackResult(4, true), BridgeMessage.parse("""{"v":1,"type":"back.result","q":4,"handled":true}"""))
    }

    @Test fun anythingElseIsDropped() {
        val bad = listOf(
            null, "", "not json", "[]", """{"type":"hello"}""", """{"v":2,"type":"hello"}""", """{"v":1}""",
            """{"v":1,"type":"other"}""", """{"v":1,"type":"hello","extra":1}""",
            """{"v":1,"type":"alarms.list","id":0}""", """{"v":1,"type":"alarms.list","id":"1"}""", """{"v":1,"type":"alarms.list","id":1.5}""",
            """{"v":1,"type":"alarms.set","eclipseId":"2027-02-06-solar"}""", """{"v":1,"type":"alarms.set","eclipseId":"2027-02-06-solar","records":{}}""",
            """{"v":1,"type":"alarms.set","eclipseId":7,"records":[]}""",
            """{"v":1,"type":"calendar.add","fileName":"eclipse-2027-02-06-solar.ics"}""",
            """{"v":1,"type":"problem.fix"}""", """{"v":1,"type":"back.result","q":1}""", """{"v":1,"type":"back.result","q":1,"handled":"yes"}""",
            """{"v":1,"type":"alarms.list","fireAt":"2027-02-06T11:00:00Z"}""",
        )
        for (b in bad) assertNull(b, BridgeMessage.parse(b))
        val long = """{"v":1,"type":"alarms.list","x":"${"a".repeat(BridgeMessage.MAX_MESSAGE_CHARS)}"}"""
        assertNull(BridgeMessage.parse(long))
    }

    private val known: (String) -> Boolean = { WebRoot.catalogue[it] != null }

    @Test fun theRealCalendarFileIsAccepted() {
        val golden = WebRoot.text("tests/goldens/eclipse-2027-02-06-solar.ics")
        val f = CalendarHandover.check("eclipse-2027-02-06-solar.ics", golden, known)
        assertNotNull(f)
        assertEquals("eclipse-2027-02-06-solar.ics", f!!.name)
        assertTrue(f.bytes.contentEquals(golden.toByteArray(Charsets.UTF_8)))
    }

    @Test fun theNameIsNeverAPathAndTheFileMustBeACalendar() {
        val golden = WebRoot.text("tests/goldens/eclipse-2027-02-06-solar.ics")
        for (name in listOf("../eclipse-2027-02-06-solar.ics", "eclipse-2027-02-06-solar.ics/..", "x/eclipse-2027-02-06-solar.ics",
            "eclipse-2027-02-06-solar.ICS", "eclipse-2027-02-06-solar.ics.txt", "eclipse-2027-2-06-solar.ics", "eclipse-2027-02-06-sun.ics",
            "eclipse-2026-08-12-solar.ics", "", "eclipse-2027-02-06-solar.ics\n")) {
            assertNull(name, CalendarHandover.check(name, golden, known))
        }
        assertNull(CalendarHandover.check(7, golden, known))
        val n = "eclipse-2027-02-06-solar.ics"
        assertNull("not a calendar", CalendarHandover.check(n, "hello", known))
        assertNull("no end", CalendarHandover.check(n, golden.substringBefore("END:VCALENDAR"), known))
        assertNull("no start", CalendarHandover.check(n, golden.removePrefix("BEGIN:VCALENDAR\r\n"), known))
        assertNull("a NUL", CalendarHandover.check(n, golden.replace("SUMMARY", "SUMM\u0000ARY"), known))
        val big = "BEGIN:VCALENDAR\r\n" + "X-PAD:".padEnd(CalendarHandover.MAX_BYTES, 'a') + "\r\nEND:VCALENDAR\r\n"
        assertNull("over 64 KB", CalendarHandover.check(n, big, known))
        val justUnder = "BEGIN:VCALENDAR\r\nX:" + "a".repeat(CalendarHandover.MAX_BYTES - 40) + "\r\nEND:VCALENDAR\r\n"
        assertNotNull(CalendarHandover.check(n, justUnder, known))
        assertNull(CalendarHandover.check(n, JSONArray(), known))
    }

    @Test fun theStrictPatternIsThePages() {
        // isIcsFileName in ts/core/format.ts (spec 9.6).
        assertTrue(WebRoot.text("ts/core/format.ts").contains("/^eclipse-\\d{4}-\\d{2}-\\d{2}-(solar|lunar)\\.ics$/"))
        assertEquals("^eclipse-\\d{4}-\\d{2}-\\d{2}-(solar|lunar)\\.ics$", CalendarHandover.FILE_NAME.pattern)
    }
}
