package com.slopus.happy.conversation

import com.slopus.happy.chat.arr
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.ui.QuickReply
import com.slopus.happy.conversation.ui.UiAction
import com.slopus.happy.conversation.ui.UiOffer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.URLEncoder
import java.security.SecureRandom

/** A refused request: the daemon's status, with its error `code` and words when it sent them, and the rest of its answer. */
class ConversationApiException(val status: Int, val code: String?, override val message: String?, val body: JsonObject? = null) : Exception(message)

/**
 * One request to the paired agent as its [RequestCategory], answered whatever
 * its status; the agent connection's client does the transport.
 */
typealias AgentRequest = suspend (method: String, path: String, body: JsonElement?, category: RequestCategory) -> TransportResponse

/** [AgentRequest] with a JSON body already made as bytes: a workspace file's upload, built once ([WorkspaceUploads.body]). */
typealias AgentBytesRequest = suspend (method: String, path: String, body: ByteArray, category: RequestCategory) -> TransportResponse

/** A file's own bytes as the body, sent as [contentType]: a Happy Cloud attachment's upload. */
typealias AgentFileRequest = suspend (method: String, path: String, body: ByteArray, contentType: String) -> TransportResponse

/**
 * The client-chosen ids of new work made on first send (`POST /v0/tasks` or
 * `/v0/bots`); the same ids again are the same task or bot.
 */
data class NewTask(val taskId: String, val workspaceId: String, val agentId: String, val mutationId: String) {
    companion object {
        fun make() = NewTask(ConversationApi.clientId(), ConversationApi.clientId(), ConversationApi.clientId(), ConversationApi.clientId())
    }
}

/** A tool the agent runs before it reads the message that asks for it (`tool_call_request`). */
data class ToolRequest(val name: String, val arguments: Map<String, String>)

/** What a slash command's invocation answered: the agent, and its commands as they now are. */
data class CommandInvoked(val agent: AgentInfo?, val slashCommands: List<SlashCommand>?)

/** What new work is made as. */
enum class WorkKind { Task, Bot }

/**
 * New work as chosen before its first send (iOS's `NewTask.Choice`): a task
 * unless a bot was picked, and the name given, blank for the computer to
 * name it from its first message.
 */
data class WorkChoice(val kind: WorkKind = WorkKind.Task, val name: String = "")

/** New work left before its first message, as it was left: compose again opens it. */
data class UnsentWork(val task: NewTask, val choice: WorkChoice, val draft: String)

/**
 * The conversation routes of the Happy Agent API (API.md, "Agents",
 * "Tasks"), each one a device token may use. 401 is
 * [AgentConnectionException.Reason.Revoked]; any other non-2xx is a
 * [ConversationApiException].
 */
open class ConversationApi(
    private val bytesRequest: AgentBytesRequest?,
    private val request: AgentRequest,
    /** A Happy Cloud server's: its models run on connections ([catalog]). */
    private val cloud: Boolean = false,
    /** Sends [uploadAttachment]'s bytes; without it they go as [request] can't, and the upload fails. */
    private val fileRequest: AgentFileRequest? = null,
    /**
     * The device a send names (`deviceId`), once the computer takes this
     * device's environment ([com.slopus.happy.agent.UserEnvironmentReports.sendingDeviceId]):
     * an older one refuses the whole send.
     */
    private val sendingDevice: () -> String? = { null },
) {
    constructor(request: AgentRequest) : this(null, request)

    private suspend fun call(method: String, path: String, body: JsonElement? = null, category: RequestCategory = RequestCategory.Query): JsonObject =
        decode(request(method, path, body, category))

    /**
     * A new chat: a task (`{task, membership}`) or a bot (`{bot}`), its folder
     * and its one agent, made together under [task]'s ids, as desktop's
     * `createTask` and `createBot` make them. A blank name is left out rather
     * than sent, which the computer would refuse.
     */
    open suspend fun createWork(task: NewTask, choice: WorkChoice = WorkChoice()): JsonObject {
        val owner = if (choice.kind == WorkKind.Bot) "bot" else "task"
        val body = buildJsonObject {
            put("id", task.taskId)
            put("workspaceId", task.workspaceId)
            put("agentId", task.agentId)
            put("mutationId", task.mutationId)
            choice.name.trim().takeIf { it.isNotEmpty() }?.let { put("name", it) }
        }
        return call("POST", "/v0/${owner}s", body).takeIf { it[owner].obj != null } ?: throw invalid()
    }

    /**
     * The agent of this computer's Chief of Staff: the active bot whose
     * `systemKey` is `chief_of_staff` (API.md "Bots"), never one guessed by
     * name. Null when there is none.
     */
    open suspend fun chiefOfStaffAgentId(): String? =
        call("GET", "/v0/bots")["bots"].arr.orEmpty()
            .mapNotNull { it.obj }
            .firstOrNull { it["systemKey"].str == "chief_of_staff" && it["status"].str == "active" }
            ?.get("agent").obj?.get("id").str

    open suspend fun bootstrap(agentId: String): Bootstrap =
        Bootstrap.parse(call("GET", "/v0/agents/${escape(agentId)}/bootstrap")) ?: throw invalid()

    /**
     * The newest runs, the runs before the run [before], or the messages
     * after the message [after] (API.md: what extends the newest run and the
     * runs started since). Tool data is left out where a presentation stands
     * for it, unless [omitToolData] is false: a tool call opened whole.
     */
    open suspend fun messages(agentId: String, before: String? = null, limit: Int = 100, after: String? = null, omitToolData: Boolean = true): MessagesPage {
        val query = StringBuilder("limit=$limit&omitToolData=$omitToolData")
        before?.let { query.append("&before=").append(escape(it)) }
        after?.let { query.append("&after=").append(escape(it)) }
        return MessagesPage.parse(call("GET", "/v0/agents/${escape(agentId)}/messages?$query")) ?: throw invalid()
    }

    /** The models a message can run with, and the mode new work is sent with when nothing was picked. */
    open suspend fun catalog(): ModeCatalog {
        val catalog = ModeCatalog.parse(call("GET", "/v0/config"))
        if (!cloud) return catalog
        val connections = call("GET", "/v0/cloud/providers")["providers"].arr.orEmpty().mapNotNull { it.obj }.mapNotNull(com.slopus.happy.agent.CloudConnection::parse)
        return ModeCatalog.withConnections(catalog, connections)
    }

    /**
     * Sends [text] (and pictures) under the client's [id]: the same id again
     * is the same message. Always steering, as desktop sends: mid-turn it is
     * taken at the next boundary; idle, it starts a run.
     */
    open suspend fun send(
        agentId: String,
        id: String,
        text: String,
        images: List<Block.Image>,
        mode: Mode,
        toolRequest: ToolRequest? = null,
        attachments: List<SentAttachment> = emptyList(),
        /** The suggested reply [text] is, exactly: the daemon checks it, and answers `400` where it isn't. */
        quickReply: QuickReply? = null,
    ): Message? {
        val body = buildJsonObject {
            put("id", id)
            // The API requires top-level text; a picture or a file alone goes with a short caption.
            put(
                "text",
                when {
                    text.isNotEmpty() -> text
                    images.isNotEmpty() && attachments.isEmpty() -> if (images.size == 1) "Attached image." else "Attached images."
                    attachments.isNotEmpty() -> if (images.size + attachments.size == 1) "Attached file." else "Attached files."
                    else -> text
                },
            )
            put("delivery", "steer")
            put("clientMetadata", buildJsonObject { put("composer", "mobile") })
            quickReply?.let { put("quickReply", it.json()) }
            sendingDevice()?.let { put("deviceId", it) }
            if (images.isNotEmpty() || attachments.isNotEmpty() || toolRequest != null) put("content", buildJsonArray {
                images.forEach { add(buildJsonObject { put("type", "image"); put("mimeType", it.mimeType); put("data", it.data) }) }
                attachments.forEach { add(buildJsonObject { put("type", "file"); put("attachment", it.id); put("name", it.name) }) }
                // A tool request rides the words (desktop aa8a2529); the words go once, as `text`.
                toolRequest?.let { request ->
                    add(
                        buildJsonObject {
                            put("type", "tool_call_request")
                            put("name", request.name)
                            put("arguments", JsonObject(request.arguments.mapValues { (_, value) -> JsonPrimitive(value) }))
                        },
                    )
                }
            })
            put("mode", mode.json())
        }
        // Pictures make it a file's size: a file's client and deadline.
        val category = if (images.isEmpty()) RequestCategory.Query else RequestCategory.File
        return Message.parse(call("POST", "/v0/agents/${escape(agentId)}/send", body, category)["message"])
    }

    /**
     * One press of a chat UI component, to `POST /v0/agents/:agentId/actions`
     * under the client's [id], the attempt's idempotency key: the same id
     * again answers what the first did. The answer is the attempt's record,
     * a service message of one `action` block; a refusal on its merits is a
     * record whose outcome is `rejected`, while `400`, `403`, `404`, `409`
     * and `429` record nothing. Its `result` is not read: no action this
     * build sends answers with one.
     */
    open suspend fun act(agentId: String, id: String, offer: UiOffer, action: UiAction): Message {
        val body = buildJsonObject {
            put("id", id)
            put("messageId", offer.messageId)
            put("uiId", offer.uiId)
            put("componentId", offer.componentId)
            put("action", action.json())
        }
        return Message.parse(call("POST", "/v0/agents/${escape(agentId)}/actions", body)["record"])?.takeIf { it.attempt != null } ?: throw invalid()
    }

    /**
     * Uploads [file] as an attachment of [agentId] (Happy Cloud, `PUT
     * …/attachments?name=`): its own bytes, as its type. The answer's id is
     * the bytes' digest, so a retry whose answer was lost gets the same one.
     * The disk is read on [io].
     */
    open suspend fun uploadAttachment(agentId: String, file: OutgoingFile, io: kotlin.coroutines.CoroutineContext = kotlinx.coroutines.Dispatchers.IO): String {
        val send = fileRequest ?: throw ConversationApiException(501, "unsupported", null)
        val bytes = kotlinx.coroutines.withContext(io) { file.file.readBytes() }
        val path = "/v0/agents/${escape(agentId)}/attachments?name=${escape(file.name)}"
        val response = kotlinx.coroutines.withContext(com.slopus.happy.connection.BodyProgress { _, _ -> }) {
            send("PUT", path, bytes, file.mimeType.ifBlank { "application/octet-stream" })
        }
        return decode(response)["attachment"].obj?.get("id").str ?: throw invalid()
    }

    /**
     * Writes [bytes] at [path] in the workspace, new only (`expectedHash:
     * null`). The same bytes already there, a retry whose answer was lost,
     * count as written (iOS `AttachmentRules.upload`).
     */
    open suspend fun uploadFile(workspaceId: String, path: String, bytes: ByteArray) {
        val hash = WorkspaceUploads.hex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes))
        val body = buildJsonObject {
            put("path", path)
            put("content", java.util.Base64.getEncoder().encodeToString(bytes))
            put("expectedHash", JsonNull)
        }
        written(hash) { request("PUT", "/v0/workspaces/${escape(workspaceId)}/file", body, RequestCategory.File) }
    }

    /**
     * [uploadFile] of a file on disk (desktop 3885593e: up to 50 MB). Its
     * JSON is made once, from the disk a piece at a time, and goes out a
     * chunk at a time: a 50 MB file as a string, then JSON, then bytes ran
     * the phone's 192 MB heap out. Without [bytesRequest] it is read whole.
     * The disk is read on [io].
     */
    open suspend fun uploadFile(workspaceId: String, path: String, file: java.io.File, io: kotlin.coroutines.CoroutineContext = kotlinx.coroutines.Dispatchers.IO) {
        val send = bytesRequest
            ?: return uploadFile(workspaceId, path, kotlinx.coroutines.withContext(io) { file.readBytes() })
        val (body, hash) = kotlinx.coroutines.withContext(io) { WorkspaceUploads.body(path, file) }
        kotlinx.coroutines.withContext(com.slopus.happy.connection.BodyProgress { _, _ -> }) {
            written(hash) { send("PUT", "/v0/workspaces/${escape(workspaceId)}/file", body, RequestCategory.File) }
        }
    }

    /** A write's answer: its [hash] back, or a `409` saying those bytes are there already (a retry whose answer was lost). */
    private suspend fun written(hash: String, put: suspend () -> TransportResponse) {
        fun already(status: Int, answer: JsonObject?) = status == 409 && answer?.get("code").str == "hash_mismatch" && answer?.get("hash").str == hash
        val response = try {
            put()
        } catch (e: ConversationApiException) {
            if (already(e.status, e.body)) return
            throw e
        }
        if (already(response.status, runCatching { json.parseToJsonElement(response.text).obj }.getOrNull())) return
        if (decode(response)["hash"].str != hash) throw invalid()
    }

    /**
     * Runs one slash command on the module that offers it (API.md `POST
     * …/slash-commands/:name`): its [arguments] when it takes any, under the
     * composer's whole [mode]. 404 is a command unknown or just removed, 409
     * one that can't run now. The answer carries the catalog as it now is.
     */
    open suspend fun invokeCommand(agentId: String, name: String, arguments: String?, mode: Mode): CommandInvoked {
        val body = buildJsonObject {
            arguments?.let { put("arguments", it) }
            put("mode", mode.json())
            put("mutationId", clientId())
        }
        val answer = call("POST", "/v0/agents/${escape(agentId)}/slash-commands/${escape(name)}", body)
        return CommandInvoked(AgentInfo.parse(answer["agent"]), SlashCommand.parseAll(answer["slashCommands"]))
    }

    /**
     * The computer's global skills a new chat offers before it has an agent
     * (API.md `GET /v0/skills`), as skill commands: only the enabled, ready
     * ones, in the catalog's order, each name once (two folders may share
     * one; an agent offers it once). Read 100 a page; a catalog that changed
     * between pages (`409`) is read again from the start. `404` or `501` is
     * a computer without skills: none.
     */
    open suspend fun skills(): List<SlashCommand> {
        repeat(SKILL_READS) {
            val skills = ArrayList<SlashCommand>()
            var cursor: String? = null
            try {
                do {
                    val query = "limit=100" + (cursor?.let { "&pageCursor=${escape(it)}" } ?: "")
                    val page = call("GET", "/v0/skills?$query")
                    page["skills"].arr.orEmpty().mapNotNullTo(skills, SlashCommand::globalSkill)
                    cursor = page["nextPageCursor"].str
                } while (cursor != null)
                return skills.distinctBy { it.name }
            } catch (e: ConversationApiException) {
                when (e.status) {
                    404, 501 -> return emptyList()
                    409 -> Unit
                    else -> throw e
                }
            }
        }
        throw ConversationApiException(409, "conflict", null)
    }

    open suspend fun abort(agentId: String) {
        call("POST", "/v0/agents/${escape(agentId)}/abort", JsonObject(emptyMap()))
    }

    open suspend fun markRead(agentId: String) {
        call("POST", "/v0/agents/${escape(agentId)}/read", JsonObject(emptyMap()))
    }

    /** A failed turn run again: the failure's message, now carrying its resolution. */
    open suspend fun retry(agentId: String, messageId: String): Message? = Message.parse(
        call("POST", "/v0/agents/${escape(agentId)}/messages/${escape(messageId)}/retry", buildJsonObject { put("mutationId", clientId()) })["message"],
    )

    /** Saves the draft (text with the mode it goes with); the answer is what is kept, maybe a newer one. */
    open suspend fun saveDraft(agentId: String, text: String, mode: Mode, updatedAt: Long): Draft? {
        val body = buildJsonObject {
            put("draft", JsonObject(mode.json() + ("text" to JsonPrimitive(text))))
            put("updatedAt", updatedAt)
            put("mutationId", clientId())
        }
        return Draft.parse(call("PUT", "/v0/agents/${escape(agentId)}/draft", body)["draft"])
    }

    /** The open question, or null. */
    open suspend fun question(agentId: String): Question? = Question.parse(call("GET", "/v0/agents/${escape(agentId)}/question")["question"])

    /** First answer wins; a late one is 409. */
    open suspend fun answer(agentId: String, questionId: String, answers: Map<String, List<String>>) {
        val body = buildJsonObject {
            put("answers", JsonObject(answers.mapValues { (_, values) -> JsonArray(values.map(::JsonPrimitive)) }))
            put("mutationId", clientId())
        }
        call("POST", "/v0/agents/${escape(agentId)}/question/${escape(questionId)}/answer", body)
    }

    /** The bytes of one item a tool call presented (`media` presentation). */
    open suspend fun media(agentId: String, toolCallId: String, index: Int): ByteArray {
        val response = request("GET", mediaPath(agentId, toolCallId, index), null, RequestCategory.File)
        if (response.status !in 200..299) decode(response)
        return response.body
    }

    /**
     * The secrets an agent may be given (API.md "Secrets"), as safe
     * metadata: names and variable names, never a value.
     */
    open suspend fun secrets(): List<SecretSummary> =
        call("GET", "/v0/secrets")["secrets"].arr.orEmpty().mapNotNull { SecretSummary.parse(it) }.filter { it.availableToAgents }

    /**
     * Makes a secret from the values the person typed and answers with its
     * id alone. The values go in this one request and nowhere else: not a
     * draft, not saved state, not a log, not an error.
     */
    open suspend fun createSecret(id: String?, description: String?, values: Map<String, String>): String {
        val body = buildJsonObject {
            id?.takeIf { it.isNotBlank() }?.let { put("id", it) }
            description?.takeIf { it.isNotBlank() }?.let { put("description", it) }
            put("environment", buildJsonObject { values.forEach { (name, value) -> put(name, value) } })
            put("availableToAgents", true)
            put("mutationId", clientId())
        }
        return call("POST", "/v0/secrets", body)["secret"].obj?.get("id").str ?: throw invalid()
    }

    /** A todo list's active todos, then its completed ones (API.md "Surfaces"). */
    open suspend fun todos(surfaceId: String): List<Todo> {
        val path = "/v0/surfaces/todo/${escape(surfaceId)}"
        fun parse(answer: JsonObject) = answer["todos"].arr.orEmpty().mapNotNull { item ->
            val o = item.obj ?: return@mapNotNull null
            Todo(o["id"].str ?: return@mapNotNull null, o["text"].str.orEmpty(), o["status"].str == "completed")
        }
        return parse(call("GET", path)) + parse(call("GET", "$path?scope=completed"))
    }

    /** A new todo at the top of the list; [id] is its retry key. */
    open suspend fun addTodo(surfaceId: String, id: String, text: String) {
        call("POST", "/v0/surfaces/todo/${escape(surfaceId)}", buildJsonObject {
            put("id", id)
            put("text", text)
            put("mutationId", clientId())
        })
    }

    /** A document as Markdown, its read-only projection. */
    open suspend fun document(surfaceId: String): String =
        call("GET", "/v0/surfaces/document/${escape(surfaceId)}")["document"].obj?.get("text").str.orEmpty()

    companion object {
        private val json = Json { ignoreUnknownKeys = true }
        private val random = SecureRandom()
        private const val ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
        /** Reads of the skills catalog before one that keeps changing under its pages is given up. */
        private const val SKILL_READS = 3

        fun escape(component: String): String = URLEncoder.encode(component, "UTF-8").replace("+", "%20")

        /** One item a tool call presented; it answers a `Range` with that range (`206`). */
        fun mediaPath(agentId: String, toolCallId: String, index: Int): String =
            "/v0/agents/${escape(agentId)}/tool-calls/${escape(toolCallId)}/media/$index"

        /** A CUID2-shaped id the daemon accepts from a client (`^[a-z][a-z0-9]+$`, 24 long). */
        fun clientId(): String = buildString {
            append(ALPHABET[random.nextInt(26)])
            repeat(23) { append(ALPHABET[random.nextInt(ALPHABET.length)]) }
        }

        fun decode(response: TransportResponse): JsonObject {
            if (response.status == 401) throw AgentConnectionException(AgentConnectionException.Reason.Revoked)
            val body = try {
                if (response.body.isEmpty()) JsonObject(emptyMap()) else json.parseToJsonElement(response.text).obj
            } catch (_: Exception) {
                null
            }
            if (response.status !in 200..299) throw ConversationApiException(response.status, body?.get("code").str, body?.get("error").str)
            return body ?: throw invalid()
        }

        /** `config.defaults` (provider, model, effort, permission mode), the effort else the model's own default. */
        fun defaultModeOf(config: JsonObject): Mode? {
            val root = config["config"].obj ?: config
            val defaults = root["defaults"].obj ?: return null
            val providerId = defaults["providerId"].str ?: return null
            val modelId = defaults["modelId"].str ?: return null
            val effort = defaults["effort"].str ?: root["models"].obj?.get(modelId).obj?.get("defaultEffort").str ?: "medium"
            return Mode(providerId, modelId, effort, defaults["serviceTier"].str, defaults["permissionMode"].str ?: "auto")
        }

        private fun invalid() = AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
    }
}
