package com.slopus.happy.conversation.ui

import com.slopus.happy.agent.ServerPermissions
import com.slopus.happy.conversation.Problem
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The actions this build sends ([UiActions]) and what it keeps of a press
 * ([UiPresses]), against the vendored contract ([UiContract]): the
 * catalog's schemas, where a secret field is marked, and the client
 * package's `payload`, `offer` and `permission` vectors.
 */
class UiActionsTest {
    /** Every action the catalog declares, by its wire type, with its definition. */
    private val declared: Map<String, JsonObject> = UiContract.schema.getValue("components").jsonObject.flatMap { (type, bundle) ->
        bundle.jsonObject.getValue("actions").jsonObject.map { (name, definition) -> "$type.$name" to definition.jsonObject }
    }.toMap()

    private fun secret(schema: JsonObject): Boolean = schema[UiContract.secretKeyword] == JsonPrimitive(true)

    /**
     * [value] with every secret left out, by the schema's marker alone: the
     * client package's `redactUiValue`, for the object payloads the catalog
     * has. A payload shape it doesn't know fails loudly.
     */
    private fun redactedBySchema(schema: JsonObject, value: JsonObject): JsonObject {
        check(schema.getValue("type").jsonPrimitive.content == "object") { "a payload that is no object: $schema" }
        return JsonObject(
            schema.getValue("properties").jsonObject.mapNotNull { (name, child) ->
                val field = child.jsonObject
                check(field.getValue("type").jsonPrimitive.content !in setOf("object", "array")) { "a nested payload field: $name" }
                value[name]?.takeIf { !secret(field) }?.let { name to it }
            }.toMap(),
        )
    }

    private fun action(vector: JsonObject): UiAction = UiAction.parse(vector.getValue("action"))!!

    private fun component(type: String, props: JsonElement): UiComponent =
        UiComponent.parse(Json.parseToJsonElement("""{"id":"c","type":"$type","fallback":"A line","props":$props}"""))!!

    @Test fun `the schema's marker reads as the vectors say`() {
        for (vector in UiContract.vectors("payload").filter { it.getValue("schemaValid").jsonPrimitive.boolean }) {
            val action = action(vector)
            assertEquals(vector.toString(), vector.getValue("redacted"), redactedBySchema(declared.getValue(action.type).getValue("payload").jsonObject, action.payload))
        }
    }

    @Test fun `every action this build sends is the catalog's, its fields the ones no marker makes secret, its permission the one declared`() {
        val sent = declared.filterKeys { UiActions.permission(it) != null }
        assertEquals(setOf(UiActions.SET_DEFAULT_MODEL), sent.keys)
        for ((type, definition) in sent) {
            val payload = definition.getValue("payload").jsonObject
            val properties = payload.getValue("properties").jsonObject
            // What the entry lists: read back from what it keeps of a payload holding every declared field.
            val whole = UiAction(type, JsonObject(properties.mapValues { JsonPrimitive("x") }))
            val kept = UiActions.redacted(whole).payload.keys
            assertEquals("$type keeps the fields that are no secret", properties.filterValues { !secret(it.jsonObject) }.keys, kept)
            assertTrue("$type keeps no secret", kept.none { secret(properties.getValue(it).jsonObject) })
            // The entry takes exactly the payloads the schema takes: every field required, non-empty text, nothing else.
            assertEquals(JsonPrimitive(false), payload["additionalProperties"])
            assertEquals(properties.keys, payload.getValue("required").jsonArray.map { it.jsonPrimitive.content }.toSet())
            for (field in properties.values) {
                assertEquals("string", field.jsonObject.getValue("type").jsonPrimitive.content)
                assertEquals("1", field.jsonObject.getValue("minLength").jsonPrimitive.content)
            }
            assertEquals(definition.getValue("permission").jsonPrimitive.content, UiActions.permission(type))
        }
        assertNull(UiActions.permission("default_model.reset"))
        assertEquals("""{"type":"default_model.set","payload":{"providerId":"claude","modelId":"opus","effort":"high"}}""", UiActions.setDefaultModel("claude", "opus", "high").json().toString())
    }

    @Test fun `what is kept of a payload is what the marker leaves, and nothing of an action this build does not send`() {
        for (vector in UiContract.vectors("payload")) {
            val action = action(vector)
            val kept = UiActions.redacted(action)
            assertEquals(action.type, kept.type)
            val schema = declared.getValue(action.type).getValue("payload").jsonObject
            if (UiActions.permission(action.type) != null) {
                assertEquals(vector.toString(), redactedBySchema(schema, action.payload), kept.payload)
                if (vector.getValue("schemaValid").jsonPrimitive.boolean) assertEquals(vector.getValue("redacted"), kept.payload)
            } else {
                assertEquals(vector.toString(), JsonObject(emptyMap()), kept.payload)
            }
            // Never more than the package keeps, and never a marked field.
            assertTrue(vector.toString(), kept.payload.all { (name, value) -> redactedBySchema(schema, action.payload)[name] == value })
        }
        assertEquals(JsonObject(emptyMap()), UiActions.redacted(UiAction("team_invite.create", Json.parseToJsonElement("""{"code":"4F2-K9Q"}""").jsonObject)).payload)
    }

    @Test fun `a press keeps only what is left of its action while it goes, and nothing of it after`() {
        val offer = UiOffer("m1", "u1", "c1")
        var ids = 0
        for (vector in UiContract.vectors("payload")) {
            val action = action(vector)
            val presses = UiPresses { "k${ids++}" }
            val id = presses.begin(offer, action) { false }!!
            assertEquals(vector.toString(), UiActions.redacted(action), presses.sending(offer))
            for (value in action.payload.values.filterIsInstance<JsonPrimitive>().filter { it.isString && it.content.isNotEmpty() }) {
                val field = action.payload.entries.first { it.value == value }.key
                val marked = declared.getValue(action.type).getValue("payload").jsonObject.getValue("properties").jsonObject[field]?.jsonObject?.let(::secret) != false
                if (marked) assertFalse("$field is kept", presses.sending(offer).toString().contains(value.content))
            }
            assertNull("one press of an offer at a time", presses.begin(offer, action) { false })
            presses.lost(offer, id, action, Problem.Unknown)
            assertNull(presses.sending(offer))
            // The same press again is the same attempt only where nothing was left out: else it can't be told from another.
            val again = presses.begin(offer, action) { false }!!
            if (UiActions.redacted(action) == action) assertEquals(vector.toString(), id, again) else assertNotEquals(vector.toString(), id, again)
        }
    }

    @Test fun `a component takes its own actions with the payload they declare, as the offer vectors say`() {
        for (vector in UiContract.vectors("offer")) {
            val offered = vector.getValue("component").jsonObject
            val component = component(offered.getValue("type").jsonPrimitive.content, offered.getValue("props"))
            val action = action(vector)
            // Never one the package refuses; of those it takes, the ones this build sends.
            val expected = vector.getValue("problem") == JsonNull && UiActions.permission(action.type) != null
            assertEquals(vector.toString(), expected, UiActions.takes(component, action))
        }
        for (vector in UiContract.vectors("payload").filter { UiActions.permission(action(it).type) != null }) {
            assertEquals(vector.toString(), vector.getValue("schemaValid").jsonPrimitive.boolean, UiActions.takes(component(vector.getValue("component").jsonPrimitive.content, JsonObject(emptyMap())), action(vector)))
        }
        val set = UiActions.setDefaultModel("claude", "opus", "high")
        assertFalse("another component's action", UiActions.takes(component("file_tree", Json.parseToJsonElement("""{"paths":["a"]}""")), set))
        assertFalse("a fallback line takes none", UiActions.takes(UiComponent.Other("c", "A line"), set))
        assertFalse("an empty field", UiActions.takes(component("default_model", JsonObject(emptyMap())), UiActions.setDefaultModel("claude", "opus", "")))
    }

    @Test fun `a control is offered to whoever holds the action's permission, as the permission vectors say`() {
        val owner = ServerPermissions(gated = true, granted = UiContract.schema.getValue("permissions").jsonArray.map { it.jsonPrimitive.content }.toSet())
        val member = ServerPermissions(gated = true, granted = UiContract.schema.getValue("memberPermissions").jsonArray.map { it.jsonPrimitive.content }.toSet())
        val viewer = ServerPermissions(gated = true)
        val vectors = UiContract.vectors("permission").filter { UiActions.permission(it.getValue("action").jsonPrimitive.content) != null }
        assertTrue(vectors.isNotEmpty())
        for (vector in vectors) {
            val needed = UiActions.permission(vector.getValue("action").jsonPrimitive.content)!!
            assertEquals(vector.toString(), vector.getValue("permission").jsonPrimitive.content, needed)
            val allowed = vector.getValue("allowed").jsonObject
            assertEquals(vector.toString(), allowed.getValue("owner").jsonPrimitive.boolean, owner.allows(needed))
            assertEquals(vector.toString(), allowed.getValue("member").jsonPrimitive.boolean, member.allows(needed))
            assertEquals(vector.toString(), allowed.getValue("viewer").jsonPrimitive.boolean, viewer.allows(needed))
            assertTrue("a computer of one person's gates nothing", ServerPermissions.Ungated.allows(needed))
        }
    }
}
