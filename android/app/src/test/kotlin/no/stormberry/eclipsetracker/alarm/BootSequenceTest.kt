package no.stormberry.eclipsetracker.alarm

import no.stormberry.eclipsetracker.WebRoot
import no.stormberry.eclipsetracker.core.AlarmRecord
import no.stormberry.eclipsetracker.core.AlarmSpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/**
 * Fix D (17 October 2026, N-3, found by the independent verification of fix C): a restart with a
 * PIN sends LOCKED_BOOT_COMPLETED, which re-plans and arms everything before the first unlock,
 * and then, at the unlock, BOOT_COMPLETED in the same boot. Both re-planned as after a restart,
 * so the second threw away what the first had armed: an alarm whose time had passed a minute
 * before the unlock was deleted while still on its way to its fire receiver, and nothing said so.
 * These tests replay the sequence as AlarmScheduling.replanAfterBoot runs it (the boot noted by
 * the first re-plan, the codes and instants it stored), and the "Missed" notice a restart that
 * costs an alarm gives. Fix E (17 October 2026): through ReplanHarness, with FireRules.missed in
 * place of fix D's lostToRestart and the pending intents as a second sign of a restart (C-3).
 */
class BootSequenceTest {
    private val catalogue = WebRoot.catalogue
    private val oslo = ZoneId.of("Europe/Oslo")
    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    /** Noon in Oslo on 20 February 2027, the day before the lunar eclipse (00:12 on 21 February in Oslo): 11:00 UTC. */
    private val rec = AlarmRecord("0".repeat(31) + "1", "2027-02-20-lunar", AlarmSpec.Day(1, "12:00"))
    private val code = AlarmScheduler.requestCodeFor(rec.id)
    private val at = ms("2027-02-20T11:00:00Z")

    private fun bootBroadcast(store: Store, bootCount: Int, now: Long): Step = ReplanHarness.boot(store, bootCount, now, oslo)

    @Test fun theFirstBootBroadcastOfABootIsARestartAndTheSecondIsNot() {
        assertTrue(FireRules.bootIsRestart(5, 4))
        assertTrue(FireRules.bootIsRestart(5, -1))
        assertFalse(FireRules.bootIsRestart(5, 5))
        // The boot count unknown: every boot broadcast re-plans as a restart, as before fix D.
        assertTrue(FireRules.bootIsRestart(-1, -1))
        assertTrue(FireRules.bootIsRestart(-1, 5))
        // Fix E (C-3): the pending intents of the alarms still to come gone is a restart too; still
        // there, or nothing to ask about, leaves it to the boot count.
        assertTrue(FireRules.bootIsRestart(5, 5, armedAheadLive = false))
        assertFalse(FireRules.bootIsRestart(5, 5, armedAheadLive = true))
        assertFalse(FireRules.bootIsRestart(5, 5, armedAheadLive = null))
        assertTrue(FireRules.bootIsRestart(5, 4, armedAheadLive = true))
    }

    /** The verifier's case: armed at the locked boot two minutes before noon, unlocked a minute after it. */
    @Test fun anUnlockAMinuteAfterAnAlarmLeavesItToItsReceiver() {
        // Before the restart (boot 4) the alarm was armed; the restart erased it from AlarmManager.
        val before = Store(listOf(rec.toJson()), setOf(code), mapOf(code to at), restartBoot = 4).restarted()
        val locked = bootBroadcast(before, bootCount = 5, now = at - 120_000L)
        assertTrue(locked.restart)
        assertEquals(listOf(at), locked.plan.armed.map { it.fireAt })
        assertTrue(locked.missed.isEmpty())
        assertEquals(5, locked.store.restartBoot)

        val unlock = bootBroadcast(locked.store, bootCount = 5, now = at + 60_000L)
        assertFalse(unlock.restart)
        assertEquals("not deleted at the unlock", emptyList<Pair<String, String>>(), unlock.plan.deleted)
        assertEquals(listOf(rec), unlock.plan.keep)
        assertEquals(listOf(at), unlock.plan.armed.map { it.fireAt })
        assertTrue(unlock.missed.isEmpty())
        // Its alarm, armed at the locked boot, arrives seconds later and rings.
        assertEquals(FireDecision.Ring, FireRules.decide(rec, catalogue[rec.eclipseId], oslo, at, at + 70_000L))

        // What happened before fix D: the unlock re-planned as a restart and deleted it as passed.
        val old = AlarmScheduler.plan(locked.store.records, catalogue, oslo, at + 60_000L)
        assertEquals(listOf(rec.id to "passed"), old.deleted)
    }

    /** Held back past the late limit after the unlock (Android 12's app standby): not rung late, deleted, and reported by that re-plan (fix E). */
    @Test fun anAlarmHeldBackPastTheLateLimitIsDeletedWithTheMissedNotice() {
        val locked = Store(listOf(rec.toJson()), setOf(code), mapOf(code to at), restartBoot = 5)
        val now = at + FireRules.LATE_LIMIT_MS + 60_000L
        assertEquals(FireDecision.Late, FireRules.decide(rec, catalogue[rec.eclipseId], oslo, at, now))
        val after = bootBroadcast(locked, bootCount = 5, now = now)
        assertEquals(listOf(rec.id to "passed"), after.plan.deleted)
        assertTrue(after.store.records.isEmpty())
        assertEquals(listOf(rec), after.missed)
    }

    /** The phone off over the alarm's time: the restart re-plan deletes it and reports it, once. */
    @Test fun aRestartThatCostsAnAlarmReportsIt() {
        val later = AlarmRecord("0".repeat(31) + "2", "2027-02-20-lunar", AlarmSpec.Before(30))
        val never = AlarmRecord("0".repeat(31) + "3", "2027-02-20-lunar", AlarmSpec.Day(1, "11:00"))
        val laterCode = AlarmScheduler.requestCodeFor(later.id)
        val laterAt = AlarmScheduler.plan(listOf(later.toJson()), catalogue, oslo, at).armed.single().fireAt
        // `never` passed too, but was not armed before the restart (never happens with fewer than 100): not reported.
        val before = Store(
            listOf(rec.toJson(), later.toJson(), never.toJson()), setOf(code, laterCode),
            mapOf(code to at, laterCode to laterAt), restartBoot = 4,
        ).restarted()
        // Five minutes after it: a restart re-plan keeps nothing on its way, so the notice is due at once.
        val locked = bootBroadcast(before, bootCount = 5, now = at + 5 * 60_000L)
        assertEquals(listOf(rec.id to "passed", never.id to "passed"), locked.plan.deleted)
        assertEquals(listOf(rec), locked.missed)
        assertEquals(listOf(later), locked.plan.keep)
        // BOOT_COMPLETED in the same boot: a normal re-plan, nothing reported a second time.
        val again = bootBroadcast(locked.store, bootCount = 5, now = at + 6 * 60_000L)
        assertFalse(again.restart)
        assertTrue(again.missed.isEmpty())
    }

    /** Off for days, past the 48 hours after greatest eclipse: the record expired, the alarm was still lost. */
    @Test fun anExpiredRecordArmedBeforeTheRestartIsReportedToo() {
        val before = Store(listOf(rec.toJson()), setOf(code), mapOf(code to at), restartBoot = 4).restarted()
        val step = bootBroadcast(before, bootCount = 5, now = ms("2027-02-24T08:00:00Z"))
        assertEquals(listOf(rec.id to "expired"), step.plan.deleted)
        assertEquals(listOf(rec), step.missed)
    }

    /** An alarm still to ring after the restart is armed again and not reported. */
    @Test fun aRestartBeforeTheAlarmReportsNothing() {
        val before = Store(listOf(rec.toJson()), setOf(code), mapOf(code to at), restartBoot = 4).restarted()
        val step = bootBroadcast(before, bootCount = 5, now = at - 3_600_000L)
        assertEquals(listOf(at), step.plan.armed.map { it.fireAt })
        assertTrue(step.missed.isEmpty())
    }
}
