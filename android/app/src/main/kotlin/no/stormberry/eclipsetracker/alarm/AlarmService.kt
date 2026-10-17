package no.stormberry.eclipsetracker.alarm

import android.annotation.SuppressLint
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.text.format.DateFormat
import android.util.Log
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import no.stormberry.eclipsetracker.R
import no.stormberry.eclipsetracker.core.AlarmRecord
import no.stormberry.eclipsetracker.core.Words
import java.util.Date
import kotlin.math.PI
import kotlin.math.min
import kotlin.math.sin

/** What is ringing now, for the ring screen; [eclipseId] lets a snooze of it be deleted with its eclipse's alarms (fix B, A-6). */
data class RingingAlarm(val recordId: String?, val eclipseId: String?, val title: String, val text: String, val fireAt: Long) {
    /** One ring of one alarm: a snooze of it rings with another [fireAt]. */
    val key: String get() = "${recordId.orEmpty()}@$fireAt"
}

/**
 * Rings the alarm (SunApp's AlarmService, with MoonApp's audit fixes): a foreground service of type
 * systemExempted, the tone on the alarm stream (the phone's own alarm sound, LOOPING, with a
 * generated two-note tone if that cannot be played), vibration, and the ring notification whose
 * full-screen intent opens the ring screen over the lock screen (a background activity start from
 * the receiver would be blocked on Android 10 and later). It stops on Dismiss, on Snooze, or on its
 * own after [AUTO_SILENCE_MS] (the ring timeout), when it leaves a "missed" notice.
 *
 * Fix B (16 October 2026):
 *  - A-1: it rings even when notifications are off or the ring channel is turned down, when the
 *    person sees nothing; the app's own screen then opens the ring screen while it rings
 *    (MainActivity), so opening EclipseTracker is always a way to stop it;
 *  - A-2 and A-4: when the ringing cannot run here (Android refused the foreground, or the
 *    receiver could not start this service at all), the backup ring notification rings instead:
 *    the phone's alarm sound, repeated, on its own channel, with the ring screen as its
 *    full-screen intent, Snooze and Dismiss, and gone after the ring timeout;
 *  - A-5: a second alarm arriving while one rings releases the first one's wake lock and reports
 *    the first one as missed.
 */
class AlarmService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private var mediaPlayer: MediaPlayer? = null
    private var tone: AudioTrack? = null
    private var vibrator: Vibrator? = null
    private var focusRequest: AudioFocusRequest? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var volume = START_VOLUME

    /** A-4: this service holds the backup ring notification in the foreground (no tone of its own). */
    private var holdsBackup = false

    /** A-5: alarms that stopped unanswered when the next one began, told once nothing rings (see ringAlone). */
    private val deferredMissed = ArrayList<RingingAlarm>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null || intent.action != ACTION_RING) {
            // Restarted by the system: the moment has passed, and ringing late is worse than silence.
            stopSelf()
            return START_NOT_STICKY
        }
        val alarm = alarmFrom(this, intent)
        // A-5: an alarm still ringing stops unanswered; say so, and let its wake lock go first.
        val replaced = FireRules.replaced(ringing, alarm)
        stopRinging()
        releaseWakeLock()
        // Its "Missed" notice waits until nothing rings: posted now, it would silence this ring (ringAlone).
        if (replaced != null) deferredMissed += replaced
        setBackup(null)
        setCurrent(alarm)
        ringAlone(this)
        if (!startInForeground(buildRingNotification(alarm))) {
            // A-4: without the foreground this service cannot play the tone. The backup ring
            // notification rings instead (the alarm sound, repeated, the ring screen, Snooze,
            // Dismiss); the ring screen stays open on it. When Android lets this service hold the
            // backup notification in the foreground, it does, until Dismiss, Snooze or the ring
            // timeout: that settles Android's demand that a service started with
            // startForegroundService enter the foreground, so stopping cannot crash the app. It is
            // NOT detached and left behind: on Android 16 that update counts as a second alert
            // straight after the first and is muted ("recently noisy"), which stops the sound
            // (emulator, 16 October 2026). Only if that fails too is it posted plainly.
            Log.w(TAG, "ringing through the backup notification instead")
            setCurrent(null)
            AlarmWakeLock.release()
            if (ringBackupFromService(alarm)) {
                holdsBackup = true
                handler.postDelayed({ autoSilence(alarm) }, AUTO_SILENCE_MS)
            } else {
                stopSelf()
            }
            return START_NOT_STICKY
        }
        holdsBackup = false
        acquireWakeLock()
        AlarmWakeLock.release()
        volume = START_VOLUME
        startAudio()
        startVibration()
        handler.postDelayed(crescendo, CRESCENDO_INTERVAL_MS)
        handler.postDelayed({ autoSilence(alarm) }, AUTO_SILENCE_MS)
        Log.i(TAG, "ringing")
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopRinging()
        setCurrent(null)
        if (holdsBackup) setBackup(null)
        releaseWakeLock()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        // Nothing rings any more: the notices ringAlone took away come back (the snoozes still
        // waiting, with Dismiss), and the alarms another alarm cut short are told as missed.
        deferredMissed.forEach { postMissedNotice(this, it, R.string.missed_replaced_text) }
        deferredMissed.clear()
        repostSnoozedNotices(this)
        Log.i(TAG, "stopped ringing")
        super.onDestroy()
    }

    private fun foregroundType(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED else 0

    private fun startInForeground(notification: Notification): Boolean = try {
        // Debug builds only: lets the emulator test force the A-4 path (TestHooks.kt; release has none).
        if (TestHooks.failForeground(this)) throw IllegalStateException("test hook: the foreground is refused")
        ServiceCompat.startForeground(this, NOTIFICATION_ID_RING, notification, foregroundType())
        true
    } catch (e: RuntimeException) {
        Log.e(TAG, "could not enter the foreground", e)
        false
    }

    /**
     * A-4: the backup ring notification, held in the foreground by this service if Android allows
     * it (true), else posted plainly (false; the service then stops).
     */
    private fun ringBackupFromService(alarm: RingingAlarm): Boolean {
        ensureChannels(this)
        setBackup(alarm)
        val backup = buildBackupNotification(this, alarm)
        return try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID_RING, backup, foregroundType())
            true
        } catch (e: RuntimeException) {
            Log.e(TAG, "could not enter the foreground with the backup either", e)
            postPlain(this, NOTIFICATION_ID_RING, backup)
            false
        }
    }

    private fun buildRingNotification(alarm: RingingAlarm): Notification {
        val ring = ringScreenIntent(this, alarm, backup = false)
        val snooze = snoozePendingIntent(this, alarm)
        val dismiss = dismissPendingIntent(this, alarm.recordId)
        return NotificationCompat.Builder(this, CHANNEL_RING)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(alarm.title)
            .setContentText(alarm.text)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            // The service plays the sound itself, so it can loop, rise and stop on Dismiss; the
            // channel has no sound and no vibration of its own. NOT setSilent(true): that puts the
            // notification in a silent group with GROUP_ALERT_SUMMARY, and Android then suppresses
            // its full-screen intent, so the ring screen never opened (found on the emulator,
            // 16 October 2026, defect E-2; SunApp's AlarmService has the same call).
            .setOnlyAlertOnce(true)
            .setFullScreenIntent(ring, true)
            .setContentIntent(ring)
            .addAction(0, getString(R.string.action_snooze), snooze)
            .addAction(0, getString(R.string.action_dismiss), dismiss)
            .build()
    }

    private fun autoSilence(alarm: RingingAlarm) {
        Log.i(TAG, "ring timeout: silenced after ${AUTO_SILENCE_MS / 60_000} minutes")
        postMissedNotice(this, alarm, R.string.missed_text)
        stopSelf()
    }

    // ------------------------------------------------------------------------------- audio

    private fun startAudio() {
        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        requestFocus(attributes)
        val uri = runCatching { RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_ALARM) }.getOrNull()
            ?: Settings.System.DEFAULT_ALARM_ALERT_URI
        if (uri != null && startRingtone(uri, attributes)) return
        Log.w(TAG, "no playable alarm sound, using the generated tone")
        startGeneratedTone(attributes)
    }

    private fun startRingtone(uri: Uri, attributes: AudioAttributes): Boolean = try {
        mediaPlayer = MediaPlayer().apply {
            setAudioAttributes(attributes)
            setWakeMode(this@AlarmService, PowerManager.PARTIAL_WAKE_LOCK)
            setDataSource(this@AlarmService, uri)
            // MoonApp's audit: the tone played once and stopped. It loops until Dismiss, Snooze or the timeout.
            isLooping = true
            setVolume(START_VOLUME, START_VOLUME)
            prepare()
            start()
        }
        true
    } catch (e: Exception) {
        // Before the first unlock the media provider cannot be read: the generated tone covers it.
        Log.w(TAG, "could not play the alarm sound", e)
        releasePlayer()
        false
    }

    /** SunApp's fallback: a two-note tone made with arithmetic, looping with no gap. */
    private fun startGeneratedTone(attributes: AudioAttributes) {
        try {
            val samples = generateTone()
            val track = AudioTrack.Builder()
                .setAudioAttributes(attributes)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(SAMPLE_RATE_HZ)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build(),
                )
                .setBufferSizeInBytes(samples.size * 2)
                .setTransferMode(AudioTrack.MODE_STATIC)
                .build()
            track.write(samples, 0, samples.size)
            track.setLoopPoints(0, samples.size, -1)
            track.setVolume(START_VOLUME)
            track.play()
            tone = track
        } catch (e: RuntimeException) {
            Log.e(TAG, "could not start the generated tone either", e)
            releaseTone()
        }
    }

    private fun generateTone(): ShortArray {
        val total = SAMPLE_RATE_HZ * 1_400 / 1000
        val slot = SAMPLE_RATE_HZ * 450 / 1000
        val note = SAMPLE_RATE_HZ * 350 / 1000
        val ramp = SAMPLE_RATE_HZ * 12 / 1000
        val out = ShortArray(total)
        val frequencies = doubleArrayOf(880.0, 660.0)
        for (n in frequencies.indices) {
            for (i in 0 until note) {
                val index = n * slot + i
                if (index >= total) break
                val envelope = min(1.0, min(i, note - i).toDouble() / ramp)
                out[index] = (sin(2.0 * PI * frequencies[n] * i / SAMPLE_RATE_HZ) * envelope * 0.6 * Short.MAX_VALUE).toInt().toShort()
            }
        }
        return out
    }

    private fun requestFocus(attributes: AudioAttributes) {
        val audio = getSystemService(AudioManager::class.java) ?: return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(attributes)
                    .setWillPauseWhenDucked(false)
                    // An alarm never yields its sound to another app.
                    .setOnAudioFocusChangeListener { }
                    .build()
                focusRequest = request
                audio.requestAudioFocus(request)
            } else {
                @Suppress("DEPRECATION")
                audio.requestAudioFocus(null, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            }
        } catch (e: RuntimeException) {
            Log.w(TAG, "could not take audio focus", e)
        }
    }

    private fun abandonFocus() {
        val audio = getSystemService(AudioManager::class.java) ?: return
        runCatching {
            val request = focusRequest
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && request != null) {
                audio.abandonAudioFocusRequest(request)
            } else {
                @Suppress("DEPRECATION")
                audio.abandonAudioFocus(null)
            }
        }
        focusRequest = null
    }

    /** Rises over about thirty seconds, as SunApp's. */
    private val crescendo = object : Runnable {
        override fun run() {
            volume = min(1f, volume + CRESCENDO_STEP)
            mediaPlayer?.runCatching { setVolume(volume, volume) }
            tone?.runCatching { setVolume(volume) }
            if (volume < 1f) handler.postDelayed(this, CRESCENDO_INTERVAL_MS)
        }
    }

    private fun startVibration() {
        val device = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Vibrator::class.java)
        } ?: return
        vibrator = device
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                device.vibrate(VibrationEffect.createWaveform(VIBRATION_PATTERN, 0), VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM))
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                @Suppress("DEPRECATION")
                device.vibrate(VibrationEffect.createWaveform(VIBRATION_PATTERN, 0), alarmAudioAttributes())
            } else {
                @Suppress("DEPRECATION")
                device.vibrate(VIBRATION_PATTERN, 0, alarmAudioAttributes())
            }
        } catch (e: RuntimeException) {
            Log.w(TAG, "could not vibrate", e)
        }
    }

    private fun alarmAudioAttributes(): AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ALARM)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()

    private fun acquireWakeLock() {
        val power = getSystemService(PowerManager::class.java) ?: return
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "EclipseTracker:ring").apply {
            setReferenceCounted(false)
            acquire(AUTO_SILENCE_MS + 30_000L)
        }
    }

    private fun releaseWakeLock() {
        val held = wakeLock ?: return
        wakeLock = null
        if (held.isHeld) runCatching { held.release() }
    }

    private fun stopRinging() {
        handler.removeCallbacksAndMessages(null)
        releasePlayer()
        releaseTone()
        abandonFocus()
        runCatching { vibrator?.cancel() }
        vibrator = null
    }

    private fun releasePlayer() {
        val player = mediaPlayer ?: return
        mediaPlayer = null
        runCatching { player.stop() }
        runCatching { player.release() }
    }

    private fun releaseTone() {
        val track = tone ?: return
        tone = null
        runCatching { track.stop() }
        runCatching { track.release() }
    }

    companion object {
        private const val TAG = "EclipseAlarmService"
        const val ACTION_RING = "no.stormberry.eclipsetracker.action.RING"

        const val CHANNEL_RING = "alarm_ring"
        const val CHANNEL_NOTICES = "alarm_notices"
        /** Fix B (A-2, A-4): the backup ring notification's channel, with the phone's alarm sound of its own. */
        const val CHANNEL_RING_BACKUP = "alarm_ring_backup"

        const val NOTIFICATION_ID_RING = 0x5E01
        private const val NOTIFICATION_ID_NOTICE = 0x5E02
        private const val REQUEST_RING_SCREEN = 0x5E10
        private const val REQUEST_SNOOZE = 0x5E11
        private const val REQUEST_DISMISS = 0x5E12
        private const val REQUEST_RING_SCREEN_BACKUP = 0x5E13
        private const val REQUEST_BACKUP_GONE = 0x5E14

        /** The ring timeout (MoonApp's audit: an unanswered alarm rang for ever). Ten minutes, as SunApp. */
        const val AUTO_SILENCE_MS = 10L * 60L * 1000L

        private const val START_VOLUME = 0.12f
        private const val CRESCENDO_INTERVAL_MS = 500L
        private const val CRESCENDO_STEP = 0.0147f
        private val VIBRATION_PATTERN = longArrayOf(0L, 500L, 800L)
        private const val SAMPLE_RATE_HZ = 44_100

        /** What this service rings now. */
        @Volatile
        var ringing: RingingAlarm? = null
            private set

        /** What the backup ring notification rings now (fix B, A-2, A-4), when this service could not. */
        @Volatile
        private var backup: RingingAlarm? = null

        private val listeners = java.util.concurrent.CopyOnWriteArraySet<() -> Unit>()

        /** The ring screen and the app's screen listen: the ring screen closes when nothing rings any more. */
        fun addListener(l: () -> Unit) { listeners += l }
        fun removeListener(l: () -> Unit) { listeners -= l }

        private fun notifyListeners() {
            Handler(Looper.getMainLooper()).post { listeners.forEach { it() } }
        }

        private fun setCurrent(alarm: RingingAlarm?) {
            ringing = alarm
            notifyListeners()
        }

        /** Sets (or clears) what the backup ring notification rings, for the ring screen. */
        fun setBackup(alarm: RingingAlarm?) {
            backup = alarm
            notifyListeners()
        }

        /**
         * What rings now, by this service or by the backup notification (until its ring timeout),
         * or null. The ring screen shows it; MainActivity opens the ring screen while it is not
         * null (fix B, A-1).
         */
        fun current(now: Long = System.currentTimeMillis()): RingingAlarm? =
            ringing ?: backup?.takeIf { now < it.fireAt + AUTO_SILENCE_MS }

        /** The alarm a ring intent (or a ring screen intent) carries. */
        fun alarmFrom(context: Context, intent: Intent): RingingAlarm = RingingAlarm(
            recordId = intent.getStringExtra(AlarmFireReceiver.EXTRA_RECORD_ID),
            eclipseId = intent.getStringExtra(AlarmFireReceiver.EXTRA_ECLIPSE_ID),
            title = intent.getStringExtra(AlarmFireReceiver.EXTRA_TITLE) ?: context.getString(R.string.alarm_default_title),
            text = intent.getStringExtra(AlarmFireReceiver.EXTRA_TEXT).orEmpty(),
            fireAt = intent.getLongExtra(AlarmFireReceiver.EXTRA_FIRE_AT, System.currentTimeMillis()),
        )

        private fun putAlarm(intent: Intent, alarm: RingingAlarm): Intent = intent
            .putExtra(AlarmFireReceiver.EXTRA_RECORD_ID, alarm.recordId)
            .putExtra(AlarmFireReceiver.EXTRA_ECLIPSE_ID, alarm.eclipseId)
            .putExtra(AlarmFireReceiver.EXTRA_TITLE, alarm.title)
            .putExtra(AlarmFireReceiver.EXTRA_TEXT, alarm.text)
            .putExtra(AlarmFireReceiver.EXTRA_FIRE_AT, alarm.fireAt)

        /**
         * The ring screen. For the backup ring it carries the alarm, because the process that shows
         * the screen may not be the one that posted the notification.
         */
        fun ringScreenIntent(context: Context, alarm: RingingAlarm, backup: Boolean): PendingIntent {
            val intent = Intent(context, RingActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (backup) putAlarm(intent, alarm).putExtra(RingActivity.EXTRA_BACKUP, true)
            return PendingIntent.getActivity(
                context, if (backup) REQUEST_RING_SCREEN_BACKUP else REQUEST_RING_SCREEN, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }

        private fun snoozePendingIntent(context: Context, alarm: RingingAlarm): PendingIntent = PendingIntent.getBroadcast(
            context, REQUEST_SNOOZE, AlarmFireReceiver.snoozeIntent(context, alarm),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        private fun dismissPendingIntent(context: Context, recordId: String?): PendingIntent = PendingIntent.getBroadcast(
            context, REQUEST_DISMISS, AlarmFireReceiver.dismissIntent(context, recordId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        /**
         * The backup ring notification (fix B, A-2 and A-4): what rings when this service cannot.
         * The phone's alarm sound from its own channel, repeated until answered (insistent, from
         * Android 8, where the timeout below exists), the ring screen as its full-screen intent,
         * Snooze and Dismiss, and gone after the ring timeout. Swiping it away, or its timeout,
         * tells the receiver (ACTION_BACKUP_GONE), which then says when it was missed.
         */
        fun buildBackupNotification(context: Context, alarm: RingingAlarm): Notification {
            val ring = ringScreenIntent(context, alarm, backup = true)
            val gone = PendingIntent.getBroadcast(
                context, REQUEST_BACKUP_GONE, putAlarm(AlarmFireReceiver.backupGoneIntent(context, alarm.recordId), alarm),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val builder = NotificationCompat.Builder(context, CHANNEL_RING_BACKUP)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(alarm.title)
                .setContentText(alarm.text)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(false)
                .setFullScreenIntent(ring, true)
                .setContentIntent(ring)
                .setDeleteIntent(gone)
                .addAction(0, context.getString(R.string.action_snooze), snoozePendingIntent(context, alarm))
                .addAction(0, context.getString(R.string.action_dismiss), dismissPendingIntent(context, alarm.recordId))
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                // No channels before Android 8: the sound and the vibration go on the notification.
                @Suppress("DEPRECATION")
                builder.setSound(Settings.System.DEFAULT_ALARM_ALERT_URI, android.media.AudioManager.STREAM_ALARM)
                    .setVibrate(VIBRATION_PATTERN)
            } else {
                builder.setTimeoutAfter(AUTO_SILENCE_MS)
            }
            val notification = builder.build()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) notification.flags = notification.flags or Notification.FLAG_INSISTENT
            return notification
        }

        /** Rings through the backup notification (fix B, A-2): called by the receiver when this service could not be started. */
        fun postBackupRing(context: Context, alarm: RingingAlarm) {
            ensureChannels(context)
            setBackup(alarm)
            ringAlone(context)
            postPlain(context, NOTIFICATION_ID_RING, buildBackupNotification(context, alarm))
        }

        /**
         * Fix B, E-3 (found by SunApp's fix, 16 October 2026): a ring notification must be the app's
         * only notification when it is posted. A "snoozed" or "missed" notice still showing makes
         * two, Android 16 then groups them itself and marks the ringing one silent, which suppresses
         * its full-screen intent just as setSilent did (E-2): a locked phone shows no ring screen.
         * So every notice goes before a ring is posted; the snoozed ones come back when nothing
         * rings any more ([repostSnoozedNotices]); a missed notice still showing is the cost.
         */
        fun ringAlone(context: Context) {
            runCatching {
                val manager = context.getSystemService(android.app.NotificationManager::class.java) ?: return
                manager.activeNotifications
                    .filter { it.id == NOTIFICATION_ID_NOTICE }
                    .forEach { manager.cancel(it.tag, it.id) }
            }.onFailure { Log.w(TAG, "could not clear the notices before ringing", it) }
        }

        /**
         * The notices of the snoozes still waiting, posted again once nothing rings, and the
         * "Missed" notices a re-plan owed while something rang (fix E, C-4).
         */
        fun repostSnoozedNotices(context: Context) {
            runCatching { AlarmScheduling.snoozes(context).forEach { postSnoozedNotice(context, it) } }
                .onFailure { Log.w(TAG, "could not post the snoozed notices again", it) }
            AlarmScheduling.tellMissed(context)
        }

        /** Takes the ring notification away (the backup's, or a stale one); the service's own goes with the service. */
        fun cancelRingNotification(context: Context) {
            runCatching { NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID_RING) }
        }

        /** Both channels; idempotent, called from every entry point (SunApp's rule). */
        fun ensureChannels(context: Context) {
            val manager = NotificationManagerCompat.from(context)
            manager.createNotificationChannel(
                NotificationChannelCompat.Builder(CHANNEL_RING, NotificationManagerCompat.IMPORTANCE_HIGH)
                    .setName(context.getString(R.string.channel_ring_name))
                    .setDescription(context.getString(R.string.channel_ring_description))
                    .setSound(null, null)
                    .setVibrationEnabled(false)
                    .setShowBadge(false)
                    .build(),
            )
            manager.createNotificationChannel(
                NotificationChannelCompat.Builder(CHANNEL_NOTICES, NotificationManagerCompat.IMPORTANCE_DEFAULT)
                    .setName(context.getString(R.string.channel_notices_name))
                    .setDescription(context.getString(R.string.channel_notices_description))
                    .setShowBadge(false)
                    .build(),
            )
            manager.createNotificationChannel(
                NotificationChannelCompat.Builder(CHANNEL_RING_BACKUP, NotificationManagerCompat.IMPORTANCE_HIGH)
                    .setName(context.getString(R.string.channel_backup_name))
                    .setDescription(context.getString(R.string.channel_backup_description))
                    .setSound(
                        Settings.System.DEFAULT_ALARM_ALERT_URI,
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ALARM)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build(),
                    )
                    .setVibrationEnabled(true)
                    .setVibrationPattern(VIBRATION_PATTERN)
                    .setShowBadge(false)
                    .build(),
            )
        }

        fun ringIntent(context: Context, alarm: RingingAlarm): Intent =
            putAlarm(Intent(context, AlarmService::class.java).setAction(ACTION_RING), alarm)

        /** The phone's own 12 or 24 hour setting. */
        fun formatTime(context: Context, millis: Long): String = DateFormat.getTimeFormat(context).format(Date(millis))

        /**
         * "{eclipse}, snoozed / Rings again at {time}." with Dismiss, which cancels the snooze (fix B,
         * A-6). One notice per alarm (tagged with its record id), so each snooze can be dismissed.
         */
        fun postSnoozedNotice(context: Context, snooze: Snooze) {
            ensureChannels(context)
            val notice = NotificationCompat.Builder(context, CHANNEL_NOTICES)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(context.getString(R.string.snoozed_title, snooze.title))
                .setContentText(context.getString(R.string.snoozed_text, formatTime(context, snooze.at)))
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setSilent(true)
                .addAction(0, context.getString(R.string.action_dismiss), dismissPendingIntent(context, snooze.recordId))
                .build()
            postPlain(context, NOTIFICATION_ID_NOTICE, notice, tag = snooze.recordId)
        }

        /** "Missed: {eclipse}" with [textRes]: after the ring timeout, or when the next alarm took over (A-5). */
        fun postMissedNotice(context: Context, alarm: RingingAlarm, textRes: Int) {
            ensureChannels(context)
            val notice = NotificationCompat.Builder(context, CHANNEL_NOTICES)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(context.getString(R.string.missed_title, alarm.title))
                .setContentText(context.getString(textRes))
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setSilent(true)
                .build()
            postPlain(context, NOTIFICATION_ID_NOTICE, notice, tag = alarm.recordId)
        }

        /**
         * Fix D (17 October 2026, N-3): "Missed: {eclipse} / The phone could not ring this alarm on
         * time." for an alarm that never rang: its time came while the phone was off or restarting
         * (AlarmScheduling.replanAfterBoot), or it arrived past the late limit and was not rung late
         * (AlarmFireReceiver). Before, both ended with no notice at all. Fix E (17 October 2026): one
         * rule for every re-plan (FireRules.missed), posted through AlarmScheduling.tellMissed.
         */
        fun postNotRungNotice(context: Context, record: AlarmRecord) {
            val eclipse = runCatching { AlarmScheduling.catalogue(context)[record.eclipseId] }.getOrNull()
            val alarm = RingingAlarm(
                recordId = record.id,
                eclipseId = record.eclipseId,
                title = eclipse?.let { Words.eclipseName(it) } ?: context.getString(R.string.alarm_default_title),
                text = Words.alarmWords(record.spec),
                fireAt = 0L,
            )
            postMissedNotice(context, alarm, R.string.missed_not_rung_text)
        }

        /** Takes away the snoozed or missed notice of one alarm. */
        fun cancelNotice(context: Context, recordId: String?) {
            runCatching { NotificationManagerCompat.from(context).cancel(recordId, NOTIFICATION_ID_NOTICE) }
        }

        /** Posts a notification; nothing happens when notifications are off (the page says so). */
        @SuppressLint("MissingPermission")
        internal fun postPlain(context: Context, id: Int, notification: Notification, tag: String? = null) {
            runCatching { NotificationManagerCompat.from(context).notify(tag, id, notification) }
        }
    }

}
