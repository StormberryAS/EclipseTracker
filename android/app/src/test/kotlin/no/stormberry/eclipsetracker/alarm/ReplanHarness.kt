package no.stormberry.eclipsetracker.alarm

import no.stormberry.eclipsetracker.WebRoot
import no.stormberry.eclipsetracker.core.AlarmRecord
import java.time.ZoneId

/**
 * Fix E (17 October 2026): the store as AlarmScheduling keeps it between re-plans, and one re-plan
 * as AlarmScheduling.replanLocked and replanAfterBoot run it, through the same pure code
 * (FireRules.bootIsRestart, FireRules.codesToProbe, AlarmScheduler.replan, FireRules.untold).
 * [held] is what AlarmManager holds of the app: emptied by a restart or a force stop, the codes
 * armed after each re-plan.
 */
internal data class Store(
    val records: List<Any?>,
    val armed: Set<Int>,
    val armedAt: Map<Int, Long>,
    val restartBoot: Int,
    val held: Set<Int> = armed,
    val untold: List<AlarmRecord> = emptyList(),
) {
    /** The phone restarted (or the app was force-stopped): AlarmManager holds nothing of the app. */
    fun restarted(): Store = copy(held = emptySet())
}

internal data class Step(val store: Store, val plan: Plan, val missed: List<AlarmRecord>, val restart: Boolean)

internal object ReplanHarness {
    private val catalogue = WebRoot.catalogue

    /** A boot broadcast: restart or not by the boot count and the pending intents (C-3), then the re-plan. */
    fun boot(store: Store, bootCount: Int, now: Long, zone: ZoneId): Step {
        val probe = FireRules.codesToProbe(store.armed, store.armedAt, now)
        val live = if (probe.isEmpty()) null else probe.any { it in store.held }
        val restart = FireRules.bootIsRestart(bootCount, store.restartBoot, live)
        return replan(store, now, zone, restart, restartBoot = if (restart && bootCount >= 0) bootCount else store.restartBoot)
    }

    /** Any other re-plan (the unlock of the app, the app coming to the front, a fire, a change of time or zone). */
    fun normal(store: Store, now: Long, zone: ZoneId, drop: String? = null): Step =
        replan(store, now, zone, afterRestart = false, restartBoot = store.restartBoot, drop = drop)

    private fun replan(store: Store, now: Long, zone: ZoneId, afterRestart: Boolean, restartBoot: Int, drop: String? = null): Step {
        val (plan, missed) = AlarmScheduler.replan(store.records, catalogue, zone, now, store.armed, store.armedAt, afterRestart, drop)
        val codes = AlarmScheduler.apply(plan, FakeAlarmSink(), store.armed)
        val next = Store(
            records = plan.keep.map { it.toJson() },
            armed = codes,
            armedAt = plan.armed.associate { it.requestCode to it.fireAt },
            restartBoot = restartBoot,
            held = codes,
            untold = FireRules.untold(store.untold, missed),
        )
        return Step(next, plan, missed, afterRestart)
    }
}
