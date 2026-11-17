package com.slopus.happy.ui.genui

import androidx.compose.foundation.layout.Column
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
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
import com.slopus.happy.genui.GenUiMessage
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GenUiMessageBlockTest {
    @get:Rule val rule = createComposeRule()
    private val client = AgentClient(object : Transport {
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse =
            throw AssertionError("Direct Gen UI must not fetch $path")
        override suspend fun close() {}
    }, "t")

    @Test fun canonicalBlockHasNativeHeightAndSendsOnlyToItsConversation() {
        val document = GenUiMessage.document(Json.parseToJsonElement(File("src/debug/assets/genui/fixtures/01-stats.json").readText()))
        val sent = ArrayList<String>()
        val inline = GenUiInline(client, null, "origin", onMessage = { sent += "origin:$it" }, onOpenWeb = {})
        rule.setHappyContent {
            Column {
                GenUiMessageBlock("call", document, inline)
                GenUiView(document, Modifier.testTag("baseline"), GenUiHost(cached = { null }, load = { null }))
            }
        }
        val height = rule.node("genui.message").fetchSemanticsNode().size.height
        assertTrue(height > 200)
        assertEquals(rule.node("baseline").fetchSemanticsNode().size.height, height)
        // There are two copies of the document, so target the direct block's subtree.
        rule.node("genui.message").assertExists()
        val host = inline.messageState("call")
        host.choose("choice", "picked")
        assertSame(host, inline.messageState("call"))
        val other = GenUiInline(client, null, "other", onMessage = { fail("wrong conversation") }, onOpenWeb = {})
        assertNotSame(host, other.messageState("call"))
    }

    @Test fun buttonsSendThroughOriginAndPrivilegedActionsStayDisabled() {
        val document = GenUiMessage.document(Json.parseToJsonElement("""{"genuiRender":1,"fallback":"Controls","root":"root","elements":{
          "root":{"type":"box","props":{"gap":"items"},"children":["send","plugin","unsafe"]},
          "send":{"type":"button","props":{"label":"Continue","action":{"type":"message","text":"next"}}},
          "plugin":{"type":"button","props":{"label":"Install","action":{"type":"plugin","plugin":{"id":"p"}}}},
          "unsafe":{"type":"button","props":{"label":"Unsafe","action":{"type":"open","url":"https://user:pass@example.com"}}}
        }}"""))
        val sent = ArrayList<String>()
        val inline = GenUiInline(client, null, "origin", onMessage = { sent += it }, onOpenWeb = { fail("unsafe URL opened") })
        rule.setHappyContent { GenUiMessageBlock("call", document, inline) }
        rule.onNodeWithText("Continue").assertIsEnabled().performClick()
        assertEquals(listOf("next"), sent)
        rule.onNodeWithText("Install").assertIsNotEnabled()
        rule.onNodeWithText("Unsafe").assertIsNotEnabled()
    }
}