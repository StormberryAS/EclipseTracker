package no.stormberry.eclipsetracker.alarm

import no.stormberry.eclipsetracker.WebRoot
import no.stormberry.eclipsetracker.core.AlarmRecord
import no.stormberry.eclipsetracker.core.AlarmSpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/**
 * Fix C (17 October 2026, S-1): F-1 meets a change of zone. The first test is the independent
 * verification's probe (verifyB/scratch/VerifierZoneF1Test.kt.probe), unchanged but for its name
 * and its two printed lines (what the stale alarm then meets is the second test's last check).
 * Before fix C the plan kept the record and armed it five minutes in the past, so it rang late.
 * The others pin down the rule as it now is: a passed record is kept for its fire receiver only
 * while its alarm is armed for the very instant worked out now.
 */
class ZoneChangeRaceTest {
    private val catalogue = WebRoot.catalogue
    private val helsinki = ZoneId.of("Europe/Helsinki")
    private val oslo = ZoneId.of("Europe/Oslo")
    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()
    private val rec = AlarmRecord("0".repeat(31) + "1", "2027-02-20-lunar", AlarmSpec.Day(1, "12:00"))
    private val code = AlarmScheduler.requestCodeFor(rec.id)

    /** The verifier's probe: 11:05 in Oslo (10:05 UTC), the noon alarm armed for 11:00 UTC; the zone becomes Helsinki. */
    @Test fun aZoneChangeThatMovesAnArmedAlarmUnderTenMinutesIntoThePast() {
        val now = Instant.parse("2027-02-20T10:05:00Z").toEpochMilli()
        val plan = AlarmScheduler.plan(listOf(rec.toJson()), catalogue, ZoneId.of("Europe/Helsinki"), now, previouslyArmed = setOf(code))
        // Spec 9.4 and C-23 say: deleted, never rung late.
        assertEquals(listOf(rec.id to "passed"), plan.deleted)
    }

    /** The same with the armed instant the app now stores (11:00 UTC): still deleted, nothing armed. */
    @Test fun withTheArmedInstantKnownTheMovedAlarmIsStillDeleted() {
        val now = ms("2027-02-20T10:05:00Z")
        val plan = AlarmScheduler.plan(listOf(rec.toJson()), catalogue, helsinki, now, previouslyArmed = setOf(code), armedAt = mapOf(code to ms("2027-02-20T11:00:00Z")))
        assertEquals(listOf(rec.id to "passed"), plan.deleted)
        assertTrue(plan.armed.isEmpty())
        assertTrue(plan.keep.isEmpty())
        // And the stale alarm, if it still arrives, finds no record: nothing rings.
        assertEquals(FireDecision.Gone, FireRules.decide(null, catalogue[rec.eclipseId], helsinki, ms("2027-02-20T11:00:00Z"), ms("2027-02-20T11:00:00Z")))
    }

    /** F-1 itself is unchanged: no change of zone, the re-plan a second after the armed instant keeps it for the receiver. */
    @Test fun f1WithoutAChangeOfZoneStillLeavesTheAlarmToItsReceiver() {
        val at = ms("2027-02-20T11:00:00Z") // noon in Oslo on the day before the lunar eclipse
        val plan = AlarmScheduler.plan(listOf(rec.toJson()), catalogue, oslo, at + 1_000L, previouslyArmed = setOf(code), armedAt = mapOf(code to at))
        assertEquals(emptyList<Pair<String, String>>(), plan.deleted)
        assertEquals(listOf(at), plan.armed.map { it.fireAt })
        assertEquals(FireDecision.Ring, FireRules.decide(rec, catalogue[rec.eclipseId], oslo, at, at + 3_000L))
    }

    /** A zone change that moves the alarm later is not affected: noon on the day of the 6 February 2027 solar eclipse, Oslo to London. */
    @Test fun aZoneChangeThatMovesTheAlarmLaterArmsItAgain() {
        val noon = AlarmRecord("0".repeat(31) + "2", "2027-02-06-solar", AlarmSpec.Day(0, "12:00"))
        val c = AlarmScheduler.requestCodeFor(noon.id)
        val now = ms("2027-02-06T11:05:00Z") // armed for 11:00 UTC (noon in Oslo), five minutes ago
        val plan = AlarmScheduler.plan(listOf(noon.toJson()), catalogue, ZoneId.of("Europe/London"), now, previouslyArmed = setOf(c), armedAt = mapOf(c to ms("2027-02-06T11:00:00Z")))
        assertEquals(emptyList<Pair<String, String>>(), plan.deleted)
        assertEquals(listOf(ms("2027-02-06T12:00:00Z")), plan.armed.map { it.fireAt })
    }
}
