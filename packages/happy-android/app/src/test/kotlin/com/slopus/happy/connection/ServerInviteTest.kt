package com.slopus.happy.connection

import com.slopus.happy.agent.HappyUrls
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A team server's link (edge SSO contract §8), read exactly or not at all. */
class ServerInviteTest {
    private val id = "k3x9q2m7p0a4b8c1d5e6f7g2"
    private fun link(encoded: String) = "happy://$id/server?url=$encoded"

    @Test
    fun theContractsExampleNamesTheServerAndItsInstallation() {
        val invite = ServerInvite.parse(link("https%3A%2F%2Fhappy.acme.example%2F"))!!
        assertEquals(ServerInvite(id, "https://happy.acme.example/"), invite)
        assertEquals("https://happy.acme.example", invite.origin?.value)
    }

    @Test
    fun anyValidEscapeIsRead() {
        assertEquals("https://happy.acme.example:8443/", ServerInvite.parse(link("https%3a%2f%2fhappy.acme.example%3a8443%2f"))?.url)
        assertEquals("https://acme.example/(team)/", ServerInvite.parse(link("https%3A%2F%2Facme.example%2F(team)%2F"))?.url)
    }

    @Test
    fun aPathPrefixIsAServerThisAppCantReachYet() {
        val invite = ServerInvite.parse(link("https%3A%2F%2Facme.example%2Fhappy%2F"))!!
        assertEquals("https://acme.example/happy/", invite.url)
        assertNull(invite.origin)
    }

    @Test
    fun aURLNotAlreadyNormalizedIsMalformed() {
        listOf(
            "http%3A%2F%2Fhappy.acme.example%2F",
            "https%3A%2F%2Fhappy.acme.example",
            "https%3A%2F%2FHappy.acme.example%2F",
            "https%3A%2F%2Fhappy.acme.example%3A443%2F",
            "https%3A%2F%2Fme%40happy.acme.example%2F",
            "https%3A%2F%2Fhappy.acme.example%2F%3Fa%3D1",
            "https%3A%2F%2Fhappy.acme.example%2F%23top",
            "https%3A%2F%2Facme.example%2Fhappy",
            "https%3A%2F%2Fhappy.acme.example%2F%2",
            "https%3A%2F%2Fhappy.acme.example%2F%zz",
            "https%3A%2F%2Fhapp%FF.example%2F",
            "https:%2F%2Fhappy.acme.example/",
            "",
        ).forEach { assertNull(it, ServerInvite.parse(link(it))) }
    }

    @Test
    fun nothingElseMayBeInTheLink() {
        val url = "https%3A%2F%2Fhappy.acme.example%2F"
        listOf(
            "happy://$id/server/?url=$url",
            "happy://$id/server?url=$url&token=t",
            "happy://$id/server?url=$url#x",
            "happy://$id/server?other=1&url=$url",
            "happy://$id/server",
            "happy://K3x9q2m7p0a4b8c1d5e6f7g2/server?url=$url",
            "happy://3k3x9q2m7p0a4b8c1d5e6f7g/server?url=$url",
            " " + link(url),
            link("https%3A%2F%2Facme.example%2F" + "x".repeat(4096) + "%2F"),
        ).forEach { assertNull(it, ServerInvite.parse(it)) }
    }

    @Test
    fun aMalformedServerLinkIsStillOne() {
        assertTrue(ServerInvite.isServerCode("happy://$id/server"))
        assertTrue(ServerInvite.isServerCode("happy://$id/server?url=http%3A%2F%2Fx%2F"))
        assertFalse(ServerInvite.isServerCode("happy://$id/artifacts/a1"))
        assertFalse(ServerInvite.isServerCode("happy://$id/servers"))
    }

    @Test
    fun itIsNotAHappyUrl() {
        val text = link("https%3A%2F%2Fhappy.acme.example%2F")
        assertNull(HappyUrls.parse(text))
    }
}
