package com.slopus.happy.testing

import com.slopus.happy.crypto.AccountEncryption
import com.slopus.happy.crypto.AuthChallenge
import com.slopus.happy.crypto.Sodium
import com.slopus.happy.crypto.decodeBase64
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.net.HappyJson
import com.slopus.happy.sync.ApiMachine
import com.slopus.happy.sync.ApiMessage
import com.slopus.happy.sync.ApiMessageContent
import com.slopus.happy.sync.ApiMessagePage
import com.slopus.happy.sync.ApiSession
import com.slopus.happy.sync.ApiSessionPage
import com.slopus.happy.sync.ApiSettings
import com.slopus.happy.sync.ApiSettingsUpdate
import com.slopus.happy.sync.ApiSettingsUpdateResult
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList

/**
 * An in-memory happy-server with the routes the app calls, following the
 * real routes' contracts (authRoutes.ts, sessionRoutes.ts /v2/sessions,
 * v3SessionRoutes.ts, machinesRoutes.ts, accountRoutes.ts). It encrypts its
 * records the way the CLI does, for the account [secret].
 */
class FakeHappyServer(val secret: ByteArray = ByteArray(32) { (it * 7 + 1).toByte() }) {
    val encryption: AccountEncryption = AccountEncryption.create(secret)
    val server = MockWebServer()
    val requests = CopyOnWriteArrayList<RecordedRequest>()

    val sessions = mutableListOf<ApiSession>()
    val messages = mutableMapOf<String, MutableList<ApiMessage>>()
    val machines = mutableListOf<ApiMachine>()
    var settings: String? = null
    var settingsVersion = 0L
    var profile: JsonObject = buildJsonObject { put("id", "account-1") }
    var failProfile = false

    /** Next settings POSTs that lose a race: before checking, the server's settings move on to this. */
    val settingsRaces = ArrayDeque<JsonObject>()

    private val dataKeys = mutableMapOf<String, ByteArray>()

    fun start(): FakeHappyServer {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                return synchronized(this@FakeHappyServer) { route(request) }
            }
        }
        server.start()
        return this
    }

    fun close() = server.close()

    val url: String get() = server.url("/").toString().trimEnd('/')

    fun requestsTo(path: String): List<RecordedRequest> = requests.filter { it.url.encodedPath == path }

    // Fixtures

    fun dataKey(id: String): ByteArray = dataKeys.getOrPut(id) { AccountEncryption.generateDataKey() }

    private fun wrap(id: String): String = encodeBase64(encryption.encryptDataEncryptionKey(dataKey(id)))

    fun seal(id: String, value: JsonElement): String = encryption.dataKeyCipher(dataKey(id)).encryptToBase64(value)

    fun addSession(
        id: String,
        updatedAt: Long,
        metadata: JsonObject = buildJsonObject { put("path", "/repo/$id") },
        seq: Long = 0,
        legacy: Boolean = false,
    ) = synchronized(this) {
        sessions.removeAll { it.id == id }
        sessions += ApiSession(
            id = id,
            seq = seq,
            createdAt = 1,
            updatedAt = updatedAt,
            active = true,
            activeAt = updatedAt,
            metadata = if (legacy) encodeBase64(ByteArray(40)) else seal(id, metadata),
            metadataVersion = 1,
            agentState = null,
            agentStateVersion = 0,
            dataEncryptionKey = if (legacy) null else wrap(id),
        )
    }

    fun addMessage(sessionId: String, seq: Long, content: JsonObject, updatedAt: Long) = synchronized(this) {
        messages.getOrPut(sessionId) { mutableListOf() } += ApiMessage(
            id = "msg-$sessionId-$seq",
            seq = seq,
            content = ApiMessageContent(t = "encrypted", c = seal(sessionId, content)),
            createdAt = updatedAt,
            updatedAt = updatedAt,
        )
        val session = sessions.first { it.id == sessionId }
        sessions[sessions.indexOf(session)] = session.copy(seq = maxOf(session.seq, seq), updatedAt = updatedAt)
    }

    fun addMachine(id: String) = synchronized(this) {
        machines += ApiMachine(
            id = id, seq = 1, createdAt = 1, updatedAt = 1, active = true, activeAt = 1,
            metadata = seal(id, buildJsonObject { put("host", id) }), metadataVersion = 1,
            daemonState = null, daemonStateVersion = 0, dataEncryptionKey = wrap(id),
        )
    }

    fun setSettings(value: JsonObject, version: Long) = synchronized(this) {
        settings = encryption.settingsCipher().encryptToBase64(value)
        settingsVersion = version
    }

    fun settingsJson(): JsonObject? = settings?.let { encryption.settingsCipher().decryptFromBase64(it)?.jsonObject }

    /** The public key [secret] signs in with. */
    val publicKey: String get() = encodeBase64(AuthChallenge.create(secret).publicKey)

    /** A JWT-shaped token whose `sub` is the account id. */
    val token: String = listOf(
        """{"alg":"none"}""",
        """{"sub":"account-1"}""",
        "sig",
    ).joinToString(".") { Base64.getUrlEncoder().withoutPadding().encodeToString(it.toByteArray()) }

    // Routes

    private fun route(request: RecordedRequest): MockResponse {
        val path = request.url.encodedPath
        val query = { name: String -> request.url.queryParameter(name) }
        if (path == "/" && request.method == "GET") return text("Welcome to Happy Server!")
        if (path == "/v1/auth" && request.method == "POST") return auth(request)
        if (request.headers["Authorization"] != "Bearer $token") return json(401, """{"error":"Unauthorized"}""")

        return when {
            path == "/v2/sessions" -> {
                val limit = query("limit")?.toInt() ?: 50
                val changedSince = query("changedSince")?.toLong()
                val cursor = query("cursor")?.removePrefix("cursor_v1_")
                val matching = sessions
                    .filter { changedSince == null || it.updatedAt > changedSince }
                    .filter { cursor == null || it.id < cursor }
                    .sortedByDescending { it.id }
                val page = matching.take(limit)
                val hasNext = matching.size > limit
                json(200, HappyJson.encodeToString(ApiSessionPage.serializer(), ApiSessionPage(page, if (hasNext) "cursor_v1_${page.last().id}" else null, hasNext)))
            }
            path.startsWith("/v3/sessions/") && path.endsWith("/messages") -> {
                val id = path.removePrefix("/v3/sessions/").removeSuffix("/messages")
                if (sessions.none { it.id == id }) return json(404, """{"error":"Session not found"}""")
                val after = query("after_seq")?.toLong() ?: 0
                val limit = query("limit")?.toInt() ?: 100
                val matching = messages[id].orEmpty().filter { it.seq > after }.sortedBy { it.seq }
                json(200, HappyJson.encodeToString(ApiMessagePage.serializer(), ApiMessagePage(matching.take(limit), matching.size > limit)))
            }
            path == "/v1/machines" -> json(200, HappyJson.encodeToString(ListSerializer(ApiMachine.serializer()), machines))
            path == "/v1/account/profile" -> if (failProfile) json(500, """{"error":"boom"}""") else json(200, profile.toString())
            path == "/v1/account/settings" && request.method == "GET" ->
                json(200, HappyJson.encodeToString(ApiSettings.serializer(), ApiSettings(settings, settingsVersion)))
            path == "/v1/account/settings" && request.method == "POST" -> {
                settingsRaces.removeFirstOrNull()?.let { setSettings(it, settingsVersion + 1) }
                val body = HappyJson.decodeFromString(ApiSettingsUpdate.serializer(), request.body!!.utf8())
                val result = if (body.expectedVersion != settingsVersion) {
                    ApiSettingsUpdateResult(success = false, error = "version-mismatch", currentVersion = settingsVersion, currentSettings = settings)
                } else {
                    settings = body.settings
                    settingsVersion += 1
                    ApiSettingsUpdateResult(success = true, version = settingsVersion)
                }
                json(200, HappyJson.encodeToString(ApiSettingsUpdateResult.serializer(), result))
            }
            else -> json(404, """{"error":"Not found"}""")
        }
    }

    /** Public keys that signed in, in order. */
    val authenticatedKeys = CopyOnWriteArrayList<String>()

    /** authRoutes.ts POST /v1/auth: any key with a valid signature gets a token (and an account). */
    private fun auth(request: RecordedRequest): MockResponse {
        val body = HappyJson.parseToJsonElement(request.body!!.utf8()).jsonObject
        val publicKey = decodeBase64(body.getValue("publicKey").jsonPrimitive.content)
        val challenge = decodeBase64(body.getValue("challenge").jsonPrimitive.content)
        val signature = decodeBase64(body.getValue("signature").jsonPrimitive.content)
        if (!Sodium.signVerifyDetached(signature, challenge, publicKey)) return json(401, """{"error":"Invalid signature"}""")
        authenticatedKeys += encodeBase64(publicKey)
        return json(200, """{"success":true,"token":"$token"}""")
    }

    private fun json(code: Int, body: String) = MockResponse.Builder()
        .code(code)
        .addHeader("Content-Type", "application/json")
        .body(body)
        .build()

    private fun text(body: String) = MockResponse.Builder().code(200).addHeader("Content-Type", "text/plain").body(body).build()
}
