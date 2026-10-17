package no.stormberry.eclipsetracker.alarm

import no.stormberry.eclipsetracker.WebRoot
import no.stormberry.eclipsetracker.core.AlarmRecord
import no.stormberry.eclipsetracker.core.AlarmSpec
import no.stormberry.eclipsetracker.core.Json
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/** What AlarmManager would hold: armed request codes and their instants, and every call made (SunApp's FakeAlarmSink). */
class FakeAlarmSink : AlarmSink {
    val armed = LinkedHashMap<Int, ArmedAlarm>()
    val cancelled = ArrayList<Int>()
    var arms = 0
    /** The backstop (fix B, A-2): the alarm it was last set for, null when cleared. */
    var guarded: ArmedAlarm? = null
    var guards = 0

    override fun arm(alarm: ArmedAlarm) {
        armed[alarm.requestCode] = alarm
        arms++
    }

    override fun cancel(requestCode: Int) {
        cancelled += requestCode
        armed.remove(requestCode)
    }

    override fun guard(next: ArmedAlarm?) {
        guarded = next
        guards++
    }
}

/**
 * The scheduler against a fake sink (spec 9.4, 9.6, 9.7): unique request codes, the nearest 100,
 * the re-plan after a fire, a restart, a change of zone, the deletion of passed, expired, unknown
 * and invalid records, and the page's alarms.set.
 */
class AlarmSchedulerTest {
    private val catalogue = WebRoot.catalogue
    private val oslo = ZoneId.of("Europe/Oslo")
    private val tokyo = ZoneId.of("Asia/Tokyo")
    private val now = Instant.parse("2026-10-16T12:00:00Z").toEpochMilli()
    private var counter = 0

    private fun newId(): String = (++counter).toString(16).padStart(32, '0')
    private fun record(eclipseId: String, spec: AlarmSpec) = AlarmRecord(newId(), eclipseId, spec)
    private fun raw(records: List<AlarmRecord>): List<Any?> = records.map { it.toJson() }
    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    /** Every eclipse in the list with eight alarms each: 2,696 records. */
    private fun everything(): List<AlarmRecord> {
        val specs = listOf(
            AlarmSpec.Day(0, "12:00"), AlarmSpec.Day(1, "12:00"), AlarmSpec.Day(2, "08:00"), AlarmSpec.Day(3, "20:00"),
            AlarmSpec.Day(7, "12:00"), AlarmSpec.Before(15), AlarmSpec.Before(60), AlarmSpec.Before(120),
        )
        val ids = org.json.JSONObject(WebRoot.text("data/eclipses.json")).getJSONArray("eclipses")
        return (0 until ids.length()).flatMap { i -> specs.map { record(ids.getJSONObject(i).getString("id"), it) } }
    }

    @Test fun requestCodesAreUniqueStableEvenAndTheirSnoozesOdd() {
        val all = everything()
        assertEquals(2696, all.size)
        val codes = all.map { AlarmScheduler.requestCodeFor(it.id) }
        assertEquals(codes.size, codes.toSet().size)
        assertTrue(codes.all { it >= 0 && it % 2 == 0 })
        val snoozes = all.map { AlarmScheduler.snoozeRequestCodeFor(it.id) }
        assertTrue(snoozes.all { it % 2 == 1 })
        assertTrue((codes.toSet() intersect snoozes.toSet()).isEmpty())
        // Random ids as the page makes them: no collision among 20,000.
        val rnd = java.util.Random(7)
        val random = List(20_000) { (1..16).joinToString("") { "%02x".format(rnd.nextInt(256)) } }
        assertEquals(random.size, random.map { AlarmScheduler.requestCodeFor(it) }.toSet().size)
        // The same id always gives the same code (an edit keeps it, spec 9.6).
        assertEquals(AlarmScheduler.requestCodeFor("0123456789abcdef0123456789abcdef"), AlarmScheduler.requestCodeFor("0123456789abcdef0123456789abcdef"))
    }

    @Test fun onlyTheNearestHundredAreArmedAndTheRestStayStored() {
        val all = everything()
        val plan = AlarmScheduler.plan(raw(all), catalogue, oslo, now)
        assertEquals(2696, plan.keep.size)
        assertEquals(100, plan.armed.size)
        val fires = plan.armed.map { it.fireAt }
        assertEquals(fires.sorted(), fires)
        val notArmed = plan.keep.map { it.id }.toSet() - plan.armed.map { it.record.id }.toSet()
        val latestArmed = fires.last()
        for (r in plan.keep.filter { it.id in notArmed }) {
            val at = no.stormberry.eclipsetracker.core.Planner.fireInstant(catalogue[r.eclipseId]!!.greatest, r.spec, oslo).first
            assertTrue(at >= latestArmed)
        }
        val sink = FakeAlarmSink()
        val codes = AlarmScheduler.apply(plan, sink, emptySet())
        assertEquals(100, codes.size)
        assertEquals(100, sink.armed.size)
    }

    @Test fun afterEachFireThePlanMovesOnAndTheRungRecordIsDeleted() {
        val all = everything()
        val sink = FakeAlarmSink()
        var plan = AlarmScheduler.plan(raw(all), catalogue, oslo, now)
        var armed = AlarmScheduler.apply(plan, sink, emptySet())
        var stored = raw(plan.keep)
        repeat(5) {
            val first = plan.armed.first()
            val next101 = AlarmScheduler.plan(stored, catalogue, oslo, now).let { p -> p.keep }
            assertTrue(next101.size > 100)
            // The alarm fires: the receiver re-plans at its own time.
            plan = AlarmScheduler.plan(stored, catalogue, oslo, first.fireAt)
            assertFalse("the rung record is deleted", plan.keep.any { it.id == first.record.id })
            assertTrue(plan.deleted.contains(first.record.id to "passed"))
            armed = AlarmScheduler.apply(plan, sink, armed)
            assertTrue("its code is cancelled", first.requestCode in sink.cancelled)
            assertEquals(100, sink.armed.size)
            assertTrue(sink.armed.values.all { it.fireAt > first.fireAt })
            stored = raw(plan.keep)
        }
    }

    @Test fun aRestartArmsFromNothingAndCancelsWhatIsNoLongerWanted() {
        val a = record("2027-02-06-solar", AlarmSpec.Day(0, "12:00"))
        val b = record("2027-02-20-lunar", AlarmSpec.Before(30))
        val plan = AlarmScheduler.plan(raw(listOf(a, b)), catalogue, oslo, now)
        // After a restart AlarmManager holds nothing and the app's record of what was armed is all it has.
        val sink = FakeAlarmSink()
        val stale = setOf(AlarmScheduler.requestCodeFor("ffffffffffffffffffffffffffffffff"))
        val armed = AlarmScheduler.apply(plan, sink, stale)
        assertEquals(setOf(AlarmScheduler.requestCodeFor(a.id), AlarmScheduler.requestCodeFor(b.id)), armed)
        assertEquals(stale.toList(), sink.cancelled)
        assertEquals("2027-02-06T11:00:00Z", Json.instant(sink.armed.getValue(AlarmScheduler.requestCodeFor(a.id)).fireAt))
        assertEquals("2027-02-20T22:43:00Z", Json.instant(sink.armed.getValue(AlarmScheduler.requestCodeFor(b.id)).fireAt))
        // Re-planning again changes nothing and cancels nothing: the same codes are replaced in place.
        val again = FakeAlarmSink()
        assertEquals(armed, AlarmScheduler.apply(AlarmScheduler.plan(raw(plan.keep), catalogue, oslo, now), again, armed))
        assertTrue(again.cancelled.isEmpty())
    }

    /** The C-1 restart: after greatest eclipse (00:13 in Oslo) and before the noon alarm of that day. */
    @Test fun aRestartBetweenGreatestEclipseAndAnAlarmAfterIt() {
        val noon = record("2027-02-20-lunar", AlarmSpec.Day(0, "12:00"))
        val plan = AlarmScheduler.plan(raw(listOf(noon)), catalogue, oslo, ms("2027-02-21T01:00:00Z"))
        assertEquals(listOf(noon), plan.keep)
        assertEquals("2027-02-21T11:00:00Z", Json.instant(plan.armed.single().fireAt))
    }

    @Test fun aChangeOfZoneMovesTimesOfDayButNotTheEclipseOrTheCodes() {
        val day = record("2027-02-06-solar", AlarmSpec.Day(0, "12:00"))
        val before = record("2027-02-06-solar", AlarmSpec.Before(30))
        val inOslo = AlarmScheduler.plan(raw(listOf(day, before)), catalogue, oslo, now)
        val sink = FakeAlarmSink()
        val armed = AlarmScheduler.apply(inOslo, sink, emptySet())
        val inTokyo = AlarmScheduler.plan(raw(inOslo.keep), catalogue, tokyo, now)
        AlarmScheduler.apply(inTokyo, sink, armed)
        assertTrue(sink.cancelled.isEmpty())
        val d = sink.armed.getValue(AlarmScheduler.requestCodeFor(day.id))
        val b = sink.armed.getValue(AlarmScheduler.requestCodeFor(before.id))
        // Noon on the Tokyo day of greatest eclipse (16:00 UTC is 01:00 on 7 February in Tokyo): B-2.
        assertEquals("2027-02-07T03:00:00Z", Json.instant(d.fireAt))
        assertEquals("2027-02-06T15:30:00Z", Json.instant(b.fireAt))
    }

    @Test fun aJourneyThatMovesAnAlarmIntoThePastDeletesItWithoutRinging() {
        // Noon on the day in Oslo is 11:00 UTC; the phone, at 11:30 UTC, lands in Los Angeles,
        // where noon on the local day of greatest eclipse (6 February, 08:00) has passed.
        val day = record("2027-02-06-solar", AlarmSpec.Day(0, "12:00"))
        val plan = AlarmScheduler.plan(raw(listOf(day)), catalogue, ZoneId.of("America/Los_Angeles"), ms("2027-02-06T20:30:00Z"))
        assertTrue(plan.keep.isEmpty())
        assertEquals(listOf(day.id to "passed"), plan.deleted)
    }

    @Test fun passedExpiredUnknownAndInvalidRecordsAreDeleted() {
        val passed = record("2027-02-06-solar", AlarmSpec.Day(7, "12:00"))
        val ok = record("2027-02-20-lunar", AlarmSpec.Before(15))
        val unknown = AlarmRecord(newId(), "2026-08-12-solar", AlarmSpec.Before(15))
        val stored: List<Any?> = raw(listOf(passed, ok, unknown)) + listOf(
            org.json.JSONObject("""{"v":1,"id":"${newId()}","eclipseId":"2027-02-06-solar","spec":{"kind":"before","minutes":30},"enabled":true}"""),
            ok.toJson(), // the same id again
            "not a record",
        )
        val at = ms("2027-02-06T12:00:00Z")
        val plan = AlarmScheduler.plan(stored, catalogue, oslo, at)
        assertEquals(listOf(ok), plan.keep)
        assertEquals(listOf("passed", "unknown-eclipse", "invalid", "invalid", "invalid"), plan.deleted.map { it.second })
        // 48 hours after greatest eclipse every record is gone, without working out a time.
        val late = AlarmScheduler.plan(raw(listOf(ok)), catalogue, oslo, ms("2027-02-22T23:13:00Z"))
        assertEquals(listOf(ok.id to "expired"), late.deleted)
    }

    @Test fun thePagesAlarmsSet() {
        val a1 = record("2027-02-06-solar", AlarmSpec.Day(0, "12:00"))
        val b1 = record("2027-02-20-lunar", AlarmSpec.Before(30))
        val stored = listOf(a1, b1)
        // Changing a row keeps its id; a new row has a new id; a removed row is gone.
        val edited = AlarmRecord(a1.id, a1.eclipseId, AlarmSpec.Day(1, "09:00"))
        val added = record("2027-02-06-solar", AlarmSpec.Before(60))
        val next = AlarmScheduler.replaceEclipse(stored, "2027-02-06-solar", JSONArray(listOf(edited.toJson(), added.toJson())), catalogue)
        assertEquals(listOf(b1, edited, added), next)
        // Every alarm of an eclipse deleted.
        assertEquals(listOf(b1), AlarmScheduler.replaceEclipse(stored, "2027-02-06-solar", JSONArray(), catalogue))
        // Refused whole: another eclipse's record, an id another eclipse uses, an unknown eclipse,
        // more than eight, an invalid record.
        assertNull(AlarmScheduler.replaceEclipse(stored, "2027-02-06-solar", JSONArray(listOf(b1.toJson())), catalogue))
        assertNull(AlarmScheduler.replaceEclipse(stored, "2027-02-06-solar", JSONArray(listOf(AlarmRecord(b1.id, "2027-02-06-solar", AlarmSpec.Before(15)).toJson())), catalogue))
        assertNull(AlarmScheduler.replaceEclipse(stored, "2026-08-12-solar", JSONArray(), catalogue))
        assertNull(AlarmScheduler.replaceEclipse(stored, "2027-02-06-solar", JSONArray((1..9).map { record("2027-02-06-solar", AlarmSpec.Before(15)).toJson() }), catalogue))
        assertNull(AlarmScheduler.replaceEclipse(stored, "2027-02-06-solar", JSONArray("[{}]"), catalogue))
        assertNotNull(AlarmScheduler.replaceEclipse(emptyList(), "2100-09-04-solar", JSONArray(), catalogue))
    }

    @Test fun theProblemsFollowTheAndroidVersion() {
        assertEquals(emptyList<Problem>(), AlarmCapability.problemsFrom(24, true, null, false, false))
        assertEquals(listOf(Problem.NOTIFICATIONS), AlarmCapability.problemsFrom(24, false, null, false, false))
        assertEquals(listOf(Problem.EXACT_ALARMS), AlarmCapability.problemsFrom(31, true, 4, false, true))
        assertEquals(listOf(Problem.NOTIFICATIONS, Problem.EXACT_ALARMS, Problem.FULL_SCREEN), AlarmCapability.problemsFrom(34, false, 4, false, false))
        assertEquals(listOf("notifications-denied", "exact-alarms-denied", "full-screen-denied"), Problem.entries.map { it.wire })
        assertEquals(Problem.EXACT_ALARMS, Problem.fromWire("exact-alarms-denied"))
        assertNull(Problem.fromWire("other"))
    }
}
