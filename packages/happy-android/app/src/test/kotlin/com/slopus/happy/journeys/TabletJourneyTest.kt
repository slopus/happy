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
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.ChatScreenTags
import com.slopus.happy.ui.chat.ComposerTags
import com.slopus.happy.ui.chat.MessageTags
import com.slopus.happy.ui.home.FlatRowTags
import com.slopus.happy.ui.home.HomeDockTags
import com.slopus.happy.ui.home.HomeTags
import com.slopus.happy.ui.home.NewSessionTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.tablet.TabletShellTags
import com.slopus.happy.ui.tablet.TabletSidebarTags
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
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
 * Journey 6, the core path on a tablet: the sessions in the sidebar beside a
 * blank detail; a chat opens in the detail with its row selected and a reply
 * goes out; New Session opens in the detail, starts a session whose chat
 * takes the detail with its new row selected; back retraces both. The open
 * chat archived from its row menu leaves the sidebar but stays in the
 * detail, inactive; back then reaches the blank.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w1280dp-h800dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TabletJourneyTest {
    @get:Rule val rule = createComposeRule()

    private val journey = Journey()
    private val server = journey.server

    @After
    fun tearDown() = journey.close()

    private fun row(title: String) = rule.onNode(hasTestTag(FlatRowTags.ROW) and hasAnyDescendant(hasText(title)), useUnmergedTree = true)

    @Test
    fun sidebarDetailChatAndANewSession() {
        journey.machine()
        journey.session("a", updatedAt = 200, title = "Tablet chat")
        val graph = journey.graph()
        journey.signIn(graph)
        rule.setContent { HappyApp(graph) }

        // The list in the sidebar, a blank detail beside it.
        rule.waitFor(FlatRowTags.ROW)
        rule.node(HomeTags.TABLET_BLANK).assertExists()
        assertDp("detail beside the sidebar", 360, rule.node(TabletShellTags.DETAIL).bounds.left)
        rule.assertActionsLabelled()

        // A chat in the detail, its row selected; a reply goes out.
        row("Tablet chat").performClick()
        rule.waitFor(ChatScreenTags.SCREEN)
        assertDp("chat in the detail", 360, rule.node(ChatScreenTags.SCREEN).bounds.left)
        row("Tablet chat").assertIsSelected()
        // The composer comes with the session, a beat after the screen.
        rule.waitFor(ComposerTags.INPUT)
        rule.node(ComposerTags.INPUT).performTextInput("from the tablet")
        rule.node(ComposerTags.PRIMARY).performClick()
        rule.waitUntil(10_000) { server.sentRecords("a").any { "from the tablet" in it.second.toString() } }
        rule.waitFor(MessageTags.USER)
        rule.assertActionsLabelled()

        // New Session in the detail: it starts, and its chat replaces the other.
        val spawns = journey.rpc(Journey.MACHINE, "spawn-happy-session") { request ->
            server.addSession("b", updatedAt = 90_000, metadata = Journey.sessionMetadata(request["directory"]!!.jsonPrimitive.content, "Started on tablet"))
            buildJsonObject { put("type", "success"); put("sessionId", "b") }
        }
        rule.node(TabletSidebarTags.NEW_SESSION).performClick()
        rule.waitFor(NewSessionTags.SCREEN)
        assertTrue(rule.node(NewSessionTags.SCREEN).bounds.left >= 360.dp)
        rule.waitFor(HomeDockTags.INPUT)
        rule.node(HomeDockTags.INPUT).performTextInput("Start here")
        rule.node(HomeDockTags.PRIMARY).performClick()
        rule.waitUntil(15_000) { server.sentRecords("b").any { "Start here" in it.second.toString() } }
        assertEquals("claude", spawns.single()["agent"]!!.jsonPrimitive.content)
        rule.waitForChatTitle("Started on tablet", 15_000)
        rule.waitUntil(10_000) { runCatching { row("Started on tablet").assertIsSelected() }.isSuccess }
        assertDp("new chat in the detail", 360, rule.node(ChatScreenTags.SCREEN).bounds.left)

        // Back goes to the chat that was open before, its row selected again; once more, the blank.
        rule.node(TabletShellTags.BACK).performClick()
        rule.waitForChatTitle("Tablet chat")
        row("Tablet chat").assertIsSelected()
        // The open chat archived from its sidebar row's menu: the row leaves the sidebar, and
        // the detail stays on the chat, now inactive (happy-app's row menu moves nothing).
        row("Tablet chat").performTouchInput { longClick() }
        rule.onNode(hasText("Archive") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        rule.waitUntil(10_000) { server.requestsTo("/v1/sessions/a/archive").isNotEmpty() }
        rule.waitUntil(10_000) { rule.onAllNodes(hasTestTag(FlatRowTags.ROW) and hasAnyDescendant(hasText("Tablet chat")), useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
        // The server says the session ended, as it does once the archive lands.
        server.emitEphemeral(buildJsonObject {
            put("type", "activity"); put("id", "a"); put("active", false); put("activeAt", System.currentTimeMillis()); put("thinking", false)
        })
        rule.waitForText("This session is inactive.")
        rule.waitForChatTitle("Tablet chat")
        row("Started on tablet").assertExists()
        rule.node(TabletShellTags.BACK).performClick()
        rule.waitFor(HomeTags.TABLET_BLANK)
    }
}
