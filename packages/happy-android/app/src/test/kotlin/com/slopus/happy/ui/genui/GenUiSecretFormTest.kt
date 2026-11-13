package com.slopus.happy.ui.genui

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.Collections

/**
 * A Gen UI `secret` button over a fake computer (API.md "Gen UI actions"):
 * the form opens on the action's prefill, saves once through the artifact's
 * actions route, shows what the answer says, and opens on the saved secret
 * when tapped again. It runs only where the computer's health says
 * `artifactSecretActions`: a released daemon without the flag keeps the
 * button disabled.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GenUiSecretFormTest {
    @get:Rule val rule = createComposeRule()

    /** What the fake computer was sent: method, path and body. */
    private val sent: MutableList<Triple<String, String, JsonObject?>> = Collections.synchronizedList(ArrayList())

    /** The secrets the fake computer holds, as their safe objects. */
    private val stored = Collections.synchronizedMap(LinkedHashMap<String, String>())

    private var saveAnswer: (JsonObject) -> TransportResponse = { body -> saved(body, created = true) }

    private fun saved(body: JsonObject, created: Boolean): TransportResponse {
        val secret = body.getValue("secret").jsonObject
        val id = secret.getValue("id").jsonPrimitive.content
        val names = secret.getValue("environment").jsonObject.keys.sorted().joinToString(",") { "\"$it\"" }
        val safe = """{"id":"$id","description":"d","environmentVariables":[$names],"managed":false,"availableToAgents":true,"version":"v2","createdAt":1,"updatedAt":1}"""
        stored[id] = safe
        return json(200, """{"secret":$safe,"outcome":"${if (created) "created" else "updated"}"}""")
    }

    private fun json(status: Int, text: String) = TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())

    /** What the fake computer's health says it runs. */
    private var capabilities = """{"artifactSecretActions":true}"""

    private fun computer(origin: String? = "a1", cloud: Boolean = false) = AgentClient(
        object : Transport {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                val parsed = body?.let { Json.parseToJsonElement(String(it)).jsonObject }
                sent += Triple(method, path, parsed)
                return when {
                    path.endsWith("/files/.genui/render.json") -> TransportResponse(200, body = File("src/debug/assets/genui/fixtures/13-secret.json").readBytes())
                    "/files/" in path -> TransportResponse(404, body = "{}".toByteArray())
                    path == "/v0/health" -> json(200, """{"status":"ok","capabilities":$capabilities}""")
                    path.startsWith("/v0/secrets/") -> stored[path.removePrefix("/v0/secrets/")]?.let { json(200, """{"secret":$it}""") } ?: json(404, """{"error":"no","code":"not_found"}""")
                    path.endsWith("/actions") -> saveAnswer(parsed!!)
                    else -> {
                        val by = origin?.let { """{"kind":"agent","agentId":"$it"}""" } ?: """{"kind":"user","userId":"u1"}"""
                        json(200, """{"version":{"artifactId":"s1","number":3,"title":"Keys","entry":{"path":"index.genui.json"},"files":[{"path":".genui/render.json","mimeType":"application/json","size":10}],"createdBy":$by}}""")
                    }
                }
            }

            override suspend fun close() {}
        },
        "t",
        cloud,
    )

    private fun open(origin: String? = "a1", cloud: Boolean = false): GenUiInline {
        val inline = GenUiInline(computer(origin, cloud), null, "a1", onMessage = {}, onOpenWeb = {})
        rule.setHappyContent { GenUiInlineBlock("s1", 3, inline, label = { it }) }
        rule.waitUntil(5_000) { inline.block("s1", 3) != null }
        if (origin != null && !cloud && "\"artifactSecretActions\":true" in capabilities) rule.waitUntil(5_000) { inline.secrets.served }
        return inline
    }

    private fun values() = rule.onAllNodesWithTag(GenUiSecretTags.VALUE)

    private fun saves() = sent.filter { it.second.endsWith("/actions") }

    @Test
    fun theFormSavesOnceThroughTheActionsRouteAndSaysWhatItDid() {
        open()
        rule.onNodeWithText("Add Stripe keys").assertIsEnabled().performClick()
        rule.waitUntil(5_000) { sent.any { it.second == "/v0/secrets/stripe" } }
        rule.waitForIdle()
        rule.node(GenUiSecretTags.MODE).assertTextContains("New secret")
        // Prefilled, editable.
        rule.node(GenUiSecretTags.NAME).assertTextContains("stripe")
        assertEquals(2, rule.onAllNodesWithTag(GenUiSecretTags.VARIABLE).fetchSemanticsNodes().size)
        // Nothing goes out with a value missing.
        rule.node(GenUiSecretTags.SAVE).performClick()
        rule.waitForIdle()
        rule.node(GenUiSecretTags.PROBLEM).assertExists()
        assertTrue(saves().isEmpty())
        values()[0].performTextInput("sk_test_1")
        values()[1].performTextInput("whsec_1")
        rule.node(GenUiSecretTags.SAVE).performClick()
        rule.waitUntil(5_000) { saves().isNotEmpty() }
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(GenUiSecretTags.DONE).fetchSemanticsNodes().isNotEmpty() }
        val (_, path, body) = saves().single()
        assertEquals("/v0/artifacts/s1/versions/3/actions", path)
        body!!
        assertEquals("add-stripe", body.getValue("element").jsonPrimitive.content)
        assertTrue(Regex("[a-z][a-z0-9]{23}").matches(body.getValue("id").jsonPrimitive.content))
        assertNull("a new secret has no version to match", body["ifMatch"])
        assertFalse("the route reads the action itself", "action" in body)
        assertEquals(
            """{"id":"stripe","description":"Stripe test-mode keys for the billing service","environment":{"STRIPE_SECRET_KEY":"sk_test_1","STRIPE_WEBHOOK_SECRET":"whsec_1"}}""",
            body.getValue("secret").toString(),
        )
        assertTrue("the plain secret routes are never written", sent.none { it.first == "POST" && it.second.startsWith("/v0/secrets") })
        rule.onNodeWithText("Added stripe").assertExists()
    }

    @Test
    fun tappedAgainItChangesTheSecretItMade() {
        open()
        rule.onNodeWithText("Add Stripe keys").performClick()
        rule.waitUntil(5_000) { sent.any { it.second == "/v0/secrets/stripe" } }
        rule.waitForIdle()
        // Renamed by the person: the button now opens on their name.
        rule.node(GenUiSecretTags.NAME).performTextReplacement("stripe2")
        rule.waitUntil(5_000) { sent.any { it.second == "/v0/secrets/stripe2" } }
        rule.waitForIdle()
        values()[0].performTextInput("a")
        values()[1].performTextInput("b")
        rule.node(GenUiSecretTags.SAVE).performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(GenUiSecretTags.DONE + ".close").fetchSemanticsNodes().isNotEmpty() }
        rule.node(GenUiSecretTags.DONE + ".close").performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(GenUiSecretTags.SHEET).fetchSemanticsNodes().isEmpty() }

        saveAnswer = { body -> saved(body, created = false) }
        rule.onNodeWithText("Add Stripe keys").assertIsEnabled().performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithText("Change secret").fetchSemanticsNodes().isNotEmpty() }
        rule.node(GenUiSecretTags.NAME).assertTextContains("stripe2")
        // Every value is kept unless typed over; the agent's hints still show.
        assertTrue(rule.onAllNodes(hasText("Secret key, starts with sk_test_") and hasAnyAncestor(hasTestTag(GenUiSecretTags.SHEET))).fetchSemanticsNodes().isNotEmpty())
        rule.node(GenUiSecretTags.SAVE).performClick()
        rule.waitUntil(5_000) { saves().size == 2 }
        val body = saves().last().third!!
        assertEquals("v2", body.getValue("ifMatch").jsonPrimitive.content)
        assertEquals("{}", body.getValue("secret").jsonObject.getValue("environment").toString())
        rule.waitUntil(5_000) { rule.onAllNodesWithText("Changed stripe2").fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    fun aStaleSaveOpensWhatIsStoredNow() {
        open()
        rule.onNodeWithText("Add Stripe keys").performClick()
        rule.waitUntil(5_000) { sent.any { it.second == "/v0/secrets/stripe" } }
        rule.waitForIdle()
        values()[0].performTextInput("a")
        values()[1].performTextInput("b")
        // Made elsewhere while the form was open.
        saveAnswer = {
            json(409, """{"error":"exists","code":"conflict","currentVersion":"v9","secret":{"id":"stripe","description":"Theirs","environmentVariables":["STRIPE_SECRET_KEY"],"managed":false,"availableToAgents":true,"version":"v9"}}""")
        }
        rule.node(GenUiSecretTags.SAVE).performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithText("Change secret").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("A secret with this name already exists. Saving now changes it.").assertExists()
        saveAnswer = { body -> saved(body, created = false) }
        rule.node(GenUiSecretTags.SAVE).performClick()
        rule.waitUntil(5_000) { saves().size == 2 }
        val retry = saves().last().third!!
        assertEquals("v9", retry.getValue("ifMatch").jsonPrimitive.content)
        assertTrue("another save, another key", saves()[0].third!!["id"] != retry["id"])
    }

    @Test
    fun aComputerThatDoesntSayItRunsSecretActionsKeepsTheButtonDisabled() {
        capabilities = """{"feed":true}"""
        open()
        rule.waitUntil(5_000) { sent.any { it.second == "/v0/health" } }
        rule.waitForIdle()
        rule.onNodeWithText("Add Stripe keys").assertIsNotEnabled()
        assertTrue(rule.onAllNodesWithTag(GenUiSecretTags.SHEET).fetchSemanticsNodes().isEmpty())
    }

    /** Fallback: one that said it runs them but answers the route `404` is taken at its word. */
    @Test
    fun aComputerAnswering404DisablesTheButton() {
        open()
        saveAnswer = { json(404, """{"error":"Not found","code":"not_found"}""") }
        rule.onNodeWithText("Add Stripe keys").performClick()
        rule.waitUntil(5_000) { sent.any { it.second == "/v0/secrets/stripe" } }
        rule.waitForIdle()
        values()[0].performTextInput("a")
        values()[1].performTextInput("b")
        rule.node(GenUiSecretTags.SAVE).performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithText("This computer can’t save secrets from here. Update Happy Agent on it.").fetchSemanticsNodes().isNotEmpty() }
        rule.node(GenUiSecretTags.SAVE).assertIsNotEnabled()
        rule.node(GenUiSecretTags.CANCEL).performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(GenUiSecretTags.SHEET).fetchSemanticsNodes().isEmpty() }
        rule.onNodeWithText("Add Stripe keys").assertIsNotEnabled()
    }

    @Test
    fun aVersionAPersonMadeHasNoAgentToGiveItTo() {
        open(origin = null)
        rule.onNodeWithText("Add Stripe keys").assertIsNotEnabled()
    }

    @Test
    fun aHappyCloudServerServesItsOwnSecretActionNotThisOne() {
        open(cloud = true)
        rule.waitUntil(5_000) { sent.any { it.second == "/v0/health" } }
        rule.waitForIdle()
        rule.onNodeWithText("Add Stripe keys").assertIsNotEnabled()
    }

    @Test
    fun cancellingSendsNothing() {
        open()
        rule.onNodeWithText("Add Stripe keys").performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(GenUiSecretTags.SHEET).fetchSemanticsNodes().isNotEmpty() }
        rule.waitForIdle()
        values()[0].performTextInput("a")
        rule.node(GenUiSecretTags.CANCEL).performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(GenUiSecretTags.SHEET).fetchSemanticsNodes().isEmpty() }
        assertTrue(saves().isEmpty())
        assertTrue(rule.onAllNodes(hasTestTag(GenUiSecretTags.VALUE)).fetchSemanticsNodes().isEmpty())
    }
}
