package no.stormberry.eclipsetracker

/**
 * Which edition of EclipseTracker this is, fixed when the app is built (SunApp's Edition.kt).
 *
 * This is the GOOGLE PLAY edition (`no.stormberry.eclipsetracker.play`, built with
 * `-PplayBuild=true`): the eclipse list, the countdown and the calendar file, WITHOUT the ringing
 * alarms. No alarm permission, receiver, service or screen is in the app; `src/play/AndroidManifest.xml`
 * removes them from the merged manifest, and [ALARMS] being false lets R8 delete the code behind
 * them. The sovereign edition has its own copy of this file in `src/sovereign/kotlin`, where
 * [ALARMS] is true. The two files differ in nothing else.
 */
object Edition {
    /** True when the ringing alarms are part of this build. */
    const val ALARMS: Boolean = false
}
