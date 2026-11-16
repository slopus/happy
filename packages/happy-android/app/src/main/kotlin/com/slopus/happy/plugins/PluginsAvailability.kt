package com.slopus.happy.plugins

import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient

/** Whether a connection has plugins ([com.slopus.happy.agent.CapabilityAvailability] with health's `capabilities.plugins`). */
object PluginsAvailability {
    const val RESOURCE = "plugins-available"

    /**
     * FALLBACK for Happy Cloud servers deployed before `capabilities.plugins`:
     * `GET /v0/plugins` answering at all: true, 404/501 false, anything else
     * unknown (null). Delete it once every deployed server sends the flag.
     */
    suspend fun probe(client: AgentClient): Boolean? = try {
        client.send("GET", "/v0/plugins")
        true
    } catch (e: AgentApiException) {
        if (e.status == 404 || e.status == 501) false else null
    }
}
