package no.stormberry.eclipsetracker.web

import no.stormberry.eclipsetracker.core.Json
import org.json.JSONArray
import org.json.JSONObject

/**
 * Checks every message the page posts on the ETBridge channel before the app acts on it (spec
 * 9.6, B-4). Pure Kotlin on org.json, unit tested. Every message is a JSON object with v: 1 and a
 * type, and exactly the keys its type allows; anything else is dropped whole. The page is the
 * app's own bundled code, but the app never trusts a time, a path or a record from it: records
 * are checked again (isValidRecordSet), the native side works out every fire time itself, and a
 * calendar file name must match the strict pattern.
 *
 * Page to app:
 *   { v, type: "hello" }                                        the page's bridge has started
 *   { v, type: "alarms.list", id? }                             spec 9.6
 *   { v, type: "alarms.set", id?, eclipseId, records }          spec 9.6: replaces that eclipse's records
 *   { v, type: "calendar.add", id?, fileName, ics }             spec 9.6: hand the file to the calendar app
 *   { v, type: "calendar.save", id?, fileName, ics }            stage B addition: the page's own Save,
 *                                                               through Android's save screen
 *   { v, type: "problem.fix", problem }                         stage B addition: open the screen that fixes a problem
 *   { v, type: "back.result", q, handled }                      stage B addition: the answer to Back q
 * The optional id (a positive whole number) is echoed in the answer, so the page can tell which
 * request an answer is for (stage B addition; the spec's messages carry none).
 */
sealed interface BridgeMessage {
    data object Hello : BridgeMessage
    data class ListAlarms(val id: Int?) : BridgeMessage
    data class SetAlarms(val id: Int?, val eclipseId: String, val records: JSONArray) : BridgeMessage
    data class Calendar(val id: Int?, val save: Boolean, val fileName: Any?, val ics: Any?) : BridgeMessage
    data class FixProblem(val problem: String) : BridgeMessage
    data class BackResult(val q: Int, val handled: Boolean) : BridgeMessage

    companion object {
        /** Far longer than any message the page sends (eight records, or a calendar file of 64 KB). */
        const val MAX_MESSAGE_CHARS = 200_000

        private val KEYS = mapOf(
            "hello" to setOf("v", "type"),
            "alarms.list" to setOf("v", "type", "id"),
            "alarms.set" to setOf("v", "type", "id", "eclipseId", "records"),
            "calendar.add" to setOf("v", "type", "id", "fileName", "ics"),
            "calendar.save" to setOf("v", "type", "id", "fileName", "ics"),
            "problem.fix" to setOf("v", "type", "problem"),
            "back.result" to setOf("v", "type", "q", "handled"),
        )
        private val REQUIRED = mapOf(
            "alarms.set" to setOf("eclipseId", "records"),
            "calendar.add" to setOf("fileName", "ics"),
            "calendar.save" to setOf("fileName", "ics"),
            "problem.fix" to setOf("problem"),
            "back.result" to setOf("q", "handled"),
        )

        /** The checked message in [data], or null when it must be ignored. */
        fun parse(data: String?): BridgeMessage? {
            if (data == null || data.length > MAX_MESSAGE_CHARS) return null
            val o = try {
                JSONObject(data)
            } catch (_: Exception) {
                return null
            }
            if (Json.wholeNumber(o.opt("v")) != 1L) return null
            val type = o.opt("type") as? String ?: return null
            val allowed = KEYS[type] ?: return null
            val keys = o.keys().asSequence().toSet()
            if (!allowed.containsAll(keys)) return null
            if (!keys.containsAll(REQUIRED[type].orEmpty())) return null
            val id = if (o.has("id")) (positiveInt(o.opt("id")) ?: return null) else null
            return when (type) {
                "hello" -> Hello
                "alarms.list" -> ListAlarms(id)
                "alarms.set" -> {
                    val eclipseId = o.opt("eclipseId") as? String ?: return null
                    val records = o.opt("records") as? JSONArray ?: return null
                    SetAlarms(id, eclipseId, records)
                }
                "calendar.add", "calendar.save" -> Calendar(id, type == "calendar.save", o.opt("fileName"), o.opt("ics"))
                "problem.fix" -> FixProblem(o.opt("problem") as? String ?: return null)
                "back.result" -> BackResult(positiveInt(o.opt("q")) ?: return null, o.opt("handled") as? Boolean ?: return null)
                else -> null
            }
        }

        fun positiveInt(x: Any?): Int? = Json.wholeNumber(x)?.takeIf { it in 1..Int.MAX_VALUE.toLong() }?.toInt()
    }
}

/**
 * The calendar file the page hands over (spec 9.6, code review C-13). The app never uses the
 * page's file name as a path: it accepts it only when it is exactly eclipse-<date>-<kind>.ics
 * (isIcsFileName) for an eclipse in the bundled list; the file must be at most 64 KB and start
 * with BEGIN:VCALENDAR and end with END:VCALENDAR. The app writes it into its own cache
 * subfolder (cache/calendar/, emptied first) and hands it over from there.
 */
object CalendarHandover {
    const val MAX_BYTES = 64 * 1024
    val FILE_NAME = Regex("^eclipse-\\d{4}-\\d{2}-\\d{2}-(solar|lunar)\\.ics$")

    class File(val name: String, val bytes: ByteArray)

    /** The checked file, or null. [knownEclipse] says whether an eclipse id is in the bundled list. */
    fun check(fileName: Any?, ics: Any?, knownEclipse: (String) -> Boolean): File? {
        if (fileName !is String || !FILE_NAME.matches(fileName)) return null
        if (!knownEclipse(fileName.removePrefix("eclipse-").removeSuffix(".ics"))) return null
        if (ics !is String || ics.contains('\u0000')) return null
        val bytes = ics.toByteArray(Charsets.UTF_8)
        if (bytes.isEmpty() || bytes.size > MAX_BYTES) return null
        if (!ics.startsWith("BEGIN:VCALENDAR\r\n")) return null
        if (!ics.trimEnd('\r', '\n').endsWith("\r\nEND:VCALENDAR")) return null
        return File(fileName, bytes)
    }
}
