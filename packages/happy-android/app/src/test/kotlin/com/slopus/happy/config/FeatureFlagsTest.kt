package com.slopus.happy.config

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException

/** PostHog's flags without its SDK: the request it makes, what it reads back, and what is kept. */
@RunWith(AndroidJUnit4::class)
class FeatureFlagsTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private fun prefs() = context.getSharedPreferences(FeatureFlags.PREFS_NAME, Context.MODE_PRIVATE).also { it.edit().clear().commit() }

    /** PostHog's answer for /flags?v=2, trimmed: the migration note on, another flag off. */
    private val answer = """
        {"errorsWhileComputingFlags":false,"flags":{
          "direct-connection-migration-note":{"key":"direct-connection-migration-note","enabled":true,"variant":null},
          "direct-connection-migration-new-users":{"key":"direct-connection-migration-new-users","enabled":false,"variant":null},
          "voice-upsell":{"key":"voice-upsell","enabled":true,"variant":"control"}
        },"requestId":"r"}
    """.trimIndent()

    @Test
    fun asksWithTheProjectKeyAndDistinctIdAndReadsWhatIsOn() = runBlocking {
        val sent = mutableListOf<okhttp3.Request>()
        val bodies = mutableListOf<String>()
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            sent += chain.request()
            bodies += Buffer().also { chain.request().body!!.writeTo(it) }.readUtf8()
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body(answer.toResponseBody("application/json".toMediaType())).build()
        }.build()

        val on = PostHogFlags(http, "phc_test").fetch("0123456789abcdef")

        assertEquals(setOf("direct-connection-migration-note", "voice-upsell"), on)
        assertEquals("https://us.i.posthog.com/flags/?v=2", sent.single().url.toString())
        assertEquals("POST", sent.single().method)
        val body = Json.parseToJsonElement(bodies.single()).jsonObject
        assertEquals("phc_test", body["api_key"]!!.jsonPrimitive.content)
        assertEquals("0123456789abcdef", body["distinct_id"]!!.jsonPrimitive.content)
    }

    @Test
    fun anAnswerIsKeptPerAccountAndAFailureKeepsTheLastOne() = runBlocking {
        val prefs = prefs()
        var answers = ArrayDeque(listOf<Result<Set<String>>>(Result.success(setOf(FeatureFlags.DIRECT_CONNECTION_MIGRATION_NOTE)), Result.failure(IOException("offline"))))
        val flags = FeatureFlags(prefs) { answers.removeFirst().getOrThrow() }
        flags.load()
        assertEquals("nothing asked yet", emptyMap<String, Set<String>>(), flags.on.value)

        flags.refresh("a")
        assertEquals(mapOf("a" to setOf("direct-connection-migration-note")), flags.on.value)
        flags.refresh("a")
        assertEquals("a failed ask keeps the last answer", mapOf("a" to setOf("direct-connection-migration-note")), flags.on.value)

        answers = ArrayDeque(listOf(Result.success(emptySet())))
        val next = FeatureFlags(prefs) { answers.removeFirst().getOrThrow() }
        next.load()
        assertEquals("the next start reads it at once", mapOf("a" to setOf("direct-connection-migration-note")), next.on.value)
        next.refresh("a")
        assertEquals("turned off", mapOf("a" to emptySet<String>()), next.on.value)
    }

    @Test
    fun withoutAKeyNothingIsAskedAndEveryFlagIsOff() = runBlocking {
        val flags = FeatureFlags(prefs(), fetch = null)
        flags.load()
        flags.refresh("a")
        assertEquals(emptyMap<String, Set<String>>(), flags.on.value)
    }

    @Test
    fun anAnswerWithoutFlagsIsNothingOn() {
        assertEquals(emptySet<String>(), PostHogFlags.parse(Json.parseToJsonElement("""{"errorsWhileComputingFlags":true}""").jsonObject))
    }
}
