package com.slopus.happy.conversation

import com.slopus.happy.chat.arr
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.long
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// A Happy Agent conversation as its API sends it (happy-agent API.md,
// "Agents", "Messages and runs", "Questions", "Bootstrap"). Read by hand
// from JSON: roles, blocks and presentations grow with the daemon, and
// anything this build doesn't know is skipped, never an error.

/** The model, account and permission mode a message runs with. */
data class Mode(
    val providerId: String,
    val modelId: String,
    val effort: String,
    val serviceTier: String?,
    val permissionMode: String,
) {
    /** The wire object; `serviceTier` is required, `null` included. */
    fun json(): JsonObject = buildJsonObject {
        put("providerId", providerId)
        put("modelId", modelId)
        put("effort", effort)
        put("serviceTier", serviceTier?.let(::JsonPrimitive) ?: JsonNull)
        put("permissionMode", permissionMode)
    }

    companion object {
        fun parse(value: JsonElement?): Mode? {
            val o = value.obj ?: return null
            return Mode(
                providerId = o["providerId"].str ?: return null,
                modelId = o["modelId"].str ?: return null,
                effort = o["effort"].str ?: return null,
                serviceTier = o["serviceTier"].str,
                permissionMode = o["permissionMode"].str ?: return null,
            )
        }
    }
}

/** One picture, video or file a tool call presented (`presentation.items[]`). */
data class MediaItem(
    val kind: String,
    val name: String,
    val mimeType: String,
    val width: Double? = null,
    val height: Double? = null,
    /** Pixels per point of a capture (2 for a retina screenshot): it is never drawn past [width] / [scale]. */
    val scale: Double? = null,
    /** The picture's ThumbHash, base64: its shape before the bytes come. */
    val thumbhash: String? = null,
    /** Its length in bytes, when stated: a recording streams by range from it. */
    val size: Double? = null,
) {
    val isVisual: Boolean get() = kind == "image" || kind == "video"

    companion object {
        fun parse(value: JsonElement?): MediaItem? {
            val o = value.obj ?: return null
            return MediaItem(
                kind = o["kind"].str ?: return null,
                name = o["name"].str.orEmpty(),
                mimeType = o["mimeType"].str.orEmpty(),
                width = o["width"].num,
                height = o["height"].num,
                scale = o["scale"].num,
                thumbhash = o["thumbhash"].str,
                size = o["size"].num,
            )
        }
    }
}

/** What a tool call showed the person (`presentation`), when the daemon typed it. */
sealed interface Presentation {
    data class Command(val command: String, val output: String?) : Presentation
    data class Exploration(val operations: List<String>) : Presentation
    data class Search(val query: String, val target: String) : Presentation
    /** [columns] is the grid the producer asked for (`layout` `{type: "columns", columns}`, 1 or 2), else 0: justified rows. */
    data class Media(val items: List<MediaItem>, val columns: Int = 0) : Presentation
    data class Artifact(val artifactId: String, val artifactType: String?, val title: String?, val version: Int?, val shows: String? = null) : Presentation
    /** An answered question as the person was shown it, and the values they gave (`user_input`). */
    data class UserInput(val prompts: List<Question.Prompt>, val answers: Map<String, List<String>>) : Presentation

    companion object {
        fun parse(value: JsonElement?): Presentation? {
            val o = value.obj ?: return null
            return when (o["type"].str) {
                "exec_command" -> Command(o["command"].str ?: return null, o["output"].str)
                "exploration" -> Exploration(
                    o["operations"].arr.orEmpty().mapNotNull { op ->
                        val operation = op.obj ?: return@mapNotNull null
                        operation["name"].str ?: operation["target"].str ?: operation["query"].str ?: operation["command"].str
                    },
                )
                "search" -> Search(o["query"].str ?: return null, o["target"].str ?: "web")
                "media" -> Media(o["items"].arr.orEmpty().mapNotNull(MediaItem::parse), columns(o["layout"]))
                "artifact" -> Artifact(o["artifactId"].str ?: return null, o["artifactType"].str, o["title"].str, o["version"].num?.toInt(), o["shows"].str)
                "user_input" -> UserInput(
                    o["questions"].arr.orEmpty().mapNotNull { value ->
                        val q = value.obj ?: return@mapNotNull null
                        Question.Prompt(
                            id = q["id"].str ?: return@mapNotNull null,
                            header = q["header"].str,
                            question = q["question"].str.orEmpty(),
                            multiSelect = q["multiSelect"].bool ?: false,
                            options = q["options"].arr.orEmpty().mapNotNull { option ->
                                option.obj?.let { opt -> opt["label"].str?.let { Question.Option(it, opt["description"].str?.takeIf(String::isNotEmpty)) } }
                            },
                            secret = null,
                        )
                    }.takeIf { it.isNotEmpty() } ?: return null,
                    o["answers"].obj?.let(Question::answersOf).orEmpty(),
                )
                else -> null
            }
        }

        private fun columns(layout: JsonElement?): Int {
            val o = layout.obj ?: return 0
            val columns = o["columns"].num
            return if (o["type"].str == "columns" && (columns == 1.0 || columns == 2.0)) columns.toInt() else 0
        }
    }
}

/** One content block. Unknown types are kept by name so a message still reads in order. */
sealed interface Block {
    data class Text(val text: String) : Block
    data class Reasoning(val text: String) : Block
    /** `data` is base64; history may leave a large picture's bytes out, and then it is [Unknown]. */
    data class Image(val mimeType: String, val data: String) : Block
    /**
     * [arguments] are the raw input, sent only where no presentation stands
     * for it. Only a question ([Question.TOOL_NAME]) keeps its result's
     * [output], which says how it was answered.
     */
    data class ToolCall(
        val id: String?,
        val name: String,
        val status: String,
        val presentation: Presentation?,
        val arguments: JsonElement? = null,
        val output: String? = null,
    ) : Block
    /** One context compaction, inside a service message: `running`, then `completed` or `failed`. */
    data class Compaction(val status: String) : Block
    data class Unknown(val type: String) : Block

    companion object {
        fun parse(value: JsonElement?): Block? {
            val o = value.obj ?: return null
            return when (val type = o["type"].str ?: return null) {
                "text" -> Text(o["text"].str ?: return null)
                "reasoning" -> Reasoning(o["text"].str.orEmpty())
                "image" -> {
                    val mimeType = o["mimeType"].str
                    val data = o["data"].str
                    if (mimeType != null && data != null) Image(mimeType, data) else Unknown(type)
                }
                "tool_call" -> {
                    val name = o["name"].str.orEmpty()
                    ToolCall(
                        id = o["id"].str,
                        name = name,
                        status = o["status"].str ?: "running",
                        presentation = Presentation.parse(o["presentation"]),
                        arguments = o["arguments"]?.takeIf { it is JsonObject },
                        output = if (name == Question.TOOL_NAME) o["result"].obj?.get("output").str else null,
                    )
                }
                "compaction" -> Compaction(o["status"].str ?: "running")
                else -> Unknown(type)
            }
        }
    }
}

/** One durable conversation entry: `user`, `agent`, `system` or `service`. */
data class Message(
    val id: String,
    val role: String,
    val createdAt: Long,
    val content: List<Block>,
    /** User messages: `pending` until a run accepts it, then `accepted`. */
    val status: String? = null,
    val runId: String? = null,
    val senderAgentId: String? = null,
    /** An error service message's typed failure, kept as sent. */
    val failure: JsonObject? = null,
    val error: JsonObject? = null,
) {
    val text: String get() = content.filterIsInstance<Block.Text>().joinToString("\n") { it.text }

    companion object {
        fun parse(value: JsonElement?): Message? {
            val o = value.obj ?: return null
            return Message(
                id = o["id"].str ?: return null,
                role = o["role"].str ?: return null,
                createdAt = o["createdAt"].long ?: 0,
                content = o["content"].arr.orEmpty().mapNotNull(Block::parse),
                status = o["status"].str,
                runId = o["runId"].str,
                senderAgentId = o["metadata"].obj?.get("senderAgentId").str,
                failure = o["failure"].obj,
                error = o["error"].obj,
            )
        }
    }
}

/** A run of history: the messages one turn of work holds, oldest first. */
data class Run(val id: String, val status: String, val startedAt: Long?, val messages: List<Message>) {
    companion object {
        fun parse(value: JsonElement?): Run? {
            val o = value.obj ?: return null
            return Run(
                id = o["id"].str ?: return null,
                status = o["status"].str ?: "completed",
                startedAt = o["startedAt"].long,
                messages = o["messages"].arr.orEmpty().mapNotNull(Message::parse),
            )
        }
    }
}

/** `GET /v0/agents/:id/messages`: whole runs, oldest first. */
data class MessagesPage(val runs: List<Run>, val hasMore: Boolean) {
    companion object {
        fun parse(value: JsonElement?): MessagesPage? {
            val o = value.obj ?: return null
            return MessagesPage(o["runs"].arr?.mapNotNull(Run::parse) ?: return null, o["hasMore"].bool ?: false)
        }
    }
}

/** The composer's draft on the agent: text and the mode it goes with, stamped so a clear survives. */
data class Draft(val text: String?, val mode: Mode?, val updatedAt: Long?) {
    companion object {
        fun parse(value: JsonElement?): Draft? {
            val o = value.obj ?: return null
            val draft = o["value"].obj
            return Draft(draft?.get("text").str, Mode.parse(draft), o["updatedAt"].long)
        }
    }
}

/** The agent as a conversation needs it: who it is and what it is doing. */
data class AgentInfo(
    val id: String,
    val workspaceId: String?,
    val parentAgentId: String?,
    val title: String?,
    /** `idle`, `thinking`, `working`, `generating_tools` or `running_tools`. */
    val status: String,
    val pendingQuestionId: String?,
    val archivedAt: Long?,
    val createdAt: Long?,
    val updatedAt: Long?,
    val subagentsRunning: Int,
    val subagentsTotal: Int,
    /** Whether the agent's send route takes the person's messages; absent on older daemons. */
    val canSendMessages: Boolean? = null,
    /** A user-interactive subtask its parent manages; absent (false) on older daemons. */
    val subtask: Boolean? = null,
) {
    val isWorking: Boolean get() = status != "idle"
    val isSubagent: Boolean get() = parentAgentId != null

    /**
     * Whether the person can send here: the agent's own `canSendMessages`,
     * else the daemon's rule for it (ApiResourceProjection): a root or a
     * user-interactive subtask, not archived. An internal subagent, driven
     * by its parent, takes none.
     */
    val sendable: Boolean get() = canSendMessages ?: ((parentAgentId == null || subtask == true) && archivedAt == null)

    /** `agent.updated` `changes` laid over this copy: present and null clears, absent leaves it. */
    fun merge(changes: JsonObject): AgentInfo = copy(
        title = if ("title" in changes) changes["title"].str else title,
        status = changes["status"].str ?: status,
        pendingQuestionId = if ("pendingQuestionId" in changes) changes["pendingQuestionId"].str else pendingQuestionId,
        archivedAt = if ("archivedAt" in changes) changes["archivedAt"].long else archivedAt,
        updatedAt = changes["updatedAt"].long ?: updatedAt,
        subagentsRunning = changes["subagents"].obj?.get("running")?.num?.toInt() ?: subagentsRunning,
        subagentsTotal = changes["subagents"].obj?.get("total")?.num?.toInt() ?: subagentsTotal,
        // Sent with every archive and restore; from a daemon that doesn't, the fallback answers again.
        canSendMessages = when {
            "canSendMessages" in changes -> changes["canSendMessages"].bool
            "archivedAt" in changes -> null
            else -> canSendMessages
        },
    )

    companion object {
        fun parse(value: JsonElement?): AgentInfo? {
            val o = value.obj ?: return null
            return AgentInfo(
                id = o["id"].str ?: return null,
                workspaceId = o["workspaceId"].str,
                parentAgentId = o["parentAgentId"].str,
                title = o["title"].str,
                status = o["status"].str ?: "idle",
                pendingQuestionId = o["pendingQuestionId"].str,
                archivedAt = o["archivedAt"].long,
                createdAt = o["createdAt"].long,
                updatedAt = o["updatedAt"].long,
                subagentsRunning = o["subagents"].obj?.get("running")?.num?.toInt() ?: 0,
                subagentsTotal = o["subagents"].obj?.get("total")?.num?.toInt() ?: 0,
                canSendMessages = o["canSendMessages"].bool,
                subtask = o["subtask"].bool,
            )
        }
    }
}

/**
 * `GET /v0/agents/:id/bootstrap`: the agent, its mode and draft, what waits
 * to be taken, and its slash commands (null from a daemon that sends none).
 */
data class Bootstrap(
    val agent: AgentInfo,
    val mode: Mode?,
    val draft: Draft?,
    val pending: List<Message>,
    val cursor: String?,
    val slashCommands: List<SlashCommand>? = null,
) {
    companion object {
        fun parse(value: JsonElement?): Bootstrap? {
            val o = value.obj ?: return null
            return Bootstrap(
                agent = AgentInfo.parse(o["agent"]) ?: return null,
                mode = Mode.parse(o["mode"]),
                draft = Draft.parse(o["draft"]),
                pending = o["pending"].arr.orEmpty().mapNotNull(Message::parse),
                cursor = o["cursor"].str,
                slashCommands = SlashCommand.parseAll(o["slashCommands"]),
            )
        }
    }
}

/**
 * An open question a run waits on: the agent asking, or something outside
 * it (an MCP server) asking for permission ([permissionFrom]).
 */
data class Question(
    val id: String,
    val status: String,
    val context: String?,
    val prompts: List<Prompt>,
    /** Who asks for permission, by display name; null for the agent's own question. */
    val permissionFrom: String?,
    val isPermission: Boolean,
    /** Each prompt's values by its ID, once answered. */
    val answers: Map<String, List<String>>? = null,
) {
    data class Option(val label: String, val description: String?)

    /** One variable a secret request needs: its name, and what the agent says it is. */
    data class SecretVariable(val name: String, val description: String?)

    /**
     * What an agent needs a credential for (API.md "Secret requests"). The
     * person types the values into a form this describes; the answer is the
     * secret's id, never a value.
     */
    data class SecretRequest(val suggestedId: String?, val description: String?, val variables: List<SecretVariable>)
    data class Prompt(
        val id: String,
        val header: String?,
        val question: String,
        val multiSelect: Boolean,
        val options: List<Option>,
        /** Set when the answer is a secret's id rather than words. */
        val secret: SecretRequest?,
    ) {
        val asksForSecret: Boolean get() = secret != null
    }

    /** The one secret this question asks for, if it asks for one at all. */
    val secret: SecretRequest? get() = prompts.singleOrNull()?.secret

    val answerable: Boolean get() = prompts.isNotEmpty()

    companion object {
        /** The tool that asks a question; its call's ID is the question's. */
        const val TOOL_NAME = "request_user_input"

        /**
         * A question as its call asked it (`request_user_input` arguments)
         * and, from the result the agent was given (`formatUserInputForModel`),
         * how it was answered; null when the call says neither (iOS
         * 7f6355041 `AgentWire.Question.asked`).
         */
        fun asked(id: String, arguments: JsonElement?, output: String?): Question? {
            val args = arguments.obj ?: return null
            // One question may come bare, as the batch's `question_1`.
            val entries = args["questions"].arr?.takeIf { it.isNotEmpty() }
                ?: args.takeIf { it["question"].str != null }?.let { listOf(it) }
                ?: return null
            val prompts = entries.mapIndexed { offset, entry ->
                val e = entry.obj ?: return null
                val question = e["question"].str ?: return null
                // Options come as a list, or as `{ choices, multiSelect }`.
                val options = e["options"]
                val choices = options.arr ?: options.obj?.get("choices").arr
                Prompt(
                    id = e["id"].str ?: "question_${offset + 1}",
                    header = e["header"].str,
                    question = question,
                    multiSelect = e["multiSelect"].bool ?: options.obj?.get("multiSelect").bool ?: false,
                    options = choices.orEmpty().mapNotNull { choice ->
                        choice.obj?.get("label").str?.let { Option(it, choice.obj?.get("description").str) }
                    },
                    secret = null,
                )
            }
            val asked = Question(id, "pending", args["context"].str, prompts, null, false)
            if (output == null) return asked
            if (!output.contains("\nStatus: Answered")) return asked.copy(status = "canceled")
            return asked.copy(status = "answered", answers = answers(output, prompts))
        }

        /**
         * Each prompt's values from a result's `Answer:` section: `id: value`
         * lines, a value `Selected: a, b` then any text typed under it.
         */
        internal fun answers(output: String, prompts: List<Prompt>): Map<String, List<String>> {
            val start = output.indexOf("\nAnswer:\n").takeIf { it >= 0 } ?: return emptyMap()
            val lines = output.substring(start + "\nAnswer:\n".length).split("\n")
            val values = LinkedHashMap<String, MutableList<String>>()
            var current: String? = null
            for (line in lines) {
                val prompt = prompts.firstOrNull { line.startsWith("${it.id}: ") }
                when {
                    prompt != null -> {
                        current = prompt.id
                        values[prompt.id] = mutableListOf(line.substring(prompt.id.length + 2))
                    }
                    current != null -> values.getOrPut(current) { mutableListOf() } += line
                    // A single question's answer carries no ID.
                    prompts.size == 1 -> {
                        current = prompts[0].id
                        values[prompts[0].id] = mutableListOf(line)
                    }
                }
            }
            val answers = LinkedHashMap<String, List<String>>()
            for (prompt in prompts) {
                val body = values[prompt.id]?.takeIf { it.isNotEmpty() } ?: continue
                val picked = ArrayList<String>()
                var rest: List<String> = body
                if (body[0].startsWith("Selected: ")) {
                    val selected = body[0].removePrefix("Selected: ")
                    // Labels may hold ", " themselves: the known ones are read whole.
                    picked += prompt.options.map { it.label }.filter {
                        selected == it || selected.startsWith("$it, ") || selected.endsWith(", $it") || selected.contains(", $it, ")
                    }
                    if (picked.isEmpty()) picked += selected.split(", ")
                    rest = body.drop(1)
                }
                val text = rest.joinToString("\n").trim()
                if (text.isNotEmpty()) picked += text
                answers[prompt.id] = picked
            }
            return answers
        }

        /** `{ promptId: [values] }`, as `answers` and `question.updated` carry them. */
        fun answersOf(value: JsonObject): Map<String, List<String>> =
            value.mapValues { (_, values) -> values.arr.orEmpty().mapNotNull { it.str } }

        fun parse(value: JsonElement?): Question? {
            val o = value.obj ?: return null
            val permission = o["permissionRequest"].obj
            return Question(
                id = o["id"].str ?: return null,
                status = o["status"].str ?: "pending",
                context = o["context"].str,
                prompts = o["questions"].arr.orEmpty().mapNotNull { prompt ->
                    val p = prompt.obj ?: return@mapNotNull null
                    Prompt(
                        id = p["id"].str ?: return@mapNotNull null,
                        header = p["header"].str,
                        question = p["question"].str.orEmpty(),
                        multiSelect = p["multiSelect"].bool ?: false,
                        options = p["options"].arr.orEmpty().mapNotNull { option ->
                            val opt = option.obj ?: return@mapNotNull null
                            Option(opt["label"].str ?: return@mapNotNull null, opt["description"].str)
                        },
                        secret = p["secretRequest"].obj?.let { request ->
                            SecretRequest(
                                suggestedId = request["suggestedId"].str,
                                description = request["description"].str,
                                variables = request["environmentVariables"].arr.orEmpty().mapNotNull { value ->
                                    val variable = value.obj ?: return@mapNotNull null
                                    SecretVariable(variable["name"].str ?: return@mapNotNull null, variable["description"].str)
                                },
                            )
                        },
                    )
                },
                permissionFrom = permission?.let { it["serverTitle"].str ?: it["server"].str },
                isPermission = permission != null,
                answers = o["answers"].obj?.let(::answersOf),
            )
        }
    }
}

/** One secret as the catalog lists it: safe metadata, never a value (API.md "The secret object"). */
data class SecretSummary(
    val id: String,
    val description: String?,
    val variables: List<String>,
    val availableToAgents: Boolean,
) {
    /** Whether this secret carries every variable the request names, however they are cased. */
    fun covers(request: Question.SecretRequest): Boolean {
        val held = variables.mapTo(HashSet()) { it.lowercase() }
        return request.variables.all { it.name.lowercase() in held }
    }

    companion object {
        fun parse(value: JsonElement?): SecretSummary? {
            val o = value.obj ?: return null
            return SecretSummary(
                id = o["id"].str ?: return null,
                description = o["description"].str,
                variables = o["environmentVariables"].arr.orEmpty().mapNotNull { it.str },
                availableToAgents = o["availableToAgents"].bool ?: true,
            )
        }
    }
}

/** One todo of a todo list Surface. */
data class Todo(val id: String, val text: String, val done: Boolean)
