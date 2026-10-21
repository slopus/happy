package com.slopus.happy.net

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** A non-2xx response. [body] is kept for the few endpoints that put a result in an error status. */
class HttpStatusException(val status: Int, val body: String) : IOException("HTTP $status")

val HappyJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
}

/**
 * JSON over HTTPS to the Happy server. Every request carries the
 * `X-Happy-Client` header (apiSocket.ts getHappyClientId) and, when signed in,
 * the bearer token. The server URL is read per request so a changed server
 * applies immediately.
 */
class HappyHttp(
    private val client: OkHttpClient,
    private val serverUrl: () -> String,
    private val clientId: String,
) {
    suspend fun <T> get(
        path: String,
        response: KSerializer<T>,
        token: String? = null,
        query: Map<String, String> = emptyMap(),
    ): T {
        val url = (serverUrl() + path).toHttpUrl().newBuilder().apply {
            query.forEach { (key, value) -> addQueryParameter(key, value) }
        }.build()
        return HappyJson.decodeFromString(response, execute(request(token).url(url).get().build()))
    }

    suspend fun <B, T> post(
        path: String,
        body: B,
        bodySerializer: KSerializer<B>,
        response: KSerializer<T>,
        token: String? = null,
        acceptStatus: (Int) -> Boolean = { it in 200..299 },
    ): T {
        val json = HappyJson.encodeToString(bodySerializer, body)
        val request = request(token)
            .url(serverUrl() + path)
            .post(json.toRequestBody(JSON))
            .build()
        return HappyJson.decodeFromString(response, execute(request, acceptStatus))
    }

    /**
     * Any method, a raw JSON body (or none), the response body as text.
     * Non-2xx throws [HttpStatusException].
     */
    suspend fun send(
        method: String,
        path: String,
        token: String? = null,
        jsonBody: String? = null,
        query: Map<String, String> = emptyMap(),
    ): String {
        val url = (serverUrl() + path).toHttpUrl().newBuilder().apply {
            query.forEach { (key, value) -> addQueryParameter(key, value) }
        }.build()
        val body = jsonBody?.toRequestBody(JSON) ?: if (method == "POST" || method == "PUT") ByteArray(0).toRequestBody(null) else null
        return execute(request(token).url(url).method(method, body).build())
    }

    /** GET an absolute URL as text (server probe). */
    suspend fun getText(url: String): String =
        execute(Request.Builder().url(url).header("Accept", "text/plain").get().build())

    private fun request(token: String?): Request.Builder = Request.Builder()
        .header("X-Happy-Client", clientId)
        .apply { if (token != null) header("Authorization", "Bearer $token") }

    private suspend fun execute(request: Request, acceptStatus: (Int) -> Boolean = { it in 200..299 }): String =
        client.newCall(request).await().use { response ->
            val text = response.body.string()
            if (!acceptStatus(response.code)) throw HttpStatusException(response.code, text)
            text
        }

    private companion object {
        val JSON = "application/json".toMediaType()
    }
}

private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) = continuation.resume(response) { _, _, _ -> response.close() }
        override fun onFailure(call: Call, e: IOException) = continuation.resumeWithException(e)
    })
}
