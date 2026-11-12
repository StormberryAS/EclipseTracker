package no.stormberry.eclipsetracker.web

import no.stormberry.eclipsetracker.core.Json
import org.json.JSONObject

/**
 * The check of the city text the app keeps for the page (EclipseTracker 2.1.0, `city.set` and
 * `city.get`). The page chooses a city from its built-in catalogue and sends its own text for it,
 * the six keys `v`, `name`, `country`, `lat`, `lon`, `tz` that `storedCityText` in ts/core/citysearch.ts
 * writes. The app keeps that text in its own preferences, because the WebView's DOM storage stays
 * off, and gives it back at the next start. The page checks the text again when it reads it
 * (parseStoredCity); this check keeps junk out of the preferences and nothing more.
 *
 * The rule is the page's `parseStoredCity(text, { anyZone: true })`, and tests/stored-city-vectors.json
 * (read by both sides) holds the two to it: a JSON object with exactly the six keys; `v` equal to 1;
 * name and country of 1 to 200 characters with no control character (U+0000 to U+001F, U+007F to
 * U+009F); a latitude from -90 to 90; a longitude from -180 to 180; and a zone that is text of 1 to
 * 200 characters. The zone is NOT checked against java.time: the page checks it with the WebView's
 * own zone list, so the two lists can never disagree here.
 *
 * One rule more than the page's: the whole text is at most [MAX_CHARS] characters (a catalogue city
 * is about 100), so a page cannot fill the preferences.
 */
object KeptCity {
    const val MAX_CHARS = 1024

    private val KEYS = setOf("v", "name", "country", "lat", "lon", "tz")
    private val CONTROL = Regex("[\\u0000-\\u001f\\u007f-\\u009f]")

    /** True when [text] is exactly a city this version of the page writes. */
    fun check(text: String?): Boolean {
        if (text == null || text.length > MAX_CHARS) return false
        val o = try {
            JSONObject(text)
        } catch (_: Exception) {
            return false
        }
        if (o.length() != KEYS.size || o.keys().asSequence().toSet() != KEYS) return false
        if (Json.wholeNumber(o.opt("v")) != 1L) return false
        if (!words(o.opt("name")) || !words(o.opt("country"))) return false
        if (!inRange(o.opt("lat"), 90.0) || !inRange(o.opt("lon"), 180.0)) return false
        val tz = o.opt("tz")
        return tz is String && tz.length in 1..200
    }

    private fun words(x: Any?): Boolean = x is String && x.length in 1..200 && !CONTROL.containsMatchIn(x)

    private fun inRange(x: Any?, limit: Double): Boolean {
        if (x !is Number || x is Boolean) return false
        val d = x.toDouble()
        return d.isFinite() && d >= -limit && d <= limit
    }
}
