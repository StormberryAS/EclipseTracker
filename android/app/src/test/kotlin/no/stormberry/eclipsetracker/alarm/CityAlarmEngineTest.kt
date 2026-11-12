package no.stormberry.eclipsetracker.alarm

import no.stormberry.eclipsetracker.WebRoot
import no.stormberry.eclipsetracker.core.AlarmRecord
import no.stormberry.eclipsetracker.core.AlarmSpec
import no.stormberry.eclipsetracker.core.Json
import no.stormberry.eclipsetracker.core.LocalAnchor
import no.stormberry.eclipsetracker.core.Planner
import no.stormberry.eclipsetracker.core.Words
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/**
 * The alarm engine with version 2 records (EclipseTracker 2.1.0), and the proof that the store 2.0.1
 * wrote is read as it was: a fixture of eight version 1 records, as 2.0.1 writes them, gives
 * exactly the armed instants, request codes and deletions that the unchanged 2.0.1 code (608d0fa)
 * gave, captured by running that code on the same fixture (GOLDEN below).
 */
class CityAlarmEngineTest {
    private val catalogue = WebRoot.catalogue
    private val oslo = ZoneId.of("Europe/Oslo")
    private val tokyo = ZoneId.of("Asia/Tokyo")
    private val sydney = ZoneId.of("Australia/Sydney")
    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    /** A store as 2.0.1 writes it: eight records of four keys, one for an eclipse the list does not hold. */
    private val store201 = listOf(
        """{"v":1,"id":"1a2b3c4d5e6f708192a3b4c5d6e7f801","eclipseId":"2027-02-06-solar","spec":{"kind":"day","daysBefore":0,"time":"12:00"}}""",
        """{"v":1,"id":"2b3c4d5e6f708192a3b4c5d6e7f80192","eclipseId":"2027-02-06-solar","spec":{"kind":"before","minutes":30}}""",
        """{"v":1,"id":"3c4d5e6f708192a3b4c5d6e7f8019203","eclipseId":"2027-02-20-lunar","spec":{"kind":"day","daysBefore":1,"time":"12:00"}}""",
        """{"v":1,"id":"4d5e6f708192a3b4c5d6e7f801920314","eclipseId":"2027-02-20-lunar","spec":{"kind":"day","daysBefore":0,"time":"12:00"}}""",
        """{"v":1,"id":"5e6f708192a3b4c5d6e7f80192031425","eclipseId":"2027-07-18-lunar","spec":{"kind":"day","daysBefore":7,"time":"08:30"}}""",
        """{"v":1,"id":"6f708192a3b4c5d6e7f8019203142536","eclipseId":"2027-08-02-solar","spec":{"kind":"before","minutes":120}}""",
        """{"v":1,"id":"708192a3b4c5d6e7f801920314253647","eclipseId":"2028-01-12-lunar","spec":{"kind":"day","daysBefore":2,"time":"23:59"}}""",
        """{"v":1,"id":"8192a3b4c5d6e7f80192031425364758","eclipseId":"2026-08-12-solar","spec":{"kind":"before","minutes":15}}""",
    )

    /** What the 2.0.1 code (608d0fa) printed for store201, in this format (a scratch test in a worktree of that commit, 2026-11-11). */
    private val GOLDEN = """
PLAN Europe/Oslo 2026-10-16T12:00:00Z
  keep 1a,2b,3c,4d,5e,6f,70
  armed 1a code=1338511740 at=2027-02-06T11:00:00Z
  armed 2b code=1840368060 at=2027-02-06T15:30:00Z
  armed 3c code=1065242212 at=2027-02-20T11:00:00Z
  armed 4d code=373976442 at=2027-02-21T11:00:00Z
  armed 5e code=1211406678 at=2027-07-11T06:30:00Z
  armed 6f code=2071095904 at=2027-08-02T08:07:00Z
  armed 70 code=2038933432 at=2028-01-10T22:59:00Z
  deleted 81 unknown-eclipse
PLAN Asia/Tokyo 2026-10-16T12:00:00Z
  keep 1a,2b,3c,4d,5e,6f,70
  armed 2b code=1840368060 at=2027-02-06T15:30:00Z
  armed 1a code=1338511740 at=2027-02-07T03:00:00Z
  armed 3c code=1065242212 at=2027-02-20T03:00:00Z
  armed 4d code=373976442 at=2027-02-21T03:00:00Z
  armed 5e code=1211406678 at=2027-07-11T23:30:00Z
  armed 6f code=2071095904 at=2027-08-02T08:07:00Z
  armed 70 code=2038933432 at=2028-01-10T14:59:00Z
  deleted 81 unknown-eclipse
PLAN Europe/Oslo 2027-02-20T23:30:00Z
  keep 4d,5e,6f,70
  armed 4d code=373976442 at=2027-02-21T11:00:00Z
  armed 5e code=1211406678 at=2027-07-11T06:30:00Z
  armed 6f code=2071095904 at=2027-08-02T08:07:00Z
  armed 70 code=2038933432 at=2028-01-10T22:59:00Z
  deleted 1a expired
  deleted 2b expired
  deleted 3c passed
  deleted 81 unknown-eclipse
PLAN Pacific/Kiritimati 2027-07-10T00:00:00Z
  keep 5e,6f,70
  armed 5e code=1211406678 at=2027-07-11T18:30:00Z
  armed 6f code=2071095904 at=2027-08-02T08:07:00Z
  armed 70 code=2038933432 at=2028-01-10T09:59:00Z
  deleted 1a expired
  deleted 2b expired
  deleted 3c expired
  deleted 4d expired
  deleted 81 unknown-eclipse
CODE 1a 1338511740 snooze=1338511741
CODE 2b 1840368060 snooze=1840368061
CODE 3c 1065242212 snooze=1065242213
CODE 4d 373976442 snooze=373976443
CODE 5e 1211406678 snooze=1211406679
CODE 6f 2071095904 snooze=2071095905
CODE 70 2038933432 snooze=2038933433
CODE 81 1993416562 snooze=1993416563""".trimStart('\n') + "\n"

    private fun dump(): String {
        val raw: List<Any?> = store201.map { JSONObject(it) }
        val out = StringBuilder()
        for ((zoneName, nowIso) in listOf(
            "Europe/Oslo" to "2026-10-16T12:00:00Z", "Asia/Tokyo" to "2026-10-16T12:00:00Z",
            "Europe/Oslo" to "2027-02-20T23:30:00Z", "Pacific/Kiritimati" to "2027-07-10T00:00:00Z",
        )) {
            val plan = AlarmScheduler.plan(raw, catalogue, ZoneId.of(zoneName), ms(nowIso))
            out.append("PLAN $zoneName $nowIso\n")
            out.append("  keep ").append(plan.keep.joinToString(",") { it.id.take(2) }).append('\n')
            plan.armed.forEach { out.append("  armed ${it.record.id.take(2)} code=${it.requestCode} at=${Json.instant(it.fireAt)}\n") }
            plan.deleted.forEach { out.append("  deleted ${it.first.take(2)} ${it.second}\n") }
        }
        for (r in store201) {
            val id = JSONObject(r).getString("id")
            out.append("CODE ${id.take(2)} ${AlarmScheduler.requestCodeFor(id)} snooze=${AlarmScheduler.snoozeRequestCodeFor(id)}\n")
        }
        return out.toString()
    }

    @Test fun aStoreWrittenBy201IsReadExactlyAsThe201CodeReadIt() {
        assertEquals(GOLDEN, dump())
        // Nothing is rewritten: the kept records are the same four-key JSON, so the store stays what 2.0.1 wrote.
        val plan = AlarmScheduler.plan(store201.map { JSONObject(it) }, catalogue, oslo, ms("2026-10-16T12:00:00Z"))
        assertEquals(store201.take(7).map { JSONObject(it).toString() }.toSet(), plan.keep.map { it.toJson().toString() }.toSet())
        assertTrue(plan.keep.all { it.local == null })
    }

    private val v2Sydney = AlarmRecord(
        "99aabbccddeeff00112233445566778a", "2027-07-18-lunar", AlarmSpec.Day(1, "12:00"),
        LocalAnchor(ms("2027-07-18T15:57:00Z"), sydney, "Sydney, Australia"),
    )

    @Test fun aMixedStoreOfVersion1AndVersion2Records() {
        val stored: List<Any?> = store201.take(7).map { JSONObject(it) } + v2Sydney.toJson()
        val inOslo = AlarmScheduler.plan(stored, catalogue, oslo, ms("2026-10-16T12:00:00Z"))
        val inTokyo = AlarmScheduler.plan(stored, catalogue, tokyo, ms("2026-10-16T12:00:00Z"))
        assertEquals(8, inOslo.keep.size)
        val v2Oslo = inOslo.armed.single { it.record.id == v2Sydney.id }
        val v2Tokyo = inTokyo.armed.single { it.record.id == v2Sydney.id }
        assertEquals("2027-07-18T02:00:00Z", Json.instant(v2Oslo.fireAt)) // 12:00 on 18 July in Sydney
        assertEquals(v2Oslo.fireAt, v2Tokyo.fireAt)
        assertEquals(AlarmScheduler.requestCodeFor(v2Sydney.id), v2Oslo.requestCode)
        // A version 1 record in the same store moves with the phone.
        val v1Oslo = inOslo.armed.single { it.record.id.startsWith("1a") }
        val v1Tokyo = inTokyo.armed.single { it.record.id.startsWith("1a") }
        assertTrue(v1Oslo.fireAt != v1Tokyo.fireAt)
        // The store keeps each record in its own version.
        assertEquals(v2Sydney.toJson().toString(), JSONObject(inOslo.keepJson().getJSONObject(7).toString()).toString())
    }

    /** Setting an eclipse's alarms again with a city chosen replaces its version 1 records with version 2 records under the same ids. */
    @Test fun settingTheAlarmsAgainWithACityKeepsTheIdsAndTheCodes() {
        val old = AlarmRecord("5e6f708192a3b4c5d6e7f80192031425", "2027-07-18-lunar", AlarmSpec.Day(7, "08:30"))
        val other = AlarmRecord("1a2b3c4d5e6f708192a3b4c5d6e7f801", "2027-02-06-solar", AlarmSpec.Day(0, "12:00"))
        val now = AlarmRecord(old.id, old.eclipseId, old.spec, LocalAnchor(ms("2027-07-18T15:57:00Z"), sydney, "Sydney, Australia"))
        val next = AlarmScheduler.replaceEclipse(listOf(old, other), old.eclipseId, JSONArray(listOf(now.toJson())), catalogue)!!
        assertEquals(listOf(other, now), next)
        assertEquals(AlarmScheduler.requestCodeFor(old.id), AlarmScheduler.requestCodeFor(now.id))
        // An armed alarm is replaced in place: the same code, so it never rings twice.
        val sink = FakeAlarmSink()
        val armed = AlarmScheduler.apply(AlarmScheduler.plan(listOf(old.toJson()), catalogue, oslo, ms("2027-07-01T00:00:00Z")), sink, emptySet())
        val armedAgain = AlarmScheduler.apply(AlarmScheduler.plan(listOf(now.toJson()), catalogue, oslo, ms("2027-07-01T00:00:00Z")), sink, armed)
        assertEquals(armed, armedAgain)
        assertTrue(sink.cancelled.isEmpty())
        assertEquals(1, sink.armed.size)
    }

    @Test fun theAlarmsSetIsRefusedWholeForAStartFarFromGreatestEclipse() {
        val e = catalogue["2027-07-18-lunar"]!!
        val greatest = Planner.greatestMinute(e.greatest)
        fun at(offsetMin: Long) = v2Sydney.copy(local = v2Sydney.local!!.copy(start = greatest + offsetMin * 60_000L))
        fun set(r: AlarmRecord) = AlarmScheduler.replaceEclipse(emptyList(), e.id, JSONArray(listOf(r.toJson())), catalogue)
        assertNotNull(set(at(360)))
        assertNotNull(set(at(-360)))
        assertNull("6 h 1 min after", set(at(361)))
        assertNull("6 h 1 min before", set(at(-361)))
        // A set that mixes a good record with a far one is refused whole.
        val mixed = JSONArray(listOf(at(0).toJson(), at(361).copy(id = "aa".repeat(16)).toJson()))
        assertNull(AlarmScheduler.replaceEclipse(emptyList(), e.id, mixed, catalogue))
        // A far start already in the store (it cannot come from the page) is deleted as invalid at the next re-plan.
        val plan = AlarmScheduler.plan(listOf(at(361).toJson()), catalogue, oslo, ms("2027-07-01T00:00:00Z"))
        assertEquals(listOf(v2Sydney.id to "invalid"), plan.deleted)
    }

    @Test fun aChangeOfThePhonesZoneNeverMovesAVersion2Alarm() {
        val e = catalogue[v2Sydney.eclipseId]!!
        val at = Planner.fireInstantFor(v2Sydney, e, oslo)
        // The zone changes seconds before the alarm and the change has not been re-planned yet: version 2 rings once, version 1 is Moved.
        assertSame(FireDecision.Ring, FireRules.decide(v2Sydney, e, tokyo, at, at))
        assertSame(FireDecision.Ring, FireRules.decide(v2Sydney, e, ZoneId.of("America/Los_Angeles"), at, at + 5_000L))
        val v1 = AlarmRecord(v2Sydney.id, v2Sydney.eclipseId, v2Sydney.spec)
        val armedInOslo = Planner.fireInstantFor(v1, e, oslo)
        assertTrue(FireRules.decide(v1, e, tokyo, armedInOslo, armedInOslo) is FireDecision.Moved)
        // The early, late and ring rules are as before.
        assertSame(FireDecision.Early, FireRules.decide(v2Sydney, e, oslo, at, at - 2_001L))
        assertSame(FireDecision.Ring, FireRules.decide(v2Sydney, e, oslo, at, at + 10 * 60_000L))
        assertSame(FireDecision.Late, FireRules.decide(v2Sydney, e, oslo, at, at + 10 * 60_000L + 1L))
        // A re-plan after the zone change keeps the same armed instant, so nothing is deleted or cancelled.
        val a = AlarmScheduler.plan(listOf(v2Sydney.toJson()), catalogue, oslo, at - 3_600_000L)
        val b = AlarmScheduler.plan(listOf(v2Sydney.toJson()), catalogue, ZoneId.of("Pacific/Kiritimati"), at - 3_600_000L)
        assertEquals(a.armed.map { it.fireAt }, b.armed.map { it.fireAt })
        assertTrue(a.deleted.isEmpty() && b.deleted.isEmpty())
    }

    @Test fun aRingingVersion2AlarmCarriesTheCityInItsWordsAndItsSnoozeKeepsThem() {
        val words = Words.alarmWords(v2Sydney)
        assertEquals("1 day before at 12:00 in Sydney, Australia", words)
        val snooze = Snooze(v2Sydney.id, v2Sydney.eclipseId, 1_000L, "Penumbral lunar eclipse", words)
        assertEquals(snooze, Snooze.parse(JSONObject(snooze.toJson().toString())))
        val long = Words.alarmWords(v2Sydney.copy(spec = AlarmSpec.Before(30), local = v2Sydney.local!!.copy(place = "x".repeat(200))))
        assertEquals(240, long.length)
        val longSnooze = snooze.copy(text = long)
        assertEquals(longSnooze, Snooze.parse(JSONObject(longSnooze.toJson().toString())))
    }

    /** The "Missed" notice of a version 2 alarm names the city (the harness is MissedNoticeTest's). */
    @Test fun aMissedVersion2AlarmIsReportedWithItsRecordSoItsNoticeNamesTheCity() {
        val start = ms("2027-07-18T15:57:00Z")
        val before = Planner.fireInstantFor(v2Sydney, catalogue[v2Sydney.eclipseId]!!, oslo)
        val s0 = ReplanHarness.normal(Store(listOf(v2Sydney.toJson()), emptySet(), emptyMap(), restartBoot = 4), before - 3_600_000L, oslo).store
        assertEquals(mapOf(AlarmScheduler.requestCodeFor(v2Sydney.id) to before), s0.armedAt)
        // The phone was off over the alarm and starts again after it: reported, as the record itself.
        val step = ReplanHarness.boot(s0.restarted(), bootCount = 5, now = before + 5 * 60_000L, zone = tokyo)
        assertEquals(listOf(v2Sydney), step.missed)
        assertEquals("1 day before at 12:00 in Sydney, Australia", Words.alarmWords(step.missed.single()))
        assertTrue(start > before)
    }
}
