package com.slopus.happy.projects

import com.slopus.happy.attachments.rewriteLoopbackHost
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.net.HappyJson
import com.slopus.happy.net.HttpStatusException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.net.URLEncoder
import kotlin.coroutines.resumeWithException

/** projectTypes.ts `ApiProjectAvatar`: an opaque ref and an encrypted preview. */
data class ApiProjectAvatar(val ref: String, val preview: String, val version: Long)

/** projectTypes.ts `ApiProjectRecord`: metadata and preview are ciphertext. */
data class ApiProjectRecord(
    val id: String,
    val externalId: String,
    val metadata: String,
    val metadataVersion: Long,
    val dataEncryptionKey: String?,
    val avatar: ApiProjectAvatar?,
    val createdAt: Long,
    val updatedAt: Long,
)

class ProjectHttpException(val status: Int, message: String) : IOException(message)

private fun JsonElement?.string(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
private fun JsonElement?.number(): Long? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.let { it.longOrNull ?: it.doubleOrNull?.takeIf(Double::isFinite)?.toLong() }

private fun parseAvatar(value: JsonElement?): ApiProjectAvatar? {
    val json = value as? JsonObject ?: return null
    val ref = json["ref"].string()?.takeIf { it.isNotEmpty() } ?: return null
    val preview = json["preview"].string()?.takeIf { it.isNotEmpty() } ?: return null
    val version = json["version"].number() ?: return null
    return ApiProjectAvatar(ref, preview, version)
}

/**
 * apiProjects.ts `asProjectRecord`: a record of any other shape is dropped.
 * A malformed non-null avatar drops the whole record, so ciphertext of an
 * unexpected shape never reaches image decoding.
 */
fun parseProjectRecord(value: JsonElement?): ApiProjectRecord? {
    val json = value as? JsonObject ?: return null
    val id = json["id"].string()?.takeIf { it.isNotEmpty() } ?: return null
    val externalId = json["externalId"].string()?.takeIf { it.isNotEmpty() } ?: return null
    val metadata = json["metadata"].string()?.takeIf { it.isNotEmpty() } ?: return null
    val metadataVersion = json["metadataVersion"].number() ?: return null
    val keyElement = json["dataEncryptionKey"]
    val dataEncryptionKey = when {
        keyElement == null -> return null
        keyElement is JsonPrimitive && keyElement.contentOrNull == null -> null
        else -> keyElement.string() ?: return null
    }
    val createdAt = json["createdAt"].number() ?: return null
    val updatedAt = json["updatedAt"].number() ?: return null
    val avatarElement = json["avatar"]
    val avatar = if (avatarElement == null || avatarElement is JsonPrimitive && avatarElement.contentOrNull == null) {
        null
    } else {
        parseAvatar(avatarElement) ?: return null
    }
    return ApiProjectRecord(id, externalId, metadata, metadataVersion, dataEncryptionKey, avatar, createdAt, updatedAt)
}

/**
 * apiProjects.ts: the account's project records and avatar bytes. Only
 * opaque values travel here; nothing is decrypted. Server calls go
 * through [http]; the granted avatar URL (often presigned storage) is
 * fetched with [client], carrying the token only when it is the server's.
 */
class ProjectApi(
    private val http: HappyHttp,
    private val client: OkHttpClient,
    private val serverUrl: () -> String,
) {
    /** fetchProjects: the records behind [projectIds], 100 per request; a 404 batch is none. */
    suspend fun fetch(token: String, projectIds: Collection<String>): List<ApiProjectRecord> {
        val ids = projectIds.filter { it.isNotEmpty() }.distinct()
        val projects = mutableListOf<ApiProjectRecord>()
        for (batch in ids.chunked(BATCH_SIZE)) {
            val text = try {
                http.send("GET", "/v1/projects", token, query = mapOf("ids" to batch.joinToString(",")))
            } catch (e: HttpStatusException) {
                if (e.status == 404) continue
                throw e
            }
            val body = runCatching { HappyJson.parseToJsonElement(text) }.getOrNull() as? JsonObject
            val values = body?.get("projects") as? JsonArray ?: continue
            values.mapNotNullTo(projects, ::parseProjectRecord)
        }
        return projects
    }

    /** downloadProjectAvatar: the server grants the active avatar (no body: the client cannot choose one), then the bytes. */
    suspend fun downloadAvatar(token: String, projectId: String): ByteArray {
        val server = serverUrl()
        val text = http.send("POST", "/v1/projects/${encodePathSegment(projectId)}/avatar/request-download", token)
        val raw = (runCatching { HappyJson.parseToJsonElement(text) }.getOrNull() as? JsonObject)?.get("downloadUrl")
            ?.let { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
            ?.takeIf { it.isNotEmpty() }
            ?: throw IOException("Project avatar download response did not include downloadUrl")
        val url = rewriteLoopbackHost(raw, server)
        val download = Request.Builder().url(url).apply { if (sameOrigin(url, server)) header("Authorization", "Bearer $token") }.get().build()
        return client.newCall(download).await().use { response ->
            if (!response.isSuccessful) throw ProjectHttpException(response.code, "Failed to download project avatar: ${response.code}")
            response.body.bytes()
        }
    }

    private companion object {
        const val BATCH_SIZE = 100
    }
}

/** encodeURIComponent for one path segment. */
private fun encodePathSegment(value: String): String = URLEncoder.encode(value, "UTF-8").replace("+", "%20")

/** apiProjects.ts isServerHostedUrl: by origin, else by prefix. */
internal fun sameOrigin(url: String, serverUrl: String): Boolean {
    val target = url.toHttpUrlOrNull()
    val server = serverUrl.toHttpUrlOrNull()
    if (target == null || server == null) return url.startsWith(serverUrl)
    return target.scheme == server.scheme && target.host == server.host && target.port == server.port
}

private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) = continuation.resume(response) { _, _, _ -> response.close() }
        override fun onFailure(call: Call, e: IOException) = continuation.resumeWithException(e)
    })
    continuation.invokeOnCancellation { cancel() }
}
