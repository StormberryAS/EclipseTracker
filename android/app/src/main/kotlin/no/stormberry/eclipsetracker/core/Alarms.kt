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
 *
 * Version 2 records (EclipseTracker 2.1.0, an alarm set while a city is chosen) count from the
 * minute the eclipse starts at the city, in the city's zone, wherever the phone is: the page works
 * that start out (ts/core/local.ts) and the record carries it, whole minute, at most
 * [Planner.MAX_START_OFFSET_MS] from greatest eclipse. A version 1 record is exactly what 2.0.1
 * stored and counts from greatest eclipse in the phone's zone, as before.
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

/**
 * Where a version 2 record counts from (EclipseTracker 2.1.0): the minute the eclipse starts at the
 * city ([start], epoch ms, a whole minute), the city's time zone ([zone], an IANA region, never a
 * fixed offset) and its name ([place], "Sydney, Australia", for the alarm's words).
 */
data class LocalAnchor(val start: Long, val zone: ZoneId, val place: String)

/**
 * The record stage B stores for each alarm (spec 9.4). Version 1 has exactly v, id, eclipseId and
 * spec ([local] null). Version 2 (2.1.0) has those and start, zone and place ([local] set).
 */
data class AlarmRecord(val id: String, val eclipseId: String, val spec: AlarmSpec, val local: LocalAnchor? = null) {
    fun toJson(): JSONObject {
        val o = JSONObject().put("v", if (local == null) 1 else 2).put("id", id).put("eclipseId", eclipseId).put("spec", spec.toJson())
        if (local != null) o.put("start", Json.instant(local.start)).put("zone", local.zone.id).put("place", local.place)
        return o
    }

    companion object {
        private val RECORD_ID = Regex("^[0-9a-f]{32}$")
        val ECLIPSE_ID = Regex("^\\d{4}-\\d{2}-\\d{2}-(solar|lunar)$")

        /** A start in the contract's one format with the seconds at 00 (ts/core/alarms.ts START_TEXT). */
        private val START_TEXT = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00Z$")

        /** An IANA region name: every segment starts with a capital letter, as the tz database's names do (ZONE_TEXT). */
        private val ZONE_TEXT = Regex("^[A-Z][A-Za-z0-9_+-]*(/[A-Z][A-Za-z0-9_+-]*)*$")
        private val CONTROL = Regex("[\\u0000-\\u001f\\u007f-\\u009f]")

        fun isRecordId(id: Any?): Boolean = id is String && RECORD_ID.matches(id)

        /** The epoch ms of a start text, or null unless it is a real instant in the contract's format with the seconds at 00. */
        fun startMs(text: Any?): Long? {
            if (text !is String || !START_TEXT.matches(text)) return null
            val ms = try {
                Instant.parse(text).toEpochMilli()
            } catch (_: Exception) {
                return null
            }
            // A round trip, as the page's: 24:00 is read by some parsers as the next day.
            return ms.takeIf { Json.instant(it) == text }
        }

        /** The zone in [text] when it is an IANA region name this device knows (never a fixed offset, never a prefix form), else null. */
        fun regionZone(text: Any?): ZoneId? {
            if (text !is String || text.length > 200 || !ZONE_TEXT.matches(text)) return null
            val zone = try {
                ZoneId.of(text)
            } catch (_: Exception) {
                return null
            }
            // ZoneId.of reads "Z" and "UTC+3" as an offset or a prefix form whose id differs from the text.
            return zone.takeIf { it !is java.time.ZoneOffset && it.id == text }
        }

        /** True for a place name as a version 2 record keeps it: 1 to 200 characters, no control character. */
        fun isPlace(text: Any?): Boolean = text is String && text.length in 1..200 && !CONTROL.containsMatchIn(text)

        /** The record in [raw], or null unless it is valid (isValidRecord). */
        fun parse(raw: Any?): AlarmRecord? {
            if (raw !is JSONObject) return null
            val v = Json.wholeNumber(raw.opt("v")) ?: return null
            if (v != 1L && v != 2L) return null
            if (raw.length() != if (v == 1L) 4 else 7) return null
            val id = raw.opt("id")
            if (!isRecordId(id)) return null
            val eclipseId = raw.opt("eclipseId") as? String ?: return null
            if (!ECLIPSE_ID.matches(eclipseId)) return null
            val spec = AlarmSpec.parse(raw.opt("spec")) ?: return null
            if (v == 1L) return AlarmRecord(id as String, eclipseId, spec)
            val start = startMs(raw.opt("start")) ?: return null
            val zone = regionZone(raw.opt("zone")) ?: return null
            val place = raw.opt("place")
            if (!isPlace(place)) return null
            return AlarmRecord(id as String, eclipseId, spec, LocalAnchor(start, zone, place as String))
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

    /**
     * The most a version 2 record's start may differ from greatest eclipse (ts/core/alarms.ts
     * MAX_START_OFFSET_MS). The start at a city is never more than 3.1 hours from it (the largest of
     * 2,137 city cases); this device cannot work a local start out itself, so the bound is the check
     * it has: a record outside it cannot come from the page.
     */
    const val MAX_START_OFFSET_MS = 6L * 3_600_000L

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

    /**
     * The instant an alarm rings, and how a clock change was resolved, counted from [anchor] (a
     * whole minute): greatest eclipse (rounded) for a version 1 record, the start at the city for a
     * version 2 record. "Before" is minutes before the anchor; "at a time of day" is that wall time
     * in [zone] on the local date of the anchor in [zone], less the days chosen (fireInstantAt).
     */
    fun fireInstantAt(anchor: Long, spec: AlarmSpec, zone: ZoneId): Pair<Long, Dst> = when (spec) {
        is AlarmSpec.Before -> (anchor - spec.minutes * MINUTE) to Dst.NONE
        is AlarmSpec.Day -> {
            val day = localDate(zone, anchor).minusDays(spec.daysBefore.toLong())
            wallTimeToInstant(zone, day, LocalTime.parse(spec.time, HHMM))
        }
    }

    /** The instant an alarm rings, counted from greatest eclipse, and how a clock change was resolved. */
    fun fireInstant(greatest: String, spec: AlarmSpec, zone: ZoneId): Pair<Long, Dst> =
        fireInstantAt(greatestMinute(greatest), spec, zone)

    /** The minute a record counts from: the start at its city (version 2), else greatest eclipse. */
    fun anchorOf(record: AlarmRecord, eclipse: Eclipse): Long = record.local?.start ?: greatestMinute(eclipse.greatest)

    /** The zone a record works in: its city's (version 2, wherever the phone is), else the phone's [phone]. */
    fun zoneOf(record: AlarmRecord, phone: ZoneId): ZoneId = record.local?.zone ?: phone

    /** The instant a stored record rings now: from its own anchor, in its own zone. */
    fun fireInstantFor(record: AlarmRecord, eclipse: Eclipse, phone: ZoneId): Long =
        fireInstantAt(anchorOf(record, eclipse), record.spec, zoneOf(record, phone)).first

    /** One alarm, planned from an anchor minute; its status is ok or past (planAlarmAt). */
    fun planAlarmAt(anchor: Long, spec: AlarmSpec, zone: ZoneId, now: Long): PlannedAlarm {
        val (at, dst) = fireInstantAt(anchor, spec, zone)
        val local = Instant.ofEpochMilli(at).atZone(zone)
        return PlannedAlarm(
            spec = spec,
            fireAt = at,
            localDate = local.toLocalDate().toString(),
            localTime = local.toLocalTime().format(HHMM),
            offsetMinutes = local.offset.totalSeconds / 60,
            status = if (at > now) "ok" else "past",
            afterGreatest = at > anchor,
            dst = dst,
        )
    }

    /** One alarm, planned from greatest eclipse (planAlarm). */
    fun planAlarm(greatest: String, spec: AlarmSpec, zone: ZoneId, now: Long): PlannedAlarm =
        planAlarmAt(greatestMinute(greatest), spec, zone, now)

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
     * time), a version 2 start more than [MAX_START_OFFSET_MS] from greatest eclipse (invalid), its
     * own time worked out now (in [zone] for a version 1 record, in its city's zone for a version 2
     * record) is after now (arm), otherwise passed. A missed
     * alarm is never rung late: it is deleted (C-23).
     */
    fun recordFate(raw: Any?, eclipse: Eclipse?, zone: ZoneId, now: Long): RecordFate {
        val record = AlarmRecord.parse(raw) ?: return RecordFate.Delete("invalid")
        if (eclipse == null || eclipse.id != record.eclipseId) return RecordFate.Delete("unknown-eclipse")
        if (now >= greatestMinute(eclipse.greatest) + RECORD_GRACE_MS) return RecordFate.Delete("expired")
        // A version 2 start far from greatest eclipse cannot come from the page: invalid, after the expiry test.
        val local = record.local
        if (local != null && Math.abs(local.start - greatestMinute(eclipse.greatest)) > MAX_START_OFFSET_MS) return RecordFate.Delete("invalid")
        val fireAt = fireInstantFor(record, eclipse, zone)
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
