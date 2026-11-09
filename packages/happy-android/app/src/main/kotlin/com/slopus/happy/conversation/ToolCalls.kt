package com.slopus.happy.conversation

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.Json as JsonFormat
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

// What a Happy Agent tool call is, read for its line and its own screen
// (iOS ToolDetail): what kind of thing it did, by its presentation or else
// its name as the vendors' tools and Happy's modules name them
// (happy-providers vendors/*/tools, happy-agent-modules), and its raw
// arguments and result as fields a person reads. Never vendor JSON shown
// first: raw JSON is only ever the last thing on the page.

/** What a call's line says from its arguments, where no presentation does. */
@Immutable
sealed interface ToolHint {
    /** A plan update: [done] of [total] steps finished. */
    data class Plan(val done: Int, val total: Int) : ToolHint

    /** A page read: its address without the scheme. */
    data class Fetch(val url: String) : ToolHint

    companion object {
        fun of(call: Block.ToolCall): ToolHint? {
            if (call.presentation != null) return null
            return when (ToolKind.of(call.name, null)) {
                ToolKind.Plan -> ToolPlan.of(call.name, call.arguments)?.let { plan -> Plan(plan.items.count { it.status == ToolPlan.Status.Done }, plan.items.size) }
                ToolKind.WebPage -> call.arguments.obj?.get("url").str?.let { Fetch(it.replace(Regex("^https?://"), "").trimEnd('/')) }
                else -> null
            }
        }
    }
}

/**
 * What kind of thing a call did, which titles its screen and picks its
 * body (desktop ToolCallPreview `presentationTitle`, iOS `ToolDetail.Kind`).
 */
enum class ToolKind {
    Terminal, FileEdit, Exploration, Search, WebPage, Subagent, Plan, Message, Question, Media, Artifact, ToolCall;

    companion object {
        private val PLAN = setOf("update_plan", "todo_write", "TodoWrite")
        private val SUBAGENT = setOf("Agent", "Task", "spawn_agent", "spawn_subagent", "create_agent")
        private val WEB_PAGE = setOf("web_fetch", "WebFetch")
        private val MESSAGE = setOf("send_agent_message", "send_message", "SendMessage", "send_bot_message", "followup_task")
        private val QUESTION = setOf(com.slopus.happy.conversation.Question.TOOL_NAME, "AskUserQuestion", "ask_user_question")
        private val TERMINAL = setOf("Bash", "exec_command", "exec", "run_terminal_command", "write_stdin", "send_command_input", "TaskInput")
        private val FILE_EDIT = setOf("Edit", "Write", "apply_patch", "search_replace", "write", "MultiEdit")
        private val EXPLORATION = setOf("Read", "read_file", "view_image", "list_dir", "Glob", "Grep", "grep")
        private val SEARCH = setOf("web_search", "WebSearch", "x_search", "bedrock_web_search", "claude_web_search", "codex_web_search", "gemini_web_search", "grok_web_search", "grok_x_search")

        fun of(name: String, presentation: Presentation?): ToolKind = when (presentation) {
            is Presentation.Command, is Presentation.Terminal -> Terminal
            is Presentation.FileDiff -> FileEdit
            is Presentation.Exploration -> Exploration
            is Presentation.Search -> Search
            is Presentation.AgentSpawn -> Subagent
            is Presentation.Media -> Media
            is Presentation.Artifact -> Artifact
            is Presentation.UserInput -> Question
            is Presentation.Ui -> ToolCall
            null -> when (name) {
                in PLAN -> Plan
                in SUBAGENT -> Subagent
                in WEB_PAGE -> WebPage
                in MESSAGE -> Message
                in QUESTION -> Question
                in TERMINAL -> Terminal
                in FILE_EDIT -> FileEdit
                in EXPLORATION -> Exploration
                in SEARCH -> Search
                else -> ToolCall
            }
        }
    }
}

/** A plan a call wrote (`update_plan`, `todo_write`, `TodoWrite`), its steps in order. */
data class ToolPlan(val explanation: String?, val items: List<Item>) {
    enum class Status { Pending, Active, Done, Cancelled }

    data class Item(val text: String, val status: Status)

    companion object {
        fun of(name: String, arguments: JsonElement?): ToolPlan? {
            val args = arguments.obj ?: return null
            val steps = args["plan"].arr ?: args["todos"].arr ?: return null
            val items = steps.mapNotNull { value ->
                val step = value.obj ?: return@mapNotNull null
                val text = step["step"].str ?: step["content"].str ?: step["subject"].str ?: step["id"].str ?: return@mapNotNull null
                Item(text, status(step["status"].str))
            }
            if (name != "update_plan" && items.isEmpty()) return null
            return ToolPlan(args["explanation"].str?.takeIf { it.isNotBlank() }, items)
        }

        private fun status(value: String?): Status = when (value) {
            "completed", "done" -> Status.Done
            "in_progress", "active" -> Status.Active
            "cancelled", "canceled" -> Status.Cancelled
            else -> Status.Pending
        }
    }
}

/** A subagent a call started: what it is called, the model, and the work it was given. */
data class ToolSubagent(val title: String?, val model: String?, val prompt: String?) {
    companion object {
        /** The keys this view shows; the rest of the arguments follow as fields. */
        val SHOWN = setOf("title", "description", "task_name", "model", "text", "prompt", "message")

        fun of(arguments: JsonElement?): ToolSubagent? {
            val args = arguments.obj ?: return null
            val subagent = ToolSubagent(
                title = args["title"].str ?: args["description"].str ?: args["task_name"].str,
                model = args["model"].str,
                prompt = args["prompt"].str ?: args["text"].str ?: args["message"].str,
            )
            return subagent.takeIf { it.title != null || it.prompt != null }
        }
    }
}

/** A message a call sent another agent: to whom and what. */
data class ToolMessage(val to: String?, val text: String) {
    companion object {
        val SHOWN = setOf("toAgentId", "target", "to", "recipient", "agentId", "botId", "text", "message", "content")

        fun of(arguments: JsonElement?): ToolMessage? {
            val args = arguments.obj ?: return null
            val text = args["text"].str ?: args["message"].str ?: args["content"].str ?: return null
            return ToolMessage(args["toAgentId"].str ?: args["target"].str ?: args["to"].str ?: args["recipient"].str ?: args["agentId"].str ?: args["botId"].str, text)
        }
    }
}

/**
 * One value of a call's raw data, as a person reads it (iOS
 * `ToolFields`): words inline, long or many-line text as a block, lists as
 * bullets, an object as fields (its known keys first), and anything deeper
 * than [ToolValue.MAX_DEPTH] as indented JSON.
 */
@Immutable
sealed interface ToolValue {
    /** Short words; [mono] for paths, ids and commands, [link] for an http(s) address. */
    data class Text(val text: String, val mono: Boolean = false, val link: Boolean = false) : ToolValue

    /** Long or many-line text, in a block of its own. */
    data class Block(val text: String, val mono: Boolean = false) : ToolValue

    data class Items(val items: List<ToolValue>) : ToolValue

    data class Fields(val fields: List<Field>) : ToolValue

    /** Indented JSON: what is too deep or too odd to read as fields. */
    data class Json(val text: String) : ToolValue

    /** Nothing at all: null, an empty string, list or object. */
    data object Empty : ToolValue

    /** One key and its value; [label] is the key in words ("file_path" is "File path"). */
    data class Field(val key: String, val label: String, val value: ToolValue)

    companion object {
        const val MAX_DEPTH = 2
        private const val INLINE = 120
        private val FIRST = listOf("title", "name", "description", "path", "file_path", "filePath", "command", "cmd", "url", "query", "pattern")
        private val MONO = Regex("(^|_)(path|paths|file|files|dir|cwd|id|ids|command|cmd|pattern|glob|regex|sha|hash|ref|branch)$|(Path|Id|Ids|Command|File)$", RegexOption.IGNORE_CASE)
        private val pretty = JsonFormat { prettyPrint = true; prettyPrintIndent = "  " }

        /** A call's arguments as fields; null where it had none. */
        fun of(value: JsonElement?): ToolValue? = value?.let { read(it, null, 0) }?.takeIf { it != Empty }

        /**
         * A call's result: its `output` when that is all it says, an MCP
         * text content's words, and JSON written as a string read as JSON.
         */
        fun result(value: JsonElement?): ToolValue? = of(unwrap(value ?: return null))

        /** The result as its words, unwrapped as [result] does; null where it isn't words. */
        fun resultText(value: JsonElement?): String? = (unwrap(value ?: return null) as? JsonPrimitive)?.takeIf { it.isString }?.content

        internal fun unwrap(value: JsonElement): JsonElement {
            var current = value
            repeat(3) {
                val o = current as? JsonObject
                current = when {
                    o != null && o.size == 1 && o.keys.single() in setOf("output", "content", "text", "result") -> o.values.single()
                    // MCP: [{type: "text", text}] reads as its words.
                    current is JsonArray && (current as JsonArray).isNotEmpty() && (current as JsonArray).all { it.obj?.get("type").str == "text" } ->
                        JsonPrimitive((current as JsonArray).joinToString("\n") { it.obj?.get("text").str.orEmpty() })
                    current is JsonPrimitive && (current as JsonPrimitive).isString -> parsedJson((current as JsonPrimitive).content) ?: return current
                    else -> return current
                }
            }
            return current
        }

        private fun parsedJson(text: String): JsonElement? {
            val trimmed = text.trim()
            if (!(trimmed.startsWith("{") && trimmed.endsWith("}")) && !(trimmed.startsWith("[") && trimmed.endsWith("]"))) return null
            return runCatching { JsonFormat.parseToJsonElement(trimmed) }.getOrNull()
        }

        private fun read(value: JsonElement, key: String?, depth: Int): ToolValue = when (value) {
            is JsonNull -> Empty
            is JsonPrimitive -> primitive(value, key)
            is JsonArray -> when {
                value.isEmpty() -> Empty
                depth >= MAX_DEPTH -> Json(pretty.encodeToString(JsonElement.serializer(), value))
                // A list of words reads as bullets; a list of records as one card each.
                else -> Items(value.map { read(it, key, depth + 1) })
            }
            is JsonObject -> when {
                value.isEmpty() -> Empty
                depth >= MAX_DEPTH -> Json(pretty.encodeToString(JsonElement.serializer(), value))
                else -> Fields(
                    value.entries
                        .sortedWith(compareBy<Map.Entry<String, JsonElement>>({ FIRST.indexOf(it.key).let { i -> if (i < 0) FIRST.size else i } }, { it.key.lowercase() }))
                        .map { (k, v) -> Field(k, label(k), read(v, k, depth + 1)) }
                        .filter { it.value != Empty },
                ).takeIf { it.fields.isNotEmpty() } ?: Empty
            }
        }

        private fun primitive(value: JsonPrimitive, key: String?): ToolValue {
            if (!value.isString) {
                value.booleanOrNull?.let { return Text(it.toString()) }
                value.doubleOrNull?.let { return Text(value.content) }
                return Text(value.content)
            }
            val text = value.content
            if (text.isEmpty()) return Empty
            val mono = key != null && MONO.containsMatchIn(key)
            if (text.length > INLINE || '\n' in text) return Block(text, mono)
            val link = Regex("^https?://\\S+$").matches(text)
            return Text(text, mono = mono && !link, link = link)
        }

        /** A key in words: `file_path` and `filePath` are "File path". */
        fun label(key: String): String {
            val words = key
                .replace(Regex("[_-]+"), " ")
                .replace(Regex("([a-z0-9])([A-Z])"), "$1 $2")
                .trim()
                .lowercase()
            return words.replaceFirstChar { it.uppercaseChar() }.ifEmpty { key }
        }
    }
}

/**
 * The hunks a `file_diff` presentation sent, as a unified patch the diff
 * renderer reads: no line is diffed here, the daemon's lines are drawn as
 * they came, numbered from each hunk's starts.
 */
object ToolPatch {
    fun of(file: Presentation.FileDiff.File): String = buildString {
        val path = file.path
        append("diff --git a/").append(path).append(" b/").append(path).append('\n')
        when (file.kind) {
            "add" -> append("new file mode 100644\n--- /dev/null\n+++ b/").append(path).append('\n')
            "delete" -> append("deleted file mode 100644\n--- a/").append(path).append("\n+++ /dev/null\n")
            else -> append("--- a/").append(path).append("\n+++ b/").append(path).append('\n')
        }
        for (hunk in file.hunks) {
            val old = hunk.lines.count { it.kind != "add" }
            val new = hunk.lines.count { it.kind != "delete" }
            append("@@ -").append(hunk.oldStart).append(',').append(old)
                .append(" +").append(hunk.newStart).append(',').append(new).append(" @@\n")
            for (line in hunk.lines) {
                append(
                    when (line.kind) {
                        "add" -> '+'
                        "delete" -> '-'
                        else -> ' '
                    },
                )
                // A line holds no newline of its own; one that does would split the hunk.
                append(line.text.replace("\r", "").replace('\n', ' ')).append('\n')
            }
        }
    }
}

/** A tool call as a conversation holds it, with the run it is in and the run after it, which find it in history. */
data class LocatedCall(val call: Block.ToolCall, val runId: String?, val nextRunId: String?)

/**
 * Reads one tool call whole from history (`omitToolData=false`): the run
 * it is in when known (the page just before the run after it, or the
 * newest), else back from the newest a page at a time.
 */
class ToolCallReader(private val api: ConversationApi, private val agentId: String) {
    suspend fun read(callId: String, located: LocatedCall? = null): Block.ToolCall? {
        if (located?.runId != null) {
            val page = api.messages(agentId, before = located.nextRunId, limit = 1, omitToolData = false)
            page.runs.firstOrNull { it.id == located.runId }?.let { run -> find(run, callId)?.let { return it } }
        }
        var before: String? = null
        repeat(MAX_PAGES) {
            val page = api.messages(agentId, before = before, limit = PAGE, omitToolData = false)
            for (run in page.runs.asReversed()) find(run, callId)?.let { return it }
            if (!page.hasMore) return null
            before = page.runs.firstOrNull()?.id ?: return null
        }
        return null
    }

    private fun find(run: Run, callId: String): Block.ToolCall? =
        run.messages.firstNotNullOfOrNull { message -> message.content.firstOrNull { it is Block.ToolCall && it.id == callId } as? Block.ToolCall }

    private companion object {
        const val PAGE = 50
        const val MAX_PAGES = 6
    }
}
