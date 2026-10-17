package no.stormberry.eclipsetracker.alarm

import no.stormberry.eclipsetracker.core.AlarmRecord
import no.stormberry.eclipsetracker.core.EclipseCatalogue
import no.stormberry.eclipsetracker.core.Planner
import no.stormberry.eclipsetracker.core.RecordFate
import org.json.JSONArray
import java.time.ZoneId

/**
 * The seam between the pure alarm engine and AlarmManager (SunApp's AlarmSink, unchanged in
 * purpose): arm one alarm, replacing whatever is registered under its request code, or cancel a
 * request code. Implementations are tolerant: a refusal for one alarm must never stop the rest.
 */
interface AlarmSink {
    fun arm(alarm: ArmedAlarm)
    fun cancel(requestCode: Int)

    /**
     * The backstop for the nearest alarm, or none when [next] is null (fix B, A-2). On Android 12
     * and 12L, switching exact alarms off cancels every exact alarm with no broadcast to say so;
     * an inexact twin of the nearest one survives that, rings it (late, if Android so chooses)
     * and re-plans, which arms the rest inexactly. Elsewhere it does nothing.
     */
    fun guard(next: ArmedAlarm?)
}

/** One alarm the platform should hold: the record, the instant it rings and its request code. */
data class ArmedAlarm(val record: AlarmRecord, val fireAt: Long, val requestCode: Int)

/**
 * The outcome of a re-plan: the records to keep (the store is rewritten with exactly these),
 * those deleted and why, and the alarms to arm, nearest first (at most [AlarmScheduler.MAX_ARMED]).
 */
data class Plan(
    val keep: List<AlarmRecord>,
    val deleted: List<Pair<String, String>>,
    val armed: List<ArmedAlarm>,
) {
    /** The records as stored, a JSON array (spec 9.4). */
    fun keepJson(): JSONArray = JSONArray().apply { keep.forEach { put(it.toJson()) } }
}

/** A re-plan (fix E): the plan, and the records it deleted that get a "Missed" notice. */
data class Replan(val plan: Plan, val missed: List<AlarmRecord>)

/**
 * Decides what should be armed right now and makes an [AlarmSink] agree (SunApp's AlarmPlanner,
 * with the record rules of spec 9.4 and the limit of 9.7). Pure with respect to time and zone:
 * both come in as arguments, so the tests replay a restart, a fire, a journey and a deletion in
 * milliseconds.
 *
 * Every entry point does the same full re-plan (restart, locked restart, update, time or zone
 * change, exact-alarm permission change, after each alarm fires, and whenever the page sets or
 * deletes alarms), because each can arrive with the previous state stale or absent.
 */
object AlarmScheduler {
    /**
     * The most alarms armed at once (spec 9.7, FIX-3): Android 12 and later allow 500 pending
     * alarms per app, and 337 eclipses with 8 alarms each could make 2,696 records. Records beyond
     * the nearest 100 stay stored and are armed as nearer ones ring.
     */
    const val MAX_ARMED = 100

    /**
     * What to do with the stored records [stored] (raw JSON values, as read; any of them may be
     * invalid) for [zone] at [now]. Each record's fate is [Planner.recordFate]. A record that
     * repeats an earlier record's id, or would be a ninth for its eclipse, is deleted as invalid,
     * so the stored set always stays a valid set (isValidRecordSet).
     *
     * Fix B, F-1 (found on the Android 12 emulator, 16 October 2026): a re-plan that runs in the
     * seconds between an alarm's time and the delivery of that alarm (a boot broadcast, a change
     * of the clock, the app coming to the front) used to delete the record as passed, so the
     * alarm then arrived to find no record and nothing rang. So a record whose alarm is armed
     * ([previouslyArmed] holds its request code) and whose time passed less than
     * [FireRules.LATE_LIMIT_MS] ago is left armed for its fire receiver, which rings it or not by
     * the usual rules. After a restart AlarmManager holds nothing, so the caller passes no codes
     * there and such a record is deleted as missed, as before. [drop] is the record the fire
     * receiver has just rung (or found moved into the past): it is deleted.
     *
     * Fix C (17 October 2026, S-1, found by the independent verification): the exception above was
     * too broad. A change of zone (Oslo to Helsinki at 11:05 Oslo time) moves a noon alarm armed for
     * 11:00 UTC to 10:00 UTC, five minutes in the past; it was kept and armed again for 10:00 UTC,
     * which AlarmManager delivers at once, so it rang up to ten minutes late, which spec 9.4 and
     * C-23 forbid. Now the exception holds only while the time worked out afresh is the very
     * instant the alarm is armed for: [armedAt] gives that instant per request code (what the last
     * re-plan armed), and a record whose time has moved, or whose armed instant is unknown, is
     * deleted as passed, never rung late.
     */
    fun plan(
        stored: List<Any?>,
        catalogue: EclipseCatalogue,
        zone: ZoneId,
        now: Long,
        previouslyArmed: Set<Int> = emptySet(),
        drop: String? = null,
        armedAt: Map<Int, Long> = emptyMap(),
    ): Plan {
        val keep = ArrayList<AlarmRecord>()
        val deleted = ArrayList<Pair<String, String>>()
        val fires = ArrayList<ArmedAlarm>()
        val ids = HashSet<String>()
        val perEclipse = HashMap<String, Int>()
        for (raw in stored) {
            val record = AlarmRecord.parse(raw)
            if (record == null || record.id in ids || (perEclipse[record.eclipseId] ?: 0) >= Planner.MAX_ALARMS) {
                deleted += (record?.id ?: "") to "invalid"
                continue
            }
            ids += record.id
            perEclipse[record.eclipseId] = (perEclipse[record.eclipseId] ?: 0) + 1
            if (record.id == drop) {
                deleted += record.id to "passed"
                continue
            }
            when (val fate = Planner.recordFate(raw, catalogue[record.eclipseId], zone, now)) {
                is RecordFate.Delete -> {
                    val code = requestCodeFor(record.id)
                    val armedFor = armedAt[code]
                    val due = if (fate.reason == "passed" && code in previouslyArmed && armedFor != null) {
                        catalogue[record.eclipseId]?.let { Planner.fireInstant(it.greatest, record.spec, zone).first }
                            ?.takeIf { it > now - FireRules.LATE_LIMIT_MS && it == armedFor }
                    } else {
                        null
                    }
                    if (due != null) {
                        keep += record
                        fires += ArmedAlarm(record, due, code)
                    } else {
                        deleted += record.id to fate.reason
                    }
                }
                is RecordFate.Arm -> {
                    keep += record
                    fires += ArmedAlarm(record, fate.fireAt, requestCodeFor(record.id))
                }
            }
        }
        val armed = fires.sortedWith(compareBy<ArmedAlarm> { it.fireAt }.thenBy { it.record.id }).take(MAX_ARMED)
        return Plan(keep, deleted, armed)
    }

    /**
     * Fix E (17 October 2026, C-1, C-2): one re-plan as AlarmScheduling runs it, pure, so the JVM
     * tests replay the same code: the [plan] for the stored records, made with what was armed
     * ([armedBefore], [armedAtBefore]) unless [afterRestart] (AlarmManager then holds nothing), and
     * the records it reports as missed ([FireRules.missed], which always looks at what was armed).
     */
    fun replan(
        stored: List<Any?>,
        catalogue: EclipseCatalogue,
        zone: ZoneId,
        now: Long,
        armedBefore: Set<Int>,
        armedAtBefore: Map<Int, Long>,
        afterRestart: Boolean,
        drop: String? = null,
    ): Replan {
        val plan = plan(
            stored, catalogue, zone, now,
            if (afterRestart) emptySet() else armedBefore, drop,
            armedAt = if (afterRestart) emptyMap() else armedAtBefore,
        )
        val missed = FireRules.missed(stored.mapNotNull { AlarmRecord.parse(it) }, plan, armedBefore, armedAtBefore, now, afterRestart, drop)
        return Replan(plan, missed)
    }

    /**
     * Makes [sink] match [plan]: cancels every request code in [previouslyArmed] that is no longer
     * wanted, then arms every wanted alarm (replacing in place what is already armed under the same
     * code), and sets the backstop for the nearest (fix B, A-2). Returns the request codes now
     * armed. Cancelling a code never armed is a no-op.
     */
    fun apply(plan: Plan, sink: AlarmSink, previouslyArmed: Set<Int>): Set<Int> {
        val wanted = plan.armed.mapTo(LinkedHashSet()) { it.requestCode }
        for (stale in previouslyArmed - wanted) sink.cancel(stale)
        for (alarm in plan.armed) sink.arm(alarm)
        sink.guard(plan.armed.firstOrNull())
        return wanted
    }

    /**
     * The stored records with one eclipse's records replaced by [incoming] (the page's
     * alarms.set, spec 9.6), or null when the message must be refused whole: [incoming] is not a
     * valid record set, a record is for another eclipse, the eclipse is not in the bundled list,
     * or a record takes an id another eclipse's record already has (ids are never reused).
     * An empty [incoming] deletes that eclipse's records.
     */
    fun replaceEclipse(stored: List<AlarmRecord>, eclipseId: String, incoming: Any?, catalogue: EclipseCatalogue): List<AlarmRecord>? {
        if (!AlarmRecord.ECLIPSE_ID.matches(eclipseId) || catalogue[eclipseId] == null) return null
        val records = AlarmRecord.parseSet(incoming) ?: return null
        if (records.any { it.eclipseId != eclipseId }) return null
        val others = stored.filter { it.eclipseId != eclipseId }
        val otherIds = others.mapTo(HashSet()) { it.id }
        if (records.any { it.id in otherIds }) return null
        return others + records
    }

    /**
     * The request code of a record's alarm, from its id alone, so it stays the same for the
     * record's life (an edit keeps the id, spec 9.6) and a deletion can always cancel it. FNV-1a
     * over the id's UTF-8 bytes with the low bit cleared: alarm codes are even and snooze codes
     * odd, so the two can never collide (SunApp's scheme, MoonApp's audit fix: one code per
     * alarm, never one shared code).
     */
    fun requestCodeFor(recordId: String): Int {
        var hash = -0x7EE3623B // FNV-1a 32-bit offset basis, 2166136261 as a signed Int
        for (byte in recordId.toByteArray(Charsets.UTF_8)) {
            hash = hash xor (byte.toInt() and 0xFF)
            hash *= 0x01000193 // FNV prime
        }
        return hash and 0x7FFFFFFE
    }

    /** The request code of a record's snooze: the odd sibling of [requestCodeFor]. */
    fun snoozeRequestCodeFor(recordId: String): Int = requestCodeFor(recordId) or 1
}
