package no.stormberry.eclipsetracker.alarm

import android.app.AlarmManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import java.util.TimeZone

/**
 * Re-plans every alarm after anything that can make what is armed wrong (spec 9.4 and 9.7;
 * SunApp's SystemEventReceiver): a restart, also before the first unlock (the records are in
 * device-protected storage), an app update, a change of time zone (a time-of-day alarm follows
 * the phone to its new zone, B-2), a change of the clock, and a change of the exact-alarm
 * permission. Android sends that broadcast when exact alarms are allowed again, not when they are
 * switched off (it then cancels every exact alarm silently); the inexact backstop of fix B (A-2,
 * AlarmSink.guard) covers that case. After a restart the snoozes still waiting are armed again
 * and their notices posted again (fix B, A-6). Fix D (17 October 2026, N-3): BOOT_COMPLETED after
 * LOCKED_BOOT_COMPLETED in the same boot is a normal re-plan (AlarmScheduling.replanAfterBoot), and
 * an alarm a restart cost gets a "Missed" notice. Fix E (17 October 2026): that notice is posted by
 * the re-plan itself (AlarmScheduling, FireRules.missed), as after every other re-plan.
 */
class SystemEventReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action !in REPLAN_ACTIONS) {
            Log.w(TAG, "ignoring $action")
            return
        }
        // The process may still hold the old default zone; read the system's again.
        if (action == Intent.ACTION_TIMEZONE_CHANGED) TimeZone.setDefault(null)
        val pending = goAsync()
        val appContext = context.applicationContext
        Thread({
            try {
                val boot = action == Intent.ACTION_BOOT_COMPLETED || action == Intent.ACTION_LOCKED_BOOT_COMPLETED
                // Fix D (N-3): only the first boot broadcast of a boot re-plans as after a restart.
                val state = if (boot) AlarmScheduling.replanAfterBoot(appContext) else AlarmScheduling.replan(appContext)
                Log.i(TAG, "$action: ${state.armed.size} alarm(s) armed")
                if (boot) {
                    // Fix B, A-6: a restart clears every notification; a snooze still waiting gets its
                    // notice back, with Dismiss, so it can still be cancelled.
                    AlarmScheduling.snoozes(appContext).forEach { AlarmService.postSnoozedNotice(appContext, it) }
                }
            } catch (e: RuntimeException) {
                Log.e(TAG, "re-planning after $action failed", e)
            } finally {
                pending.finish()
            }
        }, "eclipsetracker-replan").start()
    }

    private companion object {
        const val TAG = "EclipseSystemEvent"
        /** The exact-alarm broadcast exists from Android 12 only, so the set says what this device can deliver (SunApp's). */
        val REPLAN_ACTIONS: Set<String> = buildSet {
            add(Intent.ACTION_BOOT_COMPLETED)
            add(Intent.ACTION_LOCKED_BOOT_COMPLETED)
            add(Intent.ACTION_MY_PACKAGE_REPLACED)
            add(Intent.ACTION_TIMEZONE_CHANGED)
            add(Intent.ACTION_TIME_CHANGED)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) add(AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED)
        }
    }
}
