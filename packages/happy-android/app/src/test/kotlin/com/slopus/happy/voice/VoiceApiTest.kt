package com.slopus.happy.voice

import com.slopus.happy.auth.AuthCredentials
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.crypto.Base64Variant
import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.Assert.*
import org.junit.Test

class VoiceApiTest {
    @Test fun happyWireRequiresCompleteGrantAndKnownDenialReason() {
        assertEquals(VoiceCredentials.Granted("jwt", "conv", "agent", "user"), VoiceApi.parseCredentials(GRANT))
        assertEquals(VoiceCredentials.Denied("subscription_required"), VoiceApi.parseCredentials(DENIAL))
        for (bad in listOf("{}", """{"allowed":"true"}""", GRANT.replace(",\"elevenUserId\":\"user\"", ""), DENIAL.replace("subscription_required", "unknown"))) {
            try { VoiceApi.parseCredentials(bad); fail("accepted $bad") } catch (_: IllegalArgumentException) {}
        }
    }

    @Test fun sameServerUsesExistingTokenAndOnlyAgentIdInBody() = runTest {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse.Builder().body(GRANT).build())
            server.enqueue(MockResponse.Builder().body("""{"usedSeconds":30,"limitSeconds":1200,"conversationCount":2,"conversationLimit":100,"elevenUserId":"user"}""").build())
            val url = server.url("/").toString().trimEnd('/')
            val api = VoiceApi(OkHttpClient(), "android/test", { url }, { url }, "agent")
            assertTrue(api.credentials(AuthCredentials("existing", "unused")) is VoiceCredentials.Granted)
            val request = server.takeRequest()
            assertEquals("/v1/voice/conversations", request.url.encodedPath)
            assertEquals("POST", request.method)
            assertEquals("Bearer existing", request.headers["Authorization"])
            assertEquals("android/test", request.headers["X-Happy-Client"])
            assertEquals("""{"agentId":"agent"}""", request.body!!.utf8())
            assertEquals(VoiceUsage(30, 1200, 2, 100), api.usage(AuthCredentials("existing", "unused")))
            assertEquals("/v1/voice/usage", server.takeRequest().url.encodedPath)
        }
    }

    @Test fun differentVoiceServerSignsInWithSecretInsteadOfSendingForeignToken() = runTest {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse.Builder().body("""{"token":"voice-token"}""").build())
            server.enqueue(MockResponse.Builder().body(GRANT).build())
            val voiceUrl = server.url("/").toString().trimEnd('/')
            val api = VoiceApi(OkHttpClient(), "android/test", { "https://self-hosted.example" }, { voiceUrl }, "agent")
            api.credentials(AuthCredentials("self-hosted-token", encodeBase64(ByteArray(32) { it.toByte() }, Base64Variant.Url)))
            val auth = server.takeRequest()
            assertEquals("/v1/auth", auth.url.encodedPath)
            assertNull(auth.headers["Authorization"])
            assertTrue(auth.body!!.utf8().contains("signature"))
            val conversation = server.takeRequest()
            assertEquals("Bearer voice-token", conversation.headers["Authorization"])
        }
    }

    companion object {
        const val GRANT = """{"allowed":true,"conversationToken":"jwt","conversationId":"conv","agentId":"agent","elevenUserId":"user","usedSeconds":10,"limitSeconds":1200}"""
        const val DENIAL = """{"allowed":false,"reason":"subscription_required","usedSeconds":1200,"limitSeconds":1200,"agentId":"agent"}"""
    }
}