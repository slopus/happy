package com.slopus.happy.documents

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.decode
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.documents.yjs.YDoc
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.Base64

/** Who made a change, as the daemon names them. */
@Serializable
data class DocumentActor(val userId: String? = null, val agentId: String? = null)

/** One entry of a document's permanent change log, without its bytes. */
@Serializable
data class DocumentChange(
    val seq: Int,
    val actor: DocumentActor = DocumentActor(),
    /** `api` (a person's editor), `tool` (an agent) or `conversion`. */
    val source: String = "api",
    val mutationId: String? = null,
    val createdAt: Double = 0.0,
    val size: Int = 0,
)

/** `GET /state`: the document, or what a state vector lacks, as one update. */
class DocumentState(val seq: Int, val update: ByteArray, val stateVector: Map<Long, Int>)

/** A live `document.update` frame. */
@Serializable
data class DocumentUpdateFrame(
    val surfaceId: String,
    val seq: Int,
    val update: String,
    val mutationId: String? = null,
    val actor: DocumentActor = DocumentActor(),
    val source: String = "api",
)

/** A live `document.presence` frame: one other editor's awareness, or its leaving. */
@Serializable
data class DocumentPresenceFrame(
    val surfaceId: String,
    val clientKey: String,
    val revision: Int,
    val active: Boolean,
    val awarenessClientId: Long? = null,
    val update: String? = null,
)

/**
 * The collaborative document routes (happy-agent-client `HappyAgentClient`,
 * `getSurfaceDocumentState` … `sendSurfaceDocumentPresence`; iOS's
 * `DocumentRoutes`).
 */
object DocumentRoutes {
    private fun path(surfaceId: String, route: String? = null) =
        "/v0/surfaces/document/${AgentClient.escape(surfaceId)}" + (route?.let { "/$it" } ?: "")

    private fun base64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    private fun invalid(cause: Throwable? = null) = AgentConnectionException(AgentConnectionException.Reason.InvalidResponse).also { if (cause != null) it.initCause(cause) }

    /**
     * Whether the computer keeps documents as shared Yjs state
     * (`capabilities.collaborativeDocuments`); older ones only serve Markdown.
     */
    suspend fun collaborativeDocuments(client: AgentClient): Boolean {
        val health = client.decode<JsonObject>("GET", "/v0/health")
        return (health["capabilities"] as? JsonObject)?.get("collaborativeDocuments")?.let { (it as? JsonPrimitive)?.booleanOrNull } == true
    }

    /** The document as of now, of [seq], or only what [stateVector] lacks. */
    suspend fun state(client: AgentClient, surfaceId: String, stateVector: Map<Long, Int>? = null, seq: Int? = null): DocumentState {
        val query = buildList {
            if (stateVector != null) add("stateVector=" + AgentClient.escape(base64(YDoc.encodeStateVector(stateVector))))
            if (seq != null) add("seq=$seq")
        }
        val response = client.send("GET", path(surfaceId, "state") + if (query.isEmpty()) "" else "?" + query.joinToString("&"), category = RequestCategory.File)
        return try {
            val body = AgentClient.json.parseToJsonElement(response.text).jsonObject
            DocumentState(
                seq = body["seq"]!!.jsonPrimitive.doubleOrNull!!.toInt(),
                update = Base64.getDecoder().decode(body["update"]!!.jsonPrimitive.content),
                stateVector = YDoc.decodeStateVector(Base64.getDecoder().decode(body["stateVector"]!!.jsonPrimitive.content)),
            )
        } catch (e: Exception) {
            throw invalid(e)
        }
    }

    /** Stores one change; the same [mutationId] again returns its first `seq`. */
    suspend fun sendUpdate(client: AgentClient, surfaceId: String, mutationId: String, update: ByteArray): Int {
        val body = client.decode<JsonObject>("POST", path(surfaceId, "updates"), buildJsonObject {
            put("mutationId", mutationId)
            put("update", base64(update))
        })
        return body["seq"]?.jsonPrimitive?.doubleOrNull?.toInt() ?: throw invalid()
    }

    /** The change log, oldest first, after [afterSeq]; and where the next page starts. */
    suspend fun changes(client: AgentClient, surfaceId: String, afterSeq: Int = 0, limit: Int = 200): Pair<List<DocumentChange>, Int?> {
        val body = client.decode<JsonObject>("GET", path(surfaceId, "updates") + "?afterSeq=$afterSeq&limit=$limit")
        // One entry this phone can't read is skipped, not the page.
        val changes = (body["updates"] as? JsonArray).orEmpty().mapNotNull {
            runCatching { AgentClient.json.decodeFromJsonElement(DocumentChange.serializer(), it) }.getOrNull()
        }
        return changes to body["nextAfterSeq"]?.let { (it as? JsonPrimitive)?.doubleOrNull?.toInt() }
    }

    /** The Markdown projection, now or as of [seq]. */
    suspend fun markdown(client: AgentClient, surfaceId: String, seq: Int? = null): Pair<String, Int?> {
        val body = client.decode<JsonObject>("GET", path(surfaceId) + (seq?.let { "?seq=$it" } ?: ""))
        val document = body["document"] as? JsonObject ?: throw invalid()
        val text = (document["text"] as? JsonPrimitive)?.contentOrNull ?: throw invalid()
        return text to (document["seq"] as? JsonPrimitive)?.doubleOrNull?.toInt()
    }

    /** Sends this document's live frames to the stream named [streamId]; answers its head `seq`. */
    suspend fun subscribe(client: AgentClient, surfaceId: String, streamId: String): Int? {
        val body = client.decode<JsonObject>("POST", path(surfaceId, "subscribe"), buildJsonObject { put("streamId", streamId) })
        return body["seq"]?.let { (it as? JsonPrimitive)?.doubleOrNull?.toInt() }
    }

    suspend fun unsubscribe(client: AgentClient, surfaceId: String, streamId: String) {
        client.send("POST", path(surfaceId, "unsubscribe"), buildJsonObject { put("streamId", streamId) })
    }

    /** Relays an awareness update to the document's other editors; never stored. */
    suspend fun sendPresence(client: AgentClient, surfaceId: String, streamId: String, awarenessClientId: Long, update: ByteArray) {
        client.send("POST", path(surfaceId, "presence"), buildJsonObject {
            put("streamId", streamId)
            put("awarenessClientId", awarenessClientId)
            put("update", base64(update))
        }, category = RequestCategory.Realtime)
    }

    /** Renames a Surface for everyone in it (`capabilities.surfaceEditing`); the latest name wins. */
    suspend fun rename(client: AgentClient, surfaceId: String, name: String, mutationId: String = AgentClient.newId()) {
        client.send("PATCH", "/v0/surfaces/${AgentClient.escape(surfaceId)}", buildJsonObject {
            put("name", name)
            put("mutationId", mutationId)
        })
    }

    internal fun decodeUpdate(frame: String): DocumentUpdateFrame? =
        runCatching { AgentClient.json.decodeFromString(DocumentUpdateFrame.serializer(), frame) }.getOrNull()

    internal fun decodePresence(frame: String): DocumentPresenceFrame? =
        runCatching { AgentClient.json.decodeFromString(DocumentPresenceFrame.serializer(), frame) }.getOrNull()
}
