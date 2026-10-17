package no.stormberry.eclipsetracker.web

/**
 * Maps a request path on https://appassets.androidplatform.net/ to a file under the APK's
 * assets/web/ folder, and names its content type. Pure Kotlin, unit tested.
 *
 * Only plain relative paths are answered. Anything that tries to climb out of the web
 * folder, or names a type the page does not use, gets no file at all.
 *
 * Keep TYPES in step with WebAssets.ALLOWED_EXTENSIONS in app/build.gradle.kts, with one
 * deliberate difference: json is bundled (data/eclipses.json, for the native alarm engine, which
 * reads it through AssetManager) but never served to the page. The page does not load it on the
 * website either, and its policy (connect-src 'none') forbids fetching it.
 */
object AssetPaths {
    const val ROOT = "web"

    private val TYPES = mapOf(
        "html" to "text/html",
        // Module scripts and their imports are refused unless served with a JavaScript MIME type.
        "js" to "text/javascript",
        "css" to "text/css",
        "svg" to "image/svg+xml",
        "woff2" to "font/woff2",
    )

    private val TEXT = setOf("html", "js", "css", "svg")

    /**
     * [path] is what follows the leading "/" of the request path, already URL-decoded by the
     * loader. Returns the asset path ("web/index.html") or null when it must not be served.
     */
    fun resolve(path: String?): String? {
        var p = path ?: return null
        if (p.contains('\\') || p.contains('\u0000') || p.startsWith("/")) return null
        if (p.isEmpty() || p.endsWith("/")) p += "index.html"
        val segments = p.split('/')
        if (segments.any { it.isEmpty() || it == "." || it == ".." || it.startsWith(".") }) return null
        if (extension(p) !in TYPES) return null
        return "$ROOT/$p"
    }

    fun mimeType(assetPath: String): String? = TYPES[extension(assetPath)]

    /** The charset to declare, for text types only. */
    fun encoding(assetPath: String): String? = if (extension(assetPath) in TEXT) "utf-8" else null

    /** Every extension the table can serve, for the tests. */
    val extensions: Set<String> get() = TYPES.keys

    private fun extension(p: String): String = p.substringAfterLast('/').substringAfterLast('.', "").lowercase()
}
