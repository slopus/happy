package com.slopus.happy.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Happy Cloud invite links: exactly two forms carry one, the web host's
 * `/join` and the app's own `happy://cloud/join`, the token always the
 * whole fragment. At either address anything else is a malformed
 * invitation; any other address is no invite link at all.
 */
class CloudInviteTest {
    private val token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde"
    private fun link(link: String) = CloudInviteLink.of(link, webHost = "happybases.com")
    private fun parse(link: String) = CloudInvite.parse(link, webHost = "happybases.com")

    @Test
    fun theTwoFormsCarryTheToken() {
        assertEquals(43, token.length)
        for (form in listOf(
            "https://happybases.com/join#$token",
            "https://happybases.com/join/#$token",
            "https://HAPPYBASES.com/join#$token",
            "HTTPS://happybases.com/join#$token",
            "  https://happybases.com/join#$token  ",
            "happy://cloud/join#$token",
            "happy://cloud/join/#$token",
            "HAPPY://CLOUD/join#$token",
        )) {
            assertEquals(form.replace(token, "…"), CloudInvite(token), link(form))
            assertEquals(form.replace(token, "…"), CloudInvite(token), parse(form))
        }
    }

    /** At the invite's address, but with no token to use: the screen says "Invalid invitation" and asks the API nothing. */
    @Test
    fun atTheAddressAnythingButABareTokenIsMalformed() {
        for (address in listOf("https://happybases.com/join", "happy://cloud/join")) {
            for (rest in listOf(
                "",
                "#",
                "#${token.drop(1)}",
                "#${token}x",
                "#${token.dropLast(1)}=",
                "#${token.dropLast(1)}.",
                "#token=$token",
                // A token belongs in the fragment, which is never sent anywhere: one in the query isn't taken.
                "?token=$token",
                "?$token",
                "?x=1#$token",
            )) {
                val form = address + rest
                assertEquals(form.replace(token, "…"), CloudInviteLink.Malformed, link(form))
                assertNull(form.replace(token, "…"), parse(form))
            }
        }
        assertEquals(CloudInviteLink.Malformed, link("https://happybases.com:8443/join#$token"))
        assertEquals(CloudInviteLink.Malformed, link("https://user@happybases.com/join#$token"))
    }

    @Test
    fun anotherHostOrPathIsNoInviteLink() {
        for (other in listOf(
            // A host of its own for invites is gone, and so is its form on the web host.
            "https://join.happybases.com/#$token",
            "https://join.happybases.com/join#$token",
            "https://happybases.com/#$token",
            "https://happybases.com#$token",
            // The server picker and a server's web app.
            "https://happybases.com/",
            "https://acme.happybases.com/join#$token",
            "https://happybases.com/join/x#$token",
            "https://happybases.com/joined#$token",
            "https://happybases.com/Join#$token",
            "https://happybases.com/x/join#$token",
            "https://evil.example/join#$token",
            "https://happybases.com.evil.example/join#$token",
            "https://happybases.com@evil.example/join#$token",
            "http://happybases.com/join#$token",
            "happy://cloud/#$token",
            "happy://cloud#$token",
            "happy://cloud/joined#$token",
            "happy://cloud/join/x#$token",
            "happy://clouds/join#$token",
            "happy://join#$token",
            "happy:///cloud/join#$token",
            "happy:cloud/join#$token",
            "other://cloud/join#$token",
            "not a link",
            token,
        )) {
            assertNull(other.replace(token, "…"), link(other))
            assertNull(other.replace(token, "…"), parse(other))
        }
    }

    @Test
    fun aBuildWithoutHappyCloudTakesNone() {
        assertNull(CloudInviteLink.of("https://happybases.com/join#$token", webHost = null))
        assertNull(CloudInviteLink.of("happy://cloud/join#$token", webHost = null))
    }

    @Test
    fun theTokenNeverPrints() {
        assertEquals("CloudInvite(…)", CloudInvite(token).toString())
    }
}
