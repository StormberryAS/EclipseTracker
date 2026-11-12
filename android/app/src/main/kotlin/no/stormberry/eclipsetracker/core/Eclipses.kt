package no.stormberry.eclipsetracker.core

import org.json.JSONObject

/**
 * One eclipse of the bundled list, as much of it as the native side needs: the id records refer
 * to, the kind and type for its name, and greatest eclipse (UTC, to the second) for the planner.
 * The list is data/eclipses.json, the same list the page's core/data.js holds (spec 9.3; the web
 * tests check the two are equal); the native side never parses JavaScript.
 */
data class Eclipse(val id: String, val kind: String, val type: String, val greatest: String)

/** The bundled eclipse list, by id. */
class EclipseCatalogue private constructor(private val byId: Map<String, Eclipse>) {
    val size: Int get() = byId.size

    operator fun get(id: String): Eclipse? = byId[id]

    companion object {
        private val KINDS = setOf("solar", "lunar")
        private val TYPES = mapOf(
            "solar" to setOf("total", "annular", "hybrid", "partial"),
            "lunar" to setOf("total", "partial", "penumbral"),
        )
        private val GREATEST = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$")

        /** Reads data/eclipses.json; throws on anything that is not the list the web app ships. */
        fun parse(json: String): EclipseCatalogue {
            val doc = JSONObject(json)
            val list = doc.getJSONArray("eclipses")
            val out = LinkedHashMap<String, Eclipse>(list.length() * 2)
            for (i in 0 until list.length()) {
                val o = list.getJSONObject(i)
                val e = Eclipse(o.getString("id"), o.getString("kind"), o.getString("type"), o.getString("greatest"))
                require(AlarmRecord.ECLIPSE_ID.matches(e.id) && e.id.endsWith("-${e.kind}")) { "bad eclipse id ${e.id}" }
                require(e.kind in KINDS && e.type in TYPES.getValue(e.kind)) { "bad kind or type for ${e.id}" }
                require(GREATEST.matches(e.greatest)) { "bad greatest eclipse for ${e.id}" }
                require(out.put(e.id, e) == null) { "eclipse ${e.id} twice" }
            }
            require(out.isNotEmpty()) { "the eclipse list is empty" }
            return EclipseCatalogue(out)
        }
    }
}

/**
 * The words the notification and the ring screen show, ported from ts/core/format.ts so the app
 * says exactly what the page says (eclipseName, alarmWords; approved texts of spec section 8).
 */
object Words {
    private val TYPE = mapOf("total" to "Total", "annular" to "Annular", "hybrid" to "Hybrid", "partial" to "Partial", "penumbral" to "Penumbral")
    private val BEFORE = mapOf(15 to "15 minutes", 30 to "30 minutes", 60 to "1 hour", 120 to "2 hours")
    private val DAY = mapOf(0 to "On the day of the eclipse", 1 to "1 day before", 2 to "2 days before", 3 to "3 days before", 7 to "1 week before")

    /** "Annular solar eclipse". */
    fun eclipseName(e: Eclipse): String = "${TYPE.getValue(e.type)} ${e.kind} eclipse"

    /**
     * "On the day of the eclipse at 12:00", "30 minutes before greatest eclipse". With a [place] (an
     * alarm set for a city, EclipseTracker 2.1.0) the words name it: "1 day before at 12:00 in
     * Sydney, Australia", "30 minutes before the eclipse starts in Sydney, Australia".
     */
    fun alarmWords(spec: AlarmSpec, place: String? = null): String = when (spec) {
        is AlarmSpec.Before ->
            if (place == null) "${BEFORE.getValue(spec.minutes)} before greatest eclipse"
            else "${BEFORE.getValue(spec.minutes)} before the eclipse starts in $place"
        is AlarmSpec.Day -> "${DAY.getValue(spec.daysBefore)} at ${spec.time}" + (if (place == null) "" else " in $place")
    }

    /** The words of a stored record: its place is named when it is a version 2 record. */
    fun alarmWords(record: AlarmRecord): String = alarmWords(record.spec, record.local?.place)
}
