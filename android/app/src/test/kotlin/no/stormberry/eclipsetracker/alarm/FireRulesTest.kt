package no.stormberry.eclipsetracker.alarm

import no.stormberry.eclipsetracker.WebRoot
import no.stormberry.eclipsetracker.core.AlarmRecord
import no.stormberry.eclipsetracker.core.AlarmSpec
import no.stormberry.eclipsetracker.core.Json
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/**
 * Fix B (16 October 2026): the decisions taken when an alarm arrives (A-8, A-10), when a snooze is
 * pressed or arrives (A-2, A-6, A-7), when a second alarm starts while one rings (A-5), and what
 * counts as notifications refused (A-1), each replayed with the zone and the moment as arguments.
 */
class FireRulesTest {
    private val catalogue = WebRoot.catalogue
    private val oslo = ZoneId.of("Europe/Oslo")
    private val tokyo = ZoneId.of("Asia/Tokyo")
    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()
    private val solar = catalogue["2027-02-06-solar"]!!
    private val lunar = catalogue["2027-02-20-lunar"]!!
    private val noonOnTheDay = AlarmRecord("0".repeat(31) + "1", "2027-02-06-solar", AlarmSpec.Day(0, "12:00"))
    private val thirtyBefore = AlarmRecord("0".repeat(31) + "2", "2027-02-06-solar", AlarmSpec.Before(30))

    // ------------------------------------------------------------------ the fire (A-8, A-10)

    @Test fun anAlarmOnTimeRings() {
        val at = ms("2027-02-06T11:00:00Z") // noon in Oslo
        assertSame(FireDecision.Ring, FireRules.decide(noonOnTheDay, solar, oslo, at, at))
        // Within two seconds early, and up to ten minutes late, it still rings.
        assertSame(FireDecision.Ring, FireRules.decide(noonOnTheDay, solar, oslo, at, at - 2_000L))
        assertSame(FireDecision.Ring, FireRules.decide(noonOnTheDay, solar, oslo, at, at + 10 * 60_000L))
        // A before-alarm is plain subtraction from the rounded greatest eclipse.
        val b = ms("2027-02-06T15:30:00Z")
        assertSame(FireDecision.Ring, FireRules.decide(thirtyBefore, solar, tokyo, b, b + 500L))
    }

    @Test fun aDeletedRecordOrAnUnknownEclipseDoesNotRing() {
        val at = ms("2027-02-06T11:00:00Z")
        assertSame(FireDecision.Gone, FireRules.decide(null, solar, oslo, at, at))
        assertSame(FireDecision.Gone, FireRules.decide(noonOnTheDay, null, oslo, at, at))
        assertSame(FireDecision.Gone, FireRules.decide(noonOnTheDay, lunar, oslo, at, at), "a record of another eclipse")
    }

    @Test fun earlyMeansTheClockMovedAndLateIsMissed() {
        val at = ms("2027-02-06T11:00:00Z")
        assertSame(FireDecision.Early, FireRules.decide(noonOnTheDay, solar, oslo, at, at - 2_001L))
        assertSame(FireDecision.Early, FireRules.decide(noonOnTheDay, solar, oslo, at, at - 3_600_000L))
        assertSame(FireDecision.Late, FireRules.decide(noonOnTheDay, solar, oslo, at, at + 10 * 60_000L + 1L))
        assertSame(FireDecision.Late, FireRules.decide(noonOnTheDay, solar, oslo, at, at + 6 * 3_600_000L))
    }

    /** A-8: the zone changed seconds before the alarm, and the change has not been re-planned yet. */
    @Test fun aChangeOfZoneNotYetReplannedDoesNotRingTwice() {
        val armedInOslo = ms("2027-02-06T11:00:00Z")
        // The phone is now in Tokyo: noon on the Tokyo day of greatest eclipse is 7 February 03:00 UTC.
        val decision = FireRules.decide(noonOnTheDay, solar, tokyo, armedInOslo, armedInOslo)
        assertEquals(FireDecision.Moved(ms("2027-02-07T03:00:00Z")), decision)
        // The re-plan the receiver then runs keeps the record and arms the Tokyo instant, where it rings once.
        val plan = AlarmScheduler.plan(listOf(noonOnTheDay.toJson()), catalogue, tokyo, armedInOslo)
        assertEquals(listOf(noonOnTheDay), plan.keep)
        val tokyoNoon = plan.armed.single().fireAt
        assertEquals("2027-02-07T03:00:00Z", Json.instant(tokyoNoon))
        assertSame(FireDecision.Ring, FireRules.decide(noonOnTheDay, solar, tokyo, tokyoNoon, tokyoNoon))
        // Moved into the past (a flight west: Los Angeles noon on 6 February was 20:00 UTC, so armed in
        // Tokyo for the 7th 03:00 UTC... the other way round: armed in Los Angeles, now in Oslo).
        val armedInLa = ms("2027-02-06T20:00:00Z")
        val moved = FireRules.decide(noonOnTheDay, solar, oslo, armedInLa, armedInLa)
        assertEquals(FireDecision.Moved(ms("2027-02-06T11:00:00Z")), moved)
        // ...and the re-plan deletes it as passed: never rung late (C-23).
        val gone = AlarmScheduler.plan(listOf(noonOnTheDay.toJson()), catalogue, oslo, armedInLa)
        assertEquals(listOf(noonOnTheDay.id to "passed"), gone.deleted)
        // A before-alarm follows the eclipse, so a change of zone never moves it.
        val b = ms("2027-02-06T15:30:00Z")
        assertSame(FireDecision.Ring, FireRules.decide(thirtyBefore, solar, ZoneId.of("America/Los_Angeles"), b, b))
    }

    /** C-1: an alarm after greatest eclipse (noon on the day of a lunar eclipse at 00:13 in Oslo) rings. */
    @Test fun anAlarmAfterGreatestEclipseRings() {
        val r = AlarmRecord("0".repeat(31) + "3", "2027-02-20-lunar", AlarmSpec.Day(0, "12:00"))
        val at = ms("2027-02-21T11:00:00Z")
        assertSame(FireDecision.Ring, FireRules.decide(r, lunar, oslo, at, at))
    }

    @Test fun withoutAnArmedTimeTheFreshTimeIsUsed() {
        val at = ms("2027-02-06T11:00:00Z")
        assertSame(FireDecision.Ring, FireRules.decide(noonOnTheDay, solar, oslo, 0L, at))
        assertSame(FireDecision.Early, FireRules.decide(noonOnTheDay, solar, oslo, 0L, at - 60_000L))
        assertSame(FireDecision.Late, FireRules.decide(noonOnTheDay, solar, oslo, 0L, at + 11 * 60_000L))
    }

    // ------------------------------------------------------------------ snoozes (A-2, A-6, A-7)

    @Test fun aSnoozeRingsUnlessLateOrEarly() {
        val at = ms("2027-02-06T11:09:00Z")
        assertSame(FireDecision.Ring, FireRules.decideSnooze(at, at))
        assertSame(FireDecision.Ring, FireRules.decideSnooze(at, at + 10 * 60_000L))
        assertSame(FireDecision.Late, FireRules.decideSnooze(at, at + 10 * 60_000L + 1L), "an inexact snooze hours late does not ring")
        assertSame(FireDecision.Early, FireRules.decideSnooze(at, at - 5_000L))
        assertSame(FireDecision.Ring, FireRules.decideSnooze(0L, at))
    }

    @Test fun armingFallsBackToInexactOnAnyFailureAndNeverThrows() {
        var inexact = 0
        assertEquals(ArmResult.EXACT, FireRules.armWithFallback({ }, { inexact++ }))
        assertEquals(0, inexact)
        assertEquals(ArmResult.INEXACT, FireRules.armWithFallback({ throw SecurityException("exact alarms off") }, { inexact++ }))
        // A-7: a failure of another kind used to crash the receiver after the tone had stopped.
        assertEquals(ArmResult.INEXACT, FireRules.armWithFallback({ throw IllegalStateException("too many alarms") }, { inexact++ }))
        assertEquals(2, inexact)
        assertEquals(ArmResult.FAILED, FireRules.armWithFallback({ throw SecurityException() }, { throw IllegalStateException() }))
    }

    private fun snooze(id: Char, eclipseId: String, at: Long) = Snooze(id.toString().repeat(32), eclipseId, at, "Annular solar eclipse", "On the day of the eclipse at 12:00")

    @Test fun aRestartKeepsTheSnoozesStillToRingAndForgetsThosePast() {
        val now = ms("2027-02-06T11:20:00Z")
        val due = snooze('a', "2027-02-06-solar", ms("2027-02-06T11:29:00Z"))
        val justPast = snooze('b', "2027-02-06-solar", ms("2027-02-06T11:12:00Z"))
        val longPast = snooze('c', "2027-02-06-solar", ms("2027-02-06T11:09:00Z"))
        assertEquals(listOf(justPast, due), FireRules.keepSnoozes(listOf(due, justPast, longPast), now))
        // A second snooze of the same alarm replaces the first.
        val again = due.copy(at = ms("2027-02-06T11:38:00Z"))
        assertEquals(listOf(again), FireRules.putSnooze(listOf(due), again))
        assertEquals(listOf(again), FireRules.keepSnoozes(listOf(due, again), now))
        // At most sixteen.
        val many = (0 until 20).map { snooze("0123456789abcdefghij"[it], "2027-02-06-solar", now + it * 60_000L) }
        assertEquals(16, FireRules.keepSnoozes(many, now).size)
    }

    @Test fun deletingEveryAlarmOfAnEclipseTakesItsSnoozes() {
        val s1 = snooze('a', "2027-02-06-solar", 1L)
        val s2 = snooze('b', "2027-02-20-lunar", 2L)
        assertEquals(listOf(s2), FireRules.snoozesAfterSet(listOf(s1, s2), "2027-02-06-solar", 0))
        assertEquals("an edit leaves a snooze alone", listOf(s1, s2), FireRules.snoozesAfterSet(listOf(s1, s2), "2027-02-06-solar", 1))
    }

    @Test fun aStoredSnoozeIsReadBackExactlyAndAnythingElseIsRefused() {
        val s = snooze('d', "2027-02-06-solar", ms("2027-02-06T11:09:00Z"))
        assertEquals(s, Snooze.parse(JSONObject(s.toJson().toString())))
        val good = s.toJson()
        assertNull(Snooze.parse(JSONObject(good.toString()).put("extra", 1)))
        assertNull(Snooze.parse(JSONObject(good.toString()).put("v", 2)))
        assertNull(Snooze.parse(JSONObject(good.toString()).put("id", "nope")))
        assertNull(Snooze.parse(JSONObject(good.toString()).put("eclipseId", "2027-02-06-other")))
        assertNull(Snooze.parse(JSONObject(good.toString()).put("at", -1)))
        assertNull(Snooze.parse(JSONObject(good.toString()).put("at", "soon")))
        assertNull(Snooze.parse(JSONObject(good.toString()).put("title", "x".repeat(201))))
        assertNull(Snooze.parse("not a snooze"))
    }

    // ------------------------------------------------------------------ two alarms at once (A-5)

    @Test fun aSecondAlarmReportsTheFirstAsMissed() {
        val first = RingingAlarm(noonOnTheDay.id, "2027-02-06-solar", "Annular solar eclipse", "On the day of the eclipse at 12:00", 1_000L)
        val second = RingingAlarm(thirtyBefore.id, "2027-02-06-solar", "Annular solar eclipse", "30 minutes before greatest eclipse", 2_000L)
        assertNull(FireRules.replaced(null, second))
        assertEquals(first, FireRules.replaced(first, second))
        assertNull("the same ring again is not a second alarm", FireRules.replaced(first, first.copy()))
        // A snooze of the same alarm rings at another moment: a different ring.
        assertEquals(first, FireRules.replaced(first, first.copy(fireAt = 3_000L)))
    }

    // ------------------------------------------------------------------ notifications refused (A-1)

    @Test fun aBlockedOrLoweredRingChannelCountsAsNotificationsRefused() {
        // IMPORTANCE_NONE 0 (blocked), LOW 2, DEFAULT 3 ("High" in some versions' words), HIGH 4 (Urgent), MAX 5.
        for (lowered in listOf(0, 1, 2, 3)) {
            assertEquals(listOf(Problem.NOTIFICATIONS), AlarmCapability.problemsFrom(33, true, lowered, true, true))
        }
        assertEquals(emptyList<Problem>(), AlarmCapability.problemsFrom(33, true, 4, true, true))
        assertEquals(emptyList<Problem>(), AlarmCapability.problemsFrom(33, true, 5, true, true))
        // Not made yet (it is made at Urgent), or before Android 8 (no channels): nothing to report.
        assertEquals(emptyList<Problem>(), AlarmCapability.problemsFrom(33, true, null, true, true))
        assertEquals(emptyList<Problem>(), AlarmCapability.problemsFrom(25, true, 0, true, true))
        // Only one problem, however many reasons.
        assertEquals(listOf(Problem.NOTIFICATIONS), AlarmCapability.problemsFrom(33, false, 0, true, true))
    }

    // ------------------------------------------------------------------ the backstop (A-2)

    @Test fun theBackstopFollowsTheNearestAlarmAndGoesWhenNoneIsLeft() {
        val now = ms("2026-10-16T12:00:00Z")
        val sink = FakeAlarmSink()
        val plan = AlarmScheduler.plan(listOf(thirtyBefore.toJson(), noonOnTheDay.toJson()), catalogue, oslo, now)
        val armed = AlarmScheduler.apply(plan, sink, emptySet())
        assertEquals(noonOnTheDay.id, sink.guarded?.record?.id)
        assertEquals("2027-02-06T11:00:00Z", Json.instant(sink.guarded!!.fireAt))
        // After the noon alarm rang, the backstop moves to the next one.
        val after = AlarmScheduler.plan(plan.keepJson().let { a -> List(a.length()) { a.get(it) } }, catalogue, oslo, ms("2027-02-06T11:00:00Z"))
        AlarmScheduler.apply(after, sink, armed)
        assertEquals(thirtyBefore.id, sink.guarded?.record?.id)
        // Nothing left: the backstop is cleared.
        AlarmScheduler.apply(AlarmScheduler.plan(emptyList(), catalogue, oslo, now), sink, emptySet())
        assertNull(sink.guarded)
        assertTrue(sink.guards >= 3)
    }

    // ------------------------------------------------------------------ the re-plan racing a fire (F-1)

    /**
     * Found on the Android 12 emulator: a boot broadcast re-planned at 12:00:01 and deleted the
     * noon record as passed; its alarm, delivered at 12:00:04, found no record and nothing rang.
     */
    @Test fun aReplanBetweenAnAlarmsTimeAndItsDeliveryLeavesItToTheReceiver() {
        val at = ms("2027-02-06T11:00:00Z")
        val code = AlarmScheduler.requestCodeFor(noonOnTheDay.id)
        val stored = listOf(noonOnTheDay.toJson(), thirtyBefore.toJson())
        // Armed, one second past its time: kept, and armed again at its own instant.
        val racing = AlarmScheduler.plan(stored, catalogue, oslo, at + 1_000L, previouslyArmed = setOf(code), armedAt = mapOf(code to at))
        assertTrue(racing.keep.contains(noonOnTheDay))
        assertEquals(at, racing.armed.first { it.record == noonOnTheDay }.fireAt)
        // ...and when it arrives, it rings, and the receiver's own re-plan deletes it.
        assertSame(FireDecision.Ring, FireRules.decide(noonOnTheDay, solar, oslo, at, at + 4_000L))
        val after = AlarmScheduler.plan(stored, catalogue, oslo, at + 4_000L, previouslyArmed = setOf(code), drop = noonOnTheDay.id, armedAt = mapOf(code to at))
        assertEquals(listOf(noonOnTheDay.id to "passed"), after.deleted)
        // Not armed (after a restart AlarmManager holds nothing): deleted as missed, as before.
        assertEquals(listOf(noonOnTheDay.id to "passed"), AlarmScheduler.plan(stored, catalogue, oslo, at + 1_000L).deleted)
        // More than ten minutes past: deleted even if armed; never rung late.
        assertEquals(listOf(noonOnTheDay.id to "passed"), AlarmScheduler.plan(stored, catalogue, oslo, at + 10 * 60_000L + 1L, previouslyArmed = setOf(code), armedAt = mapOf(code to at)).deleted)
        // Fix C, S-1: armed, but the instant it was armed for is not known: deleted, never rung late.
        assertEquals(listOf(noonOnTheDay.id to "passed"), AlarmScheduler.plan(stored, catalogue, oslo, at + 1_000L, previouslyArmed = setOf(code)).deleted)
    }

    private fun assertSame(expected: FireDecision, actual: FireDecision, message: String) = assertEquals(message, expected, actual)
}
