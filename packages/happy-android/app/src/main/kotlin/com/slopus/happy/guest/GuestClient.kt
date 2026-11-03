package com.slopus.happy.guest

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * The guest's own transport to the invitation bridge at [origin] (happy-ios
 * HappyGuest/GuestClient.swift, docs/APP-CLIP.md "Bridge contract"): its own
 * HTTP client with no cookies, cache or redirects, and no owner token,
 * recovery key, account or agent connection anywhere near it. A request
 * waits up to 35 s for the bridge's 25 s poll.
 */
class GuestClient(private val origin: String, client: OkHttpClient = OkHttpClient()) {
    private val http = client.newBuilder()
        .cache(null)
        .cookieJar(okhttp3.CookieJar.NO_COOKIES)
        .followRedirects(false)
        .followSslRedirects(false)
        .readTimeout(35, TimeUnit.SECONDS)
        .callTimeout(35, TimeUnit.SECONDS)
        .build()
    private val seen = HashSet<String>()

    suspend fun redeem(invitation: GuestInvitation, redeemNonce: String, displayName: String): GuestSession {
        val name = GuestDisplayName.normalized(displayName) ?: throw GuestError.InvalidName
        val body = json.encodeToString(Redeem.serializer(), Redeem(invitation.token, redeemNonce, name))
        val session = decode(GuestSession.serializer(), call(listOf("v1", "bot-invites", "redeem"), body = body))
        if (!validSessionId(session.sessionId) || session.sessionToken.isEmpty()) throw GuestError.InvalidResponse
        return session
    }

    suspend fun messages(session: GuestSession, after: String?): GuestMessages {
        if (!validSessionId(session.sessionId)) throw GuestError.InvalidResponse
        return decode(GuestMessages.serializer(), call(listOf("v1", "bot-guest", "sessions", session.sessionId, "messages"), token = session.sessionToken, after = after))
    }

    suspend fun send(session: GuestSession, localId: String, text: String) {
        if (!validSessionId(session.sessionId)) throw GuestError.InvalidResponse
        if (text.isEmpty() || text.length > MESSAGE_LIMIT) throw GuestSendRejection.InvalidMessage
        val body = json.encodeToString(Send.serializer(), Send(localId, text))
        call(listOf("v1", "bot-guest", "sessions", session.sessionId, "messages"), token = session.sessionToken, body = body, sending = true)
    }

    suspend fun report(session: GuestSession) = action("report", session)

    /** Revokes this guest's own session; the others in the chat keep theirs. */
    suspend fun block(session: GuestSession) = action("block", session)

    private suspend fun action(action: String, session: GuestSession) {
        if (!validSessionId(session.sessionId)) throw GuestError.InvalidResponse
        call(listOf("v1", "bot-guest", "sessions", session.sessionId, action), token = session.sessionToken, body = "{}")
    }

    /**
     * The lines [messages] add to the transcript, each once however often a
     * page repeats it: the bot's under its name, the guest's own as You, and
     * another member's under the name the bridge gives them. A name inside
     * a message is only text.
     */
    fun append(messages: List<GuestMessage>, botName: String): List<GuestLine> = messages.mapNotNull { message ->
        if (!seen.add(message.id)) return@mapNotNull null
        val sender = when {
            message.role == "assistant" -> GuestSender.Bot(botName)
            message.isMine == false -> GuestSender.Member(message.senderName)
            else -> GuestSender.You
        }
        GuestLine(message.id, sender, message.text)
    }

    private suspend fun call(path: List<String>, token: String? = null, after: String? = null, body: String? = null, sending: Boolean = false): String {
        val url = origin.toHttpUrlOrNull()?.newBuilder()?.apply {
            path.forEach(::addPathSegment)
            if (body == null) {
                addQueryParameter("wait", "25")
                if (after != null) addQueryParameter("after", after)
            }
        }?.build() ?: throw GuestError.InvalidResponse
        val request = Request.Builder().url(url).header("Content-Type", "application/json").apply {
            if (token != null) header("Authorization", "Bearer $token")
            if (body != null) post(body.toRequestBody(JSON)) else get()
        }.build()
        // The body is read off the main thread, where a screen's coroutine may well be.
        val (status, text, retryAfter) = withContext(Dispatchers.IO) {
            http.newCall(request).await().use { Triple(it.code, it.body.string(), it.header("Retry-After")) }
        }
        fun code() = try {
            (json.parseToJsonElement(text) as? JsonObject)?.get("code")?.jsonPrimitive?.contentOrNull
        } catch (_: Exception) {
            null
        }
        when {
            status in 200..299 -> return text
            sending && status in listOf(400, 409, 413, 422) -> throw GuestSendRejection.InvalidMessage
            status == 400 && !sending && code() == "invalid_name" -> throw GuestError.InvalidName
            status == 409 -> throw GuestError.AlreadyRedeemed
            status == 401 || status == 404 -> throw GuestError.Revoked
            status == 403 -> throw GuestError.ReadOnly
            status == 410 -> throw if (code() == "invite_full") GuestError.InviteFull else GuestError.Expired
            status == 429 || status == 503 -> {
                if (sending && code() == "limit_reached") throw GuestSendRejection.LimitReached
                val delay = retryAfter?.toDoubleOrNull() ?: 1.0
                throw GuestError.RetryAfter(delay.coerceIn(1.0, 3600.0))
            }
            else -> throw GuestError.Unavailable
        }
    }

    private fun <T> decode(serializer: kotlinx.serialization.KSerializer<T>, text: String): T = try {
        json.decodeFromString(serializer, text)
    } catch (_: Exception) {
        throw GuestError.InvalidResponse
    }

    @Serializable private data class Redeem(val token: String, val redeemNonce: String, val displayName: String)

    @Serializable private data class Send(val localId: String, val text: String)

    companion object {
        /** The bridge's limit, in UTF-16 code units, as iOS counts it. */
        const val MESSAGE_LIMIT = 4_000

        private val JSON = "application/json".toMediaType()
        private val json = Json { ignoreUnknownKeys = true }
        private val SESSION_ID = Regex("[A-Za-z0-9_-]{1,128}")

        fun validSessionId(id: String) = SESSION_ID.matches(id)
    }
}

/** Who said a line of the guest chat. */
sealed interface GuestSender {
    data object You : GuestSender
    data class Member(val name: String?) : GuestSender
    data class Bot(val name: String) : GuestSender
}

data class GuestLine(val id: String, val sender: GuestSender, val text: String)

private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) = continuation.resume(response) { _, _, _ -> response.close() }
        override fun onFailure(call: Call, e: IOException) = continuation.resumeWithException(e)
    })
    continuation.invokeOnCancellation { cancel() }
}
