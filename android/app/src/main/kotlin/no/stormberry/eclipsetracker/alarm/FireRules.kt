package no.stormberry.eclipsetracker.alarm

import no.stormberry.eclipsetracker.core.AlarmRecord
import no.stormberry.eclipsetracker.core.Eclipse
import no.stormberry.eclipsetracker.core.Planner
import org.json.JSONObject
import java.time.ZoneId
import kotlin.math.abs

/**
 * The decisions the alarm engine takes at the moment an alarm arrives, a snooze is pressed or
 * a re-plan runs, pure with respect to time and zone so the JVM tests replay each case (fix B,
 * 16 October 2026: A-5 to A-8 and A-10). The receiver and the service only carry them out.
 */

/** What the fire receiver does with an alarm that has just arrived (spec 9.4; fix B A-8, A-10). */
sealed interface FireDecision {
    /** Its record is gone (deleted, or already rung by the other alarm armed for it): nothing rings; re-plan. */
    data object Gone : FireDecision

    /** It arrived more than [FireRules.CLOCK_JUMP_TOLERANCE_MS] early: the clock moved, not time. Re-plan. */
    data object Early : FireDecision

    /** It arrived more than [FireRules.LATE_LIMIT_MS] late: missed, never rung late (C-23). Re-plan deletes it. */
    data object Late : FireDecision

    /**
     * Worked out afresh now, in the phone's zone now, it rings at another instant (a change of zone
     * seconds before, not yet re-planned): nothing rings now, and the re-plan arms the right
     * instant or deletes it as passed. Ringing now would ring it twice (fix B, A-8).
     */
    data class Moved(val freshAt: Long) : FireDecision

    /** It rings. */
    data object Ring : FireDecision
}

/** What became of an attempt to arm an alarm: exactly, inexactly after the exact call failed, or not at all. */
enum class ArmResult { EXACT, INEXACT, FAILED }

/**
 * A snoozed alarm waiting to ring again (fix B, A-6): the record it came from (deleted from the
 * records when it rang), its eclipse, the instant it rings and the words it shows. Kept in the
 * same device-protected storage as the records, so a restart re-arms it and the page's deletion
 * of every alarm of its eclipse removes it.
 */
data class Snooze(val recordId: String, val eclipseId: String, val at: Long, val title: String, val text: String) {
    fun toJson(): JSONObject = JSONObject()
        .put("v", 1).put("id", recordId).put("eclipseId", eclipseId).put("at", at).put("title", title).put("text", text)

    companion object {
        /** The longest title or text kept: the longest real ones are under 40 characters. */
        const val MAX_WORDS = 200

        /** The snooze in [raw], or null unless it is exactly one this version writes. */
        fun parse(raw: Any?): Snooze? {
            if (raw !is JSONObject || raw.length() != 6) return null
            if (no.stormberry.eclipsetracker.core.Json.wholeNumber(raw.opt("v")) != 1L) return null
            val id = raw.opt("id")
            if (!AlarmRecord.isRecordId(id)) return null
            val eclipseId = raw.opt("eclipseId") as? String ?: return null
            if (!AlarmRecord.ECLIPSE_ID.matches(eclipseId)) return null
            val at = no.stormberry.eclipsetracker.core.Json.wholeNumber(raw.opt("at")) ?: return null
            if (at <= 0L) return null
            val title = raw.opt("title") as? String ?: return null
            val text = raw.opt("text") as? String ?: return null
            if (title.length > MAX_WORDS || text.length > MAX_WORDS) return null
            return Snooze(id as String, eclipseId, at, title, text)
        }
    }
}

object FireRules {
    /** An alarm arriving more than this early means the clock moved (as before fix B). */
    const val CLOCK_JUMP_TOLERANCE_MS = 2_000L

    /**
     * How late an alarm may arrive and still ring. setAlarmClock is exact, so lateness means the
     * phone could not ring it (off, or the clock set forward past it). The inexact alarm of
     * Android 12 and 12L with exact alarms switched off can be later than this, and is then not
     * rung: the page says such an alarm "may ring late or not at all" (fix B, A-2).
     */
    const val LATE_LIMIT_MS = 10L * 60_000L

    /** The most snoozes kept at once; more than one waiting is already rare. */
    const val MAX_SNOOZES = 16

    /**
     * What to do with an alarm for [record] (null when its record is gone) of [eclipse], armed for
     * [armedAt] (0 when unknown), arriving at [now] in [zone] (fix B, A-8 and A-10), in this order:
     * gone, early, late, moved (its time worked out afresh is not the armed one), ring.
     */
    fun decide(record: AlarmRecord?, eclipse: Eclipse?, zone: ZoneId, armedAt: Long, now: Long): FireDecision {
        if (record == null || eclipse == null || eclipse.id != record.eclipseId) return FireDecision.Gone
        val fresh = Planner.fireInstant(eclipse.greatest, record.spec, zone).first
        val at = if (armedAt > 0L) armedAt else fresh
        return when {
            now < at - CLOCK_JUMP_TOLERANCE_MS -> FireDecision.Early
            now > at + LATE_LIMIT_MS -> FireDecision.Late
            abs(fresh - at) > CLOCK_JUMP_TOLERANCE_MS -> FireDecision.Moved(fresh)
            else -> FireDecision.Ring
        }
    }

    /** What to do with a snooze due at [at] that arrives at [now]: early, late or ring (fix B, A-2 "snooze too"). */
    fun decideSnooze(at: Long, now: Long): FireDecision = when {
        at <= 0L -> FireDecision.Ring
        now < at - CLOCK_JUMP_TOLERANCE_MS -> FireDecision.Early
        now > at + LATE_LIMIT_MS -> FireDecision.Late
        else -> FireDecision.Ring
    }

    /**
     * Arms with [exact]; if that throws anything, with [inexact]; if that throws too, reports
     * FAILED and never throws itself (fix B, A-7: before, a second kind of failure crashed the
     * receiver after the tone had stopped, losing the snooze).
     */
    fun armWithFallback(exact: () -> Unit, inexact: () -> Unit): ArmResult =
        try {
            exact()
            ArmResult.EXACT
        } catch (_: RuntimeException) {
            try {
                inexact()
                ArmResult.INEXACT
            } catch (_: RuntimeException) {
                ArmResult.FAILED
            }
        }

    /** The snoozes a re-plan at [now] keeps and arms: those not yet past the late limit, newest per record, at most [MAX_SNOOZES]. */
    fun keepSnoozes(snoozes: List<Snooze>, now: Long): List<Snooze> =
        snoozes.filter { now <= it.at + LATE_LIMIT_MS }
            .associateBy { it.recordId }.values
            .sortedBy { it.at }
            .take(MAX_SNOOZES)

    /** [snoozes] with [s] in place of any earlier snooze of the same record. */
    fun putSnooze(snoozes: List<Snooze>, s: Snooze): List<Snooze> = snoozes.filter { it.recordId != s.recordId } + s

    /**
     * After the page set the alarms of [eclipseId] and [remaining] of them are left: when none is
     * left, the person has deleted every alarm of that eclipse, and its waiting snoozes go too
     * (fix B, A-6). An edit that leaves at least one alarm leaves a snooze alone.
     */
    fun snoozesAfterSet(snoozes: List<Snooze>, eclipseId: String, remaining: Int): List<Snooze> =
        if (remaining > 0) snoozes else snoozes.filter { it.eclipseId != eclipseId }

    /**
     * When [next] starts while [current] still rings: the alarm to report as missed (it stops
     * unanswered), or null (fix B, A-5: before, the first ended with no notice at all).
     */
    fun replaced(current: RingingAlarm?, next: RingingAlarm): RingingAlarm? = current?.takeIf { it.key != next.key }

    /**
     * Fix D (17 October 2026, N-3): whether a boot broadcast re-plans as after a restart, when
     * AlarmManager holds nothing of this app. Android sends LOCKED_BOOT_COMPLETED and then, at the
     * first unlock, BOOT_COMPLETED in the same boot; the first re-plans after a restart and arms
     * everything, so the second must be a normal re-plan: before, it too threw away what was armed,
     * and an alarm whose time had passed a minute before the unlock was deleted while still on its
     * way, with no notice. [bootCount] is the phone's count of boots now (Settings.Global.BOOT_COUNT,
     * negative when unknown), [restartReplannedIn] the boot the last restart re-plan ran in
     * (negative for none). An unknown count re-plans as a restart, as before fix D.
     *
     * Fix E (17 October 2026, C-3, from the verification of fix D): the boot count alone can be
     * wrong (a build that never changes it, or changes it after LOCKED_BOOT_COMPLETED), so a boot
     * broadcast is also a restart when AlarmManager plainly holds nothing: [armedAheadLive] is false
     * when the stored alarms still to come (armed for an instant after now, [codesToProbe]) exist and
     * none of them has a live pending intent. It is null when there is nothing to probe: an alarm
     * whose instant has passed may have been delivered already, its pending intent gone while its
     * record is still on its way to the fire receiver, so its absence proves nothing.
     */
    fun bootIsRestart(bootCount: Int, restartReplannedIn: Int, armedAheadLive: Boolean? = null): Boolean =
        bootCount < 0 || bootCount != restartReplannedIn || armedAheadLive == false

    /**
     * Fix E (C-3): the request codes whose pending intents tell whether AlarmManager still holds
     * this app's alarms: those of [armed] whose stored instant ([armedAt]) is after [now]. Without a
     * restart (or a force stop) each of them is still registered.
     */
    fun codesToProbe(armed: Set<Int>, armedAt: Map<Int, Long>, now: Long): List<Int> =
        armed.filter { code -> (armedAt[code] ?: 0L) > now }

    /**
     * Fix E (17 October 2026, C-1 and C-2, from the verification of fix D; replaces fix D's
     * lostToRestart and the fire receiver's own late notice): the alarms a re-plan reports as
     * missed, one rule for every re-plan. Of [stored], a record [plan] deleted as passed or expired
     * (never one deleted as invalid or for an unknown eclipse, never [drop], the record the fire
     * receiver has just rung or found moved) whose request code was armed ([armedBefore]) and whose
     * stored armed instant ([armedAtBefore]) is more than [LATE_LIMIT_MS] before [now] (from the very
     * millisecond at which [AlarmScheduler.plan] stops keeping it for its receiver, so no deletion
     * falls between the two): its alarm can no longer ring, and it never rang (a record that rings is deleted at once), so it gets the
     * "Missed" notice. That covers an alarm held back by Android and deleted by the next re-plan,
     * the unlock or the app coming to the front (C-2), and one that arrives too late to ring.
     *
     * A change of zone that moves an alarm into the past while its armed instant is still ahead
     * reports nothing, also after a restart (C-1; spec 9.4: deleted without a notice). An armed
     * instant that is not known reports nothing.
     *
     * After a restart ([afterRestart]) nothing is on its way to the fire receiver, so the window of
     * [LATE_LIMIT_MS] in which a normal re-plan keeps an armed alarm for its receiver does not
     * apply: there an armed instant at or before [now] is enough, as fix D reported (the phone was
     * off or restarting when it came).
     */
    fun missed(
        stored: List<AlarmRecord>,
        plan: Plan,
        armedBefore: Set<Int>,
        armedAtBefore: Map<Int, Long>,
        now: Long,
        afterRestart: Boolean,
        drop: String? = null,
    ): List<AlarmRecord> {
        val gone = plan.deleted.filter { it.second == "passed" || it.second == "expired" }.mapTo(HashSet()) { it.first }
        return stored.filter { record ->
            if (record.id !in gone || record.id == drop) return@filter false
            val code = AlarmScheduler.requestCodeFor(record.id)
            val armedAt = armedAtBefore[code]
            code in armedBefore && armedAt != null && armedAt > 0L &&
                if (afterRestart) armedAt <= now else armedAt <= now - LATE_LIMIT_MS
        }.distinctBy { it.id }
    }

    /** Fix E (C-4): the most "Missed" notices kept waiting to be posted. */
    const val MAX_UNTOLD = 100

    /**
     * Fix E (C-4): the "Missed" notices waiting to be posted, [waiting] plus the newly [missed],
     * once per record, the newest [MAX_UNTOLD]. Stored in the same save as the re-plan that deleted
     * the records, so a process that dies before posting them posts them at its next start.
     */
    fun untold(waiting: List<AlarmRecord>, missed: List<AlarmRecord>): List<AlarmRecord> =
        (waiting + missed).distinctBy { it.id }.takeLast(MAX_UNTOLD)
}
