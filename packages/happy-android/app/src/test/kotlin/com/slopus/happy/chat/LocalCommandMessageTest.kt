package com.slopus.happy.chat

import com.slopus.happy.chat.LocalCommandMessage.Caveat
import com.slopus.happy.chat.LocalCommandMessage.CommandRun
import com.slopus.happy.chat.LocalCommandMessage.GoalConfirmation
import com.slopus.happy.chat.LocalCommandMessage.GoalRun
import com.slopus.happy.chat.LocalCommandMessage.Text
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** happy-app's components/parseLocalCommandMessage.spec.ts. */
class LocalCommandMessageTest {
    @Test fun `parses local command wrappers`() {
        assertEquals(Caveat, parseLocalCommandMessage("<local-command-caveat>The user typed a slash command.</local-command-caveat>"))
        assertEquals(CommandRun("compact"), parseLocalCommandMessage("<command-message>compact</command-message><command-name>/compact</command-name>"))
        assertEquals(
            CommandRun("superpowers:brainstorming", "think of a feature so I can charge money"),
            parseLocalCommandMessage("<command-message>brainstorming is running</command-message><command-name>/superpowers:brainstorming</command-name><command-args>think of a feature so I can charge money</command-args>"),
        )
        assertEquals(GoalRun("проанализируй проект"), parseLocalCommandMessage("<command-message>goal</command-message><command-name>/goal</command-name><command-args>проанализируй проект</command-args>"))
        assertEquals(GoalRun("проанализируй проект"), parseLocalCommandMessage(" /goal проанализируй проект "))
        assertEquals(
            CommandRun("superpowers:brainstorming", "привет давай спланируем что-нибудь"),
            parseLocalCommandMessage(" /superpowers:brainstorming привет давай спланируем что-нибудь "),
        )
        assertEquals(CommandRun("maintain", "привет давай"), parseLocalCommandMessage(" привет давай /maintain "))
        assertEquals(CommandRun("maintain", "привет давай"), parseLocalCommandMessage(" привет /maintain давай "))
        assertEquals(GoalConfirmation("проанализируй проект"), parseLocalCommandMessage("<local-command-stdout>Goal set: проанализируй проект</local-command-stdout>"))
        assertEquals(CommandRun("x", "spaced arg"), parseLocalCommandMessage("<command-message>x</command-message><command-name>/x</command-name><command-args> spaced arg </command-args>"))
        assertEquals(CommandRun("x"), parseLocalCommandMessage("<command-message>x</command-message><command-name>/x</command-name><command-args></command-args>"))
        assertEquals(Text("Please run this:"), parseLocalCommandMessage("Please run this:\n<command-message>x</command-message><command-name>/x</command-name><command-args>a</command-args>"))
        assertEquals(Text("just a normal message"), parseLocalCommandMessage("just a normal message"))
    }

    @Test fun `recognizes the user's own slash command echo`() {
        assertTrue(isUserSlashCommandEcho("/compact", true))
        assertTrue(isUserSlashCommandEcho("/superpowers:brainstorming make me rich", true))
        assertTrue(isUserSlashCommandEcho("/goal проанализируй проект", true))
        assertFalse(isUserSlashCommandEcho("/compact", false))
        assertTrue(isUserSlashCommandEcho("привет давай /maintain", true))
        assertFalse(isUserSlashCommandEcho("<command-message>x</command-message><command-name>/x</command-name><command-args>a</command-args>", true))
        assertFalse(isUserSlashCommandEcho("/etc/hosts is the file", true))
        assertFalse(isUserSlashCommandEcho("/usr/local/bin", true))
        assertFalse(isUserSlashCommandEcho("/", true))
        assertFalse(isUserSlashCommandEcho("please run / later", true))
        assertTrue(isUserSlashCommandEcho(" /clear ", true))
    }
}
