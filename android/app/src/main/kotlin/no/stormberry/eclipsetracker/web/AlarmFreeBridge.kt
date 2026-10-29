package no.stormberry.eclipsetracker.web

import org.json.JSONArray
import org.json.JSONObject

/**
 * What the app does with a bridge message in an edition WITHOUT ringing alarms: the Google Play
 * edition (Edition.ALARMS false, 29 October 2026). Pure Kotlin on org.json, unit tested in both
 * editions (AlarmFreeBridgeTest), and used by MainActivity only when Edition.ALARMS is false.
 *
 * The Play edition's bridge script never asks for alarms: it sets up neither Set ringing alarms nor
 * the overview. This is the second lock (defence in depth): should a message about alarms arrive
 * anyway, the app does not touch the alarm engine, which the Play bundle does not even contain. It
 * answers alarms.list and alarms.set with ok:false and no records, nothing armed and no problem, so
 * a page waiting for an answer gets one, and it drops problem.fix (there is no alarm whose problem
 * could be fixed). Everything else, the calendar file, Save, Back and hello, is handled as in the
 * sovereign edition.
 */
object AlarmFreeBridge {
    enum class Action {
        /** Answer with [refusal]: the page asked about alarms. */
        REFUSE,

        /** Drop it: a request that only an alarm could make sense of. */
        IGNORE,

        /** Handle it as the sovereign edition does: it has nothing to do with alarms. */
        HANDLE,
    }

    fun action(msg: BridgeMessage): Action = when (msg) {
        is BridgeMessage.ListAlarms, is BridgeMessage.SetAlarms -> Action.REFUSE
        is BridgeMessage.FixProblem -> Action.IGNORE
        BridgeMessage.Hello, is BridgeMessage.Calendar, is BridgeMessage.BackResult -> Action.HANDLE
    }

    /** The id of the request a refusal answers, if it had one. */
    fun requestId(msg: BridgeMessage): Int? = when (msg) {
        is BridgeMessage.ListAlarms -> msg.id
        is BridgeMessage.SetAlarms -> msg.id
        else -> null
    }

    /**
     * The "alarms" message (spec 9.6) of an app that keeps no alarm: ok false, no records, nothing
     * armed, no problem. MainActivity.post adds v: 1.
     */
    fun refusal(id: Int?): JSONObject = JSONObject().put("type", "alarms").apply { if (id != null) put("id", id) }
        .put("ok", false).put("records", JSONArray()).put("armed", JSONArray()).put("problems", JSONArray())
}
