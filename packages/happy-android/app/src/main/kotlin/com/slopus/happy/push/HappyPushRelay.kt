package com.slopus.happy.push

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** A send capability, never a printable model or a notification payload. */
class HappyPushToken private constructor(internal val value: String) {
    override fun toString() = "HappyPushToken(…)"

    companion object {
        private val pattern = Regex("HappyPushToken\\[[0-9A-Za-z]{22}\\]")
        fun parse(value: String): HappyPushToken? = if (pattern.matches(value)) HappyPushToken(value) else null
    }
}

/** Neither HTTP bodies nor provider/native tokens are included in diagnostics. */
class HappyPushExchangeException : IOException("Happy push registration failed")

/** Native FCM → Happy relay capability. No Cloud bearer, redirects, or global unregister here. */
class HappyPushRelay internal constructor(client: OkHttpClient, private val url: String = URL) {
    private val http = client.newBuilder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build()

    suspend fun exchange(nativeToken: String, deviceId: String, appId: String, locale: String?): HappyPushToken {
        try {
            require(nativeToken.isNotBlank())
            val installation = UUID.fromString(deviceId).toString()
            require(appId in CloudPushApi.APP_IDS)
            val body = buildJsonObject {
                put("deviceId", installation)
                put("appId", appId)
                put("platform", "android")
                put("provider", "fcm")
                put("pushToken", nativeToken)
                locale?.let { put("metadata", buildJsonObject { put("locale", it) }) }
            }
            val request = Request.Builder().url(url)
                .post(body.toString().toByteArray().toRequestBody("application/json".toMediaType())).build()
            val text = http.newCall(request).awaitPush().use { response ->
                if (response.code != 200) throw HappyPushExchangeException()
                val source = response.body.source()
                source.request(8_193)
                if (source.buffer.size > 8_192) throw HappyPushExchangeException()
                response.body.string()
            }
            val value = ((Json.parseToJsonElement(text) as? JsonObject)?.get("token") as? JsonPrimitive)
                ?.takeIf { it.isString }?.content ?: throw HappyPushExchangeException()
            return HappyPushToken.parse(value) ?: throw HappyPushExchangeException()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Error bodies may echo request credentials. Deliberately do not retain the cause.
            throw HappyPushExchangeException()
        }
    }

    companion object {
        const val URL = "https://push.cluster-fluster.com/v1/devices/register"
    }
}

private suspend fun Call.awaitPush(): Response = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) = continuation.resume(response) { _, _, _ -> response.close() }
        override fun onFailure(call: Call, e: IOException) = continuation.resumeWithException(e)
    })
}