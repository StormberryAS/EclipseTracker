package no.stormberry.eclipsetracker.web

import no.stormberry.eclipsetracker.WebRoot
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The city text the app keeps for the page (KeptCity, EclipseTracker 2.1.0) against
 * tests/stored-city-vectors.json, which the page's parseStoredCity (anyZone) passes too, and the
 * messages the page sends to keep and to read it.
 */
class KeptCityTest {
    @Test fun everyStoredCityVector() {
        val cases = JSONObject(WebRoot.text("tests/stored-city-vectors.json")).getJSONArray("cases")
        assertTrue(cases.length() >= 40)
        var valid = 0
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            assertEquals(c.getString("name"), c.getBoolean("valid"), KeptCity.check(c.getString("text")))
            if (c.getBoolean("valid")) valid++
        }
        assertTrue(valid in 5 until cases.length() - 5)
    }

    @Test fun theTextTheCatalogueWrites() {
        // Every row of the catalogue as storedCityText writes it: v first, then the five keys.
        val text = WebRoot.text("cities.js")
        assertTrue(text.isNotEmpty())
        assertTrue(KeptCity.check("""{"v":1,"name":"Bergen","country":"Norway","lat":60.393,"lon":5.3242,"tz":"Europe/Oslo"}"""))
        assertTrue(KeptCity.check("""{"v":1,"name":"Kleppestø","country":"Norway","lat":60.4079,"lon":5.2341,"tz":"Europe/Oslo"}"""))
        assertTrue(KeptCity.check("""{"v":1,"name":"Honolulu, HI","country":"USA","lat":21.30694,"lon":-157.85833,"tz":"Pacific/Honolulu"}"""))
    }

    @Test fun nothingAndTooLongAreRefused() {
        assertFalse(KeptCity.check(null))
        assertFalse(KeptCity.check(""))
        val ok = """{"v":1,"name":"Bergen","country":"Norway","lat":60.393,"lon":5.3242,"tz":"Europe/Oslo"}"""
        assertTrue(KeptCity.check(ok))
        // Over 1,024 characters the app refuses what the page's rule would allow (200 + 200 + 200 characters of quotes, each escaped).
        val big = """{"v":1,"name":"${"\\\"".repeat(200)}","country":"${"\\\"".repeat(200)}","lat":1,"lon":1,"tz":"${"Z".repeat(200)}"}"""
        assertTrue(big.length > KeptCity.MAX_CHARS)
        assertFalse(KeptCity.check(big))
        val shortEnough = """{"v":1,"name":"${"\\\"".repeat(100)}","country":"${"\\\"".repeat(100)}","lat":1,"lon":1,"tz":"Z"}"""
        assertTrue(shortEnough.length < KeptCity.MAX_CHARS)
        assertTrue(KeptCity.check(shortEnough))
    }

    @Test fun theMessagesForTheCity() {
        assertEquals(BridgeMessage.GetCity(null), BridgeMessage.parse("""{"v":1,"type":"city.get"}"""))
        assertEquals(BridgeMessage.GetCity(4), BridgeMessage.parse("""{"v":1,"type":"city.get","id":4}"""))
        assertEquals(BridgeMessage.SetCity(5, null), BridgeMessage.parse("""{"v":1,"type":"city.set","id":5,"city":null}"""))
        assertEquals(BridgeMessage.SetCity(null, "x"), BridgeMessage.parse("""{"v":1,"type":"city.set","city":"x"}"""))
        val text = """{\"v\":1,\"name\":\"Bergen\"}"""
        assertEquals(BridgeMessage.SetCity(6, """{"v":1,"name":"Bergen"}"""), BridgeMessage.parse("""{"v":1,"type":"city.set","id":6,"city":"$text"}"""))
        val bad = listOf(
            """{"v":1,"type":"city.set"}""", """{"v":1,"type":"city.set","id":1}""",
            """{"v":1,"type":"city.set","city":5}""", """{"v":1,"type":"city.set","city":{}}""", """{"v":1,"type":"city.set","city":true}""",
            """{"v":1,"type":"city.set","city":"x","extra":1}""", """{"v":2,"type":"city.set","city":"x"}""",
            """{"v":1,"type":"city.get","city":"x"}""", """{"v":1,"type":"city.get","id":0}""", """{"v":1,"type":"city.get","id":"1"}""",
        )
        for (b in bad) org.junit.Assert.assertNull(b, BridgeMessage.parse(b))
    }

    @Test fun bothEditionsHandleTheCityMessages() {
        for (json in listOf("""{"v":1,"type":"city.get","id":1}""", """{"v":1,"type":"city.set","id":2,"city":null}""", """{"v":1,"type":"city.set","city":"x"}""")) {
            assertEquals(json, AlarmFreeBridge.Action.HANDLE, AlarmFreeBridge.action(BridgeMessage.parse(json)!!))
            org.junit.Assert.assertNull(json, AlarmFreeBridge.requestId(BridgeMessage.parse(json)!!))
        }
    }
}
