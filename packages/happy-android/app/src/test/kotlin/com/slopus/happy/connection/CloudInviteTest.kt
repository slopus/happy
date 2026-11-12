package com.slopus.happy.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Happy Cloud invite links: the token in the fragment, on the invite host or the web app's older /join. */
class CloudInviteTest {
    private val token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde"
    private fun parse(link: String) = CloudInvite.parse(link, inviteHost = "join.happy.engineering", webHost = "happybases.com")

    @Test
    fun theInviteHostAndTheOlderJoinPathBothCarryTheToken() {
        assertEquals(43, token.length)
        assertEquals(CloudInvite(token), parse("https://join.happy.engineering/#$token"))
        assertEquals(CloudInvite(token), parse("https://join.happy.engineering#$token"))
        assertEquals(CloudInvite(token), parse("https://JOIN.happy.engineering/#$token"))
        assertEquals(CloudInvite(token), parse("https://happybases.com/join#$token"))
        assertEquals(CloudInvite(token), parse("https://happybases.com/join/#$token"))
    }

    @Test
    fun anythingElseIsNoInvite() {
        assertNull(parse("https://join.happy.engineering/"))
        assertNull(parse("https://join.happy.engineering/#${token.drop(1)}"))
        assertNull(parse("https://join.happy.engineering/#${token}x"))
        assertNull(parse("https://join.happy.engineering/#${token.dropLast(1)}="))
        assertNull(parse("https://join.happy.engineering/join#$token"))
        assertNull(parse("https://join.happy.engineering/?x=1#$token"))
        assertNull(parse("https://join.happy.engineering:8443/#$token"))
        assertNull(parse("https://user@join.happy.engineering/#$token"))
        assertNull(parse("http://join.happy.engineering/#$token"))
        assertNull(parse("https://happybases.com/#$token"))
        assertNull(parse("https://evil.example/#$token"))
        assertNull(parse("https://evil.example/join#$token"))
        // A build without Happy Cloud takes none.
        assertNull(CloudInvite.parse("https://join.happy.engineering/#$token", inviteHost = null, webHost = null))
    }

    @Test
    fun theTokenNeverPrints() {
        assertEquals("CloudInvite(…)", CloudInvite(token).toString())
    }
}
