package com.slopus.happy.onboarding

import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class TeamInvitesTest {
    private class Server(val status: Int, val text: String) : Transport {
        val bodies = mutableListOf<String>()
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            assertEquals("POST /v0/invites", "$method $path")
            bodies += body?.decodeToString().orEmpty()
            return TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())
        }

        override suspend fun close() {}
    }

    @Test
    fun anEmailInviteIsMadeWithItsLinkAndWhetherTheEmailWentOut() = runBlocking {
        val server = Server(200, """{"invite":{"id":"i1","link":"https://acme.example/join/x","role":"member","deliveryStatus":"failed"}}""")
        val invite = TeamInvites.invite(AgentClient(server, "t"), "olga@acme.com")
        assertEquals(TeamInvite("i1", "https://acme.example/join/x", "failed"), invite)
        assertTrue(invite.emailFailed)
        val body = Json.parseToJsonElement(server.bodies.single()).jsonObject
        assertEquals("olga@acme.com", body["email"]?.jsonPrimitive?.content)
        assertTrue("mutationId" in body)
    }

    @Test
    fun aLinkInviteSendsNoEmail() = runBlocking {
        val server = Server(200, """{"invite":{"id":"i2","link":"https://acme.example/join/y"}}""")
        val invite = TeamInvites.invite(AgentClient(server, "t"), null)
        assertNull(invite.deliveryStatus)
        assertFalse(invite.emailFailed)
        assertFalse("email" in Json.parseToJsonElement(server.bodies.single()).jsonObject)
    }

    private suspend fun refusal(status: Int, text: String): Exception = try {
        TeamInvites.invite(AgentClient(Server(status, text), "t"), "olga@acme.com")
        fail("invited")
        error("unreachable")
    } catch (e: Exception) {
        e
    }

    @Test
    fun whyAnInviteWasntMade() = runBlocking {
        assertEquals(TeamInviteRefusal.EmailNotConfigured, refusal(503, """{"error":"No email","code":"email_not_configured"}"""))
        assertEquals(TeamInviteRefusal.Unsupported, refusal(404, """{"error":"Not found","code":"not_found"}"""))
        val refused = refusal(400, """{"error":"That address can't be invited.","code":"invalid"}""")
        assertTrue(refused is TeamInviteRefusal.Refused)
        assertEquals("That address can't be invited.", refused.message)
        // A server that is down is no refusal of the address.
        assertTrue(refusal(500, """{"error":"Oops","code":"internal"}""") is AgentApiException)
    }

    @Test
    fun anAddressLooksValidWithSomethingAnAtAndADottedDomain() {
        assertTrue(EmailAddress.looksValid("olga@acme.com"))
        assertTrue(EmailAddress.looksValid("o.p+team@mail.acme.co"))
        for (bad in listOf("", "olga", "olga@acme", "@acme.com", "olga@.com", "olga@acme.", "olga @acme.com", "a@b@c.com")) {
            assertFalse(bad, EmailAddress.looksValid(bad))
        }
    }
}
