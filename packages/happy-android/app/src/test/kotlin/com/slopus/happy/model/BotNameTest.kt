package com.slopus.happy.model

import com.slopus.happy.text.Words
import com.slopus.happy.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BotNameTest {
    /** botName.ts: the composer refuses a name before a request is spent on it. */
    @Test
    fun aBotNameIsWhatTheDaemonAccepts() {
        assertEquals("Release Bot", sanitizeBotName("Release\nBot"))
        assertEquals(BOT_NAME_MAX_LENGTH, sanitizeBotName("x".repeat(300)).length)
        assertTrue(isValidBotName("  Ada "))
        assertFalse(isValidBotName("   "))
        assertEquals(Words.ours(R.string.home_bot_name_empty), describeBotNameProblem(" "))
        assertEquals(Words.ours(R.string.home_bot_name_too_long, 256), describeBotNameProblem("x".repeat(257)))
        assertEquals(Words.ours(R.string.home_bot_name_control), describeBotNameProblem("a\u0007b"))
        assertNull(describeBotNameProblem("Ada"))
    }
}
