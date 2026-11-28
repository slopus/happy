package com.slopus.happy.ui.genui

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.plugins.InstallationStatus
import com.slopus.happy.plugins.PluginInstallation
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.util.Collections

/**
 * A Gen UI `plugin` button opens the plugin's page, only where the computer
 * reports `capabilities.plugins`; where it also reports
 * `artifactPluginActions`, the page an active installation is seen on
 * reports the element once and the button reads as done.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GenUiPluginActionTest {
    @get:Rule val rule = createComposeRule()

    private val render = """{"genuiRender":1,"root":"get","fallback":"Get Linear","elements":{"get":{"type":"button","props":{"label":"Get the Linear plugin","action":{"type":"plugin","plugin":{"id":"linear"}}}}}}"""

    /** The bodies the actions route was sent. */
    private val reports: MutableList<String> = Collections.synchronizedList(ArrayList())

    private fun computer(reportsTaken: Boolean, status: Int = 201) = AgentClient(
        object : Transport {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                val json = mapOf("content-type" to "application/json")
                if (path.endsWith("/files/.genui/render.json")) return TransportResponse(200, body = render.toByteArray())
                if (path == "/v0/health") return TransportResponse(200, json, """{"status":"ok","capabilities":{"plugins":true,"artifactPluginActions":$reportsTaken}}""".toByteArray())
                if (path.endsWith("/actions")) {
                    reports += String(body ?: ByteArray(0))
                    return TransportResponse(status, json, """{"pluginId":"linear","installations":[{"id":"i1","label":null,"toolPrefix":"linear_"}],"messageId":"m1"}""".toByteArray())
                }
                return TransportResponse(
                    200,
                    json,
                    """{"version":{"artifactId":"p1","number":1,"title":"Linear","entry":{"path":"index.genui.json"},"files":[{"path":".genui/render.json","mimeType":"application/json","size":10}],"createdBy":{"kind":"agent","agentId":"a1"}}}""".toByteArray(),
                )
            }

            override suspend fun close() {}
        },
        "t",
        cloud = true,
    )

    private val active = listOf(
        PluginInstallation(id = "i1", pluginKey = "linear", name = "Linear", ordinal = 1, label = null, status = InstallationStatus.Active, authMethod = null, image = null, available = true),
    )

    private fun button() = rule.onNode(hasText("Get the Linear plugin") and hasClickAction())

    @Test
    fun itOpensThePluginPageOnlyWhereTheComputerHasPlugins() {
        val opened = ArrayList<String>()
        val plugins = MutableStateFlow(false)
        val inline = GenUiInline(computer(reportsTaken = false), null, "a1", onMessage = {}, onOpenWeb = {}, plugins = plugins, onOpenPlugin = { id, _ -> opened += id })
        rule.setHappyContent { GenUiInlineBlock("p1", 1, inline, label = { it }) }
        rule.waitUntil(5_000) { inline.block("p1", 1) != null }
        rule.onNodeWithText("Get the Linear plugin").assertIsNotEnabled()
        plugins.value = true
        rule.waitForIdle()
        rule.onNodeWithText("Get the Linear plugin").assertIsEnabled().performClick()
        assertEquals(listOf("linear"), opened)
    }

    @Test
    fun withoutArtifactPluginActionsATapOnlyOpensThePage() {
        val opened = ArrayList<Pair<String, String?>>()
        val inline = GenUiInline(computer(reportsTaken = false), null, "a1", onMessage = {}, onOpenWeb = {}, plugins = MutableStateFlow(true), onOpenPlugin = { id, report -> opened += id to report })
        rule.setHappyContent { GenUiInlineBlock("p1", 1, inline, label = { it }) }
        // Health has said no; before it answers a tap still begins a report, which sending drops.
        rule.waitUntil(5_000) { inline.block("p1", 1) != null && inline.pluginReports.refused }
        button().performClick()
        assertEquals(listOf("linear" to null), opened)
        assertEquals(emptyList<String>(), reports.toList())
    }

    @Test
    fun anActiveInstallationSeenAfterTheTapReportsTheElementOnceAndMarksItDone() {
        val tokens = ArrayList<String?>()
        val inline = GenUiInline(computer(reportsTaken = true), null, "a1", onMessage = {}, onOpenWeb = {}, plugins = MutableStateFlow(true), onOpenPlugin = { _, report -> tokens += report })
        rule.setHappyContent { GenUiInlineBlock("p1", 1, inline, label = { it }) }
        rule.waitUntil(5_000) { inline.block("p1", 1) != null && inline.pluginReports.served }
        button().performClick()
        val token = tokens.single()
        assertNotNull("a token for the page", token)
        token!!
        // Tapped again before it was set up: the same report, so the same submission ID.
        button().performClick()
        assertEquals(listOf(token, token), tokens)
        assertNull(button().fetchSemanticsNode().config.getOrNull(SemanticsProperties.StateDescription))

        // The page reads the plugin installed but not set up, then active, then again.
        GenUiPluginReports.seen(token, active.map { it.copy(status = InstallationStatus.NeedsSetup) })
        GenUiPluginReports.seen(token, active)
        rule.waitUntil(5_000) { inline.block("p1", 1)!!.state.saved("get") != null }
        GenUiPluginReports.seen(token, active)
        rule.waitForIdle()

        val sent = reports.toList().map { Json.parseToJsonElement(it).jsonObject }
        assertEquals(1, sent.size)
        assertEquals(setOf("id", "element"), sent.single().keys)
        assertEquals(token, sent.single().getValue("id").toString().trim('"'))
        assertEquals("get", sent.single().getValue("element").toString().trim('"'))
        assertEquals("linear", inline.block("p1", 1)!!.state.saved("get"))
        // Done, and still opens the page, now with nothing left to report.
        assertEquals("Set up", button().fetchSemanticsNode().config.getOrNull(SemanticsProperties.StateDescription))
        button().assertIsEnabled().performClick()
        assertNull(tokens.last())
    }
}
