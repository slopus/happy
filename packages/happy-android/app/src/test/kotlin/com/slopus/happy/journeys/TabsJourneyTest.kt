package com.slopus.happy.journeys

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.model.PENDING_CHAT_PREFIX
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.chat.ChatScreenTags
import com.slopus.happy.ui.chat.ComposerTags
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.session.WorktreeTabTags
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A checkout's tabs: picking one shows its chat in the same screen, with no
 * page pushed, the header naming the checkout and the composer holding that
 * chat's own draft; `+` opens a new chat beside them the same way.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TabsJourneyTest {
    @get:Rule val rule = createComposeRule()

    private val journey = Journey()
    private val server = journey.server
    private lateinit var graph: AppGraph

    @After
    fun tearDown() = journey.close()

    private fun text(text: String) = buildJsonObject { put("t", "text"); put("text", text) }

    /** The screen's node: the same one while the page stays. */
    private fun screen() = rule.node(ChatScreenTags.SCREEN).fetchSemanticsNode().id

    private fun headerTitle() = rule.onAllNodes(hasTestTag(HeaderTags.TITLE), useUnmergedTree = true).fetchSemanticsNodes()
        .mapNotNull { it.config.getOrNull(SemanticsProperties.Text)?.joinToString() }

    @Test
    fun aTabShowsItsChatInPlace_withItsOwnDraft_andANewTabOpensBeside() {
        journey.machine()
        journey.session("a1", updatedAt = 200, title = "First chat")
        journey.session("a2", updatedAt = 100, title = "Second chat")
        journey.agent("a1", text("First answer"))
        journey.agent("a2", text("Second answer"))
        val spawns = journey.rpc(Journey.MACHINE, "spawn-happy-session") {
            server.addSession("a3", updatedAt = 90_000, metadata = Journey.sessionMetadata("/h/repo", "Third chat", "claude-a3"))
            buildJsonObject { put("type", "success"); put("sessionId", "a3") }
        }
        graph = journey.graph()
        journey.signIn(graph)
        rule.setContent { HappyApp(graph) }
        rule.waitForText("First chat")
        rule.onNode(hasText("First chat"), useUnmergedTree = true).performClick()
        rule.waitForText("First answer")
        graph.settings.change { it.copy(sessionListGrouping = SessionListGrouping.Project) }
        rule.waitFor(WorktreeTabTags.tab("a2"))
        rule.waitForIdle()
        val page = screen()
        val composer = rule.node(ComposerTags.INPUT).fetchSemanticsNode().id

        // The second tab: its chat in the same screen and composer, the header still the checkout's.
        rule.node(WorktreeTabTags.tab("a2")).performClick()
        rule.waitForText("Second answer")
        rule.onAllNodes(hasText("First answer"), useUnmergedTree = true).fetchSemanticsNodes().let { assertTrue("the first chat's rows are gone", it.isEmpty()) }
        assertEquals(page, screen())
        assertEquals(composer, rule.node(ComposerTags.INPUT).fetchSemanticsNode().id)
        rule.node(WorktreeTabTags.tab("a2")).assertIsSelected()
        assertTrue("header names the checkout: ${headerTitle()}", headerTitle().none { "chat" in it })

        // Each tab's draft is its own, there at once on the way back.
        rule.node(ComposerTags.INPUT).performTextInput("for the second")
        rule.waitUntil(5_000) { graph.account.value?.composer?.mirrors?.value?.get("a2")?.draft == "for the second" }
        rule.node(WorktreeTabTags.tab("a1")).performClick()
        rule.waitForText("First answer")
        rule.node(ComposerTags.INPUT).assertTextEquals("")
        rule.node(WorktreeTabTags.tab("a2")).performClick()
        rule.waitForText("Second answer")
        rule.node(ComposerTags.INPUT).assertTextEquals("for the second")

        // `+`: a stand-in tab in the same screen, then the chat the machine started.
        val standIn = SemanticsMatcher("a stand-in's tab") {
            it.config.getOrNull(SemanticsProperties.TestTag)?.startsWith(WorktreeTabTags.tab(PENDING_CHAT_PREFIX)) == true
        }
        rule.node(WorktreeTabTags.ADD).performClick()
        rule.waitUntil(5_000) {
            rule.onAllNodes(standIn, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() ||
                rule.onAllNodes(hasTestTag(WorktreeTabTags.tab("a3")), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        assertEquals(page, screen())
        rule.waitUntil(10_000) { spawns.isNotEmpty() }
        rule.waitFor(WorktreeTabTags.tab("a3"))
        rule.waitUntil(10_000) {
            rule.onAllNodes(hasTestTag(WorktreeTabTags.tab("a3")), useUnmergedTree = true).fetchSemanticsNodes()
                .any { it.config.getOrNull(SemanticsProperties.Selected) == true }
        }
        assertEquals(page, screen())
    }
}
