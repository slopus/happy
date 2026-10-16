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
import com.slopus.happy.net.EngineIoHandshake
import com.slopus.happy.net.EngineIoPacket
import com.slopus.happy.net.SocketIoPacket
import com.slopus.happy.sync.ApiOutgoingMessages
import com.slopus.happy.sync.ApiStoredMessage
import com.slopus.happy.sync.ApiStoredMessages
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * An in-memory happy-server with the routes the app calls, following the
 * real routes' contracts (authRoutes.ts, sessionRoutes.ts /v2/sessions,
 * v3SessionRoutes.ts, machinesRoutes.ts, accountRoutes.ts). It encrypts its
 * records the way the CLI does, for the account [secret].
 *
 * `/v1/updates/` speaks Socket.IO over WebSocket like socket.ts: the auth
 * middleware, `update`/`ephemeral` emits ([emitUpdate], [emitEphemeral]),
 * `rpc-call` routed to [rpc] handlers, `update-metadata` with version
 * checks, and the `new-message` echo of every POSTed message.
 */
class FakeHappyServer(secret: ByteArray = ByteArray(32) { (it * 7 + 1).toByte() }) {
    var secret: ByteArray = secret
        private set
    var encryption: AccountEncryption = AccountEncryption.create(secret)
        private set

    /**
     * The account the app created itself (Create account draws a random
     * secret): records from here on are sealed for it. Call before adding any.
     */
    fun adoptAccount(secret: ByteArray) = synchronized(this) {
        this.secret = secret
        encryption = AccountEncryption.create(secret)
    }
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

    fun close() {
        sockets.forEach { it.close(1001, null) }
        server.close()
    }

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
        active: Boolean = true,
    ) = synchronized(this) {
        sessions.removeAll { it.id == id }
        sessions += ApiSession(
            id = id,
            seq = seq,
            createdAt = 1,
            updatedAt = updatedAt,
            active = active,
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

    fun session(id: String): ApiSession? = synchronized(this) { sessions.firstOrNull { it.id == id } }

    fun machine(id: String): ApiMachine? = synchronized(this) { machines.firstOrNull { it.id == id } }

    fun addMachine(id: String, metadata: JsonObject = buildJsonObject { put("host", id) }, updatedAt: Long = 1) = synchronized(this) {
        machines.removeAll { it.id == id }
        machines += ApiMachine(
            id = id, seq = 1, createdAt = 1, updatedAt = updatedAt, active = true, activeAt = updatedAt,
            metadata = seal(id, metadata), metadataVersion = 1,
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
        if (path == "/v1/auth/request/status" && request.method == "GET") return terminalStatus(query("publicKey"))
        if (path == "/v1/auth/account/request" && request.method == "POST") return accountRequest(request)
        if (path == "/v1/updates/") return MockResponse.Builder().webSocketUpgrade(SocketConnection()).build()
        if (request.headers["Authorization"] != "Bearer $token") return json(401, """{"error":"Unauthorized"}""")

        return when {
            path.startsWith("/v1/sessions/") && "/attachments/" in path -> attachmentRoute(request)
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
            path.startsWith("/v3/sessions/") && path.endsWith("/messages") && request.method == "POST" -> {
                val id = path.removePrefix("/v3/sessions/").removeSuffix("/messages")
                failSends.removeFirstOrNull()?.let { return json(it, """{"error":"boom"}""") }
                if (sessions.none { it.id == id }) return json(404, """{"error":"Session not found"}""")
                val body = HappyJson.decodeFromString(ApiOutgoingMessages.serializer(), request.body!!.utf8())
                // sendMessagesBodySchema: 1 to 100 messages.
                if (body.messages.size !in 1..100) return json(400, """{"error":"Invalid body"}""")
                json(200, HappyJson.encodeToString(ApiStoredMessages.serializer(), ApiStoredMessages(storeSent(id, body))))
            }
            path.startsWith("/v3/sessions/") && path.endsWith("/messages") -> {
                val id = path.removePrefix("/v3/sessions/").removeSuffix("/messages")
                failPages.removeFirstOrNull()?.let { return json(it, """{"error":"boom"}""") }
                if (sessions.none { it.id == id }) return json(404, """{"error":"Session not found"}""")
                pageOverride?.invoke(request)?.let { return json(200, HappyJson.encodeToString(ApiMessagePage.serializer(), it)) }
                val limit = query("limit")?.toInt() ?: 100
                val before = query("before_seq")?.toLong()
                val matching = if (before != null) {
                    messages[id].orEmpty().filter { it.seq < before }.sortedByDescending { it.seq }
                } else {
                    val after = query("after_seq")?.toLong() ?: 0
                    messages[id].orEmpty().filter { it.seq > after }.sortedBy { it.seq }
                }
                json(200, HappyJson.encodeToString(ApiMessagePage.serializer(), ApiMessagePage(matching.take(limit), matching.size > limit)))
            }
            path.startsWith("/v1/sessions/") && path.endsWith("/archive") && request.method == "POST" -> {
                val id = path.removePrefix("/v1/sessions/").removeSuffix("/archive")
                val index = sessions.indexOfFirst { it.id == id }
                if (index < 0) return json(404, """{"error":"Session not found"}""")
                // Prisma's @updatedAt: the change reaches the next delta sync.
                sessions[index] = sessions[index].copy(active = false, updatedAt = ++clock)
                json(200, """{"success":true}""")
            }
            path.startsWith("/v1/sessions/") && request.method == "DELETE" -> {
                val id = path.removePrefix("/v1/sessions/")
                if (!sessions.removeAll { it.id == id }) return json(404, """{"error":"Session not found"}""")
                messages.remove(id)
                json(200, """{"success":true}""")
            }
            path.startsWith("/v1/machines/") && request.method == "DELETE" -> {
                val id = path.removePrefix("/v1/machines/")
                if (!machines.removeAll { it.id == id }) return json(404, """{"error":"Machine not found"}""")
                json(200, """{"success":true}""")
            }
            path.startsWith("/v1/push-tokens/") && request.method == "DELETE" -> json(200, """{"success":true}""")
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
            path == "/v1/auth/response" && request.method == "POST" -> answer(request, terminalRequests.mapValues { it.value.response }) { key, response ->
                terminalRequests.getValue(key).response = response
            }
            path == "/v1/auth/account/response" && request.method == "POST" -> answer(request, accountRequests) { key, response ->
                accountRequests[key] = response
            }
            else -> json(404, """{"error":"Not found"}""")
        }
    }

    // Attachments (attachmentRoutes.ts): local storage by default, S3 presigned when [presignedStorageUrl] is set.

    /** Stored encrypted blobs by ref. */
    val attachments = mutableMapOf<String, ByteArray>()

    /** The base URL the server names in the URLs it hands out (resolveBaseUrl); this server's own by default. */
    var attachmentBaseUrl: String? = null

    /** S3 mode: request-upload answers a POST policy for this storage URL, request-download a presigned GET under it. */
    var presignedStorageUrl: String? = null

    /** Next request-upload statuses to fail with. */
    val failAttachmentUploads = ArrayDeque<Int>()

    private fun attachmentRoute(request: RecordedRequest): MockResponse {
        val path = request.url.encodedPath
        val sessionId = path.removePrefix("/v1/sessions/").substringBefore("/")
        val action = path.substringAfter("/attachments/")
        if (sessions.none { it.id == sessionId }) return json(404, """{"error":"Session not found"}""")
        val base = attachmentBaseUrl ?: url
        val prefix = "sessions/$sessionId/attachments/"
        return when {
            action == "request-upload" && request.method == "POST" -> {
                failAttachmentUploads.removeFirstOrNull()?.let { return json(it, """{"error":"nope"}""") }
                val size = HappyJson.parseToJsonElement(request.body!!.utf8()).jsonObject["size"]!!.jsonPrimitive.long
                if (size > 10 * 1024 * 1024) return json(413, """{"error":"File too large (max 10MB)"}""")
                val file = "${java.util.UUID.randomUUID()}.enc"
                val storage = presignedStorageUrl
                if (storage == null) {
                    json(200, buildJsonObject {
                        put("ref", prefix + file)
                        put("uploadUrl", "$base/v1/sessions/$sessionId/attachments/$file")
                        put("method", "PUT")
                    }.toString())
                } else {
                    json(200, buildJsonObject {
                        put("ref", prefix + file)
                        put("uploadUrl", storage)
                        put("method", "POST")
                        put("formFields", buildJsonObject {
                            put("key", prefix + file)
                            put("policy", "secret-policy")
                            put("X-Amz-Signature", "s3-secret")
                        })
                    }.toString())
                }
            }
            action == "request-download" && request.method == "POST" -> {
                val ref = HappyJson.parseToJsonElement(request.body!!.utf8()).jsonObject["ref"]!!.jsonPrimitive.content
                if (!ref.startsWith(prefix)) return json(400, """{"error":"Ref does not belong to this session"}""")
                val storage = presignedStorageUrl
                val downloadUrl = if (storage == null) {
                    "$base/v1/sessions/$sessionId/attachments/${ref.removePrefix(prefix)}"
                } else {
                    "$storage/$ref?X-Amz-Signature=s3-secret"
                }
                json(200, buildJsonObject { put("downloadUrl", downloadUrl) }.toString())
            }
            request.method == "PUT" -> {
                val body = request.body!!.toByteArray()
                if (body.size > 10 * 1024 * 1024) return json(413, """{"error":"File too large (max 10MB)"}""")
                attachments[prefix + action] = body
                json(200, """{"ok":true}""")
            }
            request.method == "GET" -> attachments[prefix + action]
                ?.let { MockResponse.Builder().code(200).addHeader("Content-Type", "application/octet-stream").body(okio.Buffer().write(it)).build() }
                ?: json(404, """{"error":"Attachment not found"}""")
            else -> json(404, """{"error":"Not found"}""")
        }
    }

    // POST /v3/sessions/:id/messages

    /** Status codes the next message POSTs fail with, in order. */
    val failSends = ArrayDeque<Int>()

    /** Answers message GETs instead of the stored messages when it returns non-null (a misbehaving server). */
    var pageOverride: ((RecordedRequest) -> ApiMessagePage?)? = null

    /** Status codes the next message GETs fail with, in order. */
    val failPages = ArrayDeque<Int>()

    /** Whether a stored message's `new-message` echo goes out on the socket (the server always sends it). */
    var echoSentMessages = true

    private var clock = 10_000L

    /** v3SessionRoutes.ts: dedupe on localId, assign seqs, echo each new message to every socket. */
    private fun storeSent(sessionId: String, body: ApiOutgoingMessages): List<ApiStoredMessage> {
        val list = messages.getOrPut(sessionId) { mutableListOf() }
        val created = mutableListOf<ApiMessage>()
        val response = mutableListOf<ApiMessage>()
        for (message in body.messages.distinctBy { it.localId }) {
            val existing = list.firstOrNull { it.localId == message.localId }
            if (existing != null) {
                response += existing
                continue
            }
            val seq = (list.maxOfOrNull { it.seq } ?: 0) + 1
            val stored = ApiMessage(
                id = "msg-$sessionId-$seq",
                seq = seq,
                localId = message.localId,
                content = ApiMessageContent(t = "encrypted", c = message.content),
                createdAt = ++clock,
                updatedAt = clock,
            )
            list += stored
            created += stored
            response += stored
            val index = sessions.indexOfFirst { it.id == sessionId }
            sessions[index] = sessions[index].copy(seq = seq, updatedAt = clock)
        }
        if (echoSentMessages) {
            for (message in created) emitUpdate(newMessageBody(sessionId, message))
        }
        return response.sortedBy { it.seq }.map { ApiStoredMessage(it.id, it.seq, it.localId, it.createdAt, it.updatedAt) }
    }

    /** What the server stored for a session, decrypted. */
    fun sentRecords(sessionId: String): List<Pair<String?, JsonObject>> = synchronized(this) {
        messages[sessionId].orEmpty().map { it.localId to encryption.dataKeyCipher(dataKey(sessionId)).decryptFromBase64(it.content.c)!!.jsonObject }
    }

    // The updates socket

    /** Client sockets connected now. */
    val sockets = CopyOnWriteArrayList<WebSocket>()

    /** Every handshake auth payload, in order. */
    val socketAuths = CopyOnWriteArrayList<JsonObject>()

    /** Every event the clients emitted (name, first argument), in order. */
    val socketEvents = LinkedBlockingQueue<Pair<String, JsonElement?>>()

    var pingIntervalMs = 15_000L
    var pingTimeoutMs = 45_000L

    /** When false, the server answers a handshake with connect_error, as the auth middleware does for a bad token. */
    var acceptSockets = true

    /** RPC methods a daemon or session registered: full method name to a handler of the encrypted params. */
    val rpc = mutableMapOf<String, (params: JsonElement) -> JsonElement>()

    /** Acks the server holds back (rpc-call method names), to test timeouts. */
    val silentRpc = mutableSetOf<String>()

    private val updateSeq = AtomicLong()

    /** Waits for the next client event with [name]. */
    fun awaitEvent(name: String, timeoutMs: Long = 5_000): JsonElement? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val left = deadline - System.currentTimeMillis()
            check(left > 0) { "no '$name' event within ${timeoutMs}ms" }
            val event = socketEvents.poll(left, TimeUnit.MILLISECONDS) ?: continue
            if (event.first == name) return event.second
        }
    }

    fun awaitSockets(count: Int, timeoutMs: Long = 5_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (sockets.size < count) {
            check(System.currentTimeMillis() < deadline) { "${sockets.size} sockets, wanted $count" }
            Thread.sleep(10)
        }
    }

    /** eventRouter.emitUpdate: an `update` with the next account update seq. */
    fun emitUpdate(body: JsonObject, createdAt: Long = ++clock) {
        val container = buildJsonObject {
            put("id", "upd-${updateSeq.incrementAndGet()}")
            put("seq", updateSeq.get())
            put("body", body)
            put("createdAt", createdAt)
        }
        emit("update", container)
    }

    fun emitEphemeral(payload: JsonObject) = emit("ephemeral", payload)

    fun emit(name: String, payload: JsonElement) {
        val text = EngineIoPacket.Message(SocketIoPacket.Event(name, listOf(payload)).encode()).encode()
        sockets.forEach { it.send(text) }
    }

    /** Drops every socket, as a server restart or a network blip would. */
    fun dropSockets() {
        val dropped = sockets.toList()
        sockets.clear()
        dropped.forEach { it.close(1001, "going away") }
    }

    fun newMessageBody(sessionId: String, message: ApiMessage) = buildJsonObject {
        put("t", "new-message")
        put("sid", sessionId)
        put("message", HappyJson.encodeToJsonElement(ApiMessage.serializer(), message))
    }

    /** Adds a message to a session and returns it, without telling anyone. */
    fun appendMessage(sessionId: String, content: JsonObject, localId: String? = null): ApiMessage = synchronized(this) {
        val list = messages.getOrPut(sessionId) { mutableListOf() }
        val seq = (list.maxOfOrNull { it.seq } ?: 0) + 1
        val message = ApiMessage(
            id = "msg-$sessionId-$seq",
            seq = seq,
            localId = localId,
            content = ApiMessageContent(t = "encrypted", c = seal(sessionId, content)),
            createdAt = ++clock,
            updatedAt = clock,
        )
        list += message
        val index = sessions.indexOfFirst { it.id == sessionId }
        sessions[index] = sessions[index].copy(seq = seq, updatedAt = clock)
        message
    }

    private inner class SocketConnection : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            val handshake = EngineIoHandshake(sid = "eio-${sockets.size}", pingInterval = pingIntervalMs, pingTimeout = pingTimeoutMs, maxPayload = 8_388_608)
            webSocket.send(EngineIoPacket.Open(handshake).encode())
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val packet = EngineIoPacket.decode(text) as? EngineIoPacket.Message ?: return
            when (val message = SocketIoPacket.decode(packet.payload)) {
                is SocketIoPacket.Connect -> {
                    val auth = message.payload as? JsonObject ?: JsonObject(emptyMap())
                    socketAuths += auth
                    val reply = if (acceptSockets && auth["token"]?.jsonPrimitive?.contentOrNull == token) {
                        sockets += webSocket
                        SocketIoPacket.Connect(buildJsonObject { put("sid", "sio-${sockets.size}") })
                    } else {
                        SocketIoPacket.ConnectError(buildJsonObject { put("message", "Invalid authentication token") })
                    }
                    webSocket.send(EngineIoPacket.Message(reply.encode()).encode())
                }
                is SocketIoPacket.Event -> {
                    val payload = message.arguments.firstOrNull()
                    socketEvents += message.name to payload
                    val ack = synchronized(this@FakeHappyServer) { answer(message.name, payload) }
                    if (message.ackId != null && ack != null) {
                        webSocket.send(EngineIoPacket.Message(SocketIoPacket.Ack(message.ackId!!, listOf(ack)).encode()).encode())
                    }
                }
                SocketIoPacket.Disconnect -> sockets.remove(webSocket)
                else -> Unit
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            sockets.remove(webSocket)
            webSocket.close(1000, null)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            sockets.remove(webSocket)
        }
    }

    /** What the server acknowledges an event with, or null to stay silent. */
    private fun answer(name: String, payload: JsonElement?): JsonElement? {
        val body = payload as? JsonObject ?: return null
        return when (name) {
            "rpc-call" -> {
                val method = body["method"]?.jsonPrimitive?.contentOrNull ?: return buildJsonObject {
                    put("ok", false)
                    put("error", "Invalid parameters: method is required")
                }
                if (method in silentRpc) return null
                val handler = rpc[method] ?: return buildJsonObject {
                    put("ok", false)
                    put("error", "RPC method not available")
                }
                buildJsonObject {
                    put("ok", true)
                    put("result", handler(body["params"] ?: JsonNull))
                }
            }
            "update-metadata" -> {
                val sid = body["sid"]?.jsonPrimitive?.contentOrNull
                val index = sessions.indexOfFirst { it.id == sid }
                if (index < 0) return buildJsonObject { put("result", "error") }
                val session = sessions[index]
                val expected = body["expectedVersion"]!!.jsonPrimitive.long
                if (expected != session.metadataVersion) {
                    return buildJsonObject {
                        put("result", "version-mismatch")
                        put("version", session.metadataVersion)
                        put("metadata", session.metadata)
                    }
                }
                val metadata = body["metadata"]!!.jsonPrimitive.content
                sessions[index] = session.copy(metadata = metadata, metadataVersion = expected + 1)
                emitUpdate(buildJsonObject {
                    put("t", "update-session")
                    put("id", session.id)
                    put("metadata", buildJsonObject {
                        put("value", metadata)
                        put("version", expected + 1)
                    })
                })
                buildJsonObject {
                    put("result", "success")
                    put("version", expected + 1)
                    put("metadata", metadata)
                }
            }
            "machine-update-metadata" -> {
                val id = body["machineId"]?.jsonPrimitive?.contentOrNull
                val index = machines.indexOfFirst { it.id == id }
                if (index < 0) return buildJsonObject { put("result", "error"); put("message", "Machine not found") }
                val machine = machines[index]
                val expected = body["expectedVersion"]!!.jsonPrimitive.long
                if (expected != machine.metadataVersion) {
                    return buildJsonObject {
                        put("result", "version-mismatch")
                        put("version", machine.metadataVersion)
                        put("metadata", machine.metadata)
                    }
                }
                val metadata = body["metadata"]!!.jsonPrimitive.content
                machines[index] = machine.copy(metadata = metadata, metadataVersion = expected + 1)
                buildJsonObject {
                    put("result", "success")
                    put("version", expected + 1)
                    put("metadata", metadata)
                }
            }
            else -> null
        }
    }

    /** Opens what a sessionRPC or machineRPC sent, with the record's data key. */
    fun openRpc(recordId: String, params: JsonElement): JsonElement =
        encryption.dataKeyCipher(dataKey(recordId)).decryptFromBase64(params.jsonPrimitive.content)!!

    /** Seals an RPC answer the way the daemon does. */
    fun sealRpc(recordId: String, result: JsonElement): JsonElement = JsonPrimitive(seal(recordId, result))

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

    // Device and terminal linking (authRoutes.ts)

    class TerminalRequest(val supportsV2: Boolean, var response: String? = null)

    /** Terminals waiting to be approved, by base64 box public key (what `/v1/auth/request` would create). */
    val terminalRequests = mutableMapOf<String, TerminalRequest>()

    /** New phones' account link requests, by base64 box public key, with the approval once given. */
    val accountRequests = mutableMapOf<String, String?>()

    fun addTerminalRequest(publicKey: ByteArray, supportsV2: Boolean) = synchronized(this) {
        terminalRequests[encodeBase64(publicKey)] = TerminalRequest(supportsV2)
    }

    /** A phone that has the account approves a link request, as `/v1/auth/account/response` does. */
    fun approveAccountRequest(publicKey: ByteArray, response: ByteArray) = synchronized(this) {
        accountRequests[encodeBase64(publicKey)] = encodeBase64(response)
    }

    private fun boxKey(value: String?): String? =
        value?.let { runCatching { decodeBase64(it) }.getOrNull() }?.takeIf { it.size == 32 }?.let { encodeBase64(it) }

    private fun terminalStatus(publicKey: String?): MockResponse {
        val request = boxKey(publicKey)?.let { terminalRequests[it] }
            ?: return json(200, """{"status":"not_found","supportsV2":false}""")
        if (request.response != null) return json(200, """{"status":"authorized","supportsV2":false}""")
        return json(200, """{"status":"pending","supportsV2":${request.supportsV2}}""")
    }

    private fun accountRequest(request: RecordedRequest): MockResponse {
        val body = HappyJson.parseToJsonElement(request.body!!.utf8()).jsonObject
        val key = boxKey(body.getValue("publicKey").jsonPrimitive.content) ?: return json(401, """{"error":"Invalid public key"}""")
        val response = accountRequests.getOrPut(key) { null }
            ?: return json(200, """{"state":"requested"}""")
        return json(200, """{"state":"authorized","token":"$token","response":"$response"}""")
    }

    /** `/v1/auth/response` and `/v1/auth/account/response`: the first answer to a known request sticks. */
    private fun answer(request: RecordedRequest, pending: Map<String, String?>, store: (String, String) -> Unit): MockResponse {
        val body = HappyJson.parseToJsonElement(request.body!!.utf8()).jsonObject
        val key = boxKey(body.getValue("publicKey").jsonPrimitive.content) ?: return json(401, """{"error":"Invalid public key"}""")
        if (key !in pending) return json(404, """{"error":"Request not found"}""")
        if (pending[key] == null) store(key, body.getValue("response").jsonPrimitive.content)
        return json(200, """{"success":true}""")
    }

    private fun json(code: Int, body: String) = MockResponse.Builder()
        .code(code)
        .addHeader("Content-Type", "application/json")
        .body(body)
        .build()

    private fun text(body: String) = MockResponse.Builder().code(200).addHeader("Content-Type", "text/plain").body(body).build()
}
