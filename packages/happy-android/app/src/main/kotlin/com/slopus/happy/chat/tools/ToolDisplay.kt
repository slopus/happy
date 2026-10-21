package com.slopus.happy.chat.tools

import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import com.slopus.happy.R
import com.slopus.happy.chat.ToolCall
import com.slopus.happy.chat.PermissionStatus
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

// utils/toolDisplay.ts, utils/happyToolDisplay.ts and utils/toolCommand.ts:
// how a tool call is named and summarised in the chat.

/** Localized text for the tool labels; the UI backs it with Resources. */
interface ToolText {
    fun string(@StringRes id: Int, vararg args: Any): String
    fun plural(@PluralsRes id: Int, count: Int, vararg args: Any): String
}

enum class ToolCategory { Terminal, Edit, Read, Search, Web, Task, Other }

private val TERMINAL_TOOLS = setOf("Bash", "CodexBash", "GeminiBash", "shell", "execute", "exec_command", "run_terminal_command", "write_stdin")
private val EDIT_TOOLS = setOf("Edit", "MultiEdit", "Write", "CodexPatch", "GeminiPatch", "edit", "NotebookEdit", "apply_patch", "search_replace")
private val READ_TOOLS = setOf(
    "Read", "read", "NotebookRead", "LS", "read_file", "read_agent_history", "view_image", "get_provider_usage", "get_goal", "agent_info",
)
private val SEARCH_TOOLS = setOf(
    "Grep", "Glob", "grep", "search", "WebSearch", "list_dir", "list_agents", "list_projects", "list_workspaces",
    "list_workspace_sessions", "TaskList",
)
private val WEB_TOOLS = setOf("WebFetch")
private val TASK_TOOLS = setOf(
    "Task", "Agent", "TaskCreate", "TaskOutput", "TaskStop", "TaskUpdate", "Workflow", "archive_workspace", "create_goal",
    "create_workspace", "delegate_to_workspace", "followup_task", "interrupt_agent", "schedule_message", "send_message",
    "agent_me", "agent_send", "spawn_agent", "stop_workflow", "update_goal", "update_plan", "wait_agent", "wait_for_workflow",
    "workflow", "workflow_status",
)
private val QUESTION_TOOLS = setOf("AskUserQuestion", "request_user_input")

/** happyToolDisplay.ts: Happy Agent tools by name; presentation only. */
val HappyToolDisplay: Map<String, Pair<ToolCategory, String>> = buildMap {
    fun t(category: ToolCategory, vararg entries: Pair<String, String>) = entries.forEach { (name, title) -> put(name, category to title) }
    t(
        ToolCategory.Terminal,
        "BashInput" to "Send shell input", "BashOutput" to "Read shell output", "BashStop" to "Stop shell",
        "write_stdin" to "Shell session", "kill_session" to "Stop shell", "get_command_or_subagent_output" to "Read shell output",
        "send_command_input" to "Send shell input", "kill_command_or_subagent" to "Stop shell",
    )
    t(
        ToolCategory.Task,
        "create_agent" to "Start collaborator", "send_agent_message" to "Send agent message", "interrupt_agent" to "Interrupt agent",
        "create_task" to "Create task", "update_task" to "Update task", "complete_task" to "Complete task", "remove_task" to "Remove task",
        "create_goal" to "Create goal", "update_goal" to "Update goal", "clear_goal" to "Clear goal",
        "create_workspace" to "Create workspace", "create_child_workspace" to "Create workspace", "rename_workspace" to "Rename workspace",
        "archive_workspace" to "Archive workspace", "set_project_avatar" to "Set project avatar", "run_workflow" to "Run workflow",
        "wait_workflow" to "Wait for workflow", "cancel_workflow" to "Cancel workflow", "resume_workflow" to "Resume workflow",
        "wait" to "Wait", "wait_until" to "Wait until", "schedule_message" to "Schedule message",
        "cancel_scheduled_message" to "Cancel scheduled message", "cancel_ask" to "Cancel question", "set_presence" to "Set presence",
        "create_secret" to "Create secret", "update_secret" to "Update secret", "attach_secret" to "Attach secret",
        "detach_secret" to "Detach secret", "call_mcp_tool" to "Call MCP tool", "configure_mcp_server" to "Configure MCP server",
        "reload_mcp_servers" to "Reload MCP servers", "create_bot" to "Create bot", "send_bot_message" to "Send bot message",
        "set_bot_avatar" to "Set bot avatar", "codex_imagegen" to "Generate image", "gemini_imagegen" to "Generate image",
        "gemini_generate_music" to "Generate music", "javascript" to "Run JavaScript", "python" to "Run Python",
    )
    t(
        ToolCategory.Search,
        "list_tasks" to "List tasks", "list_workspaces" to "List workspaces", "list_projects" to "List projects",
        "list_workflows" to "List workflows", "list_scheduled_messages" to "List scheduled messages",
        "list_presences" to "List presence states", "list_secrets" to "List secret references", "list_mcp_servers" to "List MCP servers",
        "list_mcp_tools" to "List MCP tools", "list_mcp_resources" to "List MCP resources",
        "list_mcp_resource_templates" to "List MCP resource templates", "list_mcp_prompts" to "List MCP prompts",
        "list_skills" to "List skills", "list_bots" to "List bots", "bedrock_web_search" to "Search the web",
        "claude_web_search" to "Search the web", "codex_web_search" to "Search the web", "gemini_web_search" to "Search the web",
        "grok_web_search" to "Search the web", "grok_x_search" to "Search X",
    )
    t(
        ToolCategory.Read,
        "get_task" to "Read task", "get_goal" to "Read goal", "get_workspace" to "Read workspace",
        "get_workspace_branch_metadata" to "Read branch metadata", "workflow_status" to "Check workflow",
        "workflow_logs" to "Read workflow logs", "read_user_input" to "Read answer", "get_presence" to "Check presence",
        "reference_secret" to "Read secret reference", "read_mcp_resource" to "Read MCP resource", "get_mcp_prompt" to "Read MCP prompt",
        "read_skill" to "Read skill", "get_usage" to "Read token usage", "get_agent_tree_usage" to "Read agent-tree usage",
        "read_agent_history" to "Read agent history", "gemini_analyze_media" to "Analyze media",
    )
    t(ToolCategory.Edit, "write" to "Write file")
    t(ToolCategory.Web, "web_fetch" to "Fetch URL")
}

/** `getShellControl`: shell controls have no command; never show a session id as one. */
fun shellControl(name: String, input: JsonElement?): String? {
    val args = input.obj
    val id = args?.get("session_id") ?: args?.get("bash_id") ?: args?.get("task_id")
    val idText = (id as? JsonPrimitive)?.takeIf { it.isString || it.content.toDoubleOrNull() != null }?.content
    val ids = args?.get("task_ids").arr?.mapNotNull { it.str }.orEmpty()
    val target = when {
        idText != null -> " ($idText)"
        ids.isNotEmpty() -> " (${ids.joinToString(", ")})"
        else -> ""
    }
    return when (name) {
        "kill_session", "BashStop", "kill_command_or_subagent" -> "Stopping shell$target"
        "BashOutput", "get_command_or_subagent_output" -> "Reading shell output$target"
        "write_stdin", "BashInput", "send_command_input" -> {
            val chars = (if (name == "write_stdin") args?.get("chars") else args?.get("input")).str
            if (!chars.isNullOrEmpty()) "Sending input to shell$target" else "Waiting for shell output$target"
        }
        else -> null
    }
}

private val SHELL_WRAPPERS = setOf("bash", "/bin/bash", "sh", "/bin/sh", "zsh", "/bin/zsh")

/** `stringifyToolCommand`: a string, or an argv with `bash -c` unwrapped. */
fun stringifyToolCommand(command: JsonElement?): String? {
    command.str?.let { return it.trim().ifEmpty { null } }
    val parts = command.arr?.mapNotNull { it.str?.trim()?.ifEmpty { null } } ?: return null
    if (parts.isEmpty()) return null
    if (parts.size >= 3 && parts[0] in SHELL_WRAPPERS && (parts[1] == "-c" || parts[1] == "-lc")) {
        return parts.drop(2).joinToString(" ").trim().ifEmpty { null }
    }
    return parts.joinToString(" ")
}

fun isTerminalToolName(name: String): Boolean = name in TERMINAL_TOOLS || HappyToolDisplay[name]?.first == ToolCategory.Terminal

fun isInteractiveQuestionToolName(name: String): Boolean = name in QUESTION_TOOLS

fun toolSummaryCategory(name: String): ToolCategory = HappyToolDisplay[name]?.first ?: when (name) {
    in TERMINAL_TOOLS -> ToolCategory.Terminal
    in EDIT_TOOLS -> ToolCategory.Edit
    in READ_TOOLS -> ToolCategory.Read
    in SEARCH_TOOLS -> ToolCategory.Search
    in WEB_TOOLS -> ToolCategory.Web
    in TASK_TOOLS -> ToolCategory.Task
    else -> ToolCategory.Other
}

/** Patch tools draw a header per file, and `file` is a bare picture: no card header. */
fun shouldRenderToolCardHeader(name: String): Boolean = name !in setOf("CodexPatch", "GeminiPatch", "apply_patch", "file")

/**
 * `shouldUseCompactToolRow`: compact mode shrinks every tool to its activity
 * row except attachments, questions and pending plan or input approvals; an
 * unknown tool is compact unless its approval needs the arguments shown.
 */
fun shouldUseCompactToolRow(tool: ToolCall, compactMode: Boolean, hasInlineView: Boolean = true): Boolean {
    if (tool.name == "file" || isInteractiveQuestionToolName(tool.name)) return false
    val pending = tool.permission?.status == PermissionStatus.Pending
    if ((tool.name == "ExitPlanMode" || tool.name == "exit_plan_mode") && pending) return false
    if (!hasInlineView && pending) return false
    return compactMode || !hasInlineView
}

/** `getTerminalToolCommand`: the command a terminal tool ran, from whichever field the provider used. */
fun terminalToolCommand(name: String, input: JsonElement?): String? {
    if (!isTerminalToolName(name)) return null
    val args = input.obj
    args?.get("parsed_cmd").arr?.firstNotNullOfOrNull { it.obj?.get("cmd").str?.trim()?.ifEmpty { null } }?.let { return it }
    stringifyToolCommand(args?.get("command") ?: args?.get("cmd"))?.let { return it }
    val title = args?.get("toolCall").obj?.get("title").str ?: return null
    val bracket = title.indexOf(" [")
    return (if (bracket > 0) title.substring(0, bracket) else title).trim().ifEmpty { null }
}

private val SUMMARY_KEYS = listOf(
    "query", "title", "name", "objective", "workspaceId", "requestId", "ask_id", "id", "task_id", "toAgentId", "targetAgentId",
    "target", "agent_id", "server", "at",
)

/** `getToolSummaryDetail`: the command, file, pattern or identifier a row names. */
fun toolSummaryDetail(name: String, input: JsonElement?, description: String?): String? {
    terminalToolCommand(name, input)?.let { return it }
    val args = input.obj
    (args?.get("file_path") ?: args?.get("target_file")).str?.trim()?.ifEmpty { null }?.let { return it }
    val files = patchChanges(input)?.keys?.toList().orEmpty()
    if (files.isNotEmpty()) return if (files.size == 1) files[0] else "${files[0]} +${files.size - 1}"
    (args?.get("path") ?: args?.get("target_directory")).str?.trim()?.ifEmpty { null }?.let { return it }
    args?.get("pattern").str?.trim()?.ifEmpty { null }?.let { return it }
    args?.get("url").str?.trim()?.ifEmpty { null }?.let { return it }
    val nested = args?.get("input").obj ?: args
    for (key in SUMMARY_KEYS) nested?.get(key).str?.trim()?.ifEmpty { null }?.let { return it }
    return description?.trim()?.ifEmpty { null }
}

private fun normalize(value: String) = value.trim().replace(Regex("\\s+"), " ").lowercase()

private val CAMEL = Regex("([a-z])([A-Z])")

/** `formatToolName`: `exec_command` → "Exec Command", `TaskCreate` → "Task Create". */
fun formatToolName(value: String): String = value
    .replace(Regex("[_-]+"), " ")
    .replace(CAMEL, "$1 $2")
    .trim()
    .split(Regex("\\s+"))
    .filter { it.isNotEmpty() }
    .joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }

/** `formatMCPTitle`: `mcp__linear__create_issue` → "MCP: Linear Create Issue". */
fun formatMcpTitle(name: String): String = "MCP: " + name.removePrefix("mcp__").split("__").joinToString(" ") { part ->
    part.split('_').filter { it.isNotEmpty() }.joinToString(" ") { w -> w.lowercase().replaceFirstChar(Char::uppercaseChar) }
}

private fun isGenericDescription(name: String, value: String?): Boolean {
    if (value == null) return false
    val n = normalize(value)
    return n == normalize(name) || n == normalize(formatToolName(name)) ||
        n == normalize("Running $name") || n == normalize("Running ${formatToolName(name)}")
}

private val GENERIC_DESCRIPTIONS = setOf(
    "terminal", "bash", "run command", "running command", "search", "web search", "read", "read file", "edit", "edit file",
    "write", "write file", "fetch url", "task",
)

private fun providerActivityDescription(name: String, description: String?, detail: String?): String? {
    val d = description?.trim()?.ifEmpty { null } ?: return null
    if (normalize(d) == normalize(detail ?: "")) return null
    val n = normalize(d)
    if (n == normalize(name) || n == normalize(formatToolName(name)) || n == normalize("Running $name") ||
        n == normalize("Running ${formatToolName(name)}") || n in GENERIC_DESCRIPTIONS
    ) {
        return null
    }
    return d
}

private fun activityAction(category: ToolCategory, name: String, text: ToolText): String = when (category) {
    ToolCategory.Terminal -> text.string(R.string.tool_group_ran)
    ToolCategory.Edit -> text.string(R.string.tool_group_edited)
    ToolCategory.Read -> text.string(R.string.tool_group_read)
    ToolCategory.Search -> text.string(R.string.tool_group_searched)
    ToolCategory.Web -> text.string(R.string.tool_group_fetched)
    ToolCategory.Task -> if (name == "Task" || name == "Agent") text.string(R.string.tool_group_ran_task) else formatToolName(name)
    ToolCategory.Other -> if (name.startsWith("mcp__")) formatMcpTitle(name) else formatToolName(name)
}

/** `getToolDisplayTitle`: the protocol title, the Happy Agent title, or the category's verb. */
fun toolDisplayTitle(tool: ToolCall, text: ToolText): String =
    tool.title?.trim()?.ifEmpty { null } ?: HappyToolDisplay[tool.name]?.second ?: activityAction(toolSummaryCategory(tool.name), tool.name, text)

/**
 * `getToolActivityLabel`: the command for terminal tools, a shell control's
 * own words, a provider description that adds something, else "Action:
 * detail".
 */
fun toolActivityLabel(tool: ToolCall, text: ToolText): String {
    terminalToolCommand(tool.name, tool.input)?.let { return it }
    shellControl(tool.name, tool.input)?.let { return it }
    val summary = toolSummaryDetail(tool.name, tool.input, null)
    val detail = if (isGenericDescription(tool.name, summary)) null else summary
    providerActivityDescription(tool.name, tool.description, detail)?.let { return it }
    val action = toolDisplayTitle(tool, text)
    if (detail == null || normalize(detail) == normalize(action)) return action
    return "$action: $detail"
}

private val TOOL_USE_ERROR = Regex("<tool_use_error>(.*?)</tool_use_error>", RegexOption.DOT_MATCHES_ALL)

/** `parseToolUseError`: the message inside `<tool_use_error>`, or null when there is none. */
fun parseToolUseError(message: String): String? = TOOL_USE_ERROR.find(message)?.groupValues?.get(1)?.trim()

/** A tool's result as text: strings as they are, anything else as JSON. */
fun resultText(result: JsonElement?): String? = when {
    result == null -> null
    result.str != null -> result.str
    else -> result.toString()
}
