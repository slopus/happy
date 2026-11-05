package com.slopus.happy.conversation

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelPreferencesTest {
    private val catalog = ModeCatalog.parse(
        Json.parseToJsonElement(
            """{"config":{
            "defaults":{"providerId":"claude","modelId":"opus","effort":"high","permissionMode":"workspace_write"},
            "models":{
                "opus":{"name":"Opus","efforts":["low","medium","high","max"],"defaultEffort":"high","serviceTiers":[]},
                "sol":{"name":"Sol","efforts":["low","high","xhigh"],"defaultEffort":"high","serviceTiers":["priority"]},
                "luna":{"name":"Luna","efforts":[],"serviceTiers":[]}
            },
            "providers":{
                "claude":{"type":"claude","enabled":true,"hidden":false,"models":[{"id":"opus"}]},
                "codex":{"type":"codex","enabled":true,"hidden":false,"models":[{"id":"sol"},{"id":"luna"}]},
                "codex-work":{"type":"codex","enabled":true,"hidden":false,"models":[{"id":"sol"}]},
                "codex-off":{"type":"codex","enabled":false,"hidden":false,"models":[{"id":"sol"}]},
                "codex-hidden":{"type":"codex","enabled":true,"hidden":true,"models":[{"id":"sol"}]}
            }}}""",
        ).jsonObject,
    )

    private fun values(json: String): Map<String, JsonElement> = Json.parseToJsonElement(json).jsonObject

    @Test fun `nothing saved starts on the catalog default at medium and auto, as desktop does, not the catalog permission mode`() {
        assertEquals(Mode("claude", "opus", "medium", null, "auto"), ModelPreferences().startMode(catalog))
    }

    @Test fun `the last start's model, effort, account and speed come back`() {
        val preferences = ModelPreferences.parse(
            values(
                """{
                "happy-desktop.model.default":{"modelId":"sol"},
                "happy-desktop.model.effort":"xhigh",
                "happy-desktop.model.provider":"codex-work",
                "happy-desktop.model.memory":[{"providerId":"codex-work","modelId":"sol","effort":"low","serviceTier":"priority"}]
                }""",
            ),
        )
        // The start's effort is the default effort, not the one remembered for the model.
        assertEquals(Mode("codex-work", "sol", "xhigh", "priority", "auto"), preferences.startMode(catalog))
    }

    @Test fun `each value falls back on its own`() {
        // A model that's gone: the catalog's, on its default account, the effort kept where it runs.
        assertEquals(
            Mode("claude", "opus", "max", null, "auto"),
            ModelPreferences(defaultModelId = "gone", defaultEffort = "max", providerId = "codex").startMode(catalog),
        )
        // An account that's gone or off: the first that serves the model still on.
        assertEquals("codex", ModelPreferences(defaultModelId = "sol", providerId = "codex-off").startMode(catalog)?.providerId)
        assertEquals("codex", ModelPreferences(defaultModelId = "sol", providerId = "codex-hidden").startMode(catalog)?.providerId)
        assertEquals("codex", ModelPreferences(defaultModelId = "sol", providerId = "removed").startMode(catalog)?.providerId)
        // An effort the model doesn't run: the model's own.
        assertEquals("high", ModelPreferences(defaultModelId = "sol", defaultEffort = "max").startMode(catalog)?.effort)
        // A speed the model no longer offers is dropped.
        assertNull(ModelPreferences(defaultModelId = "opus", memory = listOf(ModelMemory("claude", "opus", null, "priority"))).startMode(catalog)?.serviceTier)
        // A permission mode saved wins over the catalog's.
        assertEquals("full_access", ModelPreferences(access = "full_access").startMode(catalog)?.permissionMode)
    }

    @Test fun `unknown and legacy values read as their defaults`() {
        val preferences = ModelPreferences.parse(
            values(
                """{
                "happy-desktop.model.default":{"providerId":"codex","modelId":"sol"},
                "happy-desktop.model.effort":"turbo",
                "happy-desktop.model.access":"root",
                "happy-desktop.model.start":"lastStarted",
                "happy-desktop.model.memory":[{"providerId":"codex"},"x",{"providerId":"codex","modelId":"sol","effort":"high","serviceTier":null}]
                }""",
            ),
        )
        assertEquals(
            ModelPreferences(defaultModelId = "sol", memory = listOf(ModelMemory("codex", "sol", "high", null))),
            preferences,
        )
        assertEquals(NewSessionStart.DefaultModel, ModelPreferences.parse(values("""{"happy-desktop.model.start":"default"}""")).start)
    }

    @Test fun `a start on Last session writes the model, effort, account and memory`() {
        val before = ModelPreferences(memory = listOf(ModelMemory("codex", "sol", "low", null), ModelMemory("claude", "opus", "max", null)))
        val writes = before.changes(before.started(Mode("codex", "sol", "xhigh", "priority", "auto")))
        assertEquals(
            setOf(ModelPreferences.DEFAULT_MODEL, ModelPreferences.DEFAULT_EFFORT_KEY, ModelPreferences.PROVIDER, ModelPreferences.MEMORY),
            writes.keys,
        )
        assertEquals(JsonObject(mapOf("modelId" to JsonPrimitive("sol"))), writes[ModelPreferences.DEFAULT_MODEL])
        assertEquals(JsonPrimitive("xhigh"), writes[ModelPreferences.DEFAULT_EFFORT_KEY])
        assertEquals(JsonPrimitive("codex"), writes[ModelPreferences.PROVIDER])
        // Moved to the end, most recent last, as desktop keeps it.
        val memory = writes[ModelPreferences.MEMORY]!!.jsonArray.map { it.jsonObject }
        assertEquals(listOf("opus", "sol"), memory.map { (it["modelId"] as JsonPrimitive).content })
        assertEquals(JsonPrimitive("priority"), memory.last()["serviceTier"])
        assertEquals(JsonPrimitive("xhigh"), memory.last()["effort"])
    }

    @Test fun `medium is written as the effort cleared`() {
        val before = ModelPreferences(defaultModelId = "sol", defaultEffort = "high", providerId = "codex")
        val writes = before.changes(before.started(Mode("codex", "sol", "medium", null, "auto")))
        assertEquals(JsonNull, writes[ModelPreferences.DEFAULT_EFFORT_KEY])
        assertTrue(ModelPreferences.DEFAULT_MODEL !in writes)
        assertTrue(ModelPreferences.PROVIDER !in writes)
    }

    @Test fun `a start on Default model leaves the default model and effort alone`() {
        val before = ModelPreferences(defaultModelId = "opus", defaultEffort = "max", start = NewSessionStart.DefaultModel)
        val after = before.started(Mode("codex", "sol", "low", null, "auto"))
        assertEquals(setOf(ModelPreferences.PROVIDER, ModelPreferences.MEMORY), before.changes(after).keys)
        assertEquals(Mode("claude", "opus", "max", null, "auto"), after.startMode(catalog))
    }

    @Test fun `the start setting is written as desktop writes it`() {
        val last = ModelPreferences()
        assertEquals(mapOf(ModelPreferences.START to JsonPrimitive("default")), last.changes(last.copy(start = NewSessionStart.DefaultModel)))
        val default = ModelPreferences(start = NewSessionStart.DefaultModel)
        assertEquals(mapOf(ModelPreferences.START to JsonNull), default.changes(default.copy(start = NewSessionStart.LastSession)))
    }

    @Test fun `memory keeps the most recent 256 entries`() {
        val many = ModelPreferences(memory = (0 until 300).map { ModelMemory("p", "m$it", null, null) })
        val memory = many.encode()[ModelPreferences.MEMORY]!!.jsonArray
        assertEquals(256, memory.size)
        assertEquals(JsonPrimitive("m44"), memory.first().jsonObject["modelId"])
        assertEquals(JsonPrimitive("m299"), memory.last().jsonObject["modelId"])
        assertEquals(JsonNull, ModelPreferences().encode()[ModelPreferences.MEMORY])
    }
}
