package com.slopus.happy.conversation

import com.slopus.happy.chat.arr
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.TransportResponse
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.URLEncoder
import java.security.SecureRandom

/** A refused request: the daemon's status, with its error `code` and words when it sent them. */
class ConversationApiException(val status: Int, val code: String?, override val message: String?) : Exception(message)

/** One request to the paired agent, answered whatever its status; the agent connection's client does the transport. */
typealias AgentRequest = suspend (method: String, path: String, body: JsonElement?) -> TransportResponse

/** The client-chosen ids of a task made on first send (`POST /v0/tasks`); the same ids again are the same task. */
data class NewTask(val taskId: String, val workspaceId: String, val agentId: String, val mutationId: String) {
    companion object {
        fun make() = NewTask(ConversationApi.clientId(), ConversationApi.clientId(), ConversationApi.clientId(), ConversationApi.clientId())
    }
}

/**
 * The conversation routes of the Happy Agent API (API.md, "Agents",
 * "Tasks"), each one a device token may use. 401 is
 * [AgentConnectionException.Reason.Revoked]; any other non-2xx is a
 * [ConversationApiException].
 */
open class ConversationApi(private val request: AgentRequest) {

    private suspend fun call(method: String, path: String, body: JsonElement? = null): JsonObject = decode(request(method, path, body))

    /** A new chat: a task, its folder and its one agent, made together. Answers `{task, membership}`. */
    open suspend fun createTask(task: NewTask): JsonObject = call(
        "POST",
        "/v0/tasks",
        buildJsonObject {
            put("id", task.taskId)
            put("workspaceId", task.workspaceId)
            put("agentId", task.agentId)
            put("mutationId", task.mutationId)
        },
    ).takeIf { it["task"].obj != null } ?: throw invalid()

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

    /** The newest runs, or the runs before [before]. Tool data is left out where a presentation stands for it. */
    open suspend fun messages(agentId: String, before: String? = null, limit: Int = 100): MessagesPage {
        val query = StringBuilder("limit=$limit&omitToolData=true")
        before?.let { query.append("&before=").append(escape(it)) }
        return MessagesPage.parse(call("GET", "/v0/agents/${escape(agentId)}/messages?$query")) ?: throw invalid()
    }

    /** The models a message can run with, and the mode new work is sent with when nothing was picked. */
    open suspend fun catalog(): ModeCatalog = ModeCatalog.parse(call("GET", "/v0/config"))

    /**
     * Sends [text] (and pictures) under the client's [id]: the same id again
     * is the same message. Always steering, as desktop sends: mid-turn it is
     * taken at the next boundary; idle, it starts a run.
     */
    open suspend fun send(agentId: String, id: String, text: String, images: List<Block.Image>, mode: Mode): Message? {
        val body = buildJsonObject {
            put("id", id)
            // The API requires top-level text; a picture alone goes with a short caption.
            put("text", if (text.isEmpty() && images.isNotEmpty()) (if (images.size == 1) "Attached image." else "Attached images.") else text)
            put("delivery", "steer")
            put("clientMetadata", buildJsonObject { put("composer", "mobile") })
            if (images.isNotEmpty()) put("content", buildJsonArray {
                images.forEach { add(buildJsonObject { put("type", "image"); put("mimeType", it.mimeType); put("data", it.data) }) }
            })
            put("mode", mode.json())
        }
        return Message.parse(call("POST", "/v0/agents/${escape(agentId)}/send", body)["message"])
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
        val response = request("GET", "/v0/agents/${escape(agentId)}/tool-calls/${escape(toolCallId)}/media/$index", null)
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

    /** One artifact as the catalog has it (API.md "Artifacts"). */
    open suspend fun artifact(artifactId: String): JsonObject =
        call("GET", "/v0/artifacts/${escape(artifactId)}")["artifact"].obj ?: throw invalid()

    /** A version's manifest: its title, its entry's path and every file it holds. [number] or `latest`. */
    open suspend fun artifactVersion(artifactId: String, number: String = "latest"): JsonObject =
        call("GET", "/v0/artifacts/${escape(artifactId)}/versions/${escape(number)}")["version"].obj ?: throw invalid()

    /** Tombstones stay readable, but their versions and files no longer do (API.md). */
    open suspend fun readArtifact(artifactId: String): Artifact? {
        val metadata = artifact(artifactId)
        val version = if (Artifact.isDeleted(metadata)) JsonObject(emptyMap()) else artifactVersion(artifactId)
        return Artifact.parse(metadata, version)
    }

    /** The bytes of one file of one version, asked for by its exact manifest path. */
    open suspend fun artifactFile(artifactId: String, number: String, path: String): ByteArray {
        val route = path.split('/').joinToString("/") { escape(it) }
        val response = request("GET", "/v0/artifacts/${escape(artifactId)}/versions/${escape(number)}/files/$route", null)
        if (response.status !in 200..299) decode(response)
        return response.body
    }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }
        private val random = SecureRandom()
        private const val ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

        fun escape(component: String): String = URLEncoder.encode(component, "UTF-8").replace("+", "%20")

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
