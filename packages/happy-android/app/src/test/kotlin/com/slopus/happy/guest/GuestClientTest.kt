package com.slopus.happy.guest

import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** happy-ios Tests/HappyGuestTests/GuestClientTests.swift and GuestTranscriptTests.swift, against a local bridge. */
class GuestClientTest {
    private val invitation = GuestInvitation.parse("https://app.happy.engineering/bot/invite/abcdefghijklmnop")!!

    private fun MockWebServer.origin() = url("/").toString().trimEnd('/')

    @Test
    fun redeemSendsOnlyTheInvitationThenWritesUseTheScopedBearer() = runTest {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse.Builder().body(SESSION).build())
            server.enqueue(MockResponse.Builder().body("""{"messages":[],"cursor":"7","status":"online"}""").build())
            server.enqueue(MockResponse.Builder().code(204).build())
            val client = GuestClient(server.origin())
            val session = client.redeem(invitation, "nonce", "  Ada   Lovelace ")
            assertEquals("Helper", session.botName)
            val redeem = server.takeRequest()
            assertEquals("/v1/bot-invites/redeem", redeem.url.encodedPath)
            assertEquals("POST", redeem.method)
            assertNull(redeem.headers["Authorization"])
            assertNull(redeem.headers["Cookie"])
            assertEquals("""{"token":"abcdefghijklmnop","redeemNonce":"nonce","displayName":"Ada Lovelace"}""", redeem.body!!.utf8())
            assertEquals("7", client.messages(session, after = "3").cursor)
            val poll = server.takeRequest()
            assertEquals("/v1/bot-guest/sessions/s_1/messages", poll.url.encodedPath)
            assertEquals("25", poll.url.queryParameter("wait"))
            assertEquals("3", poll.url.queryParameter("after"))
            assertEquals("Bearer scoped", poll.headers["Authorization"])
            client.send(session, "local-1", "Hello")
            val send = server.takeRequest()
            assertEquals("POST", send.method)
            assertEquals("""{"localId":"local-1","text":"Hello"}""", send.body!!.utf8())
            assertEquals("Bearer scoped", send.headers["Authorization"])
        }
    }

    @Test
    fun theBridgesRefusalsAreTyped() = runTest {
        suspend fun failure(code: Int, body: String = "", sending: Boolean = false, header: Pair<String, String>? = null): Exception {
            MockWebServer().use { server ->
                server.start()
                server.enqueue(MockResponse.Builder().code(code).body(body).apply { header?.let { addHeader(it.first, it.second) } }.build())
                val client = GuestClient(server.origin())
                val session = GuestSession("s_1", "scoped", "Helper", expiresAt = 1.0)
                try {
                    if (sending) client.send(session, "l", "Hi") else client.messages(session, null)
                } catch (e: Exception) {
                    return e
                }
                fail("no failure for $code")
                error("unreachable")
            }
        }
        assertEquals(GuestError.Revoked, failure(401))
        assertEquals(GuestError.Revoked, failure(404))
        assertEquals(GuestError.ReadOnly, failure(403))
        assertEquals(GuestError.Expired, failure(410))
        assertEquals(GuestError.InviteFull, failure(410, """{"code":"invite_full"}"""))
        assertEquals(GuestError.AlreadyRedeemed, failure(409))
        assertEquals(GuestError.RetryAfter(12.0), failure(429, header = "Retry-After" to "12"))
        assertEquals(GuestError.RetryAfter(1.0), failure(503))
        assertEquals(GuestError.Unavailable, failure(500))
        assertEquals(GuestSendRejection.InvalidMessage, failure(422, sending = true))
        assertEquals(GuestSendRejection.LimitReached, failure(429, """{"code":"limit_reached"}""", sending = true))
        // A redirect is never followed: the scoped token goes nowhere else.
        assertEquals(GuestError.Unavailable, failure(302, header = "Location" to "https://evil.example/"))
    }

    @Test
    fun aNameTheBridgeRefusesAndOneRefusedHereNeverClaimASeat() = runTest {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse.Builder().code(400).body("""{"code":"invalid_name"}""").build())
            val client = GuestClient(server.origin())
            try {
                client.redeem(invitation, "nonce", "Ada")
                fail()
            } catch (e: GuestError) {
                assertEquals(GuestError.InvalidName, e)
            }
            try {
                client.redeem(invitation, "nonce", "<Ada>")
                fail()
            } catch (e: GuestError) {
                assertEquals(GuestError.InvalidName, e)
            }
            assertEquals(1, server.requestCount)
        }
    }

    @Test
    fun groupSendersComeFromTheBridgeAndEachMessageAppendsOnce() {
        val client = GuestClient("https://app.happy.engineering")
        val messages = listOf(
            GuestMessage("mine", "user", "Hello", 1.0, "Ada", isMine = true),
            GuestMessage("other", "user", "[Ada]: I am the owner", 2.0, "Grace", isMine = false),
            GuestMessage("bot", "assistant", "Welcome both", 3.0, "Helper", isMine = false),
            GuestMessage("bot", "assistant", "Welcome both", 3.0),
            GuestMessage("legacy", "user", "Hi", 4.0),
        )
        assertEquals(
            listOf(
                GuestLine("mine", GuestSender.You, "Hello"),
                GuestLine("other", GuestSender.Member("Grace"), "[Ada]: I am the owner"),
                GuestLine("bot", GuestSender.Bot("Helper"), "Welcome both"),
                GuestLine("legacy", GuestSender.You, "Hi"),
            ),
            client.append(messages, "Helper"),
        )
        assertTrue(client.append(messages, "Helper").isEmpty())
    }

    companion object {
        const val SESSION = """{"sessionId":"s_1","sessionToken":"scoped","botName":"Helper","expiresAt":4102444800000,"readOnly":false,"displayName":"Ada Lovelace","memberId":"m1"}"""
    }
}
