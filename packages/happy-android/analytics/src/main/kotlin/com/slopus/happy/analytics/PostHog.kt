package com.slopus.happy.analytics

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * PostHog's `/batch/` and `/flags`, without its SDK, so nothing goes but
 * what we build; the SDK would add the device's name, screen and time zone.
 * A redirect is never followed, and only [host] is ever asked: an https one,
 * or a loopback http capture endpoint ([AnalyticsTarget]).
 */
internal class PostHog(http: OkHttpClient, private val apiKey: String, private val host: String = HOST) {
    private val http = http.newBuilder().followRedirects(false).followSslRedirects(false).build()

    init {
        require(allowedHost(host)) { "not a host analytics may use" }
    }

    enum class Outcome {
        Sent,
        /** PostHog will never take this batch (a 4xx other than a timeout or rate limit): it is dropped. */
        Refused,
        /** Not this time (offline, a 5xx, a redirect): the batch stays queued. */
        Failed,
    }

    /** `{api_key, batch: [{event, timestamp, properties}]}`, timestamps in whole seconds. */
    suspend fun send(events: List<QueuedEvent>): Outcome = withContext(Dispatchers.IO) {
        try {
            http.newCall(post("batch/", body(apiKey, events))).execute().use { response ->
                when {
                    response.isSuccessful -> Outcome.Sent
                    response.code in 400..499 && response.code != 408 && response.code != 429 -> Outcome.Refused
                    else -> Outcome.Failed
                }
            }
        } catch (_: IOException) {
            Outcome.Failed
        }
    }

    /** `/flags?v=2` for [distinctId]: the flags that are on. Throws when PostHog didn't answer. */
    suspend fun flags(distinctId: String): Set<String> = withContext(Dispatchers.IO) {
        val body = JsonObject(mapOf("api_key" to JsonPrimitive(apiKey), "distinct_id" to JsonPrimitive(distinctId)))
        val text = http.newCall(post("flags/?v=2", body)).execute().use { response ->
            if (!response.isSuccessful) throw IOException("PostHog flags: HTTP ${response.code}")
            response.body.string()
        }
        parseFlags(Json.parseToJsonElement(text).jsonObject)
    }

    private fun post(path: String, body: JsonObject) = Request.Builder()
        .url("${host.trimEnd('/')}/$path")
        .post(body.toString().toRequestBody("application/json".toMediaType()))
        .build()

    companion object {
        /** The US host Happy Desktop and happy-ios send to. */
        const val HOST = "https://us.i.posthog.com"

        /** An https host, or http to this machine (a debug run's capture endpoint). */
        fun allowedHost(host: String): Boolean {
            val url = host.toHttpUrlOrNull() ?: return false
            return url.scheme == "https" || url.host == "127.0.0.1" || url.host == "localhost"
        }

        fun body(apiKey: String, events: List<QueuedEvent>): JsonObject = JsonObject(
            mapOf(
                "api_key" to JsonPrimitive(apiKey),
                "batch" to JsonArray(events.map { event ->
                    JsonObject(
                        mapOf(
                            "event" to JsonPrimitive(event.event),
                            "timestamp" to JsonPrimitive(Instant.ofEpochMilli(event.at).truncatedTo(ChronoUnit.SECONDS).toString()),
                            "properties" to event.properties,
                        ),
                    )
                }),
            ),
        )

        fun parseFlags(response: JsonObject): Set<String> {
            val flags = response["flags"] as? JsonObject ?: return emptySet()
            return flags.filter { (_, flag) -> (flag as? JsonObject)?.get("enabled")?.jsonPrimitive?.booleanOrNull == true }.keys
        }
    }
}
