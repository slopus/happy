package com.slopus.happy.sync

import com.slopus.happy.net.HappyHttp
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject

// Wire shapes of the happy-server routes the sync reads, as they are today
// (sessionRoutes.ts, v3SessionRoutes.ts, machinesRoutes.ts, accountRoutes.ts;
// message content per happy-wire SessionMessageContentSchema). Encrypted
// fields are base64 strings.

@Serializable
data class ApiSession(
    val id: String,
    val seq: Long,
    val createdAt: Long,
    val updatedAt: Long,
    val active: Boolean,
    val activeAt: Long,
    val metadata: String,
    val metadataVersion: Long,
    val agentState: String? = null,
    val agentStateVersion: Long,
    /** Null only on sessions from the retired protocol, which this app does not read. */
    val dataEncryptionKey: String? = null,
    val projectId: String? = null,
)

@Serializable
data class ApiSessionPage(val sessions: List<ApiSession>, val nextCursor: String? = null, val hasNext: Boolean = false)

@Serializable
data class ApiMessageContent(val t: String, val c: String)

@Serializable
data class ApiMessage(
    val id: String,
    val seq: Long,
    val localId: String? = null,
    val content: ApiMessageContent,
    val createdAt: Long,
    val updatedAt: Long,
)

@Serializable
data class ApiMessagePage(val messages: List<ApiMessage>, val hasMore: Boolean = false)

@Serializable
data class ApiMachine(
    val id: String,
    val seq: Long,
    val createdAt: Long,
    val updatedAt: Long,
    val active: Boolean,
    val activeAt: Long,
    val metadata: String,
    val metadataVersion: Long,
    val daemonState: String? = null,
    val daemonStateVersion: Long,
    val dataEncryptionKey: String? = null,
)

@Serializable
data class ApiSettings(val settings: String? = null, val settingsVersion: Long)

@Serializable
data class ApiSettingsUpdate(val settings: String, val expectedVersion: Long)

/** `success` with the new `version`, or `version-mismatch` with the server's copy. */
@Serializable
data class ApiSettingsUpdateResult(
    val success: Boolean,
    val version: Long? = null,
    val error: String? = null,
    val currentVersion: Long? = null,
    val currentSettings: String? = null,
)

/** The authenticated read endpoints delta sync uses. */
class SyncApi(private val http: HappyHttp, private val token: String) {

    /** Sessions by id, newest first; with [changedSince], only those updated after it (ms). */
    suspend fun sessions(cursor: String?, changedSince: Long?, limit: Int): ApiSessionPage = http.get(
        path = "/v2/sessions",
        response = ApiSessionPage.serializer(),
        token = token,
        query = buildMap {
            put("limit", limit.toString())
            if (cursor != null) put("cursor", cursor)
            if (changedSince != null) put("changedSince", changedSince.toString())
        },
    )

    /** Messages with seq > [afterSeq], oldest first. */
    suspend fun messagesAfter(sessionId: String, afterSeq: Long, limit: Int): ApiMessagePage = http.get(
        path = "/v3/sessions/$sessionId/messages",
        response = ApiMessagePage.serializer(),
        token = token,
        query = mapOf("after_seq" to afterSeq.toString(), "limit" to limit.toString()),
    )

    suspend fun machines(): List<ApiMachine> = http.get(
        path = "/v1/machines",
        response = ListSerializer(ApiMachine.serializer()),
        token = token,
    )

    suspend fun settings(): ApiSettings = http.get(
        path = "/v1/account/settings",
        response = ApiSettings.serializer(),
        token = token,
    )

    suspend fun updateSettings(settings: String, expectedVersion: Long): ApiSettingsUpdateResult = http.post(
        path = "/v1/account/settings",
        body = ApiSettingsUpdate(settings, expectedVersion),
        bodySerializer = ApiSettingsUpdate.serializer(),
        response = ApiSettingsUpdateResult.serializer(),
        token = token,
    )

    suspend fun profile(): JsonObject = http.get(
        path = "/v1/account/profile",
        response = JsonObject.serializer(),
        token = token,
    )
}
