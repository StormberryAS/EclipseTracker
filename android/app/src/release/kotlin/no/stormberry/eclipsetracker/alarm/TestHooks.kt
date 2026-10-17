package no.stormberry.eclipsetracker.alarm

import android.content.Context

/** The release build's TestHooks: none. The debug build's (src/debug) lets the emulator test force fix B's A-4 path. */
internal object TestHooks {
    @Suppress("UNUSED_PARAMETER", "FunctionOnlyReturningConstant")
    fun failForeground(context: Context): Boolean = false
}
