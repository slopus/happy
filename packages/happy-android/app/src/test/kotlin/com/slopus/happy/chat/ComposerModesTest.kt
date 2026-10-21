package com.slopus.happy.chat

import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.settings.ModeOption
import com.slopus.happy.model.settings.ModeOptions
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.sync.ComposerMirror
import com.slopus.happy.sync.SessionComposerTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Ports modelModeOptions.test.ts and useComposerModes' resolution order. */
class ComposerModesTest {
    private val translate: (Int) -> String = { "tr:$it" }

    private val rigJson = Json.parseToJsonElement(SessionComposerTest.RIG_METADATA_FIXTURE).jsonObject
    private fun rig(change: (MutableMap<String, kotlinx.serialization.json.JsonElement>) -> Unit = {}): SessionMetadata {
        val map = rigJson.toMutableMap()
        change(map)
        return requireNotNull(SessionMetadata.parse(JsonObject(map)))
    }

    private fun plain(flavor: String, extra: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit = {}): SessionMetadata =
        requireNotNull(SessionMetadata.parse(buildJsonObject {
            put("path", "/repo"); put("host", "h"); put("flavor", flavor); extra()
        }))

    @Test
    fun rigSessionsListTheirOwnModelsAndRankedModes() {
        val models = ModeOptions.availableModels("codex", rig(), translate)
        assertEquals(
            listOf(
                Triple("codex:shared-model", "GPT Shared", "OpenAI Codex"),
                Triple("claude:shared-model", "Claude Shared", "Anthropic Claude"),
            ),
            models.map { Triple(it.key, it.name, it.providerName) },
        )
        val modes = ModeOptions.availablePermissionModes("codex", rig(), translate)
        assertEquals(
            listOf("auto" to "safe-yolo", "workspace_write" to "default", "read_only" to "read-only", "full_access" to "yolo"),
            modes.map { it.key to it.semanticKind },
        )
    }

    @Test
    fun astraLeadsItsProviderAndMissingModelsAreDisabledRows() {
        val base = rigJson["models"]!!.jsonArray
        val sol = JsonObject(base[0].jsonObject + mapOf("id" to JsonPrimitive("openai/gpt-5.6-sol"), "name" to JsonPrimitive("GPT-5.6 Sol")))
        val astra = JsonObject(base[0].jsonObject + mapOf("id" to JsonPrimitive("openai/gpt-6-astra"), "name" to JsonPrimitive("GPT-6 Astra")))
        val metadata = rig { it["models"] = JsonArray(listOf(sol, base[1], astra)); it["currentModelCode"] = JsonPrimitive("openai/gpt-5.6-sol") }
        assertEquals(
            listOf("codex:openai/gpt-6-astra", "codex:openai/gpt-5.6-sol", "claude:shared-model"),
            ModeOptions.availableModels("codex", metadata, translate).map { it.key },
        )

        val missing = rig {
            it["currentModelProviderId"] = JsonPrimitive("custom-provider")
            it["currentModelCode"] = JsonPrimitive("temporarily-missing")
            it.remove("model")
        }
        val last = ModeOptions.availableModels("codex", missing, translate, selectedKey = "other:local").takeLast(2)
        assertEquals(listOf("custom-provider:temporarily-missing", "other:local"), last.map { it.key })
        assertTrue(last.all { it.disabled })
        assertEquals("other · unavailable", last[1].description)
    }

    @Test
    fun anUnknownCurrentRigModeLeadsDisabled() {
        val modes = ModeOptions.availablePermissionModes("codex", rig(), translate, selectedKey = "plan_only")
        assertEquals("plan_only", modes.first().key)
        assertTrue(modes.first().disabled)
        assertEquals("Unavailable in the current Happy mode catalog", modes.first().description)
    }

    @Test
    fun hardcodedListsDropModesTheCliCannotParse() {
        val old = ModeOptions.availablePermissionModes("claude", plain("claude") { put("version", "0.1.0") }, translate)
        assertFalse(old.any { it.key == "auto" })
        val unknown = ModeOptions.availablePermissionModes("claude", plain("claude"), translate)
        assertEquals("auto", unknown.first().key)
        val mangled = ModeOptions.availablePermissionModes("codex", plain("codex") { put("version", "nonsense") }, translate)
        assertFalse(mangled.any { it.key == "auto" })
    }

    @Test
    fun publishedCatalogsAreHackedAndRanked() {
        val metadata = plain("opencode") {
            put("operatingModes", Json.parseToJsonElement("""[{"code":"build","value":"build, build"},{"code":"plan","value":"plan/plan"},{"code":"x","value":"Default"}]"""))
        }
        val modes = ModeOptions.availablePermissionModes("opencode", metadata, translate)
        assertEquals(listOf("Plan", "Build", "Default"), modes.map { it.name })
        assertEquals("Workspace", ModeOptions.permissionModeShortLabel(ModeOption("w", "Workspace write")))
        assertNull(ModeOptions.permissionModeShortLabel(null))
    }

    @Test
    fun codexMetadataModelsGetADefaultRow() {
        val metadata = plain("codex") { put("models", Json.parseToJsonElement("""[{"code":"m1","value":"Model one"}]""")) }
        assertEquals(listOf("default", "m1"), ModeOptions.availableModels("codex", metadata, translate).map { it.key })
        // No published models: the hardcoded list keeps a custom pick.
        val hardcoded = ModeOptions.availableModels("codex", plain("codex"), translate, selectedKey = "my-model")
        assertEquals("my-model", hardcoded.last().key)
    }

    @Test
    fun groupsKeepFirstSeenProviderOrder() {
        val groups = ModeOptions.groupModelsByProvider(
            listOf(
                ModeOption("codex:sol", "Sol", providerId = "codex", providerName = "OpenAI Codex"),
                ModeOption("claude:opus", "Opus", providerId = "claude", providerName = "Anthropic Claude"),
                ModeOption("codex:terra", "Terra", providerId = "codex", providerName = "OpenAI Codex"),
                ModeOption("bare", "Bare"),
            ),
        )
        assertEquals(listOf("codex", "claude", "__models__"), groups.map { it.key })
        assertEquals(listOf("codex:sol", "codex:terra"), groups[0].models.map { it.key })
        assertNull(groups[2].title)
    }

    @Test
    fun theSessionsPickWinsThenWhatTheAgentReports() {
        val reported = ComposerModeResolver.resolve(rig(), ComposerMirror(), null, translate)
        assertEquals("auto", reported.permissionMode?.key)
        assertEquals("codex:shared-model", reported.modelMode?.key)
        assertEquals(listOf("low", "medium", "high"), reported.availableEffortLevels.map { it.key })
        assertEquals("high", reported.effortLevel?.key)
        assertTrue(reported.canChangeModel && reported.canChangePermission && reported.canChangeEffort)

        val picked = ComposerModeResolver.resolve(
            rig(),
            ComposerMirror(permissionMode = "read_only", modelMode = "claude:shared-model", effortLevel = "max"),
            null,
            translate,
        )
        assertEquals("read_only", picked.permissionMode?.key)
        assertEquals("claude:shared-model", picked.modelMode?.key)
        assertEquals(listOf("low", "high", "max"), picked.availableEffortLevels.map { it.key })
        assertEquals("max", picked.effortLevel?.key)
    }

    @Test
    fun aPlainSessionFallsBackToTheAgentDefaults() {
        val modes = ComposerModeResolver.resolve(plain("claude"), ComposerMirror(), null, translate)
        assertEquals(ModeOptions.availablePermissionModes("claude", plain("claude"), translate), modes.availableModes)
        // Claude's code defaults name a row in each list.
        assertTrue(modes.permissionMode != null)
        assertTrue(modes.modelMode != null)
        assertEquals(listOf("low", "medium", "high", "xhigh", "max"), modes.availableEffortLevels.map { it.key })
    }

    @Test
    fun aLockedRigSessionCannotChangeItsModel() {
        val locked = rig {
            it["session"] = Json.parseToJsonElement("""{"status":"running","permissionMode":"auto","modelLocked":true,"serviceTier":"fast"}""")
        }
        val modes = ComposerModeResolver.resolve(locked, ComposerMirror(), null, translate)
        assertFalse(modes.canChangeModel)
        assertTrue(modes.canChangeEffort)
    }

    @Test
    fun aModelWithoutTheEffortPickResetsItToItsDefault() {
        val claude = ModeOption("claude:shared-model", "Claude Shared", defaultThinkingLevel = "max")
        assertEquals(
            mapOf(AgentModeField.MODEL_MODE to "claude:shared-model", AgentModeField.EFFORT_LEVEL to "max"),
            ComposerModeResolver.patch(AgentModeField.MODEL_MODE, claude, rig(), ComposerMirror(effortLevel = "medium")),
        )
        assertEquals(
            mapOf(AgentModeField.MODEL_MODE to "claude:shared-model"),
            ComposerModeResolver.patch(AgentModeField.MODEL_MODE, claude, rig(), ComposerMirror(effortLevel = "high")),
        )
        assertEquals(
            mapOf(AgentModeField.MODEL_MODE to "claude:shared-model"),
            ComposerModeResolver.patch(AgentModeField.MODEL_MODE, claude, rig(), ComposerMirror()),
        )
        assertEquals(
            mapOf(AgentModeField.EFFORT_LEVEL to "low"),
            ComposerModeResolver.patch(AgentModeField.EFFORT_LEVEL, ModeOption("low", "Low"), rig(), ComposerMirror()),
        )
    }
}
