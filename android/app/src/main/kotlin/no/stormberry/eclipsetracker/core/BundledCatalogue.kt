package no.stormberry.eclipsetracker.core

import android.content.Context

/**
 * The bundled eclipse list (assets/web/data/eclipses.json, spec 9.3), read once.
 *
 * Moved here from the alarm package (AlarmScheduling.catalogue) on 29 October 2026, for the Google
 * Play edition: the page's calendar handover checks a file name against this list in both
 * editions, and with the loader outside the alarm package nothing the Play edition runs reaches
 * that package any more, so R8 can leave all of it out of the Play bundle. The ringing alarms read
 * the same list through AlarmScheduling.catalogue, which asks this object.
 */
object BundledCatalogue {
    const val ASSET = "web/data/eclipses.json"

    private val lock = Any()

    @Volatile
    private var loaded: EclipseCatalogue? = null

    /** The list, parsed on first use and kept for the life of the process. */
    fun get(context: Context): EclipseCatalogue =
        loaded ?: synchronized(lock) {
            loaded ?: context.applicationContext.assets.open(ASSET).use { input ->
                EclipseCatalogue.parse(String(input.readBytes(), Charsets.UTF_8))
            }.also { loaded = it }
        }
}
