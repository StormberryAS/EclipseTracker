package no.stormberry.eclipsetracker

/**
 * Which edition of EclipseTracker this is, fixed when the app is built (SunApp's Edition.kt).
 *
 * This is the SOVEREIGN edition (`no.stormberry.eclipsetracker`: GitHub Releases, Obtainium,
 * Zapstore): the eclipse list, the countdown, the calendar file AND the ringing alarms, with their
 * nine install-time permissions. The Google Play edition (`no.stormberry.eclipsetracker.play`,
 * built with `-PplayBuild=true`) has its own copy of this file in `src/play/kotlin`, where [ALARMS]
 * is false. The two files differ in nothing else.
 *
 * A `const val`, not a runtime setting, on purpose: Kotlin inlines it, so in the Play edition every
 * `if (Edition.ALARMS)` is dead code that R8 deletes, together with the alarm classes only it
 * reached. What the Play edition cannot do it does not contain.
 */
object Edition {
    /** True when the ringing alarms are part of this build. */
    const val ALARMS: Boolean = true
}
