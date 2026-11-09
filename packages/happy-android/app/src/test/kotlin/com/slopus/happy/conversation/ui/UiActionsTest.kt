package com.slopus.happy.conversation.ui

import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.KeptConversation
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.Presentation
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The client package's chat UI rules, against its own vectors.
 * `ui/actions.fixtures.json` and `ui/ui.schema.json` are
 * `packages/happy-agent-client/fixtures/ui/` from happy-agent 8417cce23
 * (client 0.0.161-preview.14), copied unchanged: take them again from
 * there when the catalog changes, never edit them by hand.
 */
class UiActionsTest {
    private fun resource(name: String): JsonObject =
        Json.parseToJsonElement(requireNotNull(javaClass.getResource("/ui/$name")) { "missing $name" }.readText()).jsonObject

    private val fixtures = resource("actions.fixtures.json")
    private val schema = resource("ui.schema.json")

    private fun JsonElement?.string(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

    @Test fun `the catalog is the schema's version`() {
        assertEquals(UiCatalog.VERSION, fixtures["catalogVersion"]!!.jsonPrimitive.content.toInt())
        assertEquals(UiCatalog.VERSION, schema["catalogVersion"]!!.jsonPrimitive.content.toInt())
    }

    @Test fun `every action of the schema is in the catalog as declared`() {
        val declared = HashMap<String, UiPermission>()
        for ((type, component) in schema["components"]!!.jsonObject) {
            for ((name, value) in component.jsonObject["actions"]!!.jsonObject) {
                val definition = value.jsonObject
                val permission = when (val p = definition["permission"]) {
                    is JsonPrimitive -> UiPermission.Id(p.content)
                    is JsonObject -> if ("conversation" in p) UiPermission.ConversationRead else UiPermission.ByProp(
                        p["prop"]!!.jsonPrimitive.content,
                        p["map"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content },
                        p["default"]!!.jsonPrimitive.content,
                    )
                    else -> UiPermission.Id("content.write")
                }
                declared["$type.$name"] = permission
            }
        }
        assertEquals(declared, UiCatalog.actions)
    }

    @Test fun `quick replies normalize and check as normalizeQuickReply and quickRepliesProblems do`() {
        val vectors = fixtures["quickReplies"]!!.jsonArray.map { it.jsonObject }
        assertTrue(vectors.isNotEmpty())
        for (vector in vectors) {
            val options = vector["options"]!!.jsonArray.map { it.jsonPrimitive.content }
            val normalized = options.map(QuickReplies::normalize)
            assertEquals(vector.toString(), vector["normalized"]!!.jsonArray.map { it.jsonPrimitive.content }, normalized)
            assertEquals(vector.toString(), vector["problems"]!!.jsonArray.map { it.jsonPrimitive.content }, QuickReplies.problems(normalized))
        }
    }

    @Test fun `quick replies that don't pass are not drawn`() {
        val block = { options: String -> Json.parseToJsonElement("""{"type":"quick_replies","options":$options}""").jsonObject }
        assertEquals(listOf("Yes", "No"), QuickReplies.options(block("""["Yes","No"]""")))
        assertEquals(null, QuickReplies.options(block("""["Same","Same"]""")))
        assertEquals(null, QuickReplies.options(block("[]")))
        assertEquals("""{"messageId":"m1","toolCallId":"c1","index":2}""", QuickReply("m1", "c1", 2).json().toString())
        assertEquals("""{"messageId":"m1","index":0}""", QuickReply("m1", null, 0).json().toString())
    }

    @Test fun `permissions resolve as uiActionPermission and uiActionAllowed do`() {
        val everything = schema["permissions"]!!.jsonArray.map { it.jsonPrimitive.content }.toSet()
        val member = schema["memberPermissions"]!!.jsonArray.map { it.jsonPrimitive.content }.toSet()
        val holders = mapOf("owner" to everything, "member" to member, "viewer" to emptySet())
        for (vector in fixtures["permission"]!!.jsonArray.map { it.jsonObject }) {
            val type = vector["action"]!!.jsonPrimitive.content
            val props = vector["props"]!!.jsonObject
            val expected = (vector["permission"] as? JsonPrimitive)?.content
            assertEquals(vector.toString(), expected, UiCatalog.permission(type, props))
            for ((who, allowed) in vector["allowed"]!!.jsonObject) {
                val held = holders.getValue(who)
                assertEquals("$type for $who", allowed.jsonPrimitive.content == "true", UiCatalog.allowed(type, props) { it in held })
            }
        }
    }

    @Test fun `every vector's document reads, an unknown or broken component as its fallback`() {
        for (vector in fixtures["documents"]!!.jsonArray.map { it.jsonObject }) {
            val raw = vector["document"]!!.jsonObject
            val document = UiDocument.parse(raw)!!
            val components = raw["components"]!!.jsonArray.map { it.jsonObject }
            assertEquals(components.map { it["id"].string() }, document.components.map { it.id })
            assertEquals(components.map { it["type"].string() }, document.components.map { it.type })
            assertEquals(components.map { it["fallback"].string() }, document.components.map { it.fallback })
            // What doesn't read is drawn as its line.
            if (components.any { it["type"].string() == "slideshow" }) assertTrue(document.components.single() is UiComponent.Other)
            // The fallback older clients read: each line, blank ones left out, a blank line between.
            assertEquals(vector["fallback"].string(), document.components.map { it.fallback.trim() }.filter { it.isNotEmpty() }.joinToString("\n\n"))
        }
    }

    @Test fun `a file tree lists each folder once over what it holds`() {
        val lines = UiFileTree.lines(listOf("src/app.ts", "README.md", "src/lib/a.ts", "docs/", "src/lib/b.ts"))
        assertEquals(
            listOf(
                UiFileTree.Line("src", 0, true),
                UiFileTree.Line("app.ts", 1, false),
                UiFileTree.Line("lib", 1, true),
                UiFileTree.Line("a.ts", 2, false),
                UiFileTree.Line("b.ts", 2, false),
                UiFileTree.Line("README.md", 0, false),
                UiFileTree.Line("docs", 0, true),
            ),
            lines,
        )
    }

    @Test fun `chat UI and quick replies are kept on the phone exactly as they came`() {
        val message = Message.parse(Json.parseToJsonElement(QuickRepliesConversationTest.SUGGESTED))!!
        val presentation = (message.content.last() as Block.ToolCall).presentation as Presentation.QuickReplies
        assertEquals(listOf("Fix the login redirect", "Run the tests"), presentation.options)
        val block = Message.parse(Json.parseToJsonElement(QuickRepliesConversationTest.OPENING))!!
        val person = Message.parse(Json.parseToJsonElement(QuickRepliesConversationTest.person("p1", "Run the tests", """{"messageId":"m1","toolCallId":"c1","index":1}""")))!!
        assertEquals(QuickReply("m1", "c1", 1), person.quickReply)
        val record = Message.parse(Json.parseToJsonElement(LiveUiConversationTest.record("\"k1\"", "rejected", reason = "Invites are off here.")))!!
        val ui = Message.parse(Json.parseToJsonElement(LiveUiConversationTest.OFFER))!!
        for (kept in listOf(message, block, person, record, ui)) assertEquals(kept, Message.parse(KeptConversation.messageJson(kept)))
    }
}
