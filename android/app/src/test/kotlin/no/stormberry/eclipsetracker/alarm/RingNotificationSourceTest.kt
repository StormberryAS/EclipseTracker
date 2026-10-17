package no.stormberry.eclipsetracker.alarm

import no.stormberry.eclipsetracker.WebRoot
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Guards the ring screen against the two ways Android drops a ring notification's full-screen
 * intent, both found on an API 36 emulator on 16 October 2026 (SunApp's RingNotificationSourceTest,
 * adapted):
 *  - E-2: setSilent(true) on the notification (NotificationCompat puts it in a muted group);
 *  - E-3 (fix B): another notice of the app still showing when the ring is posted; Android 16
 *    groups the two itself and marks the ringing one silent.
 * It reads AlarmService.kt as text, comments stripped, because the plain JVM cannot build a
 * Notification (the framework is stubs). The behaviour itself is proven on the emulator.
 */
class RingNotificationSourceTest {
    private val code: String by lazy {
        val file = File(WebRoot.dir, "android/app/src/main/kotlin/no/stormberry/eclipsetracker/alarm/AlarmService.kt")
        stripComments(file.readText())
    }

    private fun stripComments(s: String): String =
        s.replace(Regex("/\\*[\\s\\S]*?\\*/"), "").lines().joinToString("\n") { line ->
            val i = line.indexOf("//")
            if (i >= 0 && !line.substring(0, i).contains('"')) line.substring(0, i) else line
        }

    /** The body of the first function named [name], by brace counting. */
    private fun body(name: String): String {
        val start = code.indexOf("fun $name(")
        assertTrue("fun $name exists", start >= 0)
        val open = code.indexOf('{', start)
        var depth = 0
        for (i in open until code.length) {
            when (code[i]) {
                '{' -> depth++
                '}' -> if (--depth == 0) return code.substring(open, i + 1)
            }
        }
        error("unbalanced braces in $name")
    }

    @Test fun neitherRingNotificationIsSilentAndBothCarryTheFullScreenIntent() {
        for (name in listOf("buildRingNotification", "buildBackupNotification")) {
            val b = body(name)
            assertTrue("$name: full-screen intent", b.contains(".setFullScreenIntent(ring, true)"))
            assertTrue("$name: alarm category", b.contains(".setCategory(NotificationCompat.CATEGORY_ALARM)"))
            assertFalse("$name: setSilent suppresses the full-screen intent (E-2)", b.contains(".setSilent("))
            assertFalse("$name: no group of its own making", b.contains(".setGroup("))
        }
    }

    @Test fun everyNoticeGoesBeforeARingIsPosted() {
        // The service: ringAlone before it enters the foreground with the ring notification, and no
        // notice posted on the way there (A-5's missed notice waits until it stops).
        val start = body("onStartCommand")
        val alone = start.indexOf("ringAlone(this)")
        val foreground = start.indexOf("startInForeground(buildRingNotification(alarm))")
        assertTrue("ringAlone comes first (E-3)", alone in 0 until foreground)
        assertFalse("no notice is posted while starting a ring", start.substring(0, foreground).contains("postMissedNotice("))
        // The backup ring: the same.
        val backup = body("postBackupRing")
        assertTrue(backup.indexOf("ringAlone(context)") in 0 until backup.indexOf("postPlain("))
        // ringAlone takes away every notice, whatever its tag, and the snoozed ones come back after.
        val clear = body("ringAlone")
        assertTrue(clear.contains("activeNotifications") && clear.contains("NOTIFICATION_ID_NOTICE") && clear.contains("cancel(it.tag, it.id)"))
        assertTrue(body("onDestroy").contains("repostSnoozedNotices(this)"))
    }
}
