package no.stormberry.eclipsetracker.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The Google Play edition refuses alarm messages (AlarmFreeBridge, 29 October 2026): what
 * MainActivity does with each message the page can send when Edition.ALARMS is false.
 */
class AlarmFreeBridgeTest {
    private fun parse(json: String): BridgeMessage = BridgeMessage.parse(json)!!

    @Test fun alarmRequestsAreRefusedAndTheRestHandled() {
        val cases = mapOf(
            """{"v":1,"type":"alarms.list"}""" to AlarmFreeBridge.Action.REFUSE,
            """{"v":1,"type":"alarms.list","id":7}""" to AlarmFreeBridge.Action.REFUSE,
            """{"v":1,"type":"alarms.set","id":2,"eclipseId":"2027-02-06-solar","records":[]}""" to AlarmFreeBridge.Action.REFUSE,
            """{"v":1,"type":"alarms.set","eclipseId":"2027-02-06-solar","records":[{"v":1}]}""" to AlarmFreeBridge.Action.REFUSE,
            """{"v":1,"type":"problem.fix","problem":"notifications-denied"}""" to AlarmFreeBridge.Action.IGNORE,
            """{"v":1,"type":"hello"}""" to AlarmFreeBridge.Action.HANDLE,
            """{"v":1,"type":"calendar.add","id":3,"fileName":"eclipse-2027-02-06-solar.ics","ics":"x"}""" to AlarmFreeBridge.Action.HANDLE,
            """{"v":1,"type":"calendar.save","id":4,"fileName":"eclipse-2027-02-06-solar.ics","ics":"x"}""" to AlarmFreeBridge.Action.HANDLE,
            """{"v":1,"type":"back.result","q":1,"handled":true}""" to AlarmFreeBridge.Action.HANDLE,
        )
        for ((json, want) in cases) assertEquals(json, want, AlarmFreeBridge.action(parse(json)))
    }

    @Test fun theRefusalIsAnAlarmsMessageWithNothingInIt() {
        val r = AlarmFreeBridge.refusal(7)
        assertEquals(setOf("type", "id", "ok", "records", "armed", "problems"), r.keys().asSequence().toSet())
        assertEquals("alarms", r.getString("type"))
        assertEquals(7, r.getInt("id"))
        assertEquals(false, r.getBoolean("ok"))
        for (k in listOf("records", "armed", "problems")) assertEquals(k, 0, r.getJSONArray(k).length())
        // Without a request id it carries none (the page would read it as news, which the Play bridge ignores).
        val news = AlarmFreeBridge.refusal(null)
        assertEquals(false, news.has("id"))
        assertEquals(false, news.getBoolean("ok"))
    }

    @Test fun theRefusalAnswersTheRequestItWasFor() {
        assertEquals(7, AlarmFreeBridge.requestId(parse("""{"v":1,"type":"alarms.list","id":7}""")))
        assertEquals(2, AlarmFreeBridge.requestId(parse("""{"v":1,"type":"alarms.set","id":2,"eclipseId":"2027-02-06-solar","records":[]}""")))
        assertNull(AlarmFreeBridge.requestId(parse("""{"v":1,"type":"alarms.list"}""")))
        assertNull(AlarmFreeBridge.requestId(parse("""{"v":1,"type":"hello"}""")))
    }
}
