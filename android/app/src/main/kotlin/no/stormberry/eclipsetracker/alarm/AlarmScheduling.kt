package no.stormberry.eclipsetracker.alarm

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.edit
import androidx.core.net.toUri
import no.stormberry.eclipsetracker.MainActivity
import no.stormberry.eclipsetracker.core.AlarmRecord
import no.stormberry.eclipsetracker.core.EclipseCatalogue
import org.json.JSONArray
import org.json.JSONObject
import java.time.ZoneId

/**
 * The only [AlarmSink] that talks to Android, and the only place that calls AlarmManager
 * (SunApp's AndroidAlarmSink). setAlarmClock for every alarm (MoonApp's audit fix, not
 * setExactAndAllowWhileIdle): exempt from Doze, shown in the system's next-alarm slot, and it
 * allows the ringing foreground service to start from the background when it fires. If the
 * exact call fails for any reason (the exact-alarm grant refused, or a build's own limits), the
 * alarm is armed inexactly instead (setAndAllowWhileIdle) and the page shows the problem; the
 * same rule arms a snooze (FireRules.armWithFallback, fix B, A-7).
 */
class AndroidAlarmSink(context: Context) : AlarmSink {
    private val appContext = context.applicationContext
    private val alarmManager: AlarmManager? = appContext.getSystemService(AlarmManager::class.java)

    override fun arm(alarm: ArmedAlarm) {
        val manager = alarmManager ?: return
        val result = try {
            val operation = PendingIntent.getBroadcast(
                appContext,
                alarm.requestCode,
                AlarmFireReceiver.fireIntent(appContext, alarm.requestCode, alarm.record.id, alarm.fireAt),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            FireRules.armWithFallback(
                exact = { manager.setAlarmClock(AlarmManager.AlarmClockInfo(alarm.fireAt, showIntent(alarm.requestCode)), operation) },
                inexact = { manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, alarm.fireAt, operation) },
            )
        } catch (e: RuntimeException) {
            ArmResult.FAILED
        }
        // One alarm lost is bad, a re-plan that stops half-way is worse: never throw.
        if (result != ArmResult.EXACT) Log.w(TAG, "alarm ${alarm.requestCode} armed: $result")
    }

    /**
     * Fix B, A-2: the inexact backstop for the nearest alarm, on Android 12 and 12L only (see
     * AlarmSink.guard).
     *
     * Fix C (17 October 2026, C-3): armed twice, each its own pending intent, because each kind of
     * inexact alarm fails differently there. setAndAllowWhileIdle survives Doze, but Android 12 gives
     * it a delivery window of up to an hour after its time, and app standby can hold it longer, so
     * it may come too late to ring (more than 10 minutes, FireRules.LATE_LIMIT_MS). setWindow with
     * the shortest window Android 12 allows (10 minutes from the alarm's time) arrives within the
     * late limit while the phone is awake or in light use, but not during Doze. Whichever arrives
     * first rings the alarm and deletes its record; the other then finds the record gone. Neither
     * is exact: with exact alarms switched off, the page's line stays "may ring late or not at all".
     */
    override fun guard(next: ArmedAlarm?) {
        val manager = alarmManager ?: return
        val revocable = Build.VERSION.SDK_INT == Build.VERSION_CODES.S || Build.VERSION.SDK_INT == Build.VERSION_CODES.S_V2
        for (slot in GuardSlot.entries) {
            try {
                if (revocable && next != null) {
                    val operation = PendingIntent.getBroadcast(
                        appContext, slot.requestCode, AlarmFireReceiver.guardIntent(appContext, slot.path, next.record.id, next.fireAt),
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    )
                    when (slot) {
                        GuardSlot.WHILE_IDLE -> manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next.fireAt, operation)
                        GuardSlot.WINDOW -> manager.setWindow(AlarmManager.RTC_WAKEUP, next.fireAt, GUARD_WINDOW_MS, operation)
                    }
                } else {
                    PendingIntent.getBroadcast(
                        appContext, slot.requestCode, AlarmFireReceiver.guardIntent(appContext, slot.path, null, 0L),
                        PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
                    )?.let { pending ->
                        manager.cancel(pending)
                        pending.cancel()
                    }
                }
            } catch (e: RuntimeException) {
                Log.w(TAG, "could not set the backstop ${slot.path}", e)
            }
        }
    }

    /** A snooze, exactly if allowed, else inexactly (fix B, A-6, A-7). Never throws. */
    fun armSnooze(snooze: Snooze): ArmResult {
        val manager = alarmManager ?: return ArmResult.FAILED
        return try {
            val code = AlarmScheduler.snoozeRequestCodeFor(snooze.recordId)
            val operation = PendingIntent.getBroadcast(
                appContext, code, AlarmFireReceiver.snoozeFiredIntent(appContext, code, snooze),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            FireRules.armWithFallback(
                exact = { manager.setAlarmClock(AlarmManager.AlarmClockInfo(snooze.at, showIntent(code)), operation) },
                inexact = { manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, snooze.at, operation) },
            )
        } catch (e: RuntimeException) {
            Log.e(TAG, "could not arm the snooze", e)
            ArmResult.FAILED
        }
    }

    /** Cancels the snooze of [recordId], if one is armed. */
    fun cancelSnooze(recordId: String) {
        val code = AlarmScheduler.snoozeRequestCodeFor(recordId)
        try {
            PendingIntent.getBroadcast(
                appContext, code, AlarmFireReceiver.snoozeFiredIntent(appContext, code, null),
                PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
            )?.let { pending ->
                alarmManager?.cancel(pending)
                pending.cancel()
            }
        } catch (e: RuntimeException) {
            Log.w(TAG, "could not cancel a snooze", e)
        }
    }

    /**
     * Fix E (C-3): whether the alarm of [requestCode] still has a live pending intent, which
     * AlarmManager keeps while the alarm is registered and a restart or a force stop clears. Asks
     * with FLAG_NO_CREATE, so it never creates one; an error counts as unknown (null).
     */
    fun isArmed(requestCode: Int): Boolean? = try {
        PendingIntent.getBroadcast(
            appContext,
            requestCode,
            AlarmFireReceiver.fireIntent(appContext, requestCode, null, 0L),
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
        ) != null
    } catch (e: RuntimeException) {
        Log.w(TAG, "could not ask for the pending intent of $requestCode", e)
        null
    }

    override fun cancel(requestCode: Int) {
        val existing = PendingIntent.getBroadcast(
            appContext,
            requestCode,
            AlarmFireReceiver.fireIntent(appContext, requestCode, null, 0L),
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
        ) ?: return
        try {
            alarmManager?.cancel(existing)
        } catch (e: RuntimeException) {
            Log.w(TAG, "could not cancel $requestCode", e)
        }
        existing.cancel()
    }

    /** Where the next-alarm chip in the status bar and on the lock screen leads: the app. */
    private fun showIntent(requestCode: Int): PendingIntent = PendingIntent.getActivity(
        appContext,
        requestCode,
        Intent(appContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    /** The two backstops (fix C, C-3): their codes, and their own data addresses, which keep them apart from each other and from any alarm's. */
    private enum class GuardSlot(val requestCode: Int, val path: String) {
        WHILE_IDLE(0x5E30, "guard"),
        WINDOW(0x5E32, "guard-window"),
    }

    private companion object {
        const val TAG = "EclipseAlarmSink"
        /** The shortest window Android 12 allows setWindow (shorter ones are lengthened to it). */
        const val GUARD_WINDOW_MS = 10L * 60_000L
    }
}

/**
 * What the app holds right now: the stored records, the alarms armed, and what the platform refuses;
 * also the alarms this re-plan reported as missed ([missed], fix E: FireRules.missed), each with a
 * "Missed" notice.
 */
data class AlarmState(
    val records: List<AlarmRecord>,
    val armed: List<ArmedAlarm>,
    val problems: List<Problem>,
    val missed: List<AlarmRecord> = emptyList(),
)

/**
 * Loads the records, works out what should be armed, and makes AlarmManager agree. Every entry
 * point funnels through [replan] (SunApp's AlarmScheduling), under one lock so a restart, a fire
 * and the page cannot interleave.
 *
 * Storage (spec 9.1, MoonApp's audit fix): the records live in DEVICE-PROTECTED storage, the only
 * storage readable between a restart and the first unlock, which is exactly when
 * LOCKED_BOOT_COMPLETED must re-arm them. They hold an eclipse id and the alarm the person chose,
 * nothing else. Excluded from every backup (xml/backup_rules.xml, xml/data_extraction_rules.xml).
 */
object AlarmScheduling {
    private const val TAG = "EclipseAlarmScheduling"
    private const val PREFS = "eclipse_alarms"
    private const val KEY_RECORDS = "records"
    private const val KEY_ARMED = "armed_request_codes"
    /**
     * Fix C (S-1): the instant each armed request code was armed for, a JSON object of code to epoch
     * milliseconds, so a re-plan racing a fire keeps a record only while its alarm is armed for the
     * instant worked out now (AlarmScheduler.plan).
     */
    private const val KEY_ARMED_AT = "armed_instants"
    /** Fix B, A-6: the snoozes waiting to ring, so a restart re-arms them and a deletion can cancel them. */
    private const val KEY_SNOOZES = "snoozes"
    /** Fix D (N-3): the boot (Settings.Global.BOOT_COUNT) the last restart re-plan ran in. */
    private const val KEY_RESTART_BOOT = "restart_replanned_boot"
    /**
     * Fix E (C-4): the records whose "Missed" notice is still to be posted, a JSON array of records,
     * written in the same save as the re-plan that deleted them and emptied once they are posted, so
     * a process that dies in between posts them at its next start.
     */
    private const val KEY_UNTOLD = "missed_untold"
    private const val CATALOGUE_ASSET = "web/data/eclipses.json"

    private val lock = Any()

    @Volatile
    private var catalogue: EclipseCatalogue? = null

    /** The bundled eclipse list (assets/web/data/eclipses.json), read once. */
    fun catalogue(context: Context): EclipseCatalogue =
        catalogue ?: synchronized(lock) {
            catalogue ?: context.applicationContext.assets.open(CATALOGUE_ASSET).use { input ->
                EclipseCatalogue.parse(String(input.readBytes(), Charsets.UTF_8))
            }.also { catalogue = it }
        }

    private fun prefs(context: Context): SharedPreferences = context.applicationContext
        .createDeviceProtectedStorageContext()
        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** The stored records as raw JSON values (any may be invalid; the re-plan deletes those). */
    private fun storedRaw(context: Context): List<Any?> {
        val text = prefs(context).getString(KEY_RECORDS, null) ?: return emptyList()
        return try {
            val array = JSONArray(text)
            List(array.length()) { array.opt(it) }
        } catch (e: Exception) {
            Log.e(TAG, "the stored alarms could not be read; starting afresh", e)
            emptyList()
        }
    }

    /** One stored record by id, or null. */
    fun record(context: Context, id: String): AlarmRecord? = synchronized(lock) {
        storedRaw(context).firstNotNullOfOrNull { AlarmRecord.parse(it)?.takeIf { r -> r.id == id } }
    }

    private fun storedSnoozes(context: Context): List<Snooze> {
        val text = prefs(context).getString(KEY_SNOOZES, null) ?: return emptyList()
        return try {
            val array = JSONArray(text)
            List(array.length()) { array.opt(it) }.mapNotNull { Snooze.parse(it) }
        } catch (e: Exception) {
            Log.e(TAG, "the stored snoozes could not be read", e)
            emptyList()
        }
    }

    private fun writeSnoozes(context: Context, snoozes: List<Snooze>) {
        prefs(context).edit(commit = true) {
            putString(KEY_SNOOZES, JSONArray().apply { snoozes.forEach { put(it.toJson()) } }.toString())
        }
    }

    /** The snoozes waiting now. */
    fun snoozes(context: Context): List<Snooze> = synchronized(lock) { storedSnoozes(context) }

    /** Arms [snooze] and, when it is armed, stores it (fix B, A-6, A-7). */
    fun snooze(context: Context, snooze: Snooze): ArmResult = synchronized(lock) {
        val result = AndroidAlarmSink(context).armSnooze(snooze)
        if (result != ArmResult.FAILED) {
            runCatching { writeSnoozes(context, FireRules.putSnooze(storedSnoozes(context), snooze)) }
                .onFailure { Log.e(TAG, "the snooze is armed but could not be stored", it) }
        }
        result
    }

    /** Forgets the snooze of [recordId] (it has fired). */
    fun removeSnooze(context: Context, recordId: String) = synchronized(lock) {
        writeSnoozes(context, storedSnoozes(context).filter { it.recordId != recordId })
    }

    /** Cancels and forgets the snooze of [recordId] (Dismiss). */
    fun cancelSnooze(context: Context, recordId: String) = synchronized(lock) {
        AndroidAlarmSink(context).cancelSnooze(recordId)
        writeSnoozes(context, storedSnoozes(context).filter { it.recordId != recordId })
    }

    /**
     * Re-plans everything at [now] in the phone's current zone: deletes the records that can never
     * ring again (recordFate), arms the nearest 100, cancels what is no longer wanted, and stores
     * the result. Never throws. The "Missed" notices it owes (fix E) are posted at once unless
     * [tell] is false (the fire receiver about to ring: a notice posted then would be taken away
     * by the ring, E-3) or something rings; they then wait for [tellMissed].
     */
    fun replan(context: Context, now: Long = System.currentTimeMillis(), drop: String? = null, tell: Boolean = true): AlarmState = synchronized(lock) {
        replanLocked(context, storedRaw(context), now, drop, tell = tell)
    }

    /**
     * Fix D (17 October 2026, N-3): the re-plan for LOCKED_BOOT_COMPLETED and BOOT_COMPLETED. The
     * first of the two in a boot re-plans as after a restart (AlarmManager holds nothing) and notes
     * the boot; the second, in the same boot, finds it noted and re-plans normally, so an alarm the
     * first one armed and whose time has just passed is left to its fire receiver, not deleted
     * (FireRules.bootIsRestart). The restart re-plan reports the alarms the restart cost. Fix E
     * (C-3): a boot broadcast is also a restart when none of the alarms still to come has a live
     * pending intent ([AndroidAlarmSink.isArmed]), whatever the boot count says.
     */
    fun replanAfterBoot(context: Context, now: Long = System.currentTimeMillis()): AlarmState = synchronized(lock) {
        val boot = bootCount(context)
        val noted = runCatching { prefs(context).getInt(KEY_RESTART_BOOT, -1) }.getOrDefault(-1)
        // Fix E (C-3): also a restart when none of the alarms still to come is held by AlarmManager.
        val live = runCatching {
            val prefs = prefs(context)
            val probe = FireRules.codesToProbe(armedCodes(prefs), armedInstants(prefs.getString(KEY_ARMED_AT, null)), now)
            if (probe.isEmpty()) {
                null
            } else {
                val sink = AndroidAlarmSink(context)
                val answers = probe.map { sink.isArmed(it) }
                if (answers.any { it == true }) true else if (answers.all { it == false }) false else null
            }
        }.getOrNull()
        val restart = FireRules.bootIsRestart(boot, noted, live)
        Log.i(
            TAG,
            if (restart) "boot $boot (alarms still held: $live): re-planning after a restart"
            else "boot $boot: re-planned after this restart already; a normal re-plan",
        )
        replanLocked(context, storedRaw(context), now, afterRestart = restart, restartBoot = if (restart) boot else -1)
    }

    /** The phone's count of boots, or -1 when it cannot be read. */
    private fun bootCount(context: Context): Int = try {
        Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1)
    } catch (e: RuntimeException) {
        Log.w(TAG, "could not read the boot count", e)
        -1
    }

    /**
     * The page's alarms.set (spec 9.6): replaces one eclipse's records and re-plans; null when
     * the records are refused (nothing changes then).
     */
    fun setEclipse(context: Context, eclipseId: String, incoming: Any?): AlarmState? = synchronized(lock) {
        val current = storedRaw(context).mapNotNull { AlarmRecord.parse(it) }
        val next = AlarmScheduler.replaceEclipse(current, eclipseId, incoming, catalogue(context)) ?: return@synchronized null
        // Fix B, A-6: every alarm of the eclipse deleted takes its waiting snoozes with it.
        runCatching {
            val before = storedSnoozes(context)
            val after = FireRules.snoozesAfterSet(before, eclipseId, next.count { it.eclipseId == eclipseId })
            if (after.size != before.size) {
                val sink = AndroidAlarmSink(context)
                (before.map { it.recordId }.toSet() - after.map { it.recordId }.toSet()).forEach { gone ->
                    sink.cancelSnooze(gone)
                    AlarmService.cancelNotice(context, gone)
                }
                writeSnoozes(context, after)
            }
        }.onFailure { Log.e(TAG, "could not cancel the deleted eclipse's snoozes", it) }
        replanLocked(context, next.map { it.toJson() }, System.currentTimeMillis())
    }

    private fun replanLocked(
        context: Context,
        stored: List<Any?>,
        now: Long,
        drop: String? = null,
        afterRestart: Boolean = false,
        restartBoot: Int = -1,
        tell: Boolean = true,
    ): AlarmState {
        val problems = try {
            AlarmCapability.problems(context)
        } catch (e: RuntimeException) {
            Log.w(TAG, "could not read the alarm permissions", e)
            emptyList()
        }
        return try {
            val zone = ZoneId.systemDefault()
            val prefs = prefs(context)
            val previously = armedCodes(prefs)
            val previouslyAt = armedInstants(prefs.getString(KEY_ARMED_AT, null))
            // F-1: what is armed now may still be on its way to the fire receiver; after a restart
            // nothing is. Fix C, S-1: only while it is armed for the instant worked out now.
            // Fix E (C-1, C-2): and the records deleted whose armed alarm can no longer ring.
            val (plan, missed) = AlarmScheduler.replan(stored, catalogue(context), zone, now, previously, previouslyAt, afterRestart, drop)
            // Fix E (C-4): the notices owed, stored with the deletion that owes them.
            val untold = FireRules.untold(storedUntold(prefs), missed)
            val sink = AndroidAlarmSink(context)
            val armedCodes = AlarmScheduler.apply(plan, sink, previously)
            // Fix B, A-6: the snoozes still to ring are armed again (after a restart AlarmManager
            // holds none); those past the late limit are forgotten.
            val snoozes = storedSnoozes(context)
            val keptSnoozes = FireRules.keepSnoozes(snoozes, now)
            keptSnoozes.forEach { sink.armSnooze(it) }
            (snoozes.map { it.recordId }.toSet() - keptSnoozes.map { it.recordId }.toSet()).forEach { sink.cancelSnooze(it) }
            prefs.edit(commit = true) {
                putString(KEY_RECORDS, plan.keepJson().toString())
                putStringSet(KEY_ARMED, armedCodes.mapTo(LinkedHashSet()) { it.toString() })
                putString(KEY_ARMED_AT, JSONObject().apply { plan.armed.forEach { put(it.requestCode.toString(), it.fireAt) } }.toString())
                putString(KEY_SNOOZES, JSONArray().apply { keptSnoozes.forEach { put(it.toJson()) } }.toString())
                // Fix D, N-3: noted only once the restart re-plan is stored, so a failed one is run again.
                if (restartBoot >= 0) putInt(KEY_RESTART_BOOT, restartBoot)
                putString(KEY_UNTOLD, JSONArray().apply { untold.forEach { put(it.toJson()) } }.toString())
            }
            plan.deleted.forEach { (id, why) -> Log.i(TAG, "deleted record ${id.take(8)}: $why") }
            Log.i(TAG, "re-planned in $zone: ${plan.keep.size} record(s), ${plan.armed.size} armed")
            missed.forEach { Log.i(TAG, "record ${it.id.take(8)}: its armed alarm can no longer ring; a Missed notice") }
            if (tell) tellMissedLocked(context)
            AlarmState(plan.keep, plan.armed, problems, missed)
        } catch (e: RuntimeException) {
            Log.e(TAG, "re-planning failed", e)
            AlarmState(stored.mapNotNull { AlarmRecord.parse(it) }, emptyList(), problems)
        }
    }

    /**
     * Fix E (C-4): posts every "Missed" notice still owed, then forgets those it posted; while an
     * alarm rings it posts none (the ring would take them away, E-3) and they wait until nothing
     * rings (AlarmService.repostSnoozedNotices). One notice per record, tagged with its id, so a
     * notice posted twice replaces itself. Never throws.
     */
    fun tellMissed(context: Context) = synchronized(lock) { tellMissedLocked(context) }

    private fun tellMissedLocked(context: Context) {
        try {
            if (AlarmService.current() != null) return
            val prefs = prefs(context)
            val untold = storedUntold(prefs)
            if (untold.isEmpty()) return
            untold.forEach { AlarmService.postNotRungNotice(context, it) }
            val told = untold.mapTo(HashSet()) { it.id }
            prefs.edit(commit = true) {
                putString(KEY_UNTOLD, JSONArray().apply { storedUntold(prefs).filter { it.id !in told }.forEach { put(it.toJson()) } }.toString())
            }
        } catch (e: RuntimeException) {
            Log.e(TAG, "could not post the Missed notices; they stay owed", e)
        }
    }

    private fun storedUntold(prefs: SharedPreferences): List<AlarmRecord> {
        val text = prefs.getString(KEY_UNTOLD, null) ?: return emptyList()
        return try {
            val array = JSONArray(text)
            List(array.length()) { array.opt(it) }.mapNotNull { AlarmRecord.parse(it) }
        } catch (e: Exception) {
            Log.w(TAG, "the owed Missed notices could not be read", e)
            emptyList()
        }
    }

    private fun armedCodes(prefs: SharedPreferences): LinkedHashSet<Int> =
        prefs.getStringSet(KEY_ARMED, emptySet()).orEmpty().mapNotNullTo(LinkedHashSet()) { it.toIntOrNull() }

    /** The stored armed instants (fix C, S-1); anything unreadable counts as unknown, which deletes rather than rings late. */
    private fun armedInstants(text: String?): Map<Int, Long> {
        if (text == null) return emptyMap()
        return try {
            val o = JSONObject(text)
            buildMap {
                o.keys().forEach { key ->
                    val code = key.toIntOrNull() ?: return@forEach
                    val at = no.stormberry.eclipsetracker.core.Json.wholeNumber(o.opt(key)) ?: return@forEach
                    if (at > 0L) put(code, at)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "the armed instants could not be read", e)
            emptyMap()
        }
    }

    /** The fire intent's address, so a cancel can rebuild the pending intent from the code alone. */
    fun fireUri(requestCode: Int) = "eclipsetracker://alarm/$requestCode".toUri()
}
