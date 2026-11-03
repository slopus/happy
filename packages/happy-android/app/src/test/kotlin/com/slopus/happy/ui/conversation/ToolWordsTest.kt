package com.slopus.happy.ui.conversation

import android.content.res.Resources
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.MediaItem
import com.slopus.happy.conversation.Presentation
import com.slopus.happy.conversation.ToolUse
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Octicon
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A tool call's line in desktop's words (AgentActivityRow.tsx `toolVerb`,
 * `humanizeToolName`, `toolGlyph`; iOS ChatTurnPlans.swift `ToolWords`),
 * and how a turn ended (TurnSummary.tsx).
 */
@RunWith(AndroidJUnit4::class)
class ToolWordsTest {
    private val res: Resources = ApplicationProvider.getApplicationContext<android.content.Context>().resources

    private fun words(name: String, presentation: Presentation? = null, status: String = "completed") = ToolWords.of(ToolUse(name, status, presentation), res)

    private fun said(name: String, presentation: Presentation? = null, status: String = "completed") = words(name, presentation, status).let { "${it.verb} ${it.subject}" }

    @Test fun commandsSayTheirShellAndAreSetInMono() {
        val ran = words("exec_command", Presentation.Command("ls -la", null))
        assertEquals("Shell ls -la", "${ran.verb} ${ran.subject}")
        assertEquals(true, ran.mono)
        assertEquals(ToolGlyph.Oct(Octicon.Code), ran.glyph)
        assertEquals("Bash", words("Bash").verb)
        assertEquals("PowerShell", words("powershell").verb)
    }

    @Test fun aRunningCallSaysItInThePresentTense() {
        assertEquals("Exploring a.ts, b.ts", said("read_file", Presentation.Exploration.reads("a.ts", "b.ts", "a.ts"), "running"))
        assertEquals("Explored a.ts, b.ts", said("read_file", Presentation.Exploration.reads("a.ts", "b.ts")))
        assertEquals("Reading Read file", said("read_file", status = "running"))
        assertEquals("Edited Write file", said("write_file"))
        assertEquals("Searching cats", said("web_search", Presentation.Search("cats", "web"), "running"))
        assertEquals("Used Do something", said("do_something"))
        assertEquals("Tool Do something", said("do_something", status = "running"))
    }

    @Test fun aLookAroundSaysEachStep() {
        val steps = Presentation.Exploration(
            listOf(
                Presentation.Exploration.Operation("list", target = "src"),
                Presentation.Exploration.Operation("read", name = "a.ts"),
                Presentation.Exploration.Operation("search", query = "greet", path = "src"),
                Presentation.Exploration.Operation("search", command = "rg todo"),
            ),
        )
        assertEquals("Explored List src · Read a.ts · Search greet in src · Search rg todo", said("exploration", steps))
    }

    @Test fun aFileEditSaysTheFileAndItsCounts() {
        val edit = words("apply_patch", Presentation.FileDiff(listOf(Presentation.FileDiff.File("src/app/main.ts", "update", 1500, 1), Presentation.FileDiff.File("b.ts", "update", 2, 0))))
        assertEquals("Edit", edit.verb)
        assertEquals("main.ts", edit.subject)
        assertEquals(1502, edit.added)
        assertEquals(1, edit.deleted)
        assertEquals("1.5k", ToolWords.compact(edit.added!!))
        assertEquals(ToolGlyph.Ion(Ionicon.DocumentOutline), edit.glyph)
        val added = words("apply_patch", Presentation.FileDiff(listOf(Presentation.FileDiff.File("notes\\n.md", "add", 3, 0))))
        assertEquals("Added n.md", "${added.verb} ${added.subject}")
        // A side that changed nothing is left unsaid.
        assertEquals(null, added.deleted)
        assertEquals("Deleted old.ts", said("apply_patch", Presentation.FileDiff(listOf(Presentation.FileDiff.File("old.ts", "delete")))))
    }

    @Test fun artifactsSubagentsAndMediaSayWhatTheyDid() {
        assertEquals("Created artifact", said("create_artifact", Presentation.Artifact("x", "markdown", "Q3", 1)))
        assertEquals("Created Q3", said("create_artifact", Presentation.Artifact("x", "markdown", "Q3", 1, shows = "latest")))
        assertEquals("Updating artifact", said("update_artifact", Presentation.Artifact("x", null, "Q3", 2), "running"))
        assertEquals("Opened artifact", said("edit_artifact_files", Presentation.Artifact("x", null, "Q3", 2)))
        assertEquals("Failed artifact", said("create_artifact", Presentation.Artifact("x", null, "Q3", 1), "failed"))
        assertEquals("Spawned sub-agent", said("spawn_agent", Presentation.AgentSpawn(null)))
        assertEquals("Spawning Opus sub-agent", said("spawn_agent", Presentation.AgentSpawn("Opus"), "running"))
        assertEquals("Waited for subagents", said("wait_agent"))
        assertEquals("Images a.png, b.png", said("show_media", Presentation.Media(listOf(MediaItem("image", "a.png", "image/png"), MediaItem("image", "b.png", "image/png")))))
        assertEquals("Files a.png, c.mp4", said("show_media", Presentation.Media(listOf(MediaItem("image", "a.png", "image/png"), MediaItem("video", "c.mp4", "video/mp4")))))
        assertEquals("Read shot.png", said("view_image", Presentation.Media(listOf(MediaItem("image", "shot.png", "image/png")))))
        assertEquals(ToolGlyph.Ion(Ionicon.FilmOutline), words("show_media", Presentation.Media(listOf(MediaItem("video", "c.mp4", "video/mp4")))).glyph)
    }

    @Test fun namesReadAsWords() {
        assertEquals("github · create_issue", ToolWords.humanize("mcp__github__create_issue", res))
        assertEquals("Context compaction", ToolWords.humanize("compact", res))
        assertEquals("Read File Now", ToolWords.humanize("readFile_Now", res))
        assertEquals("Used github · create_issue", said("mcp__github__create_issue"))
    }

    @Test fun terminalInputEchoesAsATerminalWould() {
        assertEquals("Typed ^C", said("write_stdin", Presentation.Terminal("\u0003", "npm run dev")))
        assertEquals("Typed npm run dev", said("write_stdin", Presentation.Terminal("", "npm run dev")))
        assertEquals("one … +2 lines", ToolWords.terminalInput("one\r\ntwo\nthree\n", res))
        assertEquals(ToolGlyph.Ion(Ionicon.TerminalOutline), words("write_stdin", Presentation.Terminal("x", null)).glyph)
    }

    @Test fun aSkillReadIsNamedFromItsArguments() {
        val call = com.slopus.happy.conversation.Block.ToolCall(
            "c1", "read_skill", "completed", null,
            kotlinx.serialization.json.buildJsonObject { put("name", kotlinx.serialization.json.JsonPrimitive("release-notes")) },
        )
        val row = com.slopus.happy.conversation.ConversationRowBuilder.build(
            com.slopus.happy.conversation.Message("m", "agent", 1, listOf(call)), "a1", null, false,
        ).single() as ConversationRow.Tool
        assertEquals("release-notes", row.tool.skill)
        val read = ToolWords.of(row.tool, res)
        assertEquals("Read skill: release-notes", "${read.verb} ${read.subject}")
        assertEquals("Reading skill: release-notes", ToolWords.of(row.tool.copy(status = "running"), res).let { "${it.verb} ${it.subject}" })
    }

    @Test fun aFailedCallIsMarked() {
        assertEquals(ToolGlyph.Oct(Octicon.Alert), words("exec_command", Presentation.Command("false", null), "failed").glyph)
    }

    @Test fun aTurnSaysHowItEndedAndAfterHowLong() {
        fun label(reason: String, ms: Long?) = turnLabel(ConversationRow.TurnEnd("r", "r", reason, ms, 0, null), res)
        // The time stays on one line with the word before it.
        assertEquals("Completed in\u00a012s", label("completed", 12_400))
        assertEquals("Steered after\u00a03m\u00a07s", label("steering", 187_000))
        assertEquals("Stopped after\u00a02h\u00a05m", label("abort", 7_500_000))
        assertEquals("Failed after\u00a00s", label("error", 10))
        assertEquals("Worked for\u00a01s", label("compaction", 1_000))
        assertEquals("Completed", label("completed", null))
    }
}
