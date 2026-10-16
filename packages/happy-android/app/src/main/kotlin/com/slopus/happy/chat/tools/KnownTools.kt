package com.slopus.happy.chat.tools

import com.slopus.happy.R
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ToolCall
import com.slopus.happy.chat.ToolState
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonElement
import java.net.URI

// components/tools/knownTools.tsx: what the chat knows about each tool by
// name. The zod input schemas live with the views that read them.

/** The glyph a tool row shows; the UI maps it to an icon font. */
enum class ToolIcon { Task, Terminal, Search, Read, Edit, Web, Exit, Todo, Reasoning, Question, Mcp, Construct }

/** What a known tool's callbacks see. [path]/[homeDir] are the session's, for `resolvePath`. */
class ToolContext(
    val tool: ToolCall,
    val text: ToolText,
    val path: String? = null,
    val children: List<ChatMessage> = emptyList(),
) {
    val input: Map<String, JsonElement>? get() = tool.input.obj
    fun str(key: String): String? = input?.get(key).str
    fun resolve(p: String): String = resolvePath(p, path)
}

class KnownTool(
    val icon: ToolIcon,
    val title: ((ToolContext) -> String)? = null,
    val subtitle: ((ToolContext) -> String?)? = null,
    val status: ((ToolContext) -> String?)? = null,
    val minimal: (ToolContext) -> Boolean = { false },
    val hidden: Boolean = false,
    val noStatus: Boolean = false,
    val hideDefaultError: Boolean = false,
    /** Can change files: unknown tools count as mutable. */
    val isMutable: Boolean = false,
)

/**
 * pathUtils.ts `resolvePath`: a path inside the session's folder reads
 * relative to it (`<root>` for the folder itself); others stay as they are.
 */
fun resolvePath(path: String, root: String?): String {
    if (root == null) return path
    if (!path.lowercase().startsWith(root.lowercase())) return path
    val remainder = path.substring(root.length)
    if (remainder.isNotEmpty() && !remainder.startsWith("/")) return path
    val out = remainder.removePrefix("/")
    return out.ifEmpty { "<root>" }
}

private fun basename(path: String) = path.substringAfterLast('/').ifEmpty { path }

private fun patchSubtitle(ctx: ToolContext): String? {
    val files = patchChanges(ctx.tool.input)?.keys?.toList().orEmpty()
    if (files.isEmpty()) return null
    val name = basename(ctx.resolve(files[0]))
    return if (files.size > 1) ctx.text.string(R.string.tools_desc_modifying_multiple_files, name, files.size - 1) else name
}

private fun hostOf(url: String): String? = runCatching { URI(url).host }.getOrNull()?.ifEmpty { null }

private val taskLike = KnownTool(
    icon = ToolIcon.Task,
    title = { ctx -> ctx.str("description") ?: ctx.text.string(R.string.tools_names_task) },
    isMutable = true,
    minimal = { ctx ->
        ctx.children.none { it is ChatMessage.ToolCallMessage && it.tool.state in setOf(ToolState.Running, ToolState.Completed, ToolState.Error) }
    },
)

private fun reasoning() = KnownTool(
    icon = ToolIcon.Reasoning,
    title = { ctx -> ctx.str("title") ?: ctx.text.string(R.string.tools_names_reasoning) },
    hidden = true,
    minimal = { true },
)

private val planProposal = KnownTool(icon = ToolIcon.Exit, title = { it.text.string(R.string.tools_names_plan_proposal) })

private val applyChanges = KnownTool(
    icon = ToolIcon.Edit,
    title = { it.text.string(R.string.tools_names_apply_changes) },
    subtitle = ::patchSubtitle,
    hideDefaultError = true,
    isMutable = true,
)

private val viewDiff = KnownTool(
    icon = ToolIcon.Edit,
    title = { it.text.string(R.string.tools_names_view_diff) },
    subtitle = { ctx ->
        ctx.str("filePath")?.let(::basename) ?: ctx.str("unified_diff")?.lineSequence()
            ?.firstOrNull { it.startsWith("+++ ") }
            ?.removePrefix("+++ ")?.removePrefix("b/")?.let(::basename)
    },
    hideDefaultError = true,
    noStatus = true,
)

private fun firstQuestion(input: JsonElement?): Map<String, JsonElement>? {
    val o = input.obj ?: return null
    val inner = o["input"].obj ?: o
    return inner["questions"].arr?.firstOrNull().obj ?: inner
}

val KnownTools: Map<String, KnownTool> = mapOf(
    "Task" to taskLike,
    "Agent" to taskLike,
    "Bash" to KnownTool(
        icon = ToolIcon.Terminal,
        title = { ctx -> ctx.tool.description ?: ctx.text.string(R.string.tools_names_terminal) },
        subtitle = { it.str("command") },
        minimal = { true },
        hideDefaultError = true,
        isMutable = true,
    ),
    "Glob" to KnownTool(
        icon = ToolIcon.Search,
        title = { ctx -> ctx.str("pattern") ?: ctx.text.string(R.string.tools_names_search_files) },
        minimal = { true },
    ),
    "Grep" to KnownTool(
        icon = ToolIcon.Read,
        title = { ctx -> ctx.str("pattern")?.let { "grep(pattern: $it)" } ?: "Search Content" },
        minimal = { true },
    ),
    "LS" to KnownTool(
        icon = ToolIcon.Search,
        title = { ctx -> ctx.str("path")?.let(ctx::resolve) ?: ctx.text.string(R.string.tools_names_list_files) },
        minimal = { true },
    ),
    "ExitPlanMode" to planProposal,
    "exit_plan_mode" to planProposal,
    "Read" to KnownTool(
        icon = ToolIcon.Read,
        title = { ctx ->
            ctx.str("file_path")?.let(ctx::resolve)
                ?: ctx.input?.get("locations").arr?.firstOrNull().obj?.get("path").str?.let(ctx::resolve)
                ?: ctx.text.string(R.string.tools_names_read_file)
        },
        minimal = { true },
    ),
    "read" to KnownTool(
        icon = ToolIcon.Read,
        title = { ctx ->
            ctx.input?.get("locations").arr?.firstOrNull().obj?.get("path").str?.let(ctx::resolve)
                ?: ctx.str("file_path")?.let(ctx::resolve)
                ?: ctx.text.string(R.string.tools_names_read_file)
        },
        minimal = { true },
    ),
    "Edit" to KnownTool(
        icon = ToolIcon.Edit,
        title = { ctx -> ctx.str("file_path")?.let(ctx::resolve) ?: ctx.text.string(R.string.tools_names_edit_file) },
        isMutable = true,
    ),
    "MultiEdit" to KnownTool(
        icon = ToolIcon.Edit,
        title = { ctx ->
            val path = ctx.str("file_path")?.let(ctx::resolve)
            val count = ctx.input?.get("edits").arr?.size ?: 0
            when {
                path == null -> ctx.text.string(R.string.tools_names_edit_file)
                count > 1 -> ctx.text.plural(R.plurals.tools_desc_multi_edit_edits, count, path, count)
                else -> path
            }
        },
        status = { ctx ->
            val path = ctx.str("file_path")?.let(ctx::resolve)
            val count = ctx.input?.get("edits").arr?.size ?: 0
            when {
                path == null -> null
                count > 0 -> ctx.text.plural(R.plurals.tools_desc_multi_edit_edits, count, path, count)
                else -> path
            }
        },
        isMutable = true,
    ),
    "Write" to KnownTool(
        icon = ToolIcon.Edit,
        title = { ctx -> ctx.str("file_path")?.let(ctx::resolve) ?: ctx.text.string(R.string.tools_names_write_file) },
        isMutable = true,
    ),
    "WebFetch" to KnownTool(
        icon = ToolIcon.Web,
        title = { ctx -> ctx.str("url")?.let(::hostOf) ?: ctx.text.string(R.string.tools_names_fetch_url) },
        minimal = { true },
    ),
    "NotebookRead" to KnownTool(
        icon = ToolIcon.Read,
        title = { ctx -> ctx.str("notebook_path")?.let(ctx::resolve) ?: ctx.text.string(R.string.tools_names_read_notebook) },
        minimal = { true },
    ),
    "NotebookEdit" to KnownTool(
        icon = ToolIcon.Edit,
        title = { ctx -> ctx.str("notebook_path")?.let(ctx::resolve) ?: ctx.text.string(R.string.tools_names_edit_notebook) },
        isMutable = true,
    ),
    "TodoWrite" to KnownTool(
        icon = ToolIcon.Todo,
        title = { it.text.string(R.string.tools_names_todo_list) },
        noStatus = true,
        minimal = { ctx ->
            val inputTodos = ctx.input?.get("todos").arr?.size ?: 0
            val resultTodos = ctx.tool.result.obj?.get("newTodos").arr?.size ?: 0
            inputTodos == 0 && resultTodos == 0
        },
    ),
    "WebSearch" to KnownTool(
        icon = ToolIcon.Web,
        title = { ctx -> ctx.str("query") ?: ctx.text.string(R.string.tools_names_web_search) },
        minimal = { true },
    ),
    "CodexBash" to KnownTool(
        icon = ToolIcon.Terminal,
        title = { ctx ->
            val parsed = ctx.input?.get("parsed_cmd").arr
            val single = parsed?.singleOrNull().obj
            val name = single?.get("name").str
            if (single?.get("type").str == "read" && name != null) ctx.resolve(name) else ctx.text.string(R.string.tools_names_terminal)
        },
        subtitle = { ctx ->
            val parsed = ctx.input?.get("parsed_cmd").arr
            val single = parsed?.singleOrNull().obj
            val firstCmd = parsed?.firstOrNull().obj?.get("cmd").str
            val singleCmd = single?.get("cmd").str
            when {
                single?.get("type").str == "read" && singleCmd != null -> if (singleCmd.length > 50) singleCmd.take(50) + "..." else singleCmd
                firstCmd != null -> firstCmd
                else -> stringifyToolCommand(ctx.input?.get("command"))
            }
        },
        minimal = { true },
        hideDefaultError = true,
        isMutable = true,
    ),
    "CodexReasoning" to reasoning(),
    "GeminiReasoning" to reasoning(),
    "think" to reasoning(),
    "change_title" to KnownTool(icon = ToolIcon.Edit, title = { "Change Title" }, hidden = true, minimal = { true }, noStatus = true),
    "search" to KnownTool(icon = ToolIcon.Search, title = { it.text.string(R.string.tools_names_search) }, minimal = { true }),
    "edit" to KnownTool(
        icon = ToolIcon.Edit,
        title = { ctx ->
            val toolCall = ctx.input?.get("toolCall").obj
            val contentPath = toolCall?.get("content").arr?.firstOrNull().obj?.get("path").str
            val toolCallTitle = toolCall?.get("title").str
            val path = when {
                contentPath != null -> contentPath
                toolCallTitle != null -> return@KnownTool toolCallTitle
                else -> ctx.input?.get("input").arr?.firstOrNull().obj?.get("path").str ?: ctx.str("path")
            }
            path?.let(ctx::resolve) ?: ctx.text.string(R.string.tools_names_edit_file)
        },
        isMutable = true,
    ),
    "shell" to KnownTool(icon = ToolIcon.Terminal, title = { it.text.string(R.string.tools_names_terminal) }, minimal = { true }, isMutable = true),
    "execute" to KnownTool(
        icon = ToolIcon.Terminal,
        title = { ctx ->
            val title = ctx.input?.get("toolCall").obj?.get("title").str
            if (title != null) {
                val bracket = title.indexOf(" [")
                if (bracket > 0) title.substring(0, bracket) else title
            } else {
                ctx.text.string(R.string.tools_names_terminal)
            }
        },
        subtitle = { ctx ->
            ctx.input?.get("toolCall").obj?.get("title").str?.let { Regex("""\(([^)]+)\)$""").find(it)?.groupValues?.get(1) }
        },
        minimal = { ctx ->
            val title = ctx.input?.get("toolCall").obj?.get("title").str
            val command = ctx.input?.get("command")
            !(title?.isNotBlank() == true || command.str?.isNotBlank() == true || command.arr?.any { it.str?.isNotBlank() == true } == true)
        },
        isMutable = true,
    ),
    "CodexPatch" to applyChanges,
    "apply_patch" to applyChanges,
    "GeminiBash" to KnownTool(
        icon = ToolIcon.Terminal,
        title = { it.text.string(R.string.tools_names_terminal) },
        subtitle = { stringifyToolCommand(it.input?.get("command")) },
        minimal = { true },
        hideDefaultError = true,
        isMutable = true,
    ),
    "GeminiPatch" to KnownTool(
        icon = ToolIcon.Edit,
        title = { it.text.string(R.string.tools_names_apply_changes) },
        subtitle = ::patchSubtitle,
        minimal = { true },
        hideDefaultError = true,
        isMutable = true,
    ),
    "CodexDiff" to viewDiff,
    "GeminiDiff" to viewDiff,
    "AskUserQuestion" to KnownTool(
        icon = ToolIcon.Question,
        title = { ctx ->
            ctx.input?.get("questions").arr?.firstOrNull().obj?.get("header").str ?: ctx.text.string(R.string.tools_names_question)
        },
        subtitle = { ctx ->
            val questions = ctx.input?.get("questions").arr ?: return@KnownTool null
            if (questions.size == 1) questions[0].obj?.get("question").str
            else ctx.text.plural(R.plurals.tools_ask_user_question_multiple_questions, questions.size, questions.size)
        },
        noStatus = true,
    ),
    "request_user_input" to KnownTool(
        icon = ToolIcon.Question,
        title = { ctx -> firstQuestion(ctx.tool.input)?.get("header").str ?: ctx.text.string(R.string.tools_names_question) },
        subtitle = { ctx -> firstQuestion(ctx.tool.input)?.get("question").str },
        noStatus = true,
    ),
    "Skill" to KnownTool(icon = ToolIcon.Task, hidden = true, minimal = { true }),
    "ToolSearch" to KnownTool(icon = ToolIcon.Search, hidden = true),
    "tool_search" to KnownTool(icon = ToolIcon.Search, hidden = true),
)

/** `isMutableTool`: unknown tools are assumed to change things. */
fun isMutableTool(name: String): Boolean = KnownTools[name]?.isMutable ?: true

/** `getToolCategoryIcon`: the icon for a tool without its own entry. */
fun toolCategoryIcon(category: ToolCategory): ToolIcon? = when (category) {
    ToolCategory.Terminal -> ToolIcon.Terminal
    ToolCategory.Read -> ToolIcon.Read
    ToolCategory.Edit -> ToolIcon.Edit
    ToolCategory.Search -> ToolIcon.Search
    ToolCategory.Web -> ToolIcon.Web
    ToolCategory.Task -> ToolIcon.Task
    ToolCategory.Other -> null
}
