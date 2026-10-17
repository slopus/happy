package com.slopus.happy.voice

import kotlinx.coroutines.CancellationException

/** realtimeClientTools.ts: validate at the SDK boundary, use the existing sender and permission RPC. */
class VoiceTools(
    private val send: suspend (sessionId: String, message: String) -> Unit,
    private val permissionOwner: suspend (requestId: String) -> String?,
    private val decide: suspend (sessionId: String, requestId: String, allow: Boolean) -> Unit,
    private val sent: () -> Unit,
    private val isCurrent: () -> Boolean = { true },
) {
    suspend fun execute(name: String, parameters: Map<String, Any>): String {
        if (!isCurrent()) return "error (voice session ended)"
        fun text(key: String) = (parameters[key] as? String)?.takeIf { it.isNotEmpty() }
        return when (name) {
            "sendMessageToSession" -> {
                val sessionId = text("sessionId") ?: return INVALID
                val message = text("message") ?: return INVALID
                send(sessionId, message)
                sent()
                "sent [DO NOT say anything else, simply say 'sent']"
            }
            "processPermissionRequest" -> {
                val requestId = text("requestId") ?: return INVALID
                val decision = text("decision")?.takeIf { it == "allow" || it == "deny" } ?: return INVALID
                val sessionId = permissionOwner(requestId) ?: return "error (permission request not found)"
                if (!isCurrent()) return "error (voice session ended)"
                try {
                    decide(sessionId, requestId, decision == "allow")
                    "done [DO NOT say anything else, simply say 'done']"
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    "error (failed to $decision permission)"
                }
            }
            else -> INVALID
        }
    }

    companion object { const val INVALID = "error (invalid parameters)" }
}