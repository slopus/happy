package com.slopus.happy.config

import android.content.SharedPreferences
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * PostHog's feature flags, without its SDK: the flags that are on for an
 * account's analytics id (happy-app identifies PostHog with the same
 * `anonID`), kept per id on this phone so the next start reads the last
 * answer at once. A flag that is off, not yet asked, or whose ask failed
 * reads as off; a failed refresh keeps the last answer.
 */
class FeatureFlags(
    private val prefs: SharedPreferences,
    /** The flags on for a distinct id; null when no PostHog key was built in. */
    private val fetch: (suspend (distinctId: String) -> Set<String>)?,
) {
    private val state = MutableStateFlow<Map<String, Set<String>>>(emptyMap())

    /** The flags on, by distinct id, as far as this phone knows. */
    val on: StateFlow<Map<String, Set<String>>> = state.asStateFlow()

    /** Reads the kept answers; off the main thread, before the first refresh. */
    suspend fun load() = withContext(Dispatchers.IO) {
        val kept = prefs.all.mapNotNull { (key, value) ->
            val id = key.removePrefix(KEY_PREFIX).takeIf { key.startsWith(KEY_PREFIX) } ?: return@mapNotNull null
            @Suppress("UNCHECKED_CAST")
            (value as? Set<String>)?.let { id to it.toSet() }
        }.toMap()
        state.update { kept + it }
    }

    /** Asks PostHog again for [distinctId]. Never throws. */
    suspend fun refresh(distinctId: String) {
        val fetch = fetch ?: return
        val flags = try {
            fetch(distinctId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w("FeatureFlags", "PostHog flags failed", e)
            return
        }
        withContext(Dispatchers.IO) { prefs.edit().putStringSet(KEY_PREFIX + distinctId, flags).apply() }
        state.update { it + (distinctId to flags) }
    }

    companion object {
        const val PREFS_NAME = "feature-flags"
        private const val KEY_PREFIX = "on."

        /** The Happy CLI home's migration card (ui/migration). */
        const val DIRECT_CONNECTION_MIGRATION_NOTE = "direct-connection-migration-note"
    }
}

/**
 * PostHog's `/flags?v=2`, the call its SDKs make to evaluate flags: the
 * project key and a distinct id in, each flag's `enabled` out. Nothing is
 * captured.
 */
class PostHogFlags(private val http: OkHttpClient, private val apiKey: String, private val host: String = HOST) {
    suspend fun fetch(distinctId: String): Set<String> {
        val body = buildJsonObject {
            put("api_key", apiKey)
            put("distinct_id", distinctId)
        }.toString().toRequestBody("application/json".toMediaType())
        val request = Request.Builder().url("$host/flags/?v=2").post(body).build()
        val text = withContext(Dispatchers.IO) {
            http.newCall(request).execute().use { response ->
                check(response.isSuccessful) { "PostHog flags: HTTP ${response.code}" }
                response.body.string()
            }
        }
        return parse(Json.parseToJsonElement(text).jsonObject)
    }

    companion object {
        /** The US host happy-app and Happy Desktop send to. */
        const val HOST = "https://us.i.posthog.com"

        fun parse(response: JsonObject): Set<String> {
            val flags = response["flags"] as? JsonObject ?: return emptySet()
            return flags.filter { (_, flag) -> (flag as? JsonObject)?.get("enabled")?.jsonPrimitive?.booleanOrNull == true }.keys
        }
    }
}
