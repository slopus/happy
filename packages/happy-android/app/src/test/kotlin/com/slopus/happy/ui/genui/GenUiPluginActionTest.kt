package com.slopus.happy.ui.genui

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
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** A Gen UI `plugin` button opens the plugin's page, only where the computer reports `capabilities.plugins`. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GenUiPluginActionTest {
    @get:Rule val rule = createComposeRule()

    private val render = """{"genuiRender":1,"root":"get","fallback":"Get Linear","elements":{"get":{"type":"button","props":{"label":"Get the Linear plugin","action":{"type":"plugin","plugin":{"id":"linear"}}}}}}"""

    private val computer = AgentClient(
        object : Transport {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                if (path.endsWith("/files/.genui/render.json")) return TransportResponse(200, body = render.toByteArray())
                return TransportResponse(
                    200,
                    mapOf("content-type" to "application/json"),
                    """{"version":{"artifactId":"p1","number":1,"title":"Linear","entry":{"path":"index.genui.json"},"files":[{"path":".genui/render.json","mimeType":"application/json","size":10}],"createdBy":{"kind":"agent","agentId":"a1"}}}""".toByteArray(),
                )
            }

            override suspend fun close() {}
        },
        "t",
    )

    @Test
    fun itOpensThePluginPageOnlyWhereTheComputerHasPlugins() {
        val opened = ArrayList<String>()
        val plugins = MutableStateFlow(false)
        val inline = GenUiInline(computer, null, "a1", onMessage = {}, onOpenWeb = {}, plugins = plugins, onOpenPlugin = { opened += it })
        rule.setHappyContent { GenUiInlineBlock("p1", 1, inline, label = { it }) }
        rule.waitUntil(5_000) { inline.block("p1", 1) != null }
        rule.onNodeWithText("Get the Linear plugin").assertIsNotEnabled()
        plugins.value = true
        rule.waitForIdle()
        rule.onNodeWithText("Get the Linear plugin").assertIsEnabled().performClick()
        assertEquals(listOf("linear"), opened)
    }
}
