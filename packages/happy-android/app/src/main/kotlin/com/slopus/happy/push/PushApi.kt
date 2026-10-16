package com.slopus.happy.push

import com.slopus.happy.net.HappyHttp
import com.slopus.happy.net.HappyJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import java.net.URLEncoder
import kotlin.math.max
import kotlin.random.Random

/**
 * happy-server's push token routes (apiPush.ts) for this device's
 * registration. Like happy-app, every call retries until it succeeds
 * ([backoff]); cancel the caller to stop it. Settings lists the account's
 * tokens with its own `PushTokensApi`.
 */
class PushApi(
    private val http: HappyHttp,
    private val retryDelay: suspend (failures: Int) -> Unit = ::backoffDelay,
) {
    /** POST /v1/push-tokens */
    suspend fun register(authToken: String, pushToken: String) = backoff {
        val body = HappyJson.encodeToString(JsonObject.serializer(), JsonObject(mapOf("token" to JsonPrimitive(pushToken))))
        requireSuccess(http.send("POST", "/v1/push-tokens", token = authToken, jsonBody = body), "register")
    }

    /** DELETE /v1/push-tokens/:token */
    suspend fun unregister(authToken: String, pushToken: String) = backoff {
        val path = "/v1/push-tokens/" + URLEncoder.encode(pushToken, "UTF-8").replace("+", "%20")
        requireSuccess(http.send("DELETE", path, token = authToken), "unregister")
    }

    private fun requireSuccess(response: String, what: String) {
        val success = (HappyJson.parseToJsonElement(response).jsonObject["success"] as? JsonPrimitive)?.booleanOrNull
        check(success == true) { "Failed to $what push token" }
    }

    /** utils/time.ts backoff: try until it works. */
    private suspend fun <T> backoff(block: suspend () -> T): T {
        var failures = 0
        while (true) {
            try {
                return block()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                if (failures < MAX_FAILURES) failures++
                retryDelay(failures)
            }
        }
    }

    companion object {
        private const val MAX_FAILURES = 50
        private const val MIN_DELAY_MS = 250.0
        private const val MAX_DELAY_MS = 1000.0

        /** exponentialBackoffDelay(failures, 250, 1000, 50) */
        suspend fun backoffDelay(failures: Int) {
            val ceiling = MIN_DELAY_MS + ((MAX_DELAY_MS - MIN_DELAY_MS) / MAX_FAILURES) * max(failures, MAX_FAILURES)
            delay(Math.round(Random.nextDouble() * ceiling))
        }
    }
}
