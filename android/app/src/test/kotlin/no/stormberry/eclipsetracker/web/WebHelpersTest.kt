package no.stormberry.eclipsetracker.web

import no.stormberry.eclipsetracker.WebRoot
import no.stormberry.eclipsetracker.web.NavigationPolicy.Decision.BLOCK
import no.stormberry.eclipsetracker.web.NavigationPolicy.Decision.EXTERNAL
import no.stormberry.eclipsetracker.web.NavigationPolicy.Decision.EXTERNAL_APP
import no.stormberry.eclipsetracker.web.NavigationPolicy.Decision.IN_APP
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The asset paths, the response headers and the navigation policy (GDPRLetterBuilder's tests, for this app). */
class WebHelpersTest {
    @Test fun assetPaths() {
        assertEquals("web/index.html", AssetPaths.resolve(""))
        assertEquals("web/app.js", AssetPaths.resolve("app.js"))
        assertEquals("web/core/alarms.js", AssetPaths.resolve("core/alarms.js"))
        assertEquals("web/switcher-icons/eclipse.svg", AssetPaths.resolve("switcher-icons/eclipse.svg"))
        assertEquals("web/disclaimer.html", AssetPaths.resolve("disclaimer.html"))
        assertEquals("web/fonts/inter/InterVariable.woff2", AssetPaths.resolve("fonts/inter/InterVariable.woff2"))
        for (bad in listOf("../AndroidManifest.xml", "core/../../x.js", "./index.html", "/index.html", "core//alarms.js", "a\\b.js",
            ".git/config.js", "core/.hidden.js", "app.js\u0000.css", null)) assertNull(bad, AssetPaths.resolve(bad))
        // The eclipse list is bundled for the native side, never served to the page.
        assertNull(AssetPaths.resolve("data/eclipses.json"))
        for (bad in listOf("README.md", "x.txt", "x.wasm", "x.mjs", "tools/x.py", "ts/app.ts", "licences/Apache-2.0.txt")) assertNull(bad, AssetPaths.resolve(bad))
        assertEquals("text/javascript", AssetPaths.mimeType("web/core/alarms.js"))
        assertEquals("font/woff2", AssetPaths.mimeType("web/fonts/inter/Inter-Regular.woff2"))
        assertNull(AssetPaths.encoding("web/fonts/inter/Inter-Regular.woff2"))
        assertEquals(setOf("html", "js", "css", "svg", "woff2"), AssetPaths.extensions)
    }

    @Test fun theHeaderPolicyIsThePagesMetaPolicyPlusTwo() {
        val csp = ResponseHeaders.ALL.getValue("Content-Security-Policy")
        val meta = Regex("""<meta http-equiv="Content-Security-Policy" content="([^"]+)">""").find(WebRoot.text("index.html"))!!.groupValues[1]
        assertEquals("$meta; frame-ancestors 'none'; upgrade-insecure-requests", csp)
        assertTrue(csp.contains("connect-src 'none'"))
        assertFalse(csp.contains("unsafe"))
        assertEquals("no-referrer", ResponseHeaders.ALL["Referrer-Policy"])
        assertEquals("nosniff", ResponseHeaders.ALL["X-Content-Type-Options"])
        assertEquals("no-store", ResponseHeaders.ALL["Cache-Control"])
    }

    /** Fix C, M-1: the disclaimer's response alone allows its one style element, by the hash of that element as it is in the web root. */
    @Test fun theDisclaimerAloneAllowsItsStyleElementByHash() {
        val html = WebRoot.text("disclaimer.html")
        val blocks = Regex("""<style(\s[^>]*)?>([\s\S]*?)</style>""").findAll(html).toList()
        assertEquals(1, blocks.size)
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(blocks[0].groupValues[2].toByteArray(Charsets.UTF_8))
        assertEquals("sha256-" + java.util.Base64.getEncoder().encodeToString(digest), ResponseHeaders.DISCLAIMER_STYLE_HASH)
        val disclaimer = ResponseHeaders.forAsset("web/disclaimer.html").getValue("Content-Security-Policy")
        assertEquals(
            ResponseHeaders.CONTENT_SECURITY_POLICY.replace("style-src 'self';", "style-src 'self' '${ResponseHeaders.DISCLAIMER_STYLE_HASH}';"),
            disclaimer,
        )
        assertFalse(disclaimer.contains("unsafe"))
        assertTrue(disclaimer.contains("script-src 'self';"))
        for (other in listOf("web/index.html", "web/style.css", "web/app.js", "web/fonts/inter/inter.css", "web/disclaimer.html.bak", "web/sub/disclaimer.html")) {
            assertEquals(other, ResponseHeaders.ALL, ResponseHeaders.forAsset(other))
        }
        assertEquals(ResponseHeaders.ALL - "Content-Security-Policy", ResponseHeaders.DISCLAIMER - "Content-Security-Policy")
    }

    /** Fix C, S-2: Android's font scale as the page's default font size; the side page keeps the text zoom. */
    @Test fun textScale() {
        assertEquals(16, TextScale.defaultFontSize(1.0f))
        assertEquals(21, TextScale.defaultFontSize(1.3f))
        assertEquals(24, TextScale.defaultFontSize(1.5f))
        assertEquals(32, TextScale.defaultFontSize(2.0f))
        assertEquals(13, TextScale.defaultFixedFontSize(1.0f))
        assertEquals(17, TextScale.defaultFixedFontSize(1.3f))
        assertEquals(20, TextScale.defaultFixedFontSize(1.5f))
        assertEquals(26, TextScale.defaultFixedFontSize(2.0f))
        assertEquals(14, TextScale.defaultFontSize(0.85f))
        assertEquals(16, TextScale.defaultFontSize(Float.NaN))
        assertEquals(16, TextScale.defaultFontSize(0f))
        assertEquals(72, TextScale.defaultFontSize(10f))
        assertEquals(130, TextScale.sidePageTextZoom(1.3f))
        assertEquals(200, TextScale.sidePageTextZoom(2.0f))
        assertEquals(300, TextScale.sidePageTextZoom(5f))
    }

    @Test fun navigation() {
        val base = "https://appassets.androidplatform.net"
        assertEquals(IN_APP, NavigationPolicy.decide("$base/index.html"))
        assertEquals(BLOCK, NavigationPolicy.decide("http://appassets.androidplatform.net/index.html"))
        assertEquals(BLOCK, NavigationPolicy.decide("https://appassets.androidplatform.net:8443/index.html"))
        // Every outside link of the page goes to the browser.
        val links = Regex("""href="(https?://[^"]+)"""").findAll(WebRoot.text("index.html")).map { it.groupValues[1] }.toSet()
        assertTrue(links.size > 20)
        for (l in links) assertEquals(l, EXTERNAL, NavigationPolicy.decide(l))
        assertEquals(EXTERNAL_APP, NavigationPolicy.decide("nostr:npub1zz9w77p2jkn95t0st9tcuea8zdn2vknf0ctrwyd4g46w3kswdccqesr0pa"))
        for (bad in listOf("javascript:alert(1)", "intent://x#Intent;end", "file:///sdcard/x", "content://x/y", "data:text/html,x",
            "blob:https://appassets.androidplatform.net/x", "market://details?id=x", "mailto:a@b.c", "nostr:", "nostr://x",
            "https://user@example.com/", null, "")) assertEquals(bad, BLOCK, NavigationPolicy.decide(bad))
        assertEquals("/disclaimer.html", NavigationPolicy.sidePage("$base/disclaimer.html"))
        assertNull(NavigationPolicy.sidePage("$base/index.html"))
        assertNull(NavigationPolicy.sidePage("https://stormberry.as/privacy.html#labs"))
        assertTrue(NavigationPolicy.isStartPage("$base/"))
        assertTrue(NavigationPolicy.isStartPage("$base/index.html"))
        assertTrue(NavigationPolicy.isAssetOrigin("https://appassets.androidplatform.net"))
        assertFalse(NavigationPolicy.isAssetOrigin("https://appassets.androidplatform.net.evil.example"))
        assertFalse(NavigationPolicy.isAssetOrigin("null"))
    }
}
