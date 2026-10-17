package no.stormberry.eclipsetracker.web

/**
 * The headers on every response the asset loader gives the WebView: the page, its modules, the
 * style sheets, the fonts, the icons and the empty 403 and 404 answers. Pure Kotlin, unit tested.
 * Copied from GDPRLetterBuilder (whose recipe is CheckLink's).
 *
 * WebViewAssetLoader sends no headers of its own. The page carries its own meta policy (spec
 * section 10, code review C-5); the disclaimer carries none, and a meta tag cannot carry
 * frame-ancestors at all. So every response carries the full policy: the page's meta policy,
 * directive for directive, plus frame-ancestors 'none' and upgrade-insecure-requests, the two
 * directives only a header can carry. The browser enforces the header and the meta tag together,
 * so the page stays exactly as strict as on the website (connect-src 'none', no worker).
 * tests/android-app.test.mjs checks that this string is the page's meta policy plus those two
 * directives and nothing else. Referrer-Policy: no-referrer, as the page's own meta tag says.
 *
 * Fix C (17 October 2026, M-1): the disclaimer, the same file as every Labs page's disclaimer,
 * styles itself with one inline style element, which style-src 'self' refused, so in the app it
 * showed black text on the window's near-black background. The website sends no policy for it and
 * is not changed. Its response alone allows that one style element by its SHA-256
 * ([DISCLAIMER_STYLE_HASH]): any other inline style, and every script, stays refused. The build
 * (verifyWebAssets) and both test suites work the hash out from disclaimer.html again and fail
 * when it no longer matches, so an edit to the disclaimer's style cannot silently undo this.
 */
object ResponseHeaders {
    const val CONTENT_SECURITY_POLICY =
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
            "connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'; worker-src 'none'; " +
            "frame-ancestors 'none'; upgrade-insecure-requests"

    /** The asset whose response allows its one inline style element. */
    const val DISCLAIMER_ASSET = "web/disclaimer.html"

    /** SHA-256 of the text inside disclaimer.html's style element, base64, as a policy hash source names it. */
    const val DISCLAIMER_STYLE_HASH = "sha256-w1PpRd8pXaiTtxASFdDz2teeHIsF8FK3V2edo3jW+ug="

    /** [CONTENT_SECURITY_POLICY] with the disclaimer's style element allowed, and nothing else changed. */
    val DISCLAIMER_CONTENT_SECURITY_POLICY: String =
        CONTENT_SECURITY_POLICY.replace("style-src 'self';", "style-src 'self' '$DISCLAIMER_STYLE_HASH';")
            .also { check(it != CONTENT_SECURITY_POLICY) { "style-src 'self'; is missing from the policy" } }

    /** The same map for every response, success or refusal, the disclaimer apart. */
    val ALL: Map<String, String> = headers(CONTENT_SECURITY_POLICY)

    /** The disclaimer's: [ALL] with [DISCLAIMER_CONTENT_SECURITY_POLICY]. */
    val DISCLAIMER: Map<String, String> = headers(DISCLAIMER_CONTENT_SECURITY_POLICY)

    /** The headers for the asset at [assetPath] ("web/index.html"), as AssetPaths.resolve names it. */
    fun forAsset(assetPath: String): Map<String, String> = if (assetPath == DISCLAIMER_ASSET) DISCLAIMER else ALL

    private fun headers(policy: String): Map<String, String> = mapOf(
        "Content-Security-Policy" to policy,
        "X-Content-Type-Options" to "nosniff",
        "Cache-Control" to "no-store",
        "Referrer-Policy" to "no-referrer",
    )
}
