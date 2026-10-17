package com.slopus.happy.journeys

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasParent
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.isNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.tools.PermissionChoice
import com.slopus.happy.sync.SessionOps
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.ChatListTags
import com.slopus.happy.ui.chat.ChatScreenTags
import com.slopus.happy.ui.chat.ComposerTags
import com.slopus.happy.ui.chat.PermissionTags
import com.slopus.happy.ui.chat.QuestionTags
import com.slopus.happy.ui.chat.ToolTags
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.components.OptionMenuTags
import com.slopus.happy.ui.files.MessageDetailTags
import com.slopus.happy.ui.home.FlatRowTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.usage.UsageRowTags
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Journey 2, a working chat, in the order a turn goes: the agent replies in
 * markdown and runs a tool; its message detail opens, and a patch opens on
 * its file; the agent asks permission and Allow answers it; it asks a
 * question and the pick is sent; while it thinks, Stop aborts it; near the
 * context limit the usage row shows the context and the week; scrolling
 * back fades the dock's details and the scroll button brings them back.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatJourneyTest {
    @get:Rule val rule = createComposeRule()

    private val journey = Journey()
    private val server = journey.server

    @After
    fun tearDown() = journey.close()

    private fun toolStart(call: String, name: String, title: String, args: JsonObject) = buildJsonObject {
        put("t", "tool-call-start")
        put("call", call)
        put("name", name)
        put("title", title)
        put("description", title)
        put("args", args)
    }

    private fun toolEnd(call: String, result: String) = buildJsonObject {
        put("t", "tool-call-end")
        put("call", call)
        put("result", result)
    }

    private fun text(text: String) = buildJsonObject { put("t", "text"); put("text", text) }

    private fun back() = rule.onAllNodesWithTag(HeaderTags.LEFT, useUnmergedTree = true).onFirst().performClick()

    private fun shown(tag: String) = rule.node(tag).bounds.left > (-1000).dp

    @Test
    fun aTurnFromReplyToStop() {
        journey.machine()
        journey.session("s1", updatedAt = 100, title = "Port the parser")
        repeat(40) { n ->
            server.appendMessage("s1", buildJsonObject {
                put("role", "user")
                putJsonObject("content") { put("type", "text"); put("text", "earlier $n") }
            })
        }
        val graph = journey.graph()
        journey.signIn(graph)
        rule.setContent { HappyApp(graph) }
        rule.waitFor(FlatRowTags.ROW)
        rule.node(FlatRowTags.ROW).performClick()
        rule.waitFor(ChatScreenTags.SCREEN)
        rule.waitForText("earlier 39")

        // The reply: markdown, then a shell command and a patch.
        journey.agent("s1", text("Ported, **with tests**."))
        journey.agent("s1", toolStart("c1", "Bash", "Run ls", buildJsonObject { put("command", "ls") }))
        journey.agent("s1", toolEnd("c1", "a.txt"))
        val patch = buildJsonObject {
            putJsonObject("changes") {
                putJsonObject("/h/repo/src/a.ts") { put("type", "update"); put("unified_diff", "@@ -1 +1 @@\n-a\n+b") }
                putJsonObject("/h/repo/b.ts") { put("type", "add"); put("content", "x") }
            }
        }
        journey.agent("s1", toolStart("c2", "apply_patch", "Patch", patch))
        journey.agent("s1", toolEnd("c2", "Done"))
        rule.waitForText("Ported, with tests.")
        rule.waitFor(ToolTags.FILE_HEADER)
        rule.assertActionsLabelled()

        // The command's message detail, and back.
        rule.onAllNodesWithTag(ToolTags.HEADER, useUnmergedTree = true).onFirst().performClick()
        rule.waitFor(MessageDetailTags.CONTENT)
        rule.node(MessageDetailTags.COMMAND).assertExists()
        rule.assertActionsLabelled()
        back()
        rule.waitFor(ChatScreenTags.SCREEN)

        // The patch opened on one of its files.
        rule.onAllNodesWithTag(ToolTags.FILE_HEADER, useUnmergedTree = true).onFirst().performClick()
        rule.waitFor(MessageDetailTags.PATCH_FILE)
        rule.onAllNodesWithTag(MessageDetailTags.PATCH_FILE, useUnmergedTree = true).assertCountEquals(1)
        back()
        rule.waitFor(ChatScreenTags.SCREEN)

        // A permission prompt, allowed.
        val permissions = journey.rpc("s1", "permission") { JsonPrimitive(true) }
        val rm = buildJsonObject { put("command", "rm -rf build") }
        // Requests carry real times, as the CLI's do: one that lands before its tool call starts the row.
        val asked = System.currentTimeMillis()
        journey.agent("s1", toolStart("c3", "Bash", "Clean", rm), turn = "t2")
        journey.agentState("s1", buildJsonObject {
            putJsonObject("requests") { putJsonObject("c3") { put("tool", "Bash"); put("arguments", rm); put("createdAt", asked) } }
        })
        rule.waitFor(PermissionTags.option(PermissionChoice.Allow))
        rule.assertActionsLabelled()
        rule.node(PermissionTags.option(PermissionChoice.Allow)).performClick()
        rule.waitUntil(10_000) { permissions.isNotEmpty() }
        assertEquals(buildJsonObject { put("id", "c3"); put("approved", true) }, permissions.single())
        journey.agentState("s1", buildJsonObject {
            putJsonObject("requests") {}
            putJsonObject("completedRequests") {
                putJsonObject("c3") {
                    put("tool", "Bash"); put("arguments", rm); put("createdAt", asked); put("completedAt", asked + 1); put("status", "approved")
                }
            }
        })
        journey.agent("s1", toolEnd("c3", ""), turn = "t2")
        // Answered: the footer stays, showing the choice, with nothing left to press.
        rule.waitUntilAtLeastOneExists(hasParent(hasTestTag(PermissionTags.option(PermissionChoice.Allow))) and isNotEnabled(), 10_000)

        // A question, answered with a pick.
        val question = buildJsonObject {
            putJsonArray("questions") {
                add(buildJsonObject {
                    put("question", "Where should it live?")
                    put("header", "Storage")
                    put("multiSelect", false)
                    put("options", buildJsonArray {
                        add(buildJsonObject { put("label", "Settings"); put("description", "In settings") })
                        add(buildJsonObject { put("label", "Locally"); put("description", "On this device") })
                    })
                })
            }
        }
        journey.agent("s1", toolStart("c4", "AskUserQuestion", "Question", question), turn = "t3")
        journey.agentState("s1", buildJsonObject {
            putJsonObject("requests") { putJsonObject("c4") { put("tool", "AskUserQuestion"); put("arguments", question); put("createdAt", System.currentTimeMillis()) } }
        })
        rule.waitFor(QuestionTags.FORM)
        rule.onNodeWithText("Settings").performClick()
        rule.node(QuestionTags.SUBMIT).performClick()
        rule.waitUntil(10_000) { permissions.size == 2 }
        assertEquals(
            buildJsonObject {
                put("id", "c4"); put("approved", true); put("decision", "approved")
                putJsonObject("updatedInput") { putJsonObject("answers") { put("Where should it live?", "Settings") } }
            },
            permissions[1],
        )
        journey.agentState("s1", buildJsonObject { putJsonObject("requests") {} })
        journey.agent("s1", toolEnd("c4", "Settings"), turn = "t3")
        // The pending question also shows Stop. The empty online composer returns to Voice
        // once it clears, so the Stop below belongs to the next turn.
        rule.waitUntilAtLeastOneExists(hasTestTag(ComposerTags.PRIMARY) and hasContentDescription("Voice"), 10_000)

        // Thinking: the composer's button is Stop, and it aborts.
        val aborts = journey.rpc("s1", "abort") { JsonPrimitive(true) }
        journey.agent("s1", buildJsonObject { put("t", "turn-start") }, turn = "t4")
        rule.waitUntilAtLeastOneExists(hasTestTag(ComposerTags.PRIMARY) and hasContentDescription("Stop"), 10_000)
        rule.node(ComposerTags.PRIMARY).assertContentDescriptionEquals("Stop")
        rule.node(ComposerTags.PRIMARY).performClick()
        rule.waitUntil(10_000) { aborts.isNotEmpty() }
        assertEquals(buildJsonObject { put("reason", SessionOps.ABORT_REASON) }, aborts.single())
        journey.agent("s1", buildJsonObject { put("t", "turn-end"); put("status", "cancelled") }, turn = "t4")

        // Near the limit: 95% of the context, and the week from the usage limits.
        journey.agentState("s1", buildJsonObject {
            putJsonObject("usageLimits") {
                put("capturedAt", 1)
                putJsonArray("windows") {
                    add(buildJsonObject { put("id", "five_hour"); put("utilization", 12); put("resetsAt", 1.9e12) })
                    add(buildJsonObject { put("id", "seven_day"); put("utilization", 40); put("resetsAt", 1.9e12) })
                }
            }
        })
        journey.agent(
            "s1",
            text("Almost out of room."),
            turn = "t5",
            usage = buildJsonObject { put("input_tokens", 190_000); put("output_tokens", 100); put("context_window", 200_000) },
        )
        rule.waitForText("95% context")
        rule.waitForText("40% week")
        assert(shown(UsageRowTags.ROW))
        rule.assertActionsLabelled()
        // The week opens the session and week limits; picking one closes them.
        rule.node(UsageRowTags.WEEK).performClick()
        rule.waitFor(OptionMenuTags.item("usage", "session"))
        rule.waitForText("Session · 12%", substring = true)
        rule.waitForText("Week · 40%", substring = true)
        rule.assertActionsLabelled()
        rule.node(OptionMenuTags.item("usage", "week")).performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(OptionMenuTags.MENU, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }

        // Reading back fades the details; the scroll button brings them back.
        rule.node(ChatListTags.LIST).performTouchInput { swipeDown(startY = top + 200f, endY = bottom - 200f) }
        rule.waitFor(ChatListTags.SCROLL_BUTTON)
        rule.waitUntil(5_000) { !shown(UsageRowTags.ROW) }
        rule.node(ChatListTags.SCROLL_BUTTON).performClick()
        rule.waitUntil(5_000) { shown(UsageRowTags.ROW) }
    }
}
