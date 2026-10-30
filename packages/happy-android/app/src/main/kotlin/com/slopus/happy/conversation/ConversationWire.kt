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
            )
        }
    }
}

/** What a tool call showed the person (`presentation`), when the daemon typed it. */
sealed interface Presentation {
    data class Command(val command: String, val output: String?) : Presentation
    data class Exploration(val operations: List<String>) : Presentation
    data class Search(val query: String, val target: String) : Presentation
    data class Media(val items: List<MediaItem>) : Presentation
    data class Artifact(val artifactId: String, val artifactType: String?, val title: String?, val version: Int?) : Presentation

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
                "media" -> Media(o["items"].arr.orEmpty().mapNotNull(MediaItem::parse))
                "artifact" -> Artifact(o["artifactId"].str ?: return null, o["artifactType"].str, o["title"].str, o["version"].num?.toInt())
                else -> null
            }
        }
    }
}

/** One content block. Unknown types are kept by name so a message still reads in order. */
sealed interface Block {
    data class Text(val text: String) : Block
    data class Reasoning(val text: String) : Block
    /** `data` is base64; history may leave a large picture's bytes out, and then it is [Unknown]. */
    data class Image(val mimeType: String, val data: String) : Block
    /** [arguments] are the raw input, sent only where no presentation stands for it. */
    data class ToolCall(val id: String?, val name: String, val status: String, val presentation: Presentation?, val arguments: JsonElement? = null) : Block
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
                "tool_call" -> ToolCall(
                    id = o["id"].str,
                    name = o["name"].str.orEmpty(),
                    status = o["status"].str ?: "running",
                    presentation = Presentation.parse(o["presentation"]),
                    arguments = o["arguments"]?.takeIf { it is JsonObject },
                )
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
) {
    val isWorking: Boolean get() = status != "idle"
    val isSubagent: Boolean get() = parentAgentId != null

    /** `agent.updated` `changes` laid over this copy: present and null clears, absent leaves it. */
    fun merge(changes: JsonObject): AgentInfo = copy(
        title = if ("title" in changes) changes["title"].str else title,
        status = changes["status"].str ?: status,
        pendingQuestionId = if ("pendingQuestionId" in changes) changes["pendingQuestionId"].str else pendingQuestionId,
        archivedAt = if ("archivedAt" in changes) changes["archivedAt"].long else archivedAt,
        updatedAt = changes["updatedAt"].long ?: updatedAt,
        subagentsRunning = changes["subagents"].obj?.get("running")?.num?.toInt() ?: subagentsRunning,
        subagentsTotal = changes["subagents"].obj?.get("total")?.num?.toInt() ?: subagentsTotal,
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
            )
        }
    }
}

/** `GET /v0/agents/:id/bootstrap`: the agent, its mode and draft, and what waits to be taken. */
data class Bootstrap(val agent: AgentInfo, val mode: Mode?, val draft: Draft?, val pending: List<Message>, val cursor: String?) {
    companion object {
        fun parse(value: JsonElement?): Bootstrap? {
            val o = value.obj ?: return null
            return Bootstrap(
                agent = AgentInfo.parse(o["agent"]) ?: return null,
                mode = Mode.parse(o["mode"]),
                draft = Draft.parse(o["draft"]),
                pending = o["pending"].arr.orEmpty().mapNotNull(Message::parse),
                cursor = o["cursor"].str,
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
