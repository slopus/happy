package com.slopus.happy.voice

import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.model.SessionMetadata
import kotlinx.serialization.json.JsonElement

/** contextFormatters.ts with VOICE_CONFIG: tool descriptions only, 50 history rows, status events disabled. */
object VoiceContext {
    fun message(message: ChatMessage): String? = when (message) {
        is ChatMessage.AgentText -> "Claude Code: \n<text>${message.text}</text>"
        is ChatMessage.UserText -> "User sent message: \n<text>${message.text}</text>"
        is ChatMessage.ToolCallMessage -> message.tool.description?.takeIf { it.isNotEmpty() }?.let {
            "Claude Code is using ${message.tool.name} - $it"
        }
        else -> null
    }

    fun messages(sessionId: String, messages: List<ChatMessage>): String? = messages.sortedBy { it.createdAt }
        .mapNotNull(::message).takeIf { it.isNotEmpty() }?.joinToString("\n\n", "New messages in session: $sessionId\n\n")

    fun full(session: SessionRecord, messages: List<ChatMessage>): String {
        val metadata = SessionMetadata.parse(session.metadataJson)
        val summary = metadata?.summary?.text
        return buildList {
            add("# Session ID: ${session.id}")
            add("# Project path: ${metadata?.path ?: "undefined"}")
            add("# Session summary:\n${summary ?: "undefined"}")
            if (!summary.isNullOrEmpty()) { add("## Session Summary"); add(summary); add("") }
            add("## Our interaction history so far")
            add("")
            add(messages.take(50).mapNotNull(::message).joinToString("\n\n", "History of messages in session: ${session.id}\n\n"))
        }.joinToString("\n\n")
    }

    fun permission(sessionId: String, requestId: String, tool: String, args: JsonElement?): String =
        "Claude Code is requesting permission to use $tool (session $sessionId):\n<request_id>$requestId</request_id>\n<tool_name>$tool</tool_name>\n<tool_args>${args ?: "undefined"}</tool_args>"

    fun ready(sessionId: String) = "Claude Code done working in session: $sessionId. The previous message(s) are the summary of the work done. Report this to the human immediately."
}

/** voiceHooks: context is immediate; response prompts wait until both participants are idle. */
class VoiceHooks(
    private val session: (String) -> SessionRecord?,
    private val history: (String) -> List<ChatMessage>,
    private val context: (String) -> Unit,
    private val prompt: (String) -> Unit,
) {
    private val shown = mutableSetOf<String>()
    private val pending = mutableListOf<String>()
    private var mode = VoiceMode.Idle
    private var active = false

    private fun inject(id: String): String? {
        if (!shown.add(id)) return null
        return session(id)?.let { VoiceContext.full(it, history(id)) }
    }

    fun start(id: String, sessions: List<SessionRecord>): String {
        stop()
        active = true
        val directory = sessions.filter { it.active }.takeIf { it.isNotEmpty() }?.joinToString("\n", "Available sessions:\n") {
            "- ${it.id}: \"${SessionMetadata.parse(it.metadataJson)?.summary?.text ?: "No summary"}\""
        } ?: "No active sessions."
        return directory + "\n\n" + (inject(id)?.let { "CURRENT SESSION:\n\n$it" } ?: "")
    }

    fun focus(id: String) {
        if (!active) return
        inject(id)?.let(context)
        context("Session became focused: $id")
    }
    fun messages(id: String, messages: List<ChatMessage>) {
        if (!active) return
        inject(id)?.let(context)
        VoiceContext.messages(id, messages)?.let(context)
    }
    fun permission(id: String, requestId: String, tool: String, args: JsonElement?) {
        if (!active) return
        inject(id)?.let(context)
        sendPrompt(VoiceContext.permission(id, requestId, tool, args))
    }
    fun ready(id: String) {
        if (!active) return
        inject(id)?.let(context)
        sendPrompt(VoiceContext.ready(id))
    }
    private fun sendPrompt(text: String) { if (mode == VoiceMode.Idle) prompt(text) else pending += text }
    fun mode(value: VoiceMode) {
        mode = value
        if (active && mode == VoiceMode.Idle && pending.isNotEmpty()) {
            val text = pending.joinToString("\n\n")
            pending.clear()
            prompt(text)
        }
    }
    fun stop() { active = false; shown.clear(); pending.clear(); mode = VoiceMode.Idle }
}