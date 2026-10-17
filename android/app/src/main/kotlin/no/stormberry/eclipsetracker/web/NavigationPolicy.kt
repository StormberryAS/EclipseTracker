package no.stormberry.eclipsetracker.web

import java.net.URI

/**
 * Decides what happens to every navigation and request the WebView makes. Pure Kotlin on
 * java.net.URI, so it is unit tested on the JVM. Taken from GDPRLetterBuilder's (itself
 * CheckLink's), with EclipseTracker's links: the only page opened over the main one is the
 * disclaimer, and the only other app scheme is the footer's nostr: link.
 *
 *  - The bundled app lives at https://appassets.androidplatform.net/ and loads in the app: the
 *    page, and over it the disclaimer (SIDE_PAGES).
 *  - Any other http or https address (the footer's Stormberry links, the app carousel, the
 *    Privacy page on stormberry.as, the onion address) opens in the user's browser on a press;
 *    the WebView stays where it is.
 *  - nostr: (the footer's Nostr link) goes to whichever app handles it, as from the website.
 *  - Everything else (javascript:, intent:, file:, content:, data:, blob:, market:, mailto: and
 *    any address that does not parse cleanly) is refused, and so is an address with sign-in
 *    details before an @.
 */
object NavigationPolicy {
    const val ASSET_HOST = "appassets.androidplatform.net"
    const val ASSET_ORIGIN = "https://$ASSET_HOST"

    enum class Decision { IN_APP, EXTERNAL, EXTERNAL_APP, BLOCK }

    /** Schemes handed to another app on the device, with no browser involved. */
    val APP_SCHEMES = setOf("nostr")

    fun decide(url: String?): Decision {
        val uri = parse(url) ?: return Decision.BLOCK
        val scheme = uri.scheme?.lowercase() ?: return Decision.BLOCK
        if (scheme in APP_SCHEMES) {
            // Only the plain form, nostr:npub1..., never nostr://... tricks.
            val rest = uri.rawSchemeSpecificPart
            return if (uri.isOpaque && !rest.isNullOrBlank() && !rest.startsWith("/")) Decision.EXTERNAL_APP else Decision.BLOCK
        }
        if (scheme != "http" && scheme != "https") return Decision.BLOCK
        val host = uri.host?.lowercase()
        if (host == null) {
            // java.net.URI gives no host for a name with an underscore (a_b.example), which
            // browsers open. Such an address goes to the browser only when its whole authority
            // is a plain name and an optional port: no sign-in details, no escapes, never the
            // app's own host.
            val name = plainRegistryHost(uri.rawAuthority) ?: return Decision.BLOCK
            return if (name.trimEnd('.') == ASSET_HOST) Decision.BLOCK else Decision.EXTERNAL
        }
        if (host.isEmpty() || uri.rawUserInfo != null) return Decision.BLOCK
        if (host == ASSET_HOST) {
            return if (scheme == "https" && (uri.port == -1 || uri.port == 443)) Decision.IN_APP else Decision.BLOCK
        }
        return Decision.EXTERNAL
    }

    private val PLAIN_AUTHORITY = Regex("^([A-Za-z0-9._-]*[A-Za-z0-9][A-Za-z0-9._-]*)(:([0-9]{1,5}))?$")

    /** The host of an authority java.net.URI could not read as a server, if it is a plain name and optional port. */
    private fun plainRegistryHost(authority: String?): String? {
        val m = PLAIN_AUTHORITY.matchEntire(authority ?: return null) ?: return null
        val port = m.groupValues[3]
        if (port.isNotEmpty() && port.toInt() > 65_535) return null
        return m.groupValues[1].lowercase()
    }

    /** True only for requests the bundled asset loader should answer. */
    fun isAssetRequest(url: String?): Boolean = decide(url) == Decision.IN_APP

    /**
     * The bundled page that opens over the main one instead of in its place: the footer's
     * Disclaimer. It opens in a second WebView on top, so Back returns to the page exactly as it
     * was, an open planner and the scroll position included (GDPRLetterBuilder's E3-1).
     */
    val SIDE_PAGES = setOf("/disclaimer.html")

    /** The path of a side page if [url] is one of them in the bundled app, otherwise null. */
    fun sidePage(url: String?): String? {
        if (decide(url) != Decision.IN_APP) return null
        val path = parse(url)?.rawPath ?: return null
        return path.takeIf { it in SIDE_PAGES }
    }

    /** True for the main page itself ("./" from the disclaimer, or index.html). */
    fun isStartPage(url: String?): Boolean {
        if (decide(url) != Decision.IN_APP) return false
        val path = parse(url)?.rawPath ?: return false
        return path == "" || path == "/" || path == "/index.html"
    }

    /** True when a message claims to come from the bundled page's origin, and nothing else. */
    fun isAssetOrigin(origin: String?): Boolean {
        val o = origin?.trimEnd('/') ?: return false
        return o == ASSET_ORIGIN || o == "$ASSET_ORIGIN:443"
    }

    private fun parse(url: String?): URI? {
        if (url.isNullOrBlank()) return null
        return try {
            URI(url.trim())
        } catch (_: Exception) {
            null
        }
    }
}
