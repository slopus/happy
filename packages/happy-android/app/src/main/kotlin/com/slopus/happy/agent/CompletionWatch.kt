package com.slopus.happy.agent

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Which finished conversations chime (desktop a72f8304, 962201a2): a live
 * `run.finished` for a top-level conversation, its current run, that home
 * lists and whose bot the person hasn't muted or hidden, while the
 * connection's completion sound isn't Never. The journal resumes from its
 * cursor after every connect, so a run that ended more than [FRESH_MILLIS]
 * ago is a replay and stays quiet; so is a run a newer one has replaced. A
 * `hello` forgets the runs, as desktop's resync does.
 */
class CompletionWatch {
    /** Each conversation's run as last heard: one finishing that isn't it is stale. */
    private val current = HashMap<String, String>()

    /**
     * The conversation [event] finished, if it should chime: [catalog] as
     * the event left it, [listed] whether home shows a conversation, [now]
     * this phone's clock.
     */
    fun finished(event: AgentEvent, catalog: AgentCatalog, listed: (String) -> Boolean, now: Long): String? {
        val agentId = event.data.string("agentId")
        when (event.type) {
            AgentEvent.HELLO -> current.clear()
            "run.started" -> run(event.data["run"])?.let { if (agentId != null) current[agentId] = it }
            "run.boundary" -> run(event.data["startedRun"])?.let { if (agentId != null) current[agentId] = it }
            "agent.removed" -> if (agentId != null) current.remove(agentId)
            "run.finished" -> {
                agentId ?: return null
                val run = event.data["run"] as? JsonObject
                val id = run?.string("id") ?: return null
                val heard = current[agentId]
                if (heard != null && heard != id) return null
                // Its start may predate this connect.
                current[agentId] = id
                if (DesktopSettings.completionSound(catalog.settingValues) == CompletionSound.Never) return null
                val endedAt = (run?.get("endedAt") as? JsonPrimitive)?.longOrNull ?: now
                if (now - endedAt > FRESH_MILLIS) return null
                val agent = catalog.agents[agentId] ?: return null
                if (agent.string("parentAgentId") != null) return null
                if (!listed(agentId)) return null
                val bot = catalog.bots.values.firstOrNull { (it["agent"] as? JsonObject)?.string("id") == agentId }?.string("id")
                if (bot != null && DesktopSettings.botQuiet(catalog.settingValues, bot)) return null
                return agentId
            }
        }
        return null
    }

    private fun run(element: JsonElement?): String? = (element as? JsonObject)?.string("id")

    companion object {
        /** How long after a run ended its `run.finished` still counts as live. */
        const val FRESH_MILLIS = 30_000L
    }
}
