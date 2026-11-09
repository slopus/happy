package com.slopus.happy.conversation

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Builtin display metadata only. MCP descriptions belong to the remote tool's input schema. */
object ToolSummary {
    fun of(name: String, arguments: JsonElement?): String? {
        if (name.startsWith("mcp_")) return null
        val args = arguments as? JsonObject ?: return null
        val fields = listOf("description") + when (name) {
            "send_agent_message", "send_bot_message", "send_task_message" -> listOf("explanation")
            "create_agent", "create_subtask", "create_artifact", "create_calendar_event", "codex_imagegen" -> listOf("title")
            "create_task", "set_title", "set_bot_name", "set_node_name" -> listOf("name")
            "create_bot" -> listOf("name", "username")
            "read_file", "edit_file", "write_file", "view_image", "Read", "Edit", "Write",
            "read_vault_file", "edit_vault_file", "write_vault_file", "read_artifact_file", "edit_artifact_file", "write_artifact_file" -> listOf("path", "file_path")
            "glob_vault", "grep_vault" -> listOf("pattern")
            "web_search", "tool_search" -> listOf("query")
            "web_fetch" -> listOf("url")
            else -> emptyList()
        }
        return fields.firstNotNullOfOrNull { field ->
            (args[field] as? JsonPrimitive)?.takeIf { it.isString }?.content?.let(::normalize)
        }
    }

    /** One short line, capped by Unicode code points rather than splitting UTF-16 surrogate pairs. */
    internal fun normalize(value: String): String? {
        val text = value.replace(Regex("[\\s\\p{Z}\u0085\uFEFF]+"), " ").trim()
        if (text.isEmpty()) return null
        return text.substring(0, text.offsetByCodePoints(0, minOf(120, text.codePointCount(0, text.length))))
    }
}