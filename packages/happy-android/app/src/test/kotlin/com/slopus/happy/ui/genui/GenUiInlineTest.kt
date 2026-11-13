package com.slopus.happy.ui.genui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.Collections

/**
 * A Gen UI artifact under its card in a conversation: read once per
 * version, drawn in its first frame when read before, its `message` sent to
 * this conversation only when this conversation's agent made the version.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GenUiInlineTest {
    @get:Rule val rule = createComposeRule()
    private val asked: MutableList<String> = Collections.synchronizedList(ArrayList())

    private fun computer(origin: String?, render: String = "01-stats", listed: Boolean = true) = AgentClient(
        object : Transport {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                asked += path
                if ("/files/" in path) {
                    return if (path.endsWith("/files/.genui/render.json")) TransportResponse(200, body = File("src/debug/assets/genui/fixtures/$render.json").readBytes())
                    else TransportResponse(404, body = "{}".toByteArray())
                }
                val by = origin?.let { """{"kind":"agent","agentId":"$it"}""" } ?: """{"kind":"user","userId":"u1"}"""
                return TransportResponse(
                    200,
                    mapOf("content-type" to "application/json"),
                    """{"version":{"artifactId":"g1","number":2,"title":"Q3","entry":{"path":"index.genui.json"},"files":[${if (listed) """{"path":".genui/render.json","mimeType":"application/json","size":10}""" else ""}],"createdBy":$by}}""".toByteArray(),
                )
            }

            override suspend fun close() {}
        },
        "t",
    )

    @Test fun itsOwnAgentsBlockSendsToThisConversation() {
        val sent = ArrayList<String>()
        val inline = GenUiInline(computer("a1"), null, "a1", onMessage = { sent += it }, onOpenWeb = {})
        rule.setHappyContent { GenUiInlineBlock("g1", 2, inline, label = { it }) }
        rule.waitUntil(5_000) { inline.block("g1", 2) != null }
        rule.node(GenUiInlineTags.BLOCK).assertExists()
        rule.onNodeWithText("Break down by plan").assertIsEnabled().performClick()
        assertEquals(listOf("Break down by plan"), sent)
        assertTrue(asked.any { it.endsWith("/artifacts/g1/versions/2") })
    }

    private fun messageStaysDisabled(origin: String?) {
        val inline = GenUiInline(computer(origin), null, "a1", onMessage = { throw AssertionError("sent") }, onOpenWeb = {})
        rule.setHappyContent { GenUiInlineBlock("g1", 2, inline, label = { it }) }
        rule.waitUntil(5_000) { inline.block("g1", 2) != null }
        rule.onNodeWithText("Break down by plan").assertIsNotEnabled()
    }

    @Test fun anotherAgentsBlockDoesNotSendHere() = messageStaysDisabled("someone-else")

    @Test fun aPersonsBlockHasNoOneToSendTo() = messageStaysDisabled(null)

    @Test fun aVersionReadBeforeDrawsInItsFirstFrameWithoutReadingAgain() {
        val client = computer("a1")
        val first = GenUiInline(client, null, "a1", onMessage = {}, onOpenWeb = {})
        var which by mutableStateOf(first)
        rule.setHappyContent { GenUiInlineBlock("g1", 2, which, label = { it }) }
        rule.waitUntil(5_000) { first.block("g1", 2) != null }
        rule.waitForIdle()
        val height = rule.node(GenUiInlineTags.BLOCK).fetchSemanticsNode().size.height
        val reads = asked.size
        // The chat opened again: a new holder over the same connection.
        val again = GenUiInline(client, null, "a1", onMessage = {}, onOpenWeb = {})
        rule.mainClock.autoAdvance = false
        rule.runOnIdle { which = again }
        rule.mainClock.advanceTimeByFrame()
        rule.node(GenUiInlineTags.WAITING).assertDoesNotExist()
        assertEquals(height, rule.node(GenUiInlineTags.BLOCK).fetchSemanticsNode().size.height)
        assertEquals("nothing read again", reads, asked.size)
    }

    /** A version's state is one wherever it shows: a secret saved on the artifact screen marks the chat's card too. */
    @Test fun theChatsCardSharesItsVersionsStateWithTheArtifactScreen() {
        val client = computer("a1")
        val inline = GenUiInline(client, null, "a1", onMessage = {}, onOpenWeb = {})
        rule.setHappyContent { GenUiInlineBlock("g1", 2, inline, label = { it }) }
        rule.waitUntil(5_000) { inline.block("g1", 2) != null }
        val screen = GenUiState.of(GenUiSecretApi(client).computer, "g1", 2)
        assertTrue(inline.block("g1", 2)!!.state === screen)
        screen.save("add-key", "s1")
        assertEquals("s1", inline.block("g1", 2)!!.state.saved("add-key"))
        assertTrue("another version, another state", GenUiState.of(client, "g1", 3) !== screen)
        assertTrue("another computer, another state", GenUiState.of(computer("a1"), "g1", 2) !== screen)
        assertTrue("no computer, a state of its own", GenUiState.of(null, "g1", 2) !== GenUiState.of(null, "g1", 2))
    }

    /** A Happy Cloud server leaves `.genui/render.json` out of the manifest and serves it all the same. */
    @Test fun aRenderDocumentTheManifestDoesntListIsReadByItsPath() {
        val inline = GenUiInline(computer("a1", listed = false), null, "a1", onMessage = {}, onOpenWeb = {})
        rule.setHappyContent { GenUiInlineBlock("g1", 2, inline, label = { it }) }
        rule.waitUntil(5_000) { inline.block("g1", 2) != null }
        rule.node(GenUiInlineTags.BLOCK).assertExists()
        assertTrue(asked.any { it.endsWith("/files/.genui/render.json") })
    }

    @Test fun aBlockThatCantBeReadLeavesOnlyItsCard() {
        val broken = AgentClient(
            object : Transport {
                override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory) =
                    TransportResponse(500, body = "{}".toByteArray())

                override suspend fun close() {}
            },
            "t",
        )
        val inline = GenUiInline(broken, null, "a1", onMessage = {}, onOpenWeb = {})
        rule.setHappyContent { GenUiInlineBlock("g9", 1, inline, label = { it }) }
        rule.waitUntil(5_000) { inline.failed("g9", 1) }
        rule.waitForIdle()
        rule.node(GenUiInlineTags.WAITING).assertDoesNotExist()
        rule.node(GenUiInlineTags.BLOCK).assertDoesNotExist()
    }
}
