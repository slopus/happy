package com.slopus.happy.journeys

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.auth.AuthState
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.attachments.AttachmentStripTags
import com.slopus.happy.attachments.AttachTabKind
import com.slopus.happy.ui.attach.AttachTags
import com.slopus.happy.ui.chat.ChatScreenTags
import com.slopus.happy.ui.chat.ComposeChatTags
import com.slopus.happy.ui.chat.ComposerTags
import com.slopus.happy.ui.chat.MessageTags
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.home.HomeTags
import com.slopus.happy.ui.node
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Journey 1, a new account: a new account lands on Link Your Computer;
 * the computer the user links appears and home offers compose; compose opens
 * an empty chat whose first send starts a Claude session on it with a prompt
 * and a pasted image, and that screen becomes the session's chat with the
 * message delivered to the server, image and all.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NewAccountJourneyTest {
    @get:Rule val rule = createComposeRule()

    private val journey = Journey()
    private val server = journey.server
    private lateinit var graph: AppGraph

    @After
    fun tearDown() = journey.close()

    @Test
    fun createLinkStartAndSendTheFirstMessageWithAnImage() {
        graph = journey.graph()
        rule.setContent { HappyApp(graph) }

        // A new account: home, with its link state (no computer yet) under the usual header.
        // The first screen makes no empty account; make one directly, as a terminal code would.
        runBlocking { graph.auth.createAccount() }
        rule.waitFor(HomeTags.LINK)
        rule.waitForText("Link Your Computer")
        rule.assertActionsLabelled()
        val account = graph.auth.state.value as AuthState.SignedIn
        server.adoptAccount(account.credentials.secretBytes())

        // The computer links (happy-cli registers its machine); the app hears on reconnect.
        val spawns = CopyOnWriteArrayList<JsonObject>()
        server.rpc["${Journey.MACHINE}:spawn-happy-session"] = { params ->
            val request = server.openRpc(Journey.MACHINE, params).jsonObject
            spawns += request
            server.addSession(
                NEW_SESSION,
                updatedAt = 50_000,
                metadata = Journey.sessionMetadata(request["directory"]!!.jsonPrimitive.content, "New chat"),
            )
            server.sealRpc(Journey.MACHINE, buildJsonObject { put("type", "success"); put("sessionId", NEW_SESSION) })
        }
        journey.machine(updatedAt = 10)
        server.dropSockets()
        // The link state giving way is what says the computer arrived; compose floats over home.
        rule.waitUntilDoesNotExist(hasTestTag(HomeTags.LINK), 15_000)
        rule.waitFor(HomeTags.COMPOSE)

        // Compose: an empty chat aimed at that computer, with a prompt and an image from the clipboard.
        rule.node(HomeTags.COMPOSE).performClick()
        rule.waitFor(ComposeChatTags.TARGET)
        rule.waitFor(ComposerTags.INPUT)
        // The attachment sheet: its File tab pastes, the caption is the draft, its check puts the image in the composer.
        copyImageToClipboard()
        rule.node(AttachmentStripTags.ADD).performClick()
        rule.node(AttachTags.tab(AttachTabKind.Files)).performClick()
        rule.node(AttachTags.PASTE).performClick()
        rule.waitFor(AttachTags.CONFIRM)
        rule.node(AttachTags.CAPTION).performTextInput("Explain this screenshot")
        rule.node(AttachTags.CONFIRM).performClick()
        rule.waitFor(AttachmentStripTags.THUMB)
        rule.node(ComposerTags.PRIMARY).performClick()

        // The same screen becomes the new session's chat, with the message delivered.
        rule.waitFor(MessageTags.USER, 15_000)
        rule.waitForText("Explain this screenshot")
        rule.waitUntilDoesNotExist(hasTestTag(ComposeChatTags.TARGET), 5_000)
        rule.onAllNodes(hasTestTag(ChatScreenTags.SCREEN), useUnmergedTree = true).assertCountEquals(1)
        rule.assertActionsLabelled()

        val spawn = spawns.single()
        assertEquals("claude", spawn["agent"]!!.jsonPrimitive.content)
        assertEquals("/h", spawn["directory"]!!.jsonPrimitive.content)
        val records = server.sentRecords(NEW_SESSION).map { it.second }
        val text = records.single { it["role"]?.jsonPrimitive?.content == "user" && "text" in it.toString() && "Explain this screenshot" in it.toString() }
        assertTrue(text.toString(), text.toString().contains("Explain this screenshot"))
        // The image went up as a session attachment, ahead of or with the text.
        assertEquals(1, server.attachments.keys.count { it.startsWith("sessions/$NEW_SESSION/attachments/") })
        val refs = records.flatMap { record -> Regex("\"ref\":\"([^\"]+)\"").findAll(record.toString()).map { it.groupValues[1] }.toList() }
        assertTrue("a record names the uploaded image: $records", refs.any { it in server.attachments })
        rule.onAllNodes(hasTestTag(MessageTags.USER), useUnmergedTree = true).fetchSemanticsNodes().let { assertTrue(it.isNotEmpty()) }

        // It took the compose screen's place: one Back is home.
        rule.node(HeaderTags.LEFT).performClick()
        rule.waitFor(HomeTags.COMPOSE)
        rule.waitUntilDoesNotExist(hasTestTag(ChatScreenTags.SCREEN), 5_000)
    }

    private companion object {
        const val NEW_SESSION = "s-new"
    }
}
