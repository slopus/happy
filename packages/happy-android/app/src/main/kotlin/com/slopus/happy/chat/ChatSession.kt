package com.slopus.happy.chat

import androidx.compose.runtime.Immutable
import com.slopus.happy.data.SessionRecord
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * The few session metadata fields the chat reads (storageTypes.ts
 * `MetadataSchema`), read leniently from the decrypted JSON. Home owns the full
 * typed metadata; this stays the chat's narrow view of it.
 */
@Immutable
data class ChatSessionInfo(
    val id: String,
    val createdAt: Long,
    /** The server's `active` flag; presence from the socket overrides it. */
    val active: Boolean,
    val activeAt: Long,
    /** `metadata.summary.text`, or the bot's name; null for an untitled chat. */
    val title: String?,
    val flavor: String?,
    val host: String?,
    val path: String?,
    val homeDir: String?,
    val os: String?,
    val cliVersion: String?,
    /** Happy Agent (rig) session: `metadata.client.id == 'rig'`. */
    val isRig: Boolean,
    /** A rig daemon that reports when a message enters the agent's context. */
    val sendsMessageReceipts: Boolean,
    val agentState: AgentState?,
    /** Per-session picks mirrored in metadata (#1492). */
    val permissionMode: String?,
    val modelMode: String?,
    val effortLevel: String?,
) {
    /** happy-app `usesControlledSessionUi`: not a rig session. */
    val usesControlledSessionUi: Boolean get() = !isRig

    /** Claude unless the metadata names another flavor. */
    val isClaudeFlavor: Boolean get() = flavor == null || flavor == "claude"

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        fun from(record: SessionRecord): ChatSessionInfo {
            val metadata = record.metadataJson?.let { runCatching { json.parseToJsonElement(it) }.getOrNull() }.obj
                ?: JsonObject(emptyMap())
            val client = metadata["client"].obj
            val isRig = client?.get("id").str == "rig"
            val rigV1 = isRig && (metadata["rigMetadataVersion"].num ?: 0.0) >= 1
            return ChatSessionInfo(
                id = record.id,
                createdAt = record.createdAt,
                active = record.active,
                activeAt = record.activeAt,
                title = metadata["bot"].obj?.get("name").str ?: metadata["summary"].obj?.get("text").str,
                flavor = metadata["flavor"].str,
                host = metadata["host"].str,
                path = metadata["path"].str,
                homeDir = metadata["homeDir"].str,
                os = metadata["os"].str,
                cliVersion = metadata["version"].str,
                isRig = isRig,
                sendsMessageReceipts = rigV1 && metadata["capabilities"].obj?.get("messageReceipts").bool == true,
                agentState = AgentState.parse(record.agentStateJson),
                permissionMode = metadata["permissionMode"].str,
                modelMode = metadata["modelMode"].str,
                effortLevel = metadata["effortLevel"].str,
            )
        }
    }
}

/** sync/sessionState.ts `SessionState`, in its precedence order. */
enum class SessionState { Disconnected, PermissionRequired, InputRequired, Thinking, Waiting }

fun resolveSessionState(agentState: AgentState?, thinking: Boolean, online: Boolean): SessionState = when {
    !online -> SessionState.Disconnected
    !agentState?.requests.isNullOrEmpty() -> SessionState.PermissionRequired
    selectPendingCommunications(agentState).isNotEmpty() -> SessionState.InputRequired
    thinking -> SessionState.Thinking
    else -> SessionState.Waiting
}

/**
 * `formatPathRelativeToHome`: a path under the home directory reads as
 * `~/...`.
 */
fun formatPathRelativeToHome(path: String, homeDir: String?): String {
    if (homeDir.isNullOrEmpty()) return path
    val home = homeDir.removeSuffix("/")
    if (!path.startsWith(home)) return path
    val relative = path.substring(home.length)
    return when {
        relative.startsWith("/") -> "~$relative"
        relative.isEmpty() -> "~"
        else -> "~/$relative"
    }
}
