package com.slopus.happy.ui.attachments

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.rememberNavController
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.chat.AgentQuestionAnswer
import com.slopus.happy.chat.ChatActions
import com.slopus.happy.chat.PermissionAnswer
import com.slopus.happy.crypto.AccountEncryption
import com.slopus.happy.crypto.decryptBlob
import com.slopus.happy.testing.FakeHappyServer
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.chat.ComposerTags
import com.slopus.happy.ui.chat.SessionRoute
import com.slopus.happy.ui.chat.chatRoutes
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The composer's images end to end (SessionView + useImagePicker +
 * sendMessage): the add button only where the agent takes images, paste
 * into the strip, and on send the upload to the server and the file event
 * records handed to the chat's send with the text.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ComposerAttachmentsFlowTest {
    @get:Rule
    val rule = createComposeRule()

    private lateinit var server: FakeHappyServer
    private lateinit var graph: AppGraph

    private data class Sent(val text: String, val attachments: List<JsonObject>)

    private val sent = CopyOnWriteArrayList<Sent>()
    private val actions = object : ChatActions {
        override suspend fun send(sessionId: String, text: String, meta: JsonObject?, attachments: List<JsonObject>, awaitDelivery: Boolean) {
            sent += Sent(text, attachments)
        }
        override suspend fun abort(sessionId: String) = Unit
        override suspend fun answerPermission(sessionId: String, answer: PermissionAnswer) = Unit
        override suspend fun answerQuestion(sessionId: String, communicationId: String, answers: Map<String, AgentQuestionAnswer>, kind: String) = Unit
        override suspend fun cancelQuestion(sessionId: String, communicationId: String, kind: String) = Unit
    }

    @Before
    fun setUp() {
        server = FakeHappyServer().start()
        server.addSession("claude", updatedAt = 2, metadata = buildJsonObject { put("path", "/a"); put("host", "h"); put("flavor", "claude") })
        server.addSession("gemini", updatedAt = 3, metadata = buildJsonObject { put("path", "/b"); put("host", "h"); put("flavor", "gemini") })
        graph = AppGraph(
            context = ApplicationProvider.getApplicationContext(),
            clientId = "android/test",
            defaultServerUrl = server.url,
            secureStoreKeys = SoftwareKeys(),
            databaseName = null,
        )
        runBlocking { graph.auth.signIn(server.token, server.secret) }
        val deadline = System.currentTimeMillis() + 10_000
        while (graph.store.session("gemini") == null || graph.store.session("claude") == null) {
            check(System.currentTimeMillis() < deadline) { "sessions did not sync" }
            Thread.sleep(50)
        }
    }

    @After
    fun tearDown() = server.close()

    private fun open(id: String) {
        rule.setHappyContent {
            val nav = rememberNavController()
            NavHost(nav, startDestination = SessionRoute(id)) { chatRoutes(graph, nav, actions) }
        }
        rule.waitUntilAtLeastOneExists(hasTestTag(ComposerTags.INPUT), 5_000)
    }

    private fun copyImageToClipboard() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val file = File(context.cacheDir, "copied.png")
        file.outputStream().use { Bitmap.createBitmap(40, 30, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.GREEN) }.compress(Bitmap.CompressFormat.PNG, 100, it) }
        val clip = ClipData(ClipDescription("image", arrayOf("image/png")), ClipData.Item(Uri.fromFile(file)))
        context.getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
    }

    @Test
    fun agentsWithoutImagesHaveNoAddButton() {
        open("gemini")
        rule.node(AttachmentStripTags.ADD).assertDoesNotExist()
    }

    @Test
    fun aPastedImageIsUploadedAndSentAheadOfTheText() {
        open("claude")
        copyImageToClipboard()
        rule.node(AttachmentStripTags.ADD).performClick()
        rule.onNodeWithText("Paste from Clipboard").performClick()
        rule.waitUntilAtLeastOneExists(hasTestTag(AttachmentStripTags.THUMB), 10_000)

        rule.node(ComposerTags.INPUT).performTextInput("what is this?")
        rule.node(ComposerTags.PRIMARY).performClick()
        rule.waitUntil(10_000) { sent.isNotEmpty() }

        val message = sent.single()
        assertEquals("what is this?", message.text)
        val ev = message.attachments.single()["content"]!!.jsonObject["data"]!!.jsonObject["ev"]!!.jsonObject
        assertEquals("file", ev["t"]!!.jsonPrimitive.content)
        assertEquals("40", ev["image"]!!.jsonObject["width"]!!.jsonPrimitive.content)
        assertTrue(ev["name"]!!.jsonPrimitive.content.endsWith(".jpg"))
        // The blob is on the server, encrypted with the session's blob key, a JPEG inside.
        val blob = server.attachments[ev["ref"]!!.jsonPrimitive.content]
        assertNotNull(blob)
        val jpeg = decryptBlob(blob!!, AccountEncryption.blobKeyForDataKey(server.dataKey("claude")))!!
        assertEquals(0xFF.toByte(), jpeg[0])
        assertEquals(0xD8.toByte(), jpeg[1])
        // Sent images leave the strip.
        rule.waitUntil(5_000) { rule.onAllNodes(hasTestTag(AttachmentStripTags.THUMB), useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
    }

    @Test
    fun anImageAloneCanBeSent() {
        open("claude")
        copyImageToClipboard()
        rule.node(AttachmentStripTags.ADD).performClick()
        rule.onNodeWithText("Paste from Clipboard").performClick()
        rule.waitUntilAtLeastOneExists(hasTestTag(AttachmentStripTags.THUMB), 10_000)
        rule.node(ComposerTags.PRIMARY).performClick()
        rule.waitUntil(10_000) { sent.isNotEmpty() }
        assertEquals("", sent.single().text)
        assertEquals(1, sent.single().attachments.size)
    }

    @Test
    fun anEmptyClipboardSaysSo() {
        open("claude")
        rule.node(AttachmentStripTags.ADD).performClick()
        rule.onNodeWithText("Paste from Clipboard").performClick()
        rule.waitUntilAtLeastOneExists(hasText("Nothing to Paste"), 5_000)
    }
}
