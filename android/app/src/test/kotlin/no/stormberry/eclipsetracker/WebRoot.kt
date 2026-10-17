package no.stormberry.eclipsetracker

import no.stormberry.eclipsetracker.core.EclipseCatalogue
import java.io.File

/** The web app's files the tests read: the vectors and the eclipse list (app/build.gradle.kts passes the path). */
object WebRoot {
    val dir: File = File(System.getProperty("eclipsetracker.webRoot") ?: error("eclipsetracker.webRoot is not set"))

    fun text(rel: String): String = File(dir, rel).readText(Charsets.UTF_8)

    val catalogue: EclipseCatalogue by lazy { EclipseCatalogue.parse(text("data/eclipses.json")) }
}
