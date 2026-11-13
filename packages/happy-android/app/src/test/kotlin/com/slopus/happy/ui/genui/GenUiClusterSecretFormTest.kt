package com.slopus.happy.ui.genui

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.Collections

/**
 * A Gen UI `cluster_secret` button over a fake Happy Cloud server (cluster
 * API.md "Gen UI actions"): the form opens on the action's prefill with the
 * owners the person's role allows, saves once through the artifact's actions
 * route, and shows the server's words when it refuses. It runs only on a
 * cloud connection whose health says `artifactSecretActions`.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GenUiClusterSecretFormTest {
    @get:Rule val rule = createComposeRule()

    private val sent: MutableList<Triple<String, String, JsonObject?>> = Collections.synchronizedList(ArrayList())

    private var capabilities = """{"artifactSecretActions":true}"""
    private var granted = """["secrets.own","secrets.manage"]"""

    /** The render document's action, changed by a test (an `id` makes it change a stored secret). */
    private var render = File("src/debug/assets/genui/fixtures/14-cluster-secret.json").readText()

    private val secretId = "c0123456789abcdefghijklm"
    private fun stored(version: String) =
        """{"id":"$secretId","type":"endpoint","name":"Stripe API","description":"Billing","owner":"team","uses":["egress"],"access":{"use":true,"manage":true,"attach":true},"version":"$version",""" +
            """"public":{"targets":[{"host":"api.stripe.com","pathPrefixes":["/v1"]}],"algorithm":{"kind":"headers","headers":[{"name":"Authorization","prefix":"Bearer "}]}}}"""

    private var saveAnswer: (JsonObject) -> TransportResponse = { json(201, """{"secret":${stored("v2")},"secretId":"$secretId","granted":true,"messageId":"m1"}""") }

    private fun json(status: Int, text: String) = TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())

    private fun server(cloud: Boolean) = AgentClient(
        object : Transport {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                val parsed = body?.let { Json.parseToJsonElement(String(it)).jsonObject }
                sent += Triple(method, path, parsed)
                return when {
                    path.endsWith("/files/.genui/render.json") -> TransportResponse(200, body = render.toByteArray())
                    "/files/" in path -> TransportResponse(404, body = "{}".toByteArray())
                    path == "/v0/health" -> json(200, """{"status":"ok","capabilities":$capabilities}""")
                    path == "/v0/permissions" -> json(200, """{"granted":$granted}""")
                    path == "/v0/cluster/secrets/$secretId" -> json(200, """{"secret":${stored("v3")}}""")
                    path.endsWith("/actions") -> saveAnswer(parsed!!)
                    else -> json(200, """{"version":{"artifactId":"s1","number":3,"title":"Keys","entry":{"path":"index.genui.json"},"files":[{"path":".genui/render.json","mimeType":"application/json","size":10}],"createdBy":{"kind":"agent","agentId":"a1"}}}""")
                }
            }

            override suspend fun close() {}
        },
        "t",
        cloud,
    )

    private fun open(cloud: Boolean = true): GenUiInline {
        val inline = GenUiInline(server(cloud), null, "a1", onMessage = {}, onOpenWeb = {})
        rule.setHappyContent { GenUiInlineBlock("s1", 3, inline, label = { it }) }
        rule.waitUntil(5_000) { inline.block("s1", 3) != null }
        rule.waitUntil(5_000) { sent.any { it.second == "/v0/health" } }
        if (cloud && "\"artifactSecretActions\":true" in capabilities) rule.waitUntil(5_000) { inline.secrets.served }
        rule.waitForIdle()
        return inline
    }

    private fun tap() {
        rule.onNodeWithText("Add Stripe key").assertIsEnabled().performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(GenUiClusterTags.SHEET).fetchSemanticsNodes().isNotEmpty() }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("Loading…").fetchSemanticsNodes().isEmpty() }
    }

    private fun saves() = sent.filter { it.second.endsWith("/actions") }

    private fun shown(text: String) = rule.waitUntil(5_000) { rule.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }

    @Test
    fun theFormCreatesOnceThroughTheActionsRoute() {
        open()
        tap()
        rule.node(GenUiSecretTags.MODE).assertTextContains("New endpoint secret")
        rule.node(GenUiSecretTags.NAME).assertTextContains("Stripe API")
        rule.onNodeWithText("Only GET, POST requests").assertExists()
        // Nothing goes out without a value; a short one is said to be.
        rule.node(GenUiSecretTags.SAVE).assertIsNotEnabled()
        assertTrue(rule.onAllNodesWithTag(GenUiSecretTags.PROBLEM).fetchSemanticsNodes().isEmpty())
        rule.node(GenUiSecretTags.VALUE).performTextInput("sk_live_")
        rule.node(GenUiSecretTags.PROBLEM).assertExists()
        rule.node(GenUiSecretTags.SAVE).assertIsNotEnabled()
        rule.node(GenUiSecretTags.VALUE).performTextInput("0123456789abcdef")
        rule.node(GenUiSecretTags.SAVE).performClick()
        shown("Saved Stripe API")
        val (_, path, body) = saves().single()
        assertEquals("/v0/artifacts/s1/versions/3/actions", path)
        body!!
        assertEquals("add-stripe", body.getValue("element").jsonPrimitive.content)
        assertTrue(Regex("[a-z][a-z0-9]{23}").matches(body.getValue("id").jsonPrimitive.content))
        assertEquals("true", body.getValue("grant").toString())
        assertFalse("the route reads the action itself", "action" in body)
        assertEquals(
            """{"type":"endpoint","owner":"team","name":"Stripe API","description":"Restricted key for billing agents",""" +
                """"public":{"targets":[{"host":"api.stripe.com","pathPrefixes":["/v1"],"methods":["GET","POST"]}],"algorithm":{"kind":"headers","headers":[{"name":"Authorization","prefix":"Bearer "}]}},""" +
                """"uses":["egress"],"material":{"Authorization":"sk_live_0123456789abcdef"}}""",
            body.getValue("secret").toString(),
        )
        assertTrue("the plain secret routes are never written", sent.none { it.first != "GET" && it.second.startsWith("/v0/cluster/secrets") })
    }

    @Test
    fun aRoleWithoutTheTeamsPermissionMakesItsOwn() {
        granted = """["secrets.own"]"""
        open()
        tap()
        assertTrue(rule.onAllNodesWithTag(GenUiClusterTags.OWNER + "team").fetchSemanticsNodes().isEmpty())
        rule.node(GenUiSecretTags.VALUE).performTextInput("sk_live_0123456789abcdef")
        rule.node(GenUiSecretTags.SAVE).performClick()
        rule.waitUntil(5_000) { saves().isNotEmpty() }
        assertEquals("me", saves().single().third!!.getValue("secret").jsonObject.getValue("owner").jsonPrimitive.content)
    }

    @Test
    fun aRefusalShowsTheServersWords() {
        open()
        tap()
        saveAnswer = { json(403, """{"error":"Your role may not add team secrets.","code":"forbidden"}""") }
        rule.node(GenUiSecretTags.VALUE).performTextInput("sk_live_0123456789abcdef")
        rule.node(GenUiSecretTags.SAVE).performClick()
        shown("Your role may not add team secrets.")
        saveAnswer = { json(409, """{"error":"The version has no origin agent.","code":"no_origin"}""") }
        rule.node(GenUiSecretTags.VALUE).performTextInput("0")
        rule.node(GenUiSecretTags.SAVE).performClick()
        shown("Couldn’t save: no agent made this card, or the one that did is archived.")
        assertTrue("a changed form is another save", saves()[0].third!!["id"] != saves()[1].third!!["id"])
    }

    @Test
    fun anActionNamingASecretChangesIt() {
        render = render.replace("\"type\": \"endpoint\",", "\"type\": \"endpoint\", \"id\": \"$secretId\",")
        open()
        tap()
        rule.node(GenUiSecretTags.MODE).assertTextContains("Change secret")
        // Where the value goes stays as stored; only words and values change.
        assertTrue(rule.onAllNodesWithTag(GenUiClusterTags.HOST).fetchSemanticsNodes().isEmpty())
        saveAnswer = { json(409, """{"error":"stale","code":"conflict","currentVersion":"v4","secret":${stored("v4").replace("Billing", "Theirs")}}""") }
        rule.node(GenUiSecretTags.SAVE).performClick()
        shown("This secret changed since the form opened. Check it and save again.")
        assertEquals("""{"name":"Stripe API","description":"Billing","version":"v3"}""", saves().single().third!!.getValue("secret").toString())
        saveAnswer = { json(201, """{"secret":${stored("v5")},"secretId":"$secretId","granted":true,"messageId":"m1"}""") }
        rule.node(GenUiSecretTags.SAVE).performClick()
        shown("Saved Stripe API")
        assertEquals("""{"name":"Stripe API","description":"Theirs","version":"v4"}""", saves().last().third!!.getValue("secret").toString())
    }

    @Test
    fun aServerThatDoesntSayItRunsSecretActionsKeepsTheButtonDisabled() {
        capabilities = """{"plugins":true}"""
        open()
        rule.onNodeWithText("Add Stripe key").assertIsNotEnabled()
    }

    @Test
    fun aHappyAgentDoesntServeTheClustersAction() {
        open(cloud = false)
        rule.onNodeWithText("Add Stripe key").assertIsNotEnabled()
    }

    @Test
    fun cancellingSendsNothing() {
        open()
        tap()
        rule.node(GenUiSecretTags.VALUE).performTextInput("sk_live_0123456789abcdef")
        rule.node(GenUiSecretTags.CANCEL).performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(GenUiClusterTags.SHEET).fetchSemanticsNodes().isEmpty() }
        assertTrue(saves().isEmpty())
    }
}
