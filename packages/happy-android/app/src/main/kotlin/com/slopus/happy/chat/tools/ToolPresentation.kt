package com.slopus.happy.chat.tools

import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.PermissionStatus
import com.slopus.happy.chat.ToolState
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str

// ToolView.tsx's decisions, apart from drawing: what a tool call is called,
// which glyph and status it shows, and whether it is a one-line activity row
// or a card with its own view.

/** The tools with an inline view in the chat (views/_all.tsx `toolViewRegistry`). */
enum class ToolViewKind { Edit, Bash, CodexBash, CodexPatch, CodexDiff, Write, Todo, ExitPlan, MultiEdit, Task, AskUserQuestion, RequestUserInput, GeminiEdit, GeminiExecute, File }

val ToolViewRegistry: Map<String, ToolViewKind> = mapOf(
    "Edit" to ToolViewKind.Edit,
    "Bash" to ToolViewKind.Bash,
    "CodexBash" to ToolViewKind.CodexBash,
    "CodexPatch" to ToolViewKind.CodexPatch,
    "CodexDiff" to ToolViewKind.CodexDiff,
    "Write" to ToolViewKind.Write,
    "write" to ToolViewKind.Write,
    "search_replace" to ToolViewKind.Edit,
    "TodoWrite" to ToolViewKind.Todo,
    "ExitPlanMode" to ToolViewKind.ExitPlan,
    "exit_plan_mode" to ToolViewKind.ExitPlan,
    "MultiEdit" to ToolViewKind.MultiEdit,
    "Task" to ToolViewKind.Task,
    "Agent" to ToolViewKind.Task,
    "AskUserQuestion" to ToolViewKind.AskUserQuestion,
    "request_user_input" to ToolViewKind.RequestUserInput,
    "edit" to ToolViewKind.GeminiEdit,
    "execute" to ToolViewKind.GeminiExecute,
    "GeminiDiff" to ToolViewKind.CodexDiff,
    "GeminiPatch" to ToolViewKind.CodexPatch,
    "apply_patch" to ToolViewKind.CodexPatch,
    "file" to ToolViewKind.File,
)

enum class ToolStatusIcon { None, Running, Error, Removed }

/** Everything ToolView.tsx works out before it draws. */
data class ToolPresentation(
    val icon: ToolIcon,
    /** The construct and MCP glyphs are drawn secondary; the rest in the text colour. */
    val iconSecondary: Boolean,
    val title: String,
    val status: String?,
    val description: String?,
    val statusIcon: ToolStatusIcon,
    /** One-line activity row instead of a card. */
    val compact: Boolean,
    val activityLabel: String,
    val view: ToolViewKind?,
    val renderCardHeader: Boolean,
    val hideDefaultError: Boolean,
    val isToolUseError: Boolean,
    /** Pending approval of a tool with no view of its own: the card shows the raw arguments. */
    val needsApprovalInput: Boolean,
)

/**
 * ToolView.tsx: null for hidden tools. [flavor] is the session's agent
 * (`gemini` makes unknown tools minimal); [path] its folder, for titles.
 */
fun presentTool(message: ChatMessage.ToolCallMessage, text: ToolText, compactToolCalls: Boolean, flavor: String?, path: String?): ToolPresentation? {
    val tool = message.tool
    val known = KnownTools[tool.name]
    if (known?.hidden == true) return null
    val ctx = ToolContext(tool, text, path, message.children)

    val categoryIcon = toolCategoryIcon(toolSummaryCategory(tool.name))
    var icon = categoryIcon ?: ToolIcon.Construct
    var iconSecondary = categoryIcon == null
    var minimal = known == null && flavor == "gemini"
    val status = known?.status?.invoke(ctx)?.ifEmpty { null }
    var title = toolDisplayTitle(tool, text)
    if (tool.name.startsWith("mcp__")) {
        title = formatMcpTitle(tool.name)
        icon = ToolIcon.Mcp
        iconSecondary = true
        minimal = true
    } else if (known?.title != null) {
        title = known.title.invoke(ctx)
    }
    val description = known?.subtitle?.invoke(ctx)?.ifEmpty { null }
    if (known != null) minimal = known.minimal(ctx)

    val parsed = tool.input.obj?.get("parsed_cmd").arr?.firstOrNull().obj
    if (tool.name == "CodexBash" && parsed != null) {
        icon = when (parsed["type"].str) {
            "read" -> ToolIcon.Read
            "write" -> ToolIcon.Edit
            else -> ToolIcon.Terminal
        }
        iconSecondary = false
    } else if (known != null) {
        icon = known.icon
        iconSecondary = false
    }
    val noStatus = known?.noStatus ?: false
    var hideDefaultError = known?.hideDefaultError ?: false

    val isToolUseError = tool.state == ToolState.Error && tool.result.str?.let(::parseToolUseError) != null
    val permissionStatus = tool.permission?.status
    val statusIcon = when {
        permissionStatus == PermissionStatus.Denied || permissionStatus == PermissionStatus.Canceled -> ToolStatusIcon.Removed
        isToolUseError -> {
            hideDefaultError = true
            minimal = true
            ToolStatusIcon.Removed
        }
        tool.state == ToolState.Running -> if (noStatus) ToolStatusIcon.None else ToolStatusIcon.Running
        tool.state == ToolState.Error -> ToolStatusIcon.Error
        else -> ToolStatusIcon.None
    }

    val view = ToolViewRegistry[tool.name]
    val needsApprovalInput = permissionStatus == PermissionStatus.Pending && view == null
    val compact = !needsApprovalInput &&
        (shouldUseCompactToolRow(tool, compactToolCalls, view != null) || minimal || terminalToolCommand(tool.name, tool.input) != null)
    return ToolPresentation(
        icon = icon,
        iconSecondary = iconSecondary,
        title = title,
        status = status,
        description = description,
        statusIcon = statusIcon,
        compact = compact,
        activityLabel = toolActivityLabel(tool, text),
        view = view,
        renderCardHeader = compact || shouldRenderToolCardHeader(tool.name),
        hideDefaultError = hideDefaultError,
        isToolUseError = isToolUseError,
        needsApprovalInput = needsApprovalInput,
    )
}

/** A tool call's todos (TodoView.tsx): the result's `newTodos`, else the input's `todos`. */
data class TodoItem(val content: String, val status: String, val id: String?)

fun todoItems(message: ChatMessage.ToolCallMessage): List<TodoItem> {
    fun read(list: List<kotlinx.serialization.json.JsonElement>?): List<TodoItem>? = list?.mapNotNull { e ->
        val o = e.obj ?: return@mapNotNull null
        val content = o["content"].str ?: return@mapNotNull null
        TodoItem(content, o["status"].str ?: "pending", o["id"].str)
    }
    val fromResult = read(message.tool.result.obj?.get("newTodos").arr)
    if (!fromResult.isNullOrEmpty()) return fromResult
    return read(message.tool.input.obj?.get("todos").arr).orEmpty()
}

/** TaskView.tsx: a sub-agent's started tools, hidden ones left out, with their activity labels. */
fun taskChildTools(message: ChatMessage.ToolCallMessage, text: ToolText): List<Pair<String, ToolState>> =
    message.children.mapNotNull { child ->
        if (child !is ChatMessage.ToolCallMessage) return@mapNotNull null
        if (KnownTools[child.tool.name]?.hidden == true) return@mapNotNull null
        val state = child.tool.state
        if (state != ToolState.Running && state != ToolState.Completed && state != ToolState.Error) return@mapNotNull null
        toolActivityLabel(child.tool, text) to state
    }
