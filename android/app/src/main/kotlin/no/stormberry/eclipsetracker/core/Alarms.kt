package no.stormberry.eclipsetracker.core

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/**
 * The alarm planner and the alarm records, ported from the web app's ts/core/alarms.ts,
 * ts/core/zoned.ts and greatestMinute in ts/core/format.ts (spec sections 6.2, 9.4 and 9.5).
 * Pure Kotlin on java.time: the zone and "now" always come in as arguments, so the JVM tests
 * check it against tests/alarm-vectors.json, tests/record-vectors.json and tests/dst-vectors.json,
 * the same files the TypeScript passes.
 *
 * The rules, as the web app's:
 *  - greatest eclipse is rounded to the minute, half a minute up: floorDiv(ms + 30 000, 60 000) * 60 000;
 *  - "at a time of day" alarms ring at that wall time on the local date of greatest eclipse in
 *    the zone, less the days chosen; on a night the clocks change, a time that does not exist
 *    moves forward by the gap (ZonedDateTime.of) and one that happens twice takes the first
 *    (the earlier offset, withEarlierOffsetAtOverlap);
 *  - "before greatest eclipse" alarms are plain subtraction from the rounded instant;
 *  - an alarm whose time is not after now has passed; a later alarm at the same minute as an
 *    earlier one is a duplicate.
 */

/** One alarm as the person chose it: the question, never the answer (SunApp's AlarmRule rule). */
sealed interface AlarmSpec {
    /** On the day of the eclipse (daysBefore 0) or 1, 2, 3 or 7 days before, at a wall time "HH:MM". */
    data class Day(val daysBefore: Int, val time: String) : AlarmSpec

    /** 15, 30, 60 or 120 minutes before greatest eclipse. */
    data class Before(val minutes: Int) : AlarmSpec

    fun toJson(): JSONObject = when (this) {
        is Day -> JSONObject().put("kind", "day").put("daysBefore", daysBefore).put("time", time)
        is Before -> JSONObject().put("kind", "before").put("minutes", minutes)
    }

    companion object {
        val DAYS_BEFORE = listOf(0, 1, 2, 3, 7)
        val MINUTES_BEFORE = listOf(15, 30, 60, 120)
        private val TIME = Regex("^([01]\\d|2[0-3]):([0-5]\\d)$")

        fun isWallTime(text: String): Boolean = TIME.matches(text)

        /**
         * The spec in [raw] (a JSONObject as org.json parsed it), or null unless it is exactly
         * one this version understands: the right keys and no other, as isValidSpec.
         */
        fun parse(raw: Any?): AlarmSpec? {
            if (raw !is JSONObject) return null
            return when (raw.opt("kind")) {
                "before" -> {
                    if (raw.length() != 2) return null
                    val m = Json.wholeNumber(raw.opt("minutes")) ?: return null
                    if (m.toInt() !in MINUTES_BEFORE || m != m.toInt().toLong()) return null
                    Before(m.toInt())
                }
                "day" -> {
                    if (raw.length() != 3) return null
                    val d = Json.wholeNumber(raw.opt("daysBefore")) ?: return null
                    if (d.toInt() !in DAYS_BEFORE || d != d.toInt().toLong()) return null
                    val t = raw.opt("time") as? String ?: return null
                    if (!isWallTime(t)) return null
                    Day(d.toInt(), t)
                }
                else -> null
            }
        }
    }
}

/** The record stage B stores for each alarm (spec 9.4): exactly v, id, eclipseId and spec. */
data class AlarmRecord(val id: String, val eclipseId: String, val spec: AlarmSpec) {
    fun toJson(): JSONObject = JSONObject().put("v", 1).put("id", id).put("eclipseId", eclipseId).put("spec", spec.toJson())

    companion object {
        private val RECORD_ID = Regex("^[0-9a-f]{32}$")
        val ECLIPSE_ID = Regex("^\\d{4}-\\d{2}-\\d{2}-(solar|lunar)$")

        fun isRecordId(id: Any?): Boolean = id is String && RECORD_ID.matches(id)

        /** The record in [raw], or null unless it is valid (isValidRecord). */
        fun parse(raw: Any?): AlarmRecord? {
            if (raw !is JSONObject || raw.length() != 4) return null
            val v = Json.wholeNumber(raw.opt("v")) ?: return null
            if (v != 1L) return null
            val id = raw.opt("id")
            if (!isRecordId(id)) return null
            val eclipseId = raw.opt("eclipseId") as? String ?: return null
            if (!ECLIPSE_ID.matches(eclipseId)) return null
            val spec = AlarmSpec.parse(raw.opt("spec")) ?: return null
            return AlarmRecord(id as String, eclipseId, spec)
        }

        /**
         * The records in [raw] if they make a valid set (isValidRecordSet): every one valid, no id
         * twice, at most MAX_ALARMS for any one eclipse. Otherwise null.
         */
        fun parseSet(raw: Any?): List<AlarmRecord>? {
            if (raw !is JSONArray) return null
            val out = ArrayList<AlarmRecord>(raw.length())
            val ids = HashSet<String>()
            val perEclipse = HashMap<String, Int>()
            for (i in 0 until raw.length()) {
                val r = parse(raw.opt(i)) ?: return null
                if (!ids.add(r.id)) return null
                val n = (perEclipse[r.eclipseId] ?: 0) + 1
                if (n > Planner.MAX_ALARMS) return null
                perEclipse[r.eclipseId] = n
                out += r
            }
            return out
        }
    }
}

/** How a wall time was resolved on a day the clocks change. */
enum class Dst(val wire: String) { NONE("none"), GAP("gap"), OVERLAP("overlap") }

/** One alarm worked out for one eclipse, one zone and one moment (PlannedAlarm in types.ts). */
data class PlannedAlarm(
    val spec: AlarmSpec,
    val fireAt: Long,
    val localDate: String,
    val localTime: String,
    val offsetMinutes: Int,
    val status: String,
    val afterGreatest: Boolean,
    val dst: Dst,
)

/** What a re-plan does with one stored record (RecordFate in types.ts). */
sealed interface RecordFate {
    data class Arm(val fireAt: Long) : RecordFate
    data class Delete(val reason: String) : RecordFate
}

object Planner {
    /** The most alarms one eclipse can have (ALARM-5). */
    const val MAX_ALARMS = 8

    /** How long after greatest eclipse a record is kept at most (FIX-2: 48 hours, spec 9.4). */
    const val RECORD_GRACE_MS = 48L * 3_600_000L

    private const val MINUTE = 60_000L
    private val HHMM = DateTimeFormatter.ofPattern("HH:mm")

    /** Greatest eclipse rounded to the minute, half a minute up (spec 9.5, code review C-7). */
    fun greatestMinute(greatest: String): Long =
        Math.floorDiv(Instant.parse(greatest).toEpochMilli() + 30_000L, MINUTE) * MINUTE

    /** The instant a local date and wall time name in [zone], with the gap and overlap rules. */
    fun wallTimeToInstant(zone: ZoneId, date: LocalDate, time: LocalTime): Pair<Long, Dst> {
        val local = date.atTime(time)
        val valid = zone.rules.getValidOffsets(local).size
        val dst = when (valid) {
            0 -> Dst.GAP
            1 -> Dst.NONE
            else -> Dst.OVERLAP
        }
        // ZonedDateTime.of moves a time in a gap forward by the length of the gap; at an overlap
        // it takes the earlier offset, and withEarlierOffsetAtOverlap says so explicitly.
        val zdt = ZonedDateTime.of(local, zone).withEarlierOffsetAtOverlap()
        return zdt.toInstant().toEpochMilli() to dst
    }

    /** The local date of an instant in [zone]. */
    fun localDate(zone: ZoneId, epochMs: Long): LocalDate = Instant.ofEpochMilli(epochMs).atZone(zone).toLocalDate()

    /** The instant an alarm rings, and how a clock change was resolved. */
    fun fireInstant(greatest: String, spec: AlarmSpec, zone: ZoneId): Pair<Long, Dst> {
        val g = greatestMinute(greatest)
        return when (spec) {
            is AlarmSpec.Before -> (g - spec.minutes * MINUTE) to Dst.NONE
            is AlarmSpec.Day -> {
                val day = localDate(zone, g).minusDays(spec.daysBefore.toLong())
                wallTimeToInstant(zone, day, LocalTime.parse(spec.time, HHMM))
            }
        }
    }

    /** One alarm, planned; its status is ok or past (planAlarm). */
    fun planAlarm(greatest: String, spec: AlarmSpec, zone: ZoneId, now: Long): PlannedAlarm {
        val (at, dst) = fireInstant(greatest, spec, zone)
        val local = Instant.ofEpochMilli(at).atZone(zone)
        return PlannedAlarm(
            spec = spec,
            fireAt = at,
            localDate = local.toLocalDate().toString(),
            localTime = local.toLocalTime().format(HHMM),
            offsetMinutes = local.offset.totalSeconds / 60,
            status = if (at > now) "ok" else "past",
            afterGreatest = at > greatestMinute(greatest),
            dst = dst,
        )
    }

    /** Several alarms for one eclipse; a later one at the same minute as an earlier one is a duplicate. */
    fun planAlarms(greatest: String, specs: List<AlarmSpec>, zone: ZoneId, now: Long): List<PlannedAlarm> {
        require(specs.size <= MAX_ALARMS) { "at most $MAX_ALARMS alarms per eclipse, not ${specs.size}" }
        val seen = HashSet<Long>()
        return specs.map { spec ->
            val p = planAlarm(greatest, spec, zone, now)
            when {
                p.status != "ok" -> p
                !seen.add(p.fireAt) -> p.copy(status = "duplicate")
                else -> p
            }
        }
    }

    /**
     * What a re-plan does with one stored record [raw] (spec 9.4, code review C-1), in this order:
     * invalid, unknown eclipse, 48 hours after greatest eclipse (expired, without working out a
     * time), its own time worked out now in [zone] is after now (arm), otherwise passed. A missed
     * alarm is never rung late: it is deleted (C-23).
     */
    fun recordFate(raw: Any?, eclipse: Eclipse?, zone: ZoneId, now: Long): RecordFate {
        val record = AlarmRecord.parse(raw) ?: return RecordFate.Delete("invalid")
        if (eclipse == null || eclipse.id != record.eclipseId) return RecordFate.Delete("unknown-eclipse")
        if (now >= greatestMinute(eclipse.greatest) + RECORD_GRACE_MS) return RecordFate.Delete("expired")
        val (fireAt, _) = fireInstant(eclipse.greatest, record.spec, zone)
        return if (fireAt > now) RecordFate.Arm(fireAt) else RecordFate.Delete("passed")
    }
}

/** Small helpers for values org.json hands back. */
object Json {
    /**
     * A JSON number that is a whole number, as a Long, or null. JavaScript reads 1 and 1.0 as the
     * same number, so both count; a string, a boolean or a fraction does not.
     */
    fun wholeNumber(x: Any?): Long? = when (x) {
        is Int -> x.toLong()
        is Long -> x
        is Double -> if (x.isFinite() && x == Math.floor(x) && kotlin.math.abs(x) < 1e15) x.toLong() else null
        is java.math.BigDecimal -> try { x.longValueExact() } catch (_: ArithmeticException) { null }
        is java.math.BigInteger -> if (x.bitLength() < 63) x.toLong() else null
        else -> null
    }

    private val ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").withZone(java.time.ZoneOffset.UTC)

    /** An instant in the contract's one format, "2027-02-06T11:00:00Z" (spec 9.5). */
    fun instant(epochMs: Long): String = ISO.format(Instant.ofEpochMilli(epochMs))
}
