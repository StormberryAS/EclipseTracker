package no.stormberry.eclipsetracker

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/**
 * The Google Play edition has no ringing alarms, and this is the test that keeps it so (MoonApp's
 * PlayManifestTest, 25 October 2026, for this app).
 *
 * `src/play/AndroidManifest.xml` is merged over `src/main/AndroidManifest.xml` under
 * `-PplayBuild=true` and does nothing but remove. So the guarantee is a relation between two files:
 * every permission main asks for, and every component main declares except MainActivity (the page)
 * and androidx.core's FileProvider (Add to calendar), must be removed by the overlay. A permission or
 * component added to main alone fails here, before it can reach a Play bundle and a review gate.
 *
 * The test reads the two source manifests (and expected-permissions.txt); the merged manifest of a
 * Play build is checked by checkReleaseMergedManifest (no uses-permission at all, no alarm
 * component), and the built bundle by the kit's check-play-bundle.sh.
 */
class PlayManifestTest {

    private val androidNs = "http://schemas.android.com/apk/res/android"
    private val toolsNs = "http://schemas.android.com/tools"

    private fun manifest(rel: String): Element {
        val file = File(WebRoot.dir, "android/app/$rel")
        assertTrue("$rel not found", file.isFile)
        val f = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
        return f.newDocumentBuilder().parse(file).documentElement
    }

    private val main = manifest("src/main/AndroidManifest.xml")
    private val play = manifest("src/play/AndroidManifest.xml")

    private fun Element.kids(tag: String): List<Element> =
        (0 until childNodes.length).map { childNodes.item(it) }.filterIsInstance<Element>().filter { it.tagName == tag }

    private fun Element.name(): String = getAttributeNS(androidNs, "name")
    private fun Element.node(): String = getAttributeNS(toolsNs, "node")

    private val components = listOf("activity", "activity-alias", "service", "receiver", "provider")

    private fun Element.application(): Element = kids("application").single()

    /** What main asks for: its uses-permission lines that are not removals. */
    private fun mainPermissions(): List<String> =
        main.kids("uses-permission").filter { it.node() != "remove" }.map { it.name() }

    /** What main declares: its components that are not removals (main itself strips a library receiver). */
    private fun mainComponents(): List<String> =
        components.flatMap { main.application().kids(it) }.filter { it.node() != "remove" }.map { it.name() }

    private fun playRemovedPermissions(): List<String> =
        play.kids("uses-permission").filter { it.node() == "remove" }.map { it.name() }

    private fun playRemovedComponents(): List<String> =
        components.flatMap { play.application().kids(it) }.filter { it.node() == "remove" }.map { it.name() }

    /** What the Play edition keeps: the page, and the provider that hands the calendar file over. */
    private val kept = setOf(".MainActivity", "androidx.core.content.FileProvider")

    @Test fun theOverlayRemovesEveryPermissionMainAsksFor() {
        val asked = mainPermissions()
        assertEquals("main asks for the nine alarm permissions", 9, asked.size)
        val removed = playRemovedPermissions().toSet()
        for (permission in asked) assertTrue("$permission is asked for in main but not removed for Play", permission in removed)
    }

    @Test fun theOverlayRemovesExactlyTheNineOfExpectedPermissions() {
        val listed = Regex("""^uses-permission: name='([^']+)'""", RegexOption.MULTILINE)
            .findAll(WebRoot.text("android/expected-permissions.txt")).map { it.groupValues[1] }.toSet()
        assertEquals(9, listed.size)
        assertEquals(listed, playRemovedPermissions().toSet())
        assertEquals("each removed once", playRemovedPermissions().size, playRemovedPermissions().toSet().size)
    }

    @Test fun theOverlayRemovesEveryComponentButThePageAndTheCalendarProvider() {
        val all = mainComponents()
        assertTrue(all.containsAll(kept))
        val removed = playRemovedComponents().toSet()
        for (component in all.filter { it !in kept }) {
            assertTrue("$component is declared in main but not removed for Play", component in removed)
        }
        for (k in kept) assertFalse("$k must survive in the Play edition", k in removed)
        assertEquals(
            setOf(".alarm.RingActivity", ".alarm.AlarmService", ".alarm.AlarmFireReceiver", ".alarm.SystemEventReceiver"),
            removed,
        )
    }

    @Test fun theOverlayDeclaresNothingAndRemovesOnlyWhatExists() {
        val body = File(WebRoot.dir, "android/app/src/play/AndroidManifest.xml").readText().replace(Regex("<!--[\\s\\S]*?-->"), "")
        val tags = Regex("""<(uses-permission|permission|uses-feature|queries|activity|activity-alias|service|receiver|provider|meta-data)\b[^>]*>""")
            .findAll(body).map { it.value }.toList()
        assertTrue("the overlay has nothing to test", tags.size >= 13)
        for (tag in tags) assertTrue("$tag is not a removal", tag.contains("tools:node=\"remove\""))
        val asked = mainPermissions().toSet()
        for (name in playRemovedPermissions()) assertTrue("$name is removed for Play but main does not ask for it", name in asked)
        val declared = mainComponents().toSet()
        for (name in playRemovedComponents()) assertTrue("$name is removed for Play but main does not declare it", name in declared)
    }

    @Test fun thePermissionsThatNeedAPlayReviewAreRemoved() {
        val removed = playRemovedPermissions().toSet()
        for (gate in listOf(
            "android.permission.USE_EXACT_ALARM",
            "android.permission.SCHEDULE_EXACT_ALARM",
            "android.permission.USE_FULL_SCREEN_INTENT",
            "android.permission.FOREGROUND_SERVICE",
            "android.permission.FOREGROUND_SERVICE_SYSTEM_EXEMPTED",
            "android.permission.POST_NOTIFICATIONS",
        )) assertTrue(gate, gate in removed)
    }

    @Test fun neitherManifestBringsTheInternet() {
        // INTERNET stays removed in main, and the overlay only removes.
        assertTrue(main.kids("uses-permission").any { it.name() == "android.permission.INTERNET" && it.node() == "remove" })
        assertFalse(mainPermissions().contains("android.permission.INTERNET"))
        for (e in play.kids("uses-permission")) assertEquals("remove", e.node())
        // androidx.core's private receiver permission is stripped in main already, so in both editions.
        val dynamic = "\${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"
        assertTrue(main.kids("permission").any { it.name() == dynamic && it.node() == "remove" })
        assertTrue(main.kids("uses-permission").any { it.name() == dynamic && it.node() == "remove" })
    }
}
