package com.slopus.happy.journeys

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.chat.ChatScreenTags
import com.slopus.happy.ui.chat.ComposerPickerTags
import com.slopus.happy.ui.components.PickerSheetTags
import com.slopus.happy.ui.home.HomeTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.session.DuplicateSheetTags
import com.slopus.happy.ui.session.SessionInfoTags
import com.slopus.happy.ui.session.WorktreeTabTags
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Journey 3, a session's life after its first turn: archiving a worktree's
 * only chat from the home row menu offers to delete the clean worktree;
 * archiving a chat from its Session Info hands its tab to the chat beside
 * it; a stopped session resumes from Session Info with the permission mode
 * picked in its composer; and a chat is duplicated from a rewind point into
 * a new session.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LifecycleJourneyTest {
    @get:Rule val rule = createComposeRule()

    private val journey = Journey()
    private val server = journey.server
    private lateinit var graph: AppGraph

    @After
    fun tearDown() = journey.close()

    private fun launch() {
        graph = journey.graph()
        journey.signIn(graph)
        rule.setContent { HappyApp(graph) }
    }

    private fun dialogButton(text: String) = rule.onNode(hasText(text) and hasClickAction() and hasAnyAncestor(isDialog()))

    private fun spawnAnswers(newId: String, title: String): MutableList<JsonObject> =
        journey.rpc(Journey.MACHINE, "spawn-happy-session") { request ->
            server.addSession(newId, updatedAt = 90_000, metadata = Journey.sessionMetadata(request["directory"]!!.jsonPrimitive.content, title, "claude-$newId"))
            buildJsonObject { put("type", "success"); put("sessionId", newId) }
        }

    @Test
    fun archivingAWorktreesChatOffersToDeleteIt_andInfoHandsTheTabOn() {
        journey.machine()
        journey.session("w1", updatedAt = 300, path = "/h/repo/.dev/worktree/feat", title = "Worktree chat")
        journey.session("a1", updatedAt = 200, title = "First chat")
        journey.session("a2", updatedAt = 100, title = "Second chat")
        val bash = journey.rpc(Journey.MACHINE, "bash") { buildJsonObject { put("success", true); put("stdout", ""); put("stderr", ""); put("exitCode", 0) } }
        launch()
        rule.waitForText("Worktree chat")
        rule.assertActionsLabelled()

        // The worktree's only chat, archived from its menu: the clean worktree may go too.
        rule.onNode(hasText("Worktree chat"), useUnmergedTree = true).performTouchInput { longClick() }
        rule.waitForText("Archive")
        dialogButton("Archive").performClick()
        rule.waitForText("Delete Worktree?")
        rule.assertActionsLabelled()
        dialogButton("Delete Worktree").performClick()
        rule.waitUntil(10_000) { bash.any { it["command"]!!.jsonPrimitive.content.startsWith("git worktree remove") } }
        val asked = bash.filter { it["cwd"]!!.jsonPrimitive.content == "/h/repo/.dev/worktree/feat" }
        assertEquals("git status --porcelain", asked.single()["command"]!!.jsonPrimitive.content)
        val removed = bash.single { it["command"]!!.jsonPrimitive.content.startsWith("git worktree remove") }
        assertEquals("git worktree remove /h/repo/.dev/worktree/feat --force", removed["command"]!!.jsonPrimitive.content)
        assertEquals("/h/repo", removed["cwd"]!!.jsonPrimitive.content)
        rule.waitUntil(10_000) { server.requestsTo("/v1/sessions/w1/archive").isNotEmpty() }

        // The second chat archived from its Session Info: the first takes its place.
        rule.onNode(hasText("Second chat"), useUnmergedTree = true).performClick()
        rule.waitFor(ChatScreenTags.SCREEN)
        // Tabs are the project layout's: the chats of one checkout.
        graph.settings.change { it.copy(sessionListGrouping = SessionListGrouping.Project) }
        rule.waitFor(WorktreeTabTags.tab("a1"))
        rule.waitForIdle()
        openInfo()
        rule.waitFor(SessionInfoTags.ARCHIVE)
        rule.assertActionsLabelled()
        rule.node(SessionInfoTags.ARCHIVE).performScrollTo().performClick()
        rule.waitUntil(10_000) { server.requestsTo("/v1/sessions/a2/archive").isNotEmpty() }
        // The checkout's chat now: its tab is the only one left, and the archived chat's is gone.
        rule.waitUntil(10_000) {
            rule.onAllNodes(hasTestTag(WorktreeTabTags.tab("a2")), useUnmergedTree = true).fetchSemanticsNodes().isEmpty() &&
                rule.onAllNodes(hasTestTag(WorktreeTabTags.tab("a1")), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        rule.node(WorktreeTabTags.tab("a1")).assertIsSelected()
    }

    @Test
    fun aStoppedSessionResumesWithItsModes_andDuplicatesFromARewindPoint() {
        journey.machine()
        journey.session("r1", updatedAt = 100, path = "/h/old", title = "Stopped chat")
        val resumes = journey.rpc(Journey.MACHINE, "resume-happy-session") { request ->
            server.addSession("r1", updatedAt = 80_000, metadata = Journey.sessionMetadata("/h/old", "Stopped chat", "claude-r1"))
            buildJsonObject { put("type", "success"); put("sessionId", request["sessionId"]!!.jsonPrimitive.content) }
        }
        launch()
        rule.waitForText("Stopped chat")

        // Plan mode picked in the chat; then its agent stops.
        rule.onNode(hasText("Stopped chat"), useUnmergedTree = true).performClick()
        rule.waitFor(ChatScreenTags.SCREEN)
        rule.node(ComposerPickerTags.PERMISSION).performClick()
        rule.waitFor(PickerSheetTags.PANEL)
        rule.node(PickerSheetTags.option("plan")).performClick()
        rule.waitUntil(5_000) { graph.account.value?.composer?.mirrors?.value?.get("r1")?.permissionMode == "plan" }
        server.addSession("r1", updatedAt = 60_000, metadata = Journey.sessionMetadata("/h/old", "Stopped chat", "claude-r1"), active = false)
        server.emitEphemeral(buildJsonObject {
            put("type", "activity"); put("id", "r1"); put("active", false); put("activeAt", System.currentTimeMillis()); put("thinking", false)
        })
        server.dropSockets()
        rule.waitForText("This session is inactive.", substring = true)

        // Resumed from its info, with the pick.
        openInfo()
        rule.waitFor(SessionInfoTags.RESUME)
        rule.node(SessionInfoTags.RESUME).performScrollTo().performClick()
        rule.waitUntil(10_000) { resumes.isNotEmpty() }
        assertEquals("r1", resumes.single()["sessionId"]!!.jsonPrimitive.content)
        assertEquals("plan", resumes.single()["permissionMode"]!!.jsonPrimitive.content)
        rule.waitFor(ChatScreenTags.SCREEN)
        rule.waitUntil(10_000) { graph.store.session("r1")?.active == true }

        // The resumed chat, duplicated from its first answer.
        val points = journey.rpc(Journey.MACHINE, "claude-list-rewind-points") {
            buildJsonObject {
                put("type", "success")
                putJsonArray("points") {
                    add(buildJsonObject { put("uuid", "u1"); put("text", "Port the parser"); put("timestamp", 1_000.0) })
                    add(buildJsonObject { put("uuid", "u2"); put("text", "Now add tests"); put("timestamp", 2_000.0) })
                }
            }
        }
        val duplicates = journey.rpc(Journey.MACHINE, "claude-duplicate-session") {
            buildJsonObject { put("type", "success"); put("newClaudeSessionId", "claude-copy") }
        }
        val spawns = spawnAnswers("copy", "Copied chat")
        openInfo()
        rule.waitFor(SessionInfoTags.DUPLICATE)
        rule.node(SessionInfoTags.DUPLICATE).performScrollTo().performClick()
        rule.waitFor(DuplicateSheetTags.ROW)
        rule.assertActionsLabelled()
        rule.onNode(hasTestTag(DuplicateSheetTags.ROW) and hasAnyDescendant(hasText("Port the parser")), useUnmergedTree = true)
            .performClick()
        rule.node(DuplicateSheetTags.CONFIRM).performClick()
        rule.waitUntil(10_000) { spawns.isNotEmpty() }
        assertEquals("u1", duplicates.single()["cutAfterUuid"]!!.jsonPrimitive.content)
        assertEquals("claude-r1", points.single()["claudeSessionId"]!!.jsonPrimitive.content)
        assertEquals("claude-copy", spawns.single()["resumeClaudeSessionId"]!!.jsonPrimitive.content)
        rule.waitForChatTitle("Copied chat")
    }

    /** The title takes taps only once the session has loaded; its tag shows earlier. */
    private fun openInfo() {
        rule.waitUntilAtLeastOneExists(hasTestTag(ChatScreenTags.TITLE_BUTTON) and hasClickAction(), 10_000)
        rule.node(ChatScreenTags.TITLE_BUTTON).performClick()
    }
}
