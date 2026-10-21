package com.slopus.happy.journeys

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.auth.AuthState
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.attachments.AttachmentStripTags
import com.slopus.happy.ui.chat.ChatScreenTags
import com.slopus.happy.ui.chat.MessageTags
import com.slopus.happy.ui.home.HomeDockTags
import com.slopus.happy.ui.home.HomeTags
import com.slopus.happy.ui.node
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
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
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Journey 1, a new account: Create account lands on Link Your Computer;
 * the computer the user links appears and home offers the dock; the dock
 * starts a Claude session on it with a prompt and a pasted image, and the
 * chat opens with that first message delivered to the server, image and all.
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

        // Welcome → Create account → Link Your Computer.
        rule.onNodeWithText("Create account").performClick()
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
        rule.waitFor(HomeDockTags.CAPSULE, 15_000)
        rule.node(HomeTags.LINK).assertDoesNotExist()

        // The dock: a prompt and an image from the clipboard.
        rule.node(HomeDockTags.CAPSULE).performClick()
        rule.waitFor(HomeDockTags.INPUT)
        copyImageToClipboard()
        rule.node(HomeDockTags.ADD_IMAGE).performClick()
        rule.onNodeWithText("Paste from Clipboard").performClick()
        rule.waitFor(AttachmentStripTags.THUMB)
        rule.node(HomeDockTags.INPUT).performTextInput("Explain this screenshot")
        rule.assertActionsLabelled()
        rule.node(HomeDockTags.PRIMARY).performClick()

        // The chat opens on the new session with the message delivered.
        rule.waitFor(ChatScreenTags.SCREEN, 15_000)
        rule.waitFor(MessageTags.USER)
        rule.waitForText("Explain this screenshot")
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
    }

    private companion object {
        const val NEW_SESSION = "s-new"
    }
}
