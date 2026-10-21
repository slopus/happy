package com.slopus.happy.model

import com.slopus.happy.model.settings.AgentDefaultOverride
import com.slopus.happy.model.settings.AgentDefaultOverrides
import com.slopus.happy.model.settings.AgentKey
import com.slopus.happy.net.HappyJson
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** happy-app sync/settings.spec.ts, case by case. */
class SettingsTest {
    private fun json(text: String): JsonObject = HappyJson.parseToJsonElement(text).jsonObject
    private fun element(text: String): JsonElement = HappyJson.parseToJsonElement(text)
    private val defaults = Settings.Defaults
    private val defaultsJson = defaults.toJson()

    // settingsParse

    @Test
    fun invalidInputGivesDefaults() {
        assertEquals(defaults, Settings.parse(null))
        assertEquals(defaults, Settings.parse(element("\"invalid\"")))
        assertEquals(defaults, Settings.parse(element("123")))
        assertEquals(defaults, Settings.parse(element("[]")))
        assertEquals(defaults, Settings.parse(element("null")))
    }

    @Test
    fun emptyObjectGivesDefaults() = assertEquals(defaults, Settings.parse(json("{}")))

    @Test
    fun parsesAValidObject() = assertEquals(defaults.copy(viewInline = true), Settings.parse(json("""{"viewInline":true}""")))

    @Test
    fun aWrongTypeResetsKnownFieldsToDefaults() {
        assertEquals(defaults, Settings.parse(json("""{"viewInline":"not a boolean"}""")))
        // One bad field takes the good ones with it, as zod's safeParse does.
        assertEquals(defaults, Settings.parse(json("""{"viewInline":true,"experiments":1}""")))
    }

    @Test
    fun keepsUnknownFields() {
        val parsed = Settings.parse(json("""{"viewInline":true,"unknownField":"some value","anotherField":123}"""))
        assertEquals(defaults.copy(viewInline = true, unknown = json("""{"unknownField":"some value","anotherField":123}""")), parsed)
        assertEquals(json("""{"unknownField":"some value"}""")["unknownField"], parsed.toJson()["unknownField"])
    }

    @Test
    fun nullForANonNullableFieldResetsToDefaults() {
        assertEquals(defaults, Settings.parse(json("""{"viewInline":null}""")))
    }

    @Test
    fun nestedObjectsAreKeptAsExtraFields() {
        val image = json("""{"url":"http://example.com","width":100,"height":200}""")
        val parsed = Settings.parse(JsonObject(mapOf("viewInline" to JsonPrimitive(false), "image" to image)))
        assertEquals(image, parsed.unknown["image"])
        assertEquals(image, parsed.toJson()["image"])
    }

    @Test
    fun unknownFieldsSurviveAFailedParse() {
        val parsed = Settings.parse(json("""{"viewInline":"bad","future":1}"""))
        assertEquals(defaults.copy(unknown = json("""{"future":1}""")), parsed)
    }

    @Test
    fun migratesTheOldChineseCode() {
        assertEquals("zh-Hans", Settings.parse(json("""{"preferredLanguage":"zh"}""")).preferredLanguage)
        assertEquals("ja", Settings.parse(json("""{"preferredLanguage":"ja"}""")).preferredLanguage)
        assertEquals(null, Settings.parse(json("""{"preferredLanguage":null}""")).preferredLanguage)
    }

    @Test
    fun readsEveryKindOfField() {
        val parsed = Settings.parse(
            json(
                """{
                "diffStyle":"split","sessionListGrouping":"project","reviewPromptLikedApp":true,
                "recentMachinePaths":[{"machineId":"m","path":"/p","extra":1}],
                "agentDefaultOverrides":{"codex":{"modelMode":"gpt-5.4","future":"x"},"someAgent":{"a":1}},
                "dismissedCLIWarnings":{"perMachine":{"m1":{"claude":true,"other":true}}}
            }""",
            ),
        )
        assertEquals(DiffStyle.Split, parsed.diffStyle)
        assertEquals(SessionListGrouping.Project, parsed.sessionListGrouping)
        assertEquals(true, parsed.reviewPromptLikedApp)
        assertEquals(listOf(RecentMachinePath("m", "/p")), parsed.recentMachinePaths)
        assertEquals(
            AgentDefaultOverrides(
                mapOf(AgentKey.Codex to AgentDefaultOverride(modelMode = "gpt-5.4", unknown = json("""{"future":"x"}"""))),
                json("""{"someAgent":{"a":1}}"""),
            ),
            parsed.agentDefaultOverrides,
        )
        // Inner objects strip unknown keys, and global takes its default.
        assertEquals(DismissedCliWarnings(perMachine = mapOf("m1" to CliWarningFlags(claude = true))), parsed.dismissedCLIWarnings)
        assertEquals(parsed, Settings.parse(parsed.toJson()))
    }

    @Test
    fun badEnumsAndNestedValuesFailTheParse() {
        assertEquals(defaults, Settings.parse(json("""{"diffStyle":"sideways","viewInline":true}""")))
        assertEquals(defaults, Settings.parse(json("""{"recentMachinePaths":[{"machineId":"m"}],"viewInline":true}""")))
        assertEquals(defaults, Settings.parse(json("""{"agentDefaultOverrides":{"claude":null},"viewInline":true}""")))
        assertEquals(defaults, Settings.parse(json("""{"dismissedCLIWarnings":{"global":{"codex":"yes"}},"viewInline":true}""")))
    }

    // applySettings

    @Test
    fun applyAddsTheDeltaAndFillsDefaults() {
        val current = defaults.copy(schemaVersion = 1, avatarStyle = "gradient").toJson()
        assertEquals(JsonObject(current + ("viewInline" to JsonPrimitive(true))), Settings.apply(current, json("""{"viewInline":true}""")))
        assertEquals(current, Settings.apply(current, json("{}")))
    }

    @Test
    fun applyKeepsUnknownFieldsFromBothSides() {
        val result = Settings.apply(json("""{"viewInline":true,"existingExtra":"keep me"}"""), json("""{"viewInline":false,"newExtra":"add me"}"""))
        assertEquals(JsonObject(defaultsJson + json("""{"viewInline":false,"existingExtra":"keep me","newExtra":"add me"}""")), result)
    }

    // settingsDefaults

    @Test
    fun defaultsAreHappyAppsDefaults() {
        assertEquals(
            json(
                """{
                "schemaVersion":2,"viewInline":false,"expandTodos":true,"showLineNumbers":true,
                "showLineNumbersInToolViews":false,"wrapLinesInDiffs":true,"diffStyle":"unified","analyticsOptOut":false,
                "inferenceOpenAIKey":null,"experiments":false,"alwaysShowContextSize":false,"agentInputEnterToSend":true,
                "avatarStyle":"brutalist","avatarMonochrome":false,"sessionListGrouping":"flat","showFlavorIcons":false,
                "showHarnessIconInSessionHeader":true,"userMessageBubbleColor":"gray","usageLimitShowRemaining":false,
                "hideInactiveSessions":true,"sortSessionsByActivity":true,"expResumeSession":true,"fileDiffsSidebar":false,
                "groupToolCalls":false,"compactToolCalls":false,"reviewPromptAnswered":false,"reviewPromptLikedApp":null,
                "voiceAssistantLanguage":null,"voiceCustomAgentId":null,"voiceBypassToken":false,"preferredLanguage":null,
                "recentMachinePaths":[],"lastUsedAgent":null,"lastUsedPermissionMode":null,"lastUsedModelMode":null,
                "agentDefaultOverrides":{},"dismissedCLIWarnings":{"perMachine":{},"global":{}}
            }""",
            ),
            defaultsJson,
        )
        assertEquals(defaults, Settings.parse(defaultsJson))
    }

    @Test
    fun legacyListSettingLeavesTheHeaderSettingOn() {
        val parsed = Settings.parse(json("""{"showFlavorIcons":true}"""))
        assertTrue(parsed.showFlavorIcons)
        assertTrue(parsed.showHarnessIconInSessionHeader)
    }

    // settingsToSyncPayload

    @Test
    fun syncPayloadOmitsEmptyAgentOverrides() {
        assertFalse("agentDefaultOverrides" in Settings.syncPayload(defaultsJson))
        assertFalse("agentDefaultOverrides" in Settings.syncPayload(JsonObject(defaultsJson + ("agentDefaultOverrides" to json("""{"codex":{}}""")))))
        val kept = Settings.syncPayload(JsonObject(defaultsJson + ("agentDefaultOverrides" to json("""{"codex":{"modelMode":"gpt-5.4"},"claude":{}}"""))))
        assertEquals(json("""{"codex":{"modelMode":"gpt-5.4"}}"""), kept["agentDefaultOverrides"])
    }

    // forward/backward compatibility and the version-mismatch merge

    @Test
    fun newerVersionsFieldsSurviveAChange() {
        val result = Settings.apply(json("""{"viewInline":false,"futureField1":"value1","futureField2":42}"""), json("""{"viewInline":true}"""))
        val parsed = Settings.parse(result)
        assertTrue(parsed.viewInline)
        assertEquals(json("""{"futureField1":"value1","futureField2":42}"""), parsed.unknown)
    }

    @Test
    fun pendingChangesWinOverTheServerCopy() {
        val server = Settings.parse(json("""{"viewInline":true}""")).toJson()
        val merged = Settings.parse(Settings.apply(server, json("""{"experiments":true,"analyticsOptOut":true}""")))
        assertTrue(merged.experiments)
        assertTrue(merged.analyticsOptOut)
        assertTrue(merged.viewInline)

        val reset = Settings.parse(Settings.apply(Settings.parse(json("{}")).toJson(), json("""{"experiments":true}""")))
        assertTrue(reset.experiments)
        assertFalse(reset.viewInline)

        val withExtra = Settings.parse(Settings.apply(Settings.parse(json("""{"viewInline":true,"futureFeature":"x"}""")).toJson(), json("""{"experiments":true}""")))
        assertEquals(JsonPrimitive("x"), withExtra.unknown["futureFeature"])
        assertEquals(Settings.parse(server), Settings.parse(Settings.apply(server, json("{}"))))
    }

    @Test
    fun aPendingNestedValueReplacesTheServersWhole() {
        val server = Settings.parse(json("""{"dismissedCLIWarnings":{"perMachine":{"machine-1":{"claude":true}},"global":{"codex":true}}}""")).toJson()
        val pending = json("""{"experiments":true,"dismissedCLIWarnings":{"perMachine":{"machine-2":{"claude":true}},"global":{}}}""")
        val merged = Settings.parse(Settings.apply(server, pending))
        assertTrue(merged.experiments)
        assertEquals(DismissedCliWarnings(perMachine = mapOf("machine-2" to CliWarningFlags(claude = true))), merged.dismissedCLIWarnings)
    }

    @Test
    fun aVeryLargeDocumentKeepsEveryField() {
        val large = JsonObject(mapOf("viewInline" to JsonPrimitive(true)) + (0 until 1000).associate { "field$it" to JsonPrimitive("value$it") })
        val parsed = Settings.parse(large)
        assertTrue(parsed.viewInline)
        assertTrue(parsed.toJson().size > 1000)
    }

    @Test
    fun constructorAndProtoKeysAreOrdinaryFields() {
        val parsed = Settings.parse(json("""{"viewInline":true,"__proto__":{"evil":true},"constructor":{"prototype":{"evil":true}}}"""))
        assertTrue(parsed.viewInline)
        assertEquals(json("""{"prototype":{"evil":true}}"""), parsed.unknown["constructor"])
    }
}
