package no.stormberry.eclipsetracker.alarm

import no.stormberry.eclipsetracker.WebRoot
import no.stormberry.eclipsetracker.core.AlarmRecord
import no.stormberry.eclipsetracker.core.AlarmSpec
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/**
 * Fix E (17 October 2026): the verification of fix D's probes P1 to P5, turned into tests of the
 * fixed behaviour, and C-3 and C-4. One rule for every re-plan (FireRules.missed): a record deleted
 * as passed (or expired) whose alarm was armed and whose armed instant is more than 10 minutes in
 * the past gets the "Missed" notice; after a restart, any armed instant already past. A change of
 * zone whose armed instant is still ahead never does (spec 9.4).
 */
class MissedNoticeTest {
    private val catalogue = WebRoot.catalogue
    private val oslo = ZoneId.of("Europe/Oslo")
    private val helsinki = ZoneId.of("Europe/Helsinki")
    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()
    private val min = 60_000L

    /** Noon on 20 February 2027: 11:00 UTC in Oslo, 10:00 UTC in Helsinki. */
    private val rec = AlarmRecord("0".repeat(31) + "1", "2027-02-20-lunar", AlarmSpec.Day(1, "12:00"))
    private val code = AlarmScheduler.requestCodeFor(rec.id)
    private val at = ms("2027-02-20T11:00:00Z")

    /** Thirty minutes before the lunar eclipse of 20 February 2027, still to come at every moment below. */
    private val ahead = AlarmRecord("0".repeat(31) + "2", "2027-02-20-lunar", AlarmSpec.Before(30))
    private val aheadCode = AlarmScheduler.requestCodeFor(ahead.id)
    private val aheadAt = AlarmScheduler.plan(listOf(ahead.toJson()), catalogue, oslo, at).armed.single().fireAt

    private fun armed(vararg records: AlarmRecord): Store {
        val step = ReplanHarness.normal(Store(records.map { it.toJson() }, emptySet(), emptyMap(), restartBoot = 4), at - 120 * min, oslo)
        return step.store
    }

    // ------------------------------------------------------------------ P1 (C-1)

    /** P1: off in Oslo before the alarm, on in Helsinki before its ARMED instant: a zone move, deleted without a notice. */
    @Test fun p1_aZoneMoveWhileOffIsNotReported() {
        val before = armed(rec).restarted()
        assertEquals(mapOf(code to at), before.armedAt)
        val now = ms("2027-02-20T10:45:00Z") // 12:45 in Helsinki; the armed instant 11:00 UTC still ahead
        val step = ReplanHarness.boot(before, bootCount = 5, now = now, zone = helsinki)
        assertTrue(step.restart)
        assertEquals(listOf(rec.id to "passed"), step.plan.deleted)
        assertTrue("fix D reported this one", step.missed.isEmpty())
    }

    /** The same move without a restart (the zone changed while the phone was on): no notice either. */
    @Test fun p1_aZoneMoveWithoutARestartIsNotReported() {
        val step = ReplanHarness.normal(armed(rec), ms("2027-02-20T10:05:00Z"), helsinki)
        assertEquals(listOf(rec.id to "passed"), step.plan.deleted)
        assertTrue(step.missed.isEmpty())
    }

    /** Off over the armed instant itself and back on in another zone: the restart cost it, so it is reported. */
    @Test fun p1_offOverTheArmedInstantIsReportedWhateverTheZone() {
        val step = ReplanHarness.boot(armed(rec).restarted(), bootCount = 5, now = at + 3 * min, zone = helsinki)
        assertEquals(listOf(rec), step.missed)
    }

    // ------------------------------------------------------------------ P2 (C-2)

    /** P2: inexact alarm armed at the locked boot, held back by Android; first unlock 15 min after its time. Deleted and reported, once. */
    @Test fun p2_aHeldBackAlarmDeletedByTheUnlockIsReported() {
        val before = armed(rec).restarted()
        val locked = ReplanHarness.boot(before, bootCount = 5, now = at - min, zone = oslo)
        assertTrue(locked.missed.isEmpty())
        val unlock = ReplanHarness.boot(locked.store, bootCount = 5, now = at + 15 * min, zone = oslo)
        assertFalse(unlock.restart)
        assertEquals(listOf(rec.id to "passed"), unlock.plan.deleted)
        assertTrue(unlock.store.records.isEmpty())
        assertFalse(code in unlock.store.armed)
        assertEquals("fix D was silent here", listOf(rec), unlock.missed)
        // The held-back alarm arrives later: its record is gone, nothing rings, and the re-plan reports nothing again.
        assertEquals(FireDecision.Gone, FireRules.decide(null, catalogue[rec.eclipseId], oslo, at, at + 16 * min))
        assertTrue(ReplanHarness.normal(unlock.store, at + 16 * min, oslo).missed.isEmpty())
    }

    /** The same by the app coming to the front, with no boot at all. */
    @Test fun p2_theAppComingToTheFrontReportsIt() {
        val step = ReplanHarness.normal(armed(rec), at + 11 * min, oslo)
        assertEquals(listOf(rec), step.missed)
    }

    /** An alarm that arrives too late to ring: the receiver's re-plan reports it (fix D's own late notice is gone). */
    @Test fun p2_aLateArrivalIsReportedByItsReplan() {
        val store = armed(rec)
        val now = at + 12 * min
        assertEquals(FireDecision.Late, FireRules.decide(rec, catalogue[rec.eclipseId], oslo, at, now))
        assertEquals(listOf(rec), ReplanHarness.normal(store, now, oslo).missed)
    }

    // ------------------------------------------------------------------ P3 (C-3)

    /** P3: a boot count that never changes (stuck at 4). An alarm still to come shows AlarmManager empty: a restart after all. */
    @Test fun p3_aStuckBootCountWithAnAlarmStillToCome() {
        val before = armed(rec, ahead).restarted()
        assertEquals(setOf(code, aheadCode), before.armed)
        val step = ReplanHarness.boot(before, bootCount = 4, now = at + 5 * min, zone = oslo)
        assertTrue("seen as a restart by the pending intents", step.restart)
        // Off over its time: deleted and reported, never rung late.
        assertEquals(listOf(rec.id to "passed"), step.plan.deleted)
        assertEquals(listOf(rec), step.missed)
        assertEquals(listOf(aheadAt), step.plan.armed.map { it.fireAt })
        // The unlock in the same boot: the pending intents are back, so a normal re-plan.
        val unlock = ReplanHarness.boot(step.store, bootCount = 4, now = at + 6 * min, zone = oslo)
        assertFalse(unlock.restart)
        assertTrue(unlock.missed.isEmpty())
    }

    /** P3: stuck, and nothing still to come to ask about: left to the boot count, as before (degrades to re-arm, never to unarmed). */
    @Test fun p3_aStuckBootCountWithNothingToAskAbout() {
        val before = armed(rec).restarted()
        assertTrue(FireRules.codesToProbe(before.armed, before.armedAt, at + 5 * min).isEmpty())
        // Off for 30 minutes: a normal re-plan deletes it, and now reports it (more than 10 minutes).
        val late = ReplanHarness.boot(before, bootCount = 4, now = at + 30 * min, zone = oslo)
        assertFalse(late.restart)
        assertEquals(listOf(rec.id to "passed"), late.plan.deleted)
        assertEquals(listOf(rec), late.missed)
        // Back on 5 minutes after it: kept and armed for its past instant, so it rings 5 minutes late (inside the fire rule).
        val soon = ReplanHarness.boot(before, bootCount = 4, now = at + 5 * min, zone = oslo)
        assertEquals(listOf(at), soon.plan.armed.map { it.fireAt })
        assertTrue(soon.missed.isEmpty())
    }

    /** C-3: a force stop (Android 15 and later sends both boot broadcasts in the same boot) is seen by the pending intents. */
    @Test fun c3_aForceStopIsARestartByThePendingIntents() {
        val noted = armed(rec, ahead).copy(restartBoot = 7)
        val step = ReplanHarness.boot(noted.restarted(), bootCount = 7, now = at + 3 * min, zone = oslo)
        assertTrue(step.restart)
        assertEquals(listOf(rec), step.missed)
        // Without the force stop the same broadcast is a normal re-plan that leaves the alarm to its receiver.
        val normal = ReplanHarness.boot(noted, bootCount = 7, now = at + 3 * min, zone = oslo)
        assertFalse(normal.restart)
        assertEquals(listOf(rec), normal.plan.keep.filter { it.id == rec.id })
        assertTrue(normal.missed.isEmpty())
    }

    /** C-3: only alarms still to come are asked about; an armed instant already passed may be on its way with its intent spent. */
    @Test fun c3_onlyAlarmsStillToComeAreProbed() {
        val armedAt = mapOf(code to at, aheadCode to aheadAt, 42 to at + min)
        assertEquals(listOf(aheadCode), FireRules.codesToProbe(setOf(code, aheadCode), armedAt, at + min))
        assertEquals(listOf(code, aheadCode), FireRules.codesToProbe(setOf(code, aheadCode), armedAt, at - min))
        assertTrue(FireRules.codesToProbe(setOf(99), armedAt, at).isEmpty())
    }

    // ------------------------------------------------------------------ P4

    /** P4: the boot count unknown (-1): both broadcasts re-plan as restarts; the unlock race deletes and reports once, the alarm then arrives Gone. */
    @Test fun p4_anUnknownBootCount() {
        val before = armed(rec).copy(restartBoot = -1).restarted()
        val locked = ReplanHarness.boot(before, bootCount = -1, now = at - min, zone = oslo)
        assertTrue(locked.missed.isEmpty())
        assertEquals(-1, locked.store.restartBoot)
        val unlock = ReplanHarness.boot(locked.store, bootCount = -1, now = at + min, zone = oslo)
        assertTrue(unlock.restart)
        assertEquals(listOf(rec.id to "passed"), unlock.plan.deleted)
        assertEquals(listOf(rec), unlock.missed)
        assertTrue(unlock.store.records.isEmpty())
        assertEquals(FireDecision.Gone, FireRules.decide(null, catalogue[rec.eclipseId], oslo, at, at + 70_000L))
        assertTrue(ReplanHarness.normal(unlock.store, at + 2 * min, oslo).missed.isEmpty())
    }

    // ------------------------------------------------------------------ P5

    /** P5: what the rule never reports: an invalid record, one never armed, one with no known armed instant, the record just rung, and a normal re-plan within 10 minutes. */
    @Test fun p5_theRuleFilters() {
        val bad = JSONObject(mapOf("v" to 1))
        val stored = listOf<Any?>(rec.toJson(), bad, rec.toJson())
        val now = at + 11 * min
        fun missed(armed: Set<Int>, armedAt: Map<Int, Long>, n: Long = now, restart: Boolean = false, drop: String? = null) =
            AlarmScheduler.replan(stored, catalogue, oslo, n, armed, armedAt, restart, drop).missed

        assertEquals("once, despite the duplicate", listOf(rec), missed(setOf(code), mapOf(code to at)))
        assertTrue("never armed", missed(emptySet(), mapOf(code to at)).isEmpty())
        assertTrue("armed instant unknown", missed(setOf(code), emptyMap()).isEmpty())
        assertTrue("the record the receiver rang", missed(setOf(code), mapOf(code to at), drop = rec.id).isEmpty())
        // The boundary: a millisecond inside the late limit it is kept for its receiver and not reported;
        // from the millisecond the plan deletes it, it is reported (no deletion falls between the two).
        val inside = AlarmScheduler.replan(stored, catalogue, oslo, at + FireRules.LATE_LIMIT_MS - 1, setOf(code), mapOf(code to at), false)
        assertEquals(listOf(rec), inside.plan.keep)
        assertTrue(inside.missed.isEmpty())
        val edge = AlarmScheduler.replan(stored, catalogue, oslo, at + FireRules.LATE_LIMIT_MS, setOf(code), mapOf(code to at), false)
        assertTrue(edge.plan.keep.isEmpty())
        assertEquals(listOf(rec), edge.missed)
        // After a restart the armed instant reached is enough; one still ahead is not.
        assertEquals(listOf(rec), missed(setOf(code), mapOf(code to at), n = at + 1, restart = true))
        assertTrue(missed(setOf(code), mapOf(code to at + 5 * min), n = at + 1, restart = true).isEmpty())
        // Deleted as invalid only (a ninth record, a broken one): never reported.
        val plan = AlarmScheduler.plan(stored, catalogue, oslo, now)
        assertEquals(listOf(rec.id to "passed", "" to "invalid", rec.id to "invalid"), plan.deleted)
    }

    // ------------------------------------------------------------------ C-4

    /** C-4: the notices owed are stored with the deletion; a process that dies before posting them still has them at its next start. */
    @Test fun c4_theOwedNoticesSurviveADeathBeforePosting() {
        val held = ReplanHarness.normal(armed(rec, ahead), at + 15 * min, oslo)
        assertEquals(listOf(rec), held.store.untold)
        // The process dies before posting: the next re-plan owes nothing new, the old notice is still owed.
        val next = ReplanHarness.normal(held.store, at + 16 * min, oslo)
        assertTrue(next.missed.isEmpty())
        assertEquals(listOf(rec), next.store.untold)
        // Owed twice is posted once (and a notice is tagged by its record id, so a repost replaces itself).
        assertEquals(listOf(rec), FireRules.untold(listOf(rec), listOf(rec)))
        // Bounded.
        val many = (1..150).map { AlarmRecord("%032x".format(it), "2027-02-20-lunar", AlarmSpec.Before(30)) }
        val capped = FireRules.untold(many, emptyList())
        assertEquals(FireRules.MAX_UNTOLD, capped.size)
        assertEquals(many.last(), capped.last())
    }
}
