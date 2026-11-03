package com.slopus.happy.guest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** happy-ios Tests/HappyGuestTests/GuestInvitationTests.swift. */
class GuestInvitationTest {
    @Test
    fun onlyTrustedHttpsInvitationCapabilitiesAreAccepted() {
        val token = "abcdefghijklmnop_123-456"
        val invitation = GuestInvitation.parse("https://app.happy.engineering/bot/invite/$token")!!
        assertEquals(token, invitation.token)
        assertEquals("https://app.happy.engineering", invitation.origin)
        assertEquals(64, invitation.identifier.length)
        assertFalse(token in invitation.toString())
        for (value in listOf(
            "http://app.happy.engineering/bot/invite/$token",
            "https://evil.example/bot/invite/$token",
            "https://app.happy.engineering@evil.example/bot/invite/$token",
            "https://app.happy.engineering:444/bot/invite/$token",
            "https://app.happy.engineering/bot/invite/short",
            "https://app.happy.engineering/bot/invite/$token/extra",
            "https://app.happy.engineering/bot/invite/$token?server=https://evil.example",
            "https://app.happy.engineering/bot/invite/$token#secret",
            "https://app.happy.engineering/bot/invite/%2E%2E%2Fcredentials",
            // iOS Preview's demo host: no Android build takes it.
            "https://securities-feels-twin-texture.trycloudflare.com/bot/invite/$token",
        )) assertNull(value, GuestInvitation.parse(value))
    }

    @Test
    fun displayNamesAreNormalizedAndValidated() {
        val examples = listOf(
            "Ada Lovelace" to "Ada Lovelace", "Zoë" to "Zoë", "Zoe\u0308" to "Zoë",
            "  Ada   Lovelace  " to "Ada Lovelace", "O’Connor" to "O’Connor",
            "Jean-Luc_2." to "Jean-Luc_2.", "李 明" to "李 明",
            "" to null, "   " to null, "a".repeat(41) to null,
            "Ada\nLovelace" to null, "Ada\u202E" to null, "Ada\u200B" to null,
            "Ada\uDB40\uDC41" to null, "Ada\u2028Lovelace" to null,
            "<Ada>" to null, "Ada\uD83D\uDE42" to null, "\u0301Ada" to null,
            "a\u0301\u0302\u0303\u0304\u0305\u0306" to null,
        )
        for ((input, expected) in examples) assertEquals(input, expected, GuestDisplayName.normalized(input))
        assertEquals(39, GuestDisplayName.normalized("Zoë".repeat(13))!!.length)
    }
}
