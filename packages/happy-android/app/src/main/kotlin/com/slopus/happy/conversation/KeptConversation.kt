package com.slopus.happy.conversation

import com.slopus.happy.chat.arr
import com.slopus.happy.chat.bool
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * Where a conversation keeps its newest history on this phone (iOS's
 * `conversation:<agentId>` checkpoint), so it opens from disk, offline and
 * before the agent answers. Calls block: the conversation makes them off
 * the main thread.
 */
interface ConversationKeeper {
    fun read(): JsonObject?
    fun write(value: JsonObject)
}

/**
 * What a conversation keeps (iOS's `KeptConversation`): its newest
 * [KEPT_RUNS] runs, what waits in the queue, whether older history is on
 * the agent, the agent as last read and the mode. Written in the wire's
 * own shapes, so it reads back through the same parsers as the agent's
 * answers.
 */
data class KeptConversation(
    val runs: List<Run>,
    val pending: List<Message>,
    val hasMore: Boolean,
    val agent: AgentInfo?,
    val mode: Mode?,
    /** The agent's slash commands as last read; null when none were. */
    val slashCommands: List<SlashCommand>? = null,
) {
    fun json(): JsonObject = buildJsonObject {
        put("version", VERSION)
        put("runs", JsonArray(runs.map(::runJson)))
        put("pending", JsonArray(pending.map(::messageJson)))
        put("hasMore", hasMore)
        agent?.let { put("agent", agentJson(it)) }
        mode?.let { put("mode", it.json()) }
        slashCommands?.let { put("slashCommands", SlashCommand.json(it)) }
    }

    companion object {
        /** desktop's window on a conversation nobody reads (connectHappyAgent's `trimHistory`), as iOS keeps. */
        const val KEPT_RUNS = 100
        private const val VERSION = 1

        fun parse(value: JsonObject?): KeptConversation? {
            val o = value ?: return null
            if ((o["version"] as? JsonPrimitive)?.content != VERSION.toString()) return null
            return KeptConversation(
                runs = o["runs"].arr?.mapNotNull(Run::parse) ?: return null,
                pending = o["pending"].arr.orEmpty().mapNotNull(Message::parse),
                hasMore = o["hasMore"].bool ?: true,
                agent = AgentInfo.parse(o["agent"]),
                mode = Mode.parse(o["mode"]),
                slashCommands = SlashCommand.parseAll(o["slashCommands"]),
            )
        }

        private fun runJson(run: Run): JsonObject = buildJsonObject {
            put("id", run.id)
            put("status", run.status)
            run.startedAt?.let { put("startedAt", it) }
            run.endedAt?.let { put("endedAt", it) }
            run.reason?.let { put("reason", it) }
            put("messages", JsonArray(run.messages.map(::messageJson)))
        }

        fun messageJson(message: Message): JsonObject = buildJsonObject {
            put("id", message.id)
            put("role", message.role)
            put("createdAt", message.createdAt)
            put("content", JsonArray(message.content.map(::blockJson)))
            message.status?.let { put("status", it) }
            message.runId?.let { put("runId", it) }
            putJsonObject("metadata") {
                message.senderAgentId?.let { put("senderAgentId", it) }
                message.userId?.let { put("userId", it) }
            }
            message.failure?.let { put("failure", it) }
            message.error?.let { put("error", it) }
        }

        private fun blockJson(block: Block): JsonObject = when (block) {
            is Block.Text -> buildJsonObject { put("type", "text"); put("text", block.text) }
            is Block.Reasoning -> buildJsonObject { put("type", "reasoning"); put("text", block.text) }
            is Block.Image -> buildJsonObject { put("type", "image"); put("mimeType", block.mimeType); put("data", block.data) }
            is Block.File -> buildJsonObject {
                put("type", "file")
                put("attachment", block.attachment)
                put("name", block.name)
                block.mimeType?.let { put("mimeType", it) }
                block.size?.let { put("size", it) }
            }
            is Block.ToolCall -> buildJsonObject {
                put("type", "tool_call")
                block.id?.let { put("id", it) }
                put("name", block.name)
                put("status", block.status)
                block.presentation?.let { put("presentation", presentationJson(it)) }
                block.arguments?.let { put("arguments", it) }
                // As history's omitToolData: a presented call's result is read again when opened.
                val result = block.result?.takeIf { block.presentation == null }
                if (result != null) put("result", result) else block.output?.let { putJsonObject("result") { put("output", it) } }
                block.review?.let { review ->
                    putJsonObject("review") {
                        put("outcome", review.outcome)
                        put("reason", review.reason)
                        review.risk?.let { put("risk", it) }
                        review.userAuthorization?.let { put("userAuthorization", it) }
                        review.kind?.let { put("kind", it) }
                    }
                }
                block.elevated?.let { put("elevated", it) }
            }
            is Block.Compaction -> buildJsonObject { put("type", "compaction"); put("status", block.status) }
            is Block.Unknown -> buildJsonObject { put("type", block.type) }
        }

        private fun presentationJson(presentation: Presentation): JsonObject = when (presentation) {
            is Presentation.Command -> buildJsonObject {
                put("type", "exec_command")
                put("command", presentation.command)
                presentation.output?.let { put("output", it) }
            }
            is Presentation.Exploration -> buildJsonObject {
                put("type", "exploration")
                put(
                    "operations",
                    buildJsonArray {
                        presentation.operations.forEach { op ->
                            add(
                                buildJsonObject {
                                    put("kind", op.kind)
                                    op.name?.let { put("name", it) }
                                    op.target?.let { put("target", it) }
                                    op.command?.let { put("command", it) }
                                    op.query?.let { put("query", it) }
                                    op.path?.let { put("path", it) }
                                },
                            )
                        }
                    },
                )
            }
            is Presentation.Search -> buildJsonObject {
                put("type", "search")
                put("query", presentation.query)
                put("target", presentation.target)
                if (presentation.sources.isNotEmpty()) put(
                    "sources",
                    buildJsonArray { presentation.sources.forEach { add(buildJsonObject { put("title", it.title); put("url", it.url) }) } },
                )
            }
            is Presentation.Media -> buildJsonObject {
                put("type", "media")
                put("items", JsonArray(presentation.items.map(::mediaJson)))
                if (presentation.columns > 0) putJsonObject("layout") { put("type", "columns"); put("columns", presentation.columns) }
            }
            is Presentation.Artifact -> buildJsonObject {
                put("type", "artifact")
                put("artifactId", presentation.artifactId)
                presentation.artifactType?.let { put("artifactType", it) }
                presentation.title?.let { put("title", it) }
                presentation.version?.let { put("version", it) }
                presentation.shows?.let { put("shows", it) }
            }
            is Presentation.UserInput -> buildJsonObject {
                put("type", "user_input")
                put(
                    "questions",
                    buildJsonArray {
                        presentation.prompts.forEach { prompt ->
                            add(
                                buildJsonObject {
                                    put("id", prompt.id)
                                    prompt.header?.let { put("header", it) }
                                    put("question", prompt.question)
                                    put("multiSelect", prompt.multiSelect)
                                    put(
                                        "options",
                                        buildJsonArray {
                                            prompt.options.forEach { option ->
                                                add(buildJsonObject { put("label", option.label); option.description?.let { put("description", it) } })
                                            }
                                        },
                                    )
                                },
                            )
                        }
                    },
                )
                putJsonObject("answers") {
                    presentation.answers.forEach { (id, values) -> put(id, buildJsonArray { values.forEach { add(JsonPrimitive(it)) } }) }
                }
            }
            is Presentation.FileDiff -> buildJsonObject {
                put("type", "file_diff")
                put(
                    "files",
                    buildJsonArray {
                        presentation.files.forEach { file ->
                            add(
                                buildJsonObject {
                                    put("path", file.path)
                                    put("kind", file.kind)
                                    file.added?.let { put("added", it) }
                                    file.deleted?.let { put("deleted", it) }
                                    put("hunks", buildJsonArray { file.hunks.forEach { add(hunkJson(it)) } })
                                    file.language?.let { put("language", it) }
                                    if (file.omittedLines > 0) put("omittedLines", file.omittedLines)
                                },
                            )
                        }
                    },
                )
                if (presentation.omittedFiles > 0) put("omittedFiles", presentation.omittedFiles)
            }
            is Presentation.AgentSpawn -> buildJsonObject {
                put("type", "agent_spawn")
                presentation.model?.let { name -> putJsonObject("model") { put("name", name) } }
            }
            is Presentation.Terminal -> buildJsonObject {
                put("type", "background_terminal_interaction")
                put("input", presentation.input)
                presentation.command?.let { put("command", it) }
            }
        }

        private fun hunkJson(hunk: Presentation.FileDiff.Hunk): JsonObject = buildJsonObject {
            put("oldStart", hunk.oldStart)
            put("newStart", hunk.newStart)
            put("lines", buildJsonArray { hunk.lines.forEach { line -> add(buildJsonObject { put("kind", line.kind); put("text", line.text) }) } })
        }

        private fun mediaJson(item: MediaItem): JsonObject = buildJsonObject {
            put("kind", item.kind)
            put("name", item.name)
            put("mimeType", item.mimeType)
            item.width?.let { put("width", it) }
            item.height?.let { put("height", it) }
            item.scale?.let { put("scale", it) }
            item.thumbhash?.let { put("thumbhash", it) }
            item.size?.let { put("size", it) }
        }

        private fun agentJson(agent: AgentInfo): JsonObject = buildJsonObject {
            put("id", agent.id)
            agent.workspaceId?.let { put("workspaceId", it) }
            agent.parentAgentId?.let { put("parentAgentId", it) }
            agent.title?.let { put("title", it) }
            put("status", agent.status)
            agent.pendingQuestionId?.let { put("pendingQuestionId", it) }
            agent.archivedAt?.let { put("archivedAt", it) }
            agent.createdAt?.let { put("createdAt", it) }
            agent.updatedAt?.let { put("updatedAt", it) }
            putJsonObject("subagents") { put("running", agent.subagentsRunning); put("total", agent.subagentsTotal) }
            agent.canSendMessages?.let { put("canSendMessages", it) }
            agent.subtask?.let { put("subtask", it) }
        }
    }
}
