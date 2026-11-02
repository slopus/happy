package com.slopus.happy.conversation

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** How the composer reads slash commands (desktop composerState.ts, fd553cc3, 4078fd44) and how a catalog is read. */
class SlashCommandsTest {
    private val commands = listOf(
        SlashCommand("code-review", true, "Review the current changes.", "skill"),
        SlashCommand("compact", false, "Summarize.", "compaction"),
        SlashCommand("Deploy", true, "Ship it."),
    )

    @Test fun `a command reads every field and its artwork`() {
        val parsed = SlashCommand.parseAll(
            Json.parseToJsonElement(
                """[{"name":"code-review","hasArguments":true,"description":"Review.","kind":"skill","image":{"thumbhash":"abc"}},""" +
                    """{"name":"compact","hasArguments":false,"description":"Summarize.","kind":"compaction"},""" +
                    """{"name":"plain","description":"No flags."},{"name":"","description":"nameless"},{"description":"nameless"},""" +
                    """{"name":"art","hasArguments":false,"description":"Art without a hash.","image":{}}]""",
            ),
        )
        assertEquals(
            listOf(
                SlashCommand("code-review", true, "Review.", "skill", image = true, thumbhash = "abc"),
                SlashCommand("compact", false, "Summarize.", "compaction"),
                SlashCommand("plain", false, "No flags."),
                SlashCommand("art", false, "Art without a hash.", image = true),
            ),
            parsed,
        )
        // As kept, it reads back the same.
        assertEquals(parsed, SlashCommand.parseAll(SlashCommand.json(parsed!!)))
        assertNull(SlashCommand.parseAll(null))
    }

    @Test fun `a draft is a command only while it is one slash word something begins`() {
        assertEquals("", SlashCommands.query("/", commands))
        assertEquals("co", SlashCommands.query("/co", commands))
        assertEquals("de", SlashCommands.query("/de", commands))
        assertNull(SlashCommands.query("/Users/steve/project", commands))
        assertNull(SlashCommands.query("/co de", commands))
        assertNull(SlashCommands.query("/nonsense", commands))
        assertNull(SlashCommands.query(" /co", commands))
        assertNull(SlashCommands.query("hello /co", commands))
        assertNull(SlashCommands.query("/", emptyList()))
    }

    @Test fun `the list keeps commands before skills, each in the agent's order`() {
        assertEquals(listOf("compact", "Deploy", "code-review"), SlashCommands.matching(commands, "").map { it.name })
        assertEquals(listOf("compact", "code-review"), SlashCommands.matching(commands, "CO").map { it.name })
    }

    @Test fun `a submitted draft runs an offered command with what follows its name`() {
        assertEquals(CommandInvocation(commands[1], null), SlashCommands.invocation("/compact", commands))
        assertEquals(CommandInvocation(commands[0], "focus on auth\nand tests"), SlashCommands.invocation("/code-review focus on auth\nand tests", commands))
        assertEquals(CommandInvocation(commands[0], ""), SlashCommands.invocation("/code-review ", commands))
        assertNull(SlashCommands.invocation("/comp", commands))
        assertNull(SlashCommands.invocation("/deploy", commands))
        assertNull(SlashCommands.invocation("please /compact", commands))
        assertEquals("/v0/agents/a%201/slash-commands/code%20review/image", SlashCommand.imagePath("a 1", "code review"))
    }
}
