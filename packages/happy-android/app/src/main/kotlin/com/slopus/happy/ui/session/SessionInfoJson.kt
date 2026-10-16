package com.slopus.happy.ui.session

import com.slopus.happy.model.Session
import com.slopus.happy.model.SessionState
import com.slopus.happy.sync.ComposerMirror
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * useSessionStatus as info.tsx dumps it: undefined fields left out, as
 * JSON.stringify does (isPulsing only while it pulses).
 */
internal fun statusJson(state: SessionState, statusText: String): JsonObject = buildJsonObject {
    val (color, pulsing) = when (state) {
        SessionState.Disconnected -> "#999" to false
        SessionState.PermissionRequired, SessionState.InputRequired -> "#FF9500" to true
        SessionState.Thinking -> "#007AFF" to true
        SessionState.Waiting -> "#34C759" to false
    }
    put("isConnected", state != SessionState.Disconnected)
    put("statusText", statusText)
    put("statusColor", color)
    put("statusDotColor", color)
    if (pulsing) put("isPulsing", true)
}

/**
 * The session as the store holds it, for the dump (JSON.stringify(session)):
 * storageTypes.ts `Session`'s fields this app has, the picks and draft from
 * its composer mirror. latestUsage lives in the chat's reducer and todos
 * aren't kept, so both are left out.
 */
internal fun sessionJson(session: Session, agentState: JsonObject?, composer: ComposerMirror = ComposerMirror()): JsonObject = buildJsonObject {
    put("id", session.id)
    session.avatarDescriptor?.let { put("avatarDescriptor", it.toJson()) }
    put("seq", session.seq)
    put("createdAt", session.createdAt)
    put("updatedAt", session.updatedAt)
    put("active", session.active)
    put("activeAt", session.activeAt)
    put("projectId", session.projectId)
    put("metadata", session.metadata?.raw ?: JsonNull)
    put("metadataVersion", session.metadataVersion)
    put("agentState", agentState ?: JsonNull)
    put("agentStateVersion", session.agentStateVersion)
    put("thinking", session.thinking)
    put("thinkingAt", session.thinkingAt)
    if (session.isOnline) put("presence", "online") else put("presence", session.activeAt)
    (composer.draft ?: session.draft)?.let { put("draft", it) }
    composer.draftUpdatedAt?.let { put("draftUpdatedAt", it) }
    composer.permissionMode?.let { put("permissionMode", it) }
    composer.modelMode?.let { put("modelMode", it) }
    composer.effortLevel?.let { put("effortLevel", it) }
    session.lastMessageSentAt?.let { put("lastMessageSentAt", it) }
}

