package no.stormberry.eclipsetracker.alarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import no.stormberry.eclipsetracker.R
import no.stormberry.eclipsetracker.core.Words
import java.time.ZoneId
import java.util.TimeZone

/**
 * Receives the alarm from AlarmManager, the snoozed alarm coming back, and Snooze and Dismiss from
 * the notifications and the ring screen (SunApp's AlarmFireReceiver). It never throws: every
 * action runs inside one catch (fix B, A-7).
 *
 * When an alarm fires (or its Android 12 backstop, AlarmScheduling.guard), [FireRules.decide]
 * decides, with the record as stored now and its time worked out afresh in the phone's zone now
 * (fix B, A-8):
 *  1. its record is gone (deleted, or already rung): nothing rings;
 *  2. it arrived more than two seconds early: the clock moved, nothing rings;
 *  3. it arrived more than ten minutes late: missed, never rung late (spec 9.4, C-23); the
 *     re-plan deletes it and posts its "Missed" notice (fix D, N-3; fix E: FireRules.missed);
 *  4. worked out afresh it rings at another instant (a change of zone not yet re-planned):
 *     nothing rings now; the re-plan arms the right instant or deletes it as passed;
 *  5. otherwise the re-plan runs FIRST, at the alarm's own time, so the ringing record is deleted
 *     and the next nearest alarm armed (spec 9.7), and then it rings: the ringing service, or,
 *     when Android will not let the service start (Android 12 and 12L with exact alarms off,
 *     fix B, A-2), the backup ring notification.
 * In cases 1 to 4 the re-plan runs at the present moment. In case 5 it posts no "Missed" notice
 * for other alarms: the ring would take it away (E-3); it waits until nothing rings (fix E, C-4).
 */
class AlarmFireReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        try {
            when (intent.action) {
                ACTION_FIRED, ACTION_GUARD -> onFired(context, intent)
                ACTION_SNOOZE_FIRED -> onSnoozeFired(context, intent)
                ACTION_SNOOZE -> onSnooze(context, intent)
                ACTION_DISMISS -> onDismiss(context, intent)
                ACTION_BACKUP_GONE -> onBackupGone(context, intent)
                else -> Log.w(TAG, "ignoring ${intent.action}")
            }
        } catch (e: RuntimeException) {
            Log.e(TAG, "could not handle ${intent.action}", e)
        }
    }

    private fun onFired(context: Context, intent: Intent) {
        AlarmWakeLock.acquire(context)
        var handedOff = false
        try {
            val id = intent.getStringExtra(EXTRA_RECORD_ID)
            val fireAt = intent.getLongExtra(EXTRA_FIRE_AT, 0L)
            val now = System.currentTimeMillis()
            // The phone's zone as it is now, not as this process last read it (A-8).
            TimeZone.setDefault(null)
            val zone = ZoneId.systemDefault()
            val record = id?.let { runCatching { AlarmScheduling.record(context, it) }.getOrNull() }
            val eclipse = record?.let { runCatching { AlarmScheduling.catalogue(context)[it.eclipseId] }.getOrNull() }
            when (val decision = FireRules.decide(record, eclipse, zone, fireAt, now)) {
                FireDecision.Ring -> {
                    // The ringing record goes now (F-1: a re-plan would otherwise keep it as due).
                    safeReplan(context, maxOf(now, fireAt), drop = record!!.id, tell = false)
                    val alarm = RingingAlarm(
                        recordId = record!!.id,
                        eclipseId = record.eclipseId,
                        title = eclipse?.let { Words.eclipseName(it) } ?: context.getString(R.string.alarm_default_title),
                        text = Words.alarmWords(record.spec),
                        fireAt = if (fireAt > 0L) fireAt else now,
                    )
                    handedOff = ring(context, alarm)
                }
                else -> {
                    Log.w(TAG, "${intent.action}: ${describe(decision, fireAt, now)}; not ringing")
                    // Moved into the past by a change of zone: missed, never rung late (spec 9.4).
                    val missed = (decision as? FireDecision.Moved)?.takeIf { it.freshAt <= now }?.let { record?.id }
                    // Too late to ring (held back after a restart, or by Android): the re-plan deletes its
                    // record and posts its "Missed" notice (fix D, N-3; fix E, FireRules.missed).
                    safeReplan(context, now, drop = missed)
                }
            }
        } finally {
            if (!handedOff) AlarmWakeLock.release()
        }
    }

    /** A snoozed alarm coming back: it rings with the words it had; there is no record behind it any more. */
    private fun onSnoozeFired(context: Context, intent: Intent) {
        AlarmWakeLock.acquire(context)
        var handedOff = false
        try {
            val id = intent.getStringExtra(EXTRA_RECORD_ID)
            val at = intent.getLongExtra(EXTRA_FIRE_AT, 0L)
            val now = System.currentTimeMillis()
            val decision = FireRules.decideSnooze(at, now)
            if (decision == FireDecision.Early) {
                // The clock moved: the snooze stays stored and the re-plan arms it again for its instant.
                Log.w(TAG, "snooze arrived early; re-arming it")
                safeReplan(context, now)
                return
            }
            if (id != null) runCatching { AlarmScheduling.removeSnooze(context, id) }
            AlarmService.cancelNotice(context, id)
            if (decision == FireDecision.Late) {
                Log.w(TAG, "snooze arrived ${now - at} ms late: missed, never rung late")
                return
            }
            handedOff = ring(
                context,
                RingingAlarm(
                    recordId = id,
                    eclipseId = intent.getStringExtra(EXTRA_ECLIPSE_ID),
                    title = intent.getStringExtra(EXTRA_TITLE) ?: context.getString(R.string.alarm_default_title),
                    text = intent.getStringExtra(EXTRA_TEXT).orEmpty(),
                    fireAt = now,
                ),
            )
        } finally {
            if (!handedOff) AlarmWakeLock.release()
        }
    }

    /**
     * Starts the ringing service; when Android refuses (on Android 12 and 12L an inexact alarm
     * may not start a foreground service from the background), rings through the backup
     * notification instead (fix B, A-2). True when the wake lock was handed to the service.
     */
    private fun ring(context: Context, alarm: RingingAlarm): Boolean =
        try {
            ContextCompat.startForegroundService(context, AlarmService.ringIntent(context, alarm))
            true
        } catch (e: RuntimeException) {
            Log.e(TAG, "could not start the ringing service; ringing through the backup notification", e)
            AlarmService.postBackupRing(context, alarm)
            false
        }

    /**
     * Snooze: the snooze is armed FIRST; only when it is armed (exactly, or inexactly) does the
     * ringing stop (fix B, A-7). If neither works the alarm keeps ringing, so Dismiss is still
     * there and nothing is lost silently. The snooze is stored, so a restart re-arms it, and its
     * notice has Dismiss (fix B, A-6).
     */
    private fun onSnooze(context: Context, intent: Intent) {
        val id = intent.getStringExtra(EXTRA_RECORD_ID)
        val eclipseId = intent.getStringExtra(EXTRA_ECLIPSE_ID)
        if (id == null || eclipseId == null) {
            Log.w(TAG, "snooze without its alarm; stopping")
            stopRinging(context)
            return
        }
        val snooze = Snooze(
            recordId = id,
            eclipseId = eclipseId,
            at = System.currentTimeMillis() + SNOOZE_MINUTES * 60_000L,
            title = (intent.getStringExtra(EXTRA_TITLE) ?: context.getString(R.string.alarm_default_title)).take(Snooze.MAX_WORDS),
            text = intent.getStringExtra(EXTRA_TEXT).orEmpty().take(Snooze.MAX_WORDS),
        )
        val result = AlarmScheduling.snooze(context, snooze)
        if (result == ArmResult.FAILED) {
            Log.e(TAG, "the snooze could not be armed; the alarm keeps ringing")
            return
        }
        stopRinging(context)
        AlarmService.postSnoozedNotice(context, snooze)
    }

    private fun onDismiss(context: Context, intent: Intent) {
        val id = intent.getStringExtra(EXTRA_RECORD_ID)
        // Dismiss from a snoozed notice must not silence another alarm that rings meanwhile.
        val current = AlarmService.current()
        if (current == null || current.recordId == id) stopRinging(context)
        if (id == null) return
        // Dismiss means dismiss: a snooze still waiting for this alarm goes with it, and its notice.
        runCatching { AlarmScheduling.cancelSnooze(context, id) }
        AlarmService.cancelNotice(context, id)
    }

    /**
     * The backup ring notification was swiped away or reached its timeout. When it rang to the
     * end, it says so as the ringing service does ("Missed").
     */
    private fun onBackupGone(context: Context, intent: Intent) {
        val alarm = AlarmService.alarmFrom(context, intent)
        val current = AlarmService.current()
        if (current == null || current.key == alarm.key) {
            AlarmService.setBackup(null)
            AlarmService.repostSnoozedNotices(context)
        }
        if (System.currentTimeMillis() >= alarm.fireAt + AlarmService.AUTO_SILENCE_MS - BACKUP_TIMEOUT_SLACK_MS) {
            AlarmService.postMissedNotice(context, alarm, R.string.missed_text)
        }
    }

    /** stopService is allowed from the background on every version; the service's onDestroy releases everything. */
    private fun stopRinging(context: Context) {
        runCatching { context.stopService(Intent(context, AlarmService::class.java)) }
        AlarmService.setBackup(null)
        AlarmService.cancelRingNotification(context)
        // The notices a ring takes away (E-3) come back once nothing rings.
        AlarmService.repostSnoozedNotices(context)
    }

    private fun safeReplan(context: Context, now: Long, drop: String? = null, tell: Boolean = true) {
        try {
            AlarmScheduling.replan(context, now, drop, tell)
        } catch (e: RuntimeException) {
            Log.e(TAG, "re-planning after a fire failed", e)
        }
    }

    private fun describe(decision: FireDecision, fireAt: Long, now: Long): String = when (decision) {
        FireDecision.Gone -> "its record is gone"
        FireDecision.Early -> "arrived ${fireAt - now} ms early: the clock moved"
        FireDecision.Late -> "arrived ${now - fireAt} ms late: missed, never rung late"
        is FireDecision.Moved -> "its time worked out now is ${decision.freshAt}, not $fireAt: the zone changed"
        FireDecision.Ring -> "rings"
    }

    companion object {
        private const val TAG = "EclipseAlarmFire"

        const val ACTION_FIRED = "no.stormberry.eclipsetracker.action.ALARM_FIRED"
        /** The Android 12 and 12L backstop for the nearest alarm (AlarmScheduling.guard, fix B, A-2). */
        const val ACTION_GUARD = "no.stormberry.eclipsetracker.action.ALARM_GUARD"
        const val ACTION_SNOOZE_FIRED = "no.stormberry.eclipsetracker.action.SNOOZE_FIRED"
        const val ACTION_SNOOZE = "no.stormberry.eclipsetracker.action.SNOOZE"
        const val ACTION_DISMISS = "no.stormberry.eclipsetracker.action.DISMISS"
        const val ACTION_BACKUP_GONE = "no.stormberry.eclipsetracker.action.BACKUP_GONE"

        const val EXTRA_RECORD_ID = "no.stormberry.eclipsetracker.extra.RECORD_ID"
        const val EXTRA_ECLIPSE_ID = "no.stormberry.eclipsetracker.extra.ECLIPSE_ID"
        const val EXTRA_FIRE_AT = "no.stormberry.eclipsetracker.extra.FIRE_AT"
        const val EXTRA_REQUEST_CODE = "no.stormberry.eclipsetracker.extra.REQUEST_CODE"
        const val EXTRA_TITLE = "no.stormberry.eclipsetracker.extra.TITLE"
        const val EXTRA_TEXT = "no.stormberry.eclipsetracker.extra.TEXT"

        /** Nine minutes, as every alarm clock since the mechanical snooze bar (SunApp). */
        const val SNOOZE_MINUTES = 9

        /** A backup notification gone within this of its timeout counts as timed out (rang to the end). */
        private const val BACKUP_TIMEOUT_SLACK_MS = 60_000L

        /**
         * The intent AlarmManager delivers, and the same shape AndroidAlarmSink.cancel rebuilds from
         * the request code alone: the per-code data address is what keeps two alarms apart, because
         * PendingIntent matching ignores extras (MoonApp's audit: unique request codes per alarm).
         */
        fun fireIntent(context: Context, requestCode: Int, recordId: String?, fireAt: Long): Intent =
            Intent(context, AlarmFireReceiver::class.java)
                .setAction(ACTION_FIRED)
                .setData(AlarmScheduling.fireUri(requestCode))
                .putExtra(EXTRA_REQUEST_CODE, requestCode)
                .putExtra(EXTRA_RECORD_ID, recordId)
                .putExtra(EXTRA_FIRE_AT, fireAt)

        /** A backstop's intent: an address of its own ([path], fix C: two backstops), so it never replaces an alarm's or the other's. */
        fun guardIntent(context: Context, path: String, recordId: String?, fireAt: Long): Intent =
            Intent(context, AlarmFireReceiver::class.java)
                .setAction(ACTION_GUARD)
                .setData("eclipsetracker://$path".toUri())
                .putExtra(EXTRA_RECORD_ID, recordId)
                .putExtra(EXTRA_FIRE_AT, fireAt)

        fun snoozeFiredIntent(context: Context, code: Int, snooze: Snooze?): Intent =
            Intent(context, AlarmFireReceiver::class.java)
                .setAction(ACTION_SNOOZE_FIRED)
                .setData("eclipsetracker://snooze/$code".toUri())
                .apply {
                    if (snooze != null) {
                        putExtra(EXTRA_RECORD_ID, snooze.recordId)
                        putExtra(EXTRA_ECLIPSE_ID, snooze.eclipseId)
                        putExtra(EXTRA_FIRE_AT, snooze.at)
                        putExtra(EXTRA_TITLE, snooze.title)
                        putExtra(EXTRA_TEXT, snooze.text)
                    }
                }

        fun snoozeIntent(context: Context, alarm: RingingAlarm?): Intent =
            Intent(context, AlarmFireReceiver::class.java)
                .setAction(ACTION_SNOOZE)
                .setData("eclipsetracker://snooze-press/${alarm?.recordId.orEmpty()}".toUri())
                .putExtra(EXTRA_RECORD_ID, alarm?.recordId)
                .putExtra(EXTRA_ECLIPSE_ID, alarm?.eclipseId)
                .putExtra(EXTRA_TITLE, alarm?.title)
                .putExtra(EXTRA_TEXT, alarm?.text)

        fun dismissIntent(context: Context, recordId: String?): Intent =
            Intent(context, AlarmFireReceiver::class.java)
                .setAction(ACTION_DISMISS)
                .setData("eclipsetracker://dismiss/${recordId.orEmpty()}".toUri())
                .putExtra(EXTRA_RECORD_ID, recordId)

        fun backupGoneIntent(context: Context, recordId: String?): Intent =
            Intent(context, AlarmFireReceiver::class.java)
                .setAction(ACTION_BACKUP_GONE)
                .setData("eclipsetracker://backup-gone/${recordId.orEmpty()}".toUri())
    }
}

/** The wake lock that carries an alarm from the broadcast into the ringing service (SunApp's). */
internal object AlarmWakeLock {
    private const val TIMEOUT_MS = 60_000L
    private var wakeLock: PowerManager.WakeLock? = null

    @Synchronized
    fun acquire(context: Context) {
        if (wakeLock?.isHeld == true) return
        val power = context.applicationContext.getSystemService(PowerManager::class.java) ?: return
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "EclipseTracker:alarm").apply {
            setReferenceCounted(false)
            acquire(TIMEOUT_MS)
        }
    }

    @Synchronized
    fun release() {
        val held = wakeLock ?: return
        wakeLock = null
        if (held.isHeld) runCatching { held.release() }
    }
}
