package no.stormberry.eclipsetracker.web

import kotlin.math.roundToInt

/**
 * How the app enlarges the page's text with Android's font size (fix C, 17 October 2026, S-2).
 * Pure Kotlin, unit tested; tests/app-mode-smoke.ts reads the two base sizes from this file and
 * enlarges the page in Chromium exactly this way.
 *
 * Before fix C the app set the WebView's textZoom to the font scale. textZoom multiplies every
 * font size after the page's style sheet has worked it out, past the caps the page puts on its
 * large text (min(), clamp() and container units, made for a browser's larger default font), so
 * at 2.0 on a 320 dp screen the title was clipped, the page scrolled sideways and the selects were
 * cut. Now the page keeps textZoom 100 and gets the larger text the way a browser's own font
 * size setting gives it: a larger default font size (WebSettings.defaultFontSize, 16 px in a
 * browser), so the page's rem sizes grow and its caps still hold. The fixed-width default (13 px)
 * grows alike. The disclaimer, a page of plain prose with a fixed 16 px body, keeps textZoom
 * (its body would not grow otherwise, and it has no caps to break).
 */
object TextScale {
    /** A browser's default font size, and its default fixed-width size, in CSS pixels. */
    const val BASE_FONT_PX = 16
    const val BASE_FIXED_FONT_PX = 13

    /** WebSettings accepts 1 to 72. */
    private const val MAX_PX = 72

    /** The default font size for Android's font scale [fontScale] (1.0 is 16, 2.0 is 32). */
    fun defaultFontSize(fontScale: Float): Int = scaled(BASE_FONT_PX, fontScale)

    /** The default fixed-width font size for [fontScale] (1.0 is 13, 2.0 is 26). */
    fun defaultFixedFontSize(fontScale: Float): Int = scaled(BASE_FIXED_FONT_PX, fontScale)

    /** The text zoom for a side page (the disclaimer), as before fix C: the font scale in per cent. */
    fun sidePageTextZoom(fontScale: Float): Int = (safe(fontScale) * 100).roundToInt().coerceIn(50, 300)

    private fun scaled(base: Int, fontScale: Float): Int = (base * safe(fontScale)).roundToInt().coerceIn(1, MAX_PX)

    private fun safe(fontScale: Float): Float = if (fontScale.isFinite() && fontScale > 0f) fontScale else 1f
}
