package com.slopus.happy.agent

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** The existing workspace Git API's summary, not a count of an agent's tool calls. */
@Serializable
data class WorkspaceLineChanges(
    val comparison: String,
    val insertions: Long,
    val deletions: Long,
    val countsExact: Boolean,
    val scannedAt: Double,
) {
    val visible: Boolean get() = comparison == "ready" && insertions >= 0 && deletions >= 0 && (insertions > 0 || deletions > 0)

    companion object {
        fun parse(value: JsonElement?): WorkspaceLineChanges? = value?.let {
            runCatching { AgentClient.json.decodeFromJsonElement(serializer(), it) }.getOrNull()
        }
    }
}