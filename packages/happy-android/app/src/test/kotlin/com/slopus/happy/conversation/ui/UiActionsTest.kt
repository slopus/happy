package com.slopus.happy.conversation.ui

import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.KeptConversation
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.Presentation
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
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
 * `packages/happy-agent-client/fixtures/ui/` from happy-agent 39bb1c512
 * (client 0.0.161-preview.12), copied unchanged: take them again from
 * there when the catalog changes, never edit them by hand.
 */
class UiActionsTest {
    private fun resource(name: String): JsonObject =
        Json.parseToJsonElement(requireNotNull(javaClass.getResource("/ui/$name")) { "missing $name" }.readText()).jsonObject

    private val fixtures = resource("actions.fixtures.json")
    private val schema = resource("ui.schema.json")

    private fun action(value: JsonElement) = UiAction.parse(value)!!
    private fun JsonElement?.string(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

    @Test fun `the catalog is the schema's version`() {
        assertEquals(UiCatalog.VERSION, fixtures["catalogVersion"]!!.jsonPrimitive.content.toInt())
        assertEquals(UiCatalog.VERSION, schema["catalogVersion"]!!.jsonPrimitive.content.toInt())
    }

    @Test fun `every action of the schema is in the catalog as declared`() {
        val declared = HashMap<String, UiActionDefinition>()
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
                declared["$type.$name"] = UiActionDefinition(
                    message = definition["transcript"]!!.jsonPrimitive.content == "message",
                    once = definition["once"]?.jsonPrimitive?.content == "true",
                    permission = permission,
                )
            }
        }
        assertEquals(declared, UiCatalog.actions)
    }

    @Test fun `action text matches uiActionText`() {
        val vectors = fixtures["actionText"]!!.jsonArray
        assertTrue(vectors.isNotEmpty())
        for (vector in vectors.map { it.jsonObject }) {
            val component = vector["component"]!!.jsonObject
            val expected = vector["text"].string()
            val text = UiActionText.of(component["type"]!!.jsonPrimitive.content, component["props"]!!.jsonObject, action(vector["action"]!!))
            assertEquals(vector.toString(), expected, text)
        }
    }

    @Test fun `the open-offer rule matches uiOfferState`() {
        for (vector in fixtures["openOffer"]!!.jsonArray.map { it.jsonObject }) {
            val state = UiOfferState.of(
                once = vector["once"]!!.jsonPrimitive.content == "true",
                accepted = vector["accepted"]?.takeIf { it !is JsonNull }?.let(::action),
                personSpokeAfter = vector["personSpokeAfter"]!!.jsonPrimitive.content == "true",
                action = action(vector["action"]!!),
            )
            assertEquals(vector.toString(), vector["state"]!!.jsonPrimitive.content, state.name.lowercase())
        }
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
        val empty = UiDocument.parse(fixtures["documents"]!!.jsonArray.map { it.jsonObject }.first { "\"options\":[]" in it.toString() }["document"])!!
        assertTrue(empty.components.single() is UiComponent.Other)
    }

    @Test fun `a checklist submit reads its ticks back`() {
        assertEquals("""{"type":"checklist.submit","payload":{"selected":["a","b"]}}""", UiAction.submitChecklist(listOf("a", "b")).json().toString())
        assertEquals("""{"type":"text_field.submit","payload":{"text":"Ada"}}""", UiAction.submitText("Ada").json().toString())
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

    @Test fun `chat UI is kept on the phone exactly as it came`() {
        val message = Message.parse(Json.parseToJsonElement(ChatUiConversationTest.OFFER))!!
        val presentation = (message.content.single() as Block.ToolCall).presentation as Presentation.Ui
        assertEquals("pick", presentation.document.components.single().id)
        val record = Message.parse(Json.parseToJsonElement(ChatUiConversationTest.record("\"k1\"", "rejected", reason = "Already answered")))!!
        for (kept in listOf(message, record)) assertEquals(kept, Message.parse(KeptConversation.messageJson(kept)))
    }
}
