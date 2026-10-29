package no.stormberry.eclipsetracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The two editions (29 October 2026): the sovereign one with ringing alarms, the Google Play one
 * without. Runs in either edition (`testDebugUnitTest`, with or without `-PplayBuild=true`).
 */
class EditionTest {
    private fun repo(rel: String): String = File(WebRoot.dir, rel).readText(Charsets.UTF_8)

    private val sovereign = "android/app/src/sovereign/kotlin/no/stormberry/eclipsetracker/Edition.kt"
    private val play = "android/app/src/play/kotlin/no/stormberry/eclipsetracker/Edition.kt"

    @Test fun theTwoEditionFilesDifferOnlyInTheValue() {
        assertTrue(repo(sovereign).contains("const val ALARMS: Boolean = true\n"))
        assertTrue(repo(play).contains("const val ALARMS: Boolean = false\n"))
        val code = { f: String -> repo(f).lines().filter { it.startsWith("package ") || it.startsWith("object ") || it.trim().startsWith("const val ") } }
        assertEquals(code(sovereign).map { it.replace("true", "X") }, code(play).map { it.replace("false", "X") })
    }

    @Test fun theBuildCompilesOneEditionFile() {
        // One of the two folders joins the main source set; the test then runs against that constant.
        val gradle = repo("android/app/build.gradle.kts")
        assertTrue(gradle.contains("sourceSets[\"main\"].kotlin.directories.add(if (playBuild) \"src/play/kotlin\" else \"src/sovereign/kotlin\")"))
        assertTrue(gradle.contains("sourceSets[type].manifest.srcFile(\"src/play/AndroidManifest.xml\")"))
        assertTrue(gradle.contains("sourceSets[type].res.directories.add(\"src/play/res\")"))
    }

    @Test fun thePlayVersionLine() {
        val gradle = repo("android/app/build.gradle.kts")
        val code = Regex("""\n        versionCode = (\d+)\n""").find(gradle)!!.groupValues[1].toInt()
        val name = Regex("""\n        versionName = "([^"]+)"\n""").find(gradle)!!.groupValues[1]
        assertEquals(20001, code)
        assertEquals("2.0.1", name)
        assertTrue(gradle.contains("val PLAY_VERSION_CODE_OFFSET = 1_000_000\n"))
        assertTrue(gradle.contains("versionCode = PLAY_VERSION_CODE_OFFSET + versionCode!!"))
        // 1,000,000 + 20001: never the code of a sovereign release (at most 999999 in its scheme).
        assertEquals(1020001, 1_000_000 + code)
        assertTrue(gradle.contains("applicationId = if (playBuild) \"no.stormberry.eclipsetracker.play\" else \"no.stormberry.eclipsetracker\""))
        assertTrue(gradle.contains("base { archivesName = \"eclipsetracker-play\" }"))
    }

    @Test fun thePlayWordsReplaceOnlyWhatMainHasAndNeverSpeakOfAlarms() {
        val pattern = Regex("""<string name="([^"]+)">([^<]*)</string>""")
        val main = pattern.findAll(repo("android/app/src/main/res/values/strings.xml").replace(Regex("<!--[\\s\\S]*?-->"), ""))
            .associate { it.groupValues[1] to it.groupValues[2] }
        val playXml = repo("android/app/src/play/res/values/strings.xml").replace(Regex("<!--[\\s\\S]*?-->"), "")
        val playWords = pattern.findAll(playXml).associate { it.groupValues[1] to it.groupValues[2] }
        assertEquals(setOf("page_reloaded"), playWords.keys)
        for ((name, text) in playWords) {
            assertTrue("$name is not a string of main", name in main)
            assertFalse("$name speaks of alarms: $text", text.contains("alarm", ignoreCase = true))
            assertFalse(text, Regex("[\u2013\u2014!]|--").containsMatchIn(text))
            assertTrue("$name: a toast of at most 66 characters", text.length <= 66)
        }
        // The one main string a Play user could see that speaks of ringing alarms is the one replaced.
        assertTrue(main.getValue("page_reloaded").contains("ringing alarms"))
    }

    @Test fun theBridgeIsToldTheEditionByTheInjectedLine() {
        val gradle = repo("android/app/build.gradle.kts")
        assertTrue(gradle.contains("const val INJECTED_TAG = \"<script src=\\\"android-bridge.js\\\"></script>\""))
        assertTrue(gradle.contains("const val PLAY_INJECTED_TAG = \"<script src=\\\"android-bridge.js\\\" data-edition=\\\"play\\\"></script>\""))
        val bridge = repo("android/web-overlay/android-bridge.js")
        assertTrue(bridge.contains("loader.dataset['edition'] === 'play'"))
    }

    @Test fun mainActivityAsksTheAlarmEngineOnlyInTheSovereignEdition() {
        val src = repo("android/app/src/main/kotlin/no/stormberry/eclipsetracker/MainActivity.kt")
        // Every alarm hook is behind the edition, and the bridge refuses alarm messages first.
        assertTrue(src.contains("if (Edition.ALARMS) AlarmService.ensureChannels(this)"))
        assertTrue(src.contains("if (Edition.ALARMS) AlarmService.removeListener(ringListener)"))
        val dispatch = src.substringAfter("pageProxy = proxy\n").substringBefore("when (msg) {")
        assertTrue(dispatch.contains("if (!Edition.ALARMS) {") && dispatch.contains("AlarmFreeBridge.action(msg)"))
        for (fn in listOf("showRingScreenIfRinging", "pushAlarms", "setAlarms", "maybeAskNotifications", "fixProblem")) {
            val body = src.substringAfter("private fun $fn(").substringAfter("{\n").lineSequence().first().trim()
            assertTrue("$fn returns first in the Play edition: $body", body.startsWith("if (!Edition.ALARMS) return"))
        }
        // The calendar handover reads the eclipse list outside the alarm package.
        assertTrue(src.contains("BundledCatalogue.get(this)"))
        assertFalse(src.contains("AlarmScheduling.catalogue"))
    }
}
