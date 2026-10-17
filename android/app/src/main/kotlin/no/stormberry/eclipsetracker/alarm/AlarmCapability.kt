package no.stormberry.eclipsetracker.alarm

import android.app.AlarmManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat

/**
 * What the platform refuses right now that a ringing alarm needs, and the Settings screen that
 * fixes each (SunApp's AlarmCapability). The wire names are the problems of the bridge's
 * "alarms" message (spec 9.6); the page words them (android-bridge.js).
 *
 *  notifications-denied  notifications are off for the app, or its "Ringing alarms" channel is
 *                        blocked or turned below Urgent (fix B, A-1): an alarm still rings, but
 *                        nothing may show on screen; opening the app shows the ring screen
 *  exact-alarms-denied   exact alarms are switched off (Android 12 and 12L only): it may ring late,
 *                        or not at all (fix B, A-2)
 *  full-screen-denied    full-screen alarms are switched off (Android 14 and later): it rings and
 *                        shows a notification, but cannot take over a locked screen
 */
enum class Problem(val wire: String) {
    NOTIFICATIONS("notifications-denied"),
    EXACT_ALARMS("exact-alarms-denied"),
    FULL_SCREEN("full-screen-denied"),
    ;

    companion object {
        fun fromWire(s: Any?): Problem? = entries.firstOrNull { it.wire == s }
    }
}

object AlarmCapability {
    /** Everything the platform refuses on this device right now, worst first. */
    fun problems(context: Context): List<Problem> = problemsFrom(
        sdkInt = Build.VERSION.SDK_INT,
        notificationsEnabled = NotificationManagerCompat.from(context).areNotificationsEnabled(),
        ringChannelImportance = ringChannelImportance(context),
        canScheduleExactAlarms = canScheduleExactAlarms(context),
        canUseFullScreenIntent = canUseFullScreenIntent(context),
    )

    /**
     * The decision half of [problems], testable on the JVM: each switch exists only from its
     * version. [ringChannelImportance] is the "Ringing alarms" channel's importance as the person
     * left it, or null where there are no channels (before Android 8) or it does not exist yet (it
     * is then made at Urgent). Blocked, or below Urgent (no pop-up, no full-screen ring screen),
     * counts as notifications refused (fix B, A-1).
     */
    fun problemsFrom(
        sdkInt: Int,
        notificationsEnabled: Boolean,
        ringChannelImportance: Int?,
        canScheduleExactAlarms: Boolean,
        canUseFullScreenIntent: Boolean,
    ): List<Problem> =
        buildList {
            if (!notificationsEnabled || ringChannelLowered(sdkInt, ringChannelImportance)) add(Problem.NOTIFICATIONS)
            if (sdkInt >= Build.VERSION_CODES.S && !canScheduleExactAlarms) add(Problem.EXACT_ALARMS)
            if (sdkInt >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && !canUseFullScreenIntent) add(Problem.FULL_SCREEN)
        }

    /** True when the ring channel is blocked or set below Urgent (IMPORTANCE_HIGH). */
    fun ringChannelLowered(sdkInt: Int, importance: Int?): Boolean =
        sdkInt >= Build.VERSION_CODES.O && importance != null && importance < NotificationManagerCompat.IMPORTANCE_HIGH

    /** The "Ringing alarms" channel's importance now, or null when there is none to read. */
    fun ringChannelImportance(context: Context): Int? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null
        return NotificationManagerCompat.from(context).getNotificationChannelCompat(AlarmService.CHANNEL_RING)?.importance
    }

    fun canScheduleExactAlarms(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        val manager = context.getSystemService(AlarmManager::class.java) ?: return false
        return manager.canScheduleExactAlarms()
    }

    fun canUseFullScreenIntent(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true
        val manager = context.getSystemService(NotificationManager::class.java) ?: return false
        return manager.canUseFullScreenIntent()
    }

    /** The Settings screen that fixes [problem]; every branch falls back to the app's own details page. */
    fun settingsIntent(context: Context, problem: Problem): Intent {
        val packageUri = Uri.fromParts("package", context.packageName, null)
        return when (problem) {
            Problem.NOTIFICATIONS ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                    NotificationManagerCompat.from(context).areNotificationsEnabled() &&
                    ringChannelLowered(Build.VERSION.SDK_INT, ringChannelImportance(context))
                ) {
                    // Notifications are on but the ring channel is turned down: its own page (fix B, A-1).
                    Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                        .putExtra(Settings.EXTRA_CHANNEL_ID, AlarmService.CHANNEL_RING)
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                } else {
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri)
                }
            Problem.EXACT_ALARMS ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, packageUri)
                } else {
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri)
                }
            Problem.FULL_SCREEN ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, packageUri)
                } else {
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri)
                }
        }
    }
}
