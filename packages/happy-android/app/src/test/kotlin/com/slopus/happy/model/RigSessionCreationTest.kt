package com.slopus.happy.model

import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** rigSessionCreation.test.ts and permissionModeLabels' ordering. */
class RigSessionCreationTest {
    private fun rig(
        defaults: Boolean = true,
        bots: Boolean? = null,
        modes: List<Triple<String, String, String>>? = listOf(
            Triple("auto", "Auto", "safe-yolo"),
            Triple("read_only", "Read only", "read-only"),
        ),
        models: List<Map<String, Any?>> = listOf(
            mapOf("providerId" to "codex", "id" to "shared-model", "name" to "GPT Shared", "providerName" to "OpenAI Codex", "levels" to listOf("low", "medium", "high"), "default" to "high"),
            mapOf("providerId" to "claude", "id" to "shared-model", "name" to "Claude Shared", "providerName" to "Anthropic Claude", "levels" to listOf("low", "max"), "default" to "max"),
        ),
        retry: Long? = null,
    ) = machineMetadata {
        put("machineKind", "rig")
        put("rigOnly", true)
        putJsonObject("capabilities") {
            put("newSession", true)
            put("resume", false)
            put("worktrees", false)
            bots?.let { put("bots", it) }
        }
        if (defaults) {
            putJsonObject("defaults") {
                put("providerId", "codex")
                put("modelId", "shared-model")
                put("permissionMode", "auto")
                put("effort", "high")
            }
        }
        putJsonArray("models") {
            for (m in models) {
                addJsonObject {
                    put("code", m["id"] as String)
                    put("value", (m["name"] as String?) ?: (m["id"] as String))
                    put("providerId", m["providerId"] as String)
                    put("id", m["id"] as String)
                    (m["name"] as String?)?.let { put("name", it) }
                    (m["providerName"] as String?)?.let { put("providerName", it) }
                    @Suppress("UNCHECKED_CAST")
                    putJsonArray("thinkingLevels") { (m["levels"] as List<String>).forEach { add(it) } }
                    (m["default"] as String?)?.let { put("defaultThinkingLevel", it) }
                }
            }
        }
        if (modes != null) {
            putJsonArray("operatingModes") {
                for ((code, value, kind) in modes) addJsonObject { put("code", code); put("value", value); put("kind", kind) }
            }
        }
        retry?.let { putJsonObject("sessionCreation") { put("pendingRetryAfterMs", it) } }
    }

    @Test fun providerQualifiedOptionsAndModelSpecificDefaults() {
        val creation = rig().rigSessionCreation()!!
        assertEquals("codex:shared-model", creation.defaultModelKey)
        assertEquals("auto", creation.defaultPermissionMode)
        assertFalse(creation.supportsWorktrees)
        assertEquals(listOf("codex:shared-model", "claude:shared-model"), creation.models.map { it.key })
        assertEquals(listOf("OpenAI Codex", "Anthropic Claude"), creation.models.map { it.providerName })
        assertEquals(listOf("auto" to "safe-yolo", "read_only" to "read-only"), creation.permissionModes.map { it.key to it.semanticKind })
        assertEquals(listOf("low", "max"), creation.effortsForModel("claude:shared-model"))
        assertEquals("max", creation.defaultEffortForModel("claude:shared-model"))
    }

    @Test fun onlyAHappyAgentThatCanStartSessionsHasACatalog() {
        assertNull(machineMetadata().rigSessionCreation())
        assertNull(machineMetadata { put("machineKind", "rig") }.rigSessionCreation())
    }

    @Test fun offersBotsOnlyWhenTheDaemonSaysItCanMakeThem() {
        assertFalse(rig().rigSessionCreation()!!.supportsBots)
        assertTrue(rig(bots = true).rigSessionCreation()!!.supportsBots)
    }

    @Test fun putsAstraFirstWithoutChangingDefaults() {
        for (published in listOf(true, false)) {
            val metadata = machineMetadata {
                put("machineKind", "rig")
                putJsonObject("capabilities") { put("newSession", true) }
                if (published) putJsonObject("defaults") { put("providerId", "codex"); put("modelId", "openai/gpt-5.6-sol") }
                putJsonArray("models") {
                    addJsonObject { put("code", "s"); put("value", "s"); put("providerId", "codex"); put("id", "openai/gpt-5.6-sol"); putJsonArray("thinkingLevels") { add("medium") } }
                    addJsonObject { put("code", "o"); put("value", "o"); put("providerId", "claude"); put("id", "anthropic/opus-5"); putJsonArray("thinkingLevels") { add("high") } }
                    addJsonObject {
                        put("code", "a"); put("value", "a"); put("providerId", "codex"); put("id", "openai/gpt-6-astra"); put("name", "GPT-6 Astra")
                        putJsonArray("thinkingLevels") { add("medium"); add("high"); add("ultra") }
                        put("defaultThinkingLevel", "high")
                    }
                }
                putJsonArray("operatingModes") { addJsonObject { put("code", "auto"); put("value", "Auto") } }
            }
            val creation = metadata.rigSessionCreation()!!
            assertEquals(listOf("codex:openai/gpt-6-astra", "codex:openai/gpt-5.6-sol", "claude:anthropic/opus-5"), creation.models.map { it.key })
            assertEquals("codex:openai/gpt-5.6-sol", creation.defaultModelKey)
            assertEquals(listOf("medium", "high", "ultra"), creation.effortsForModel("codex:openai/gpt-6-astra"))
            assertEquals(
                RigSpawnConfiguration("codex", "openai/gpt-6-astra", "auto", "high"),
                creation.spawnConfiguration(creation.models[0].key, null, null),
            )
        }
    }

    @Test fun buildsTheExactProviderQualifiedSpawn() {
        assertEquals(
            RigSpawnConfiguration("claude", "shared-model", "read_only", "max"),
            rig().rigSessionCreation()!!.spawnConfiguration("claude:shared-model", "read_only", "max"),
        )
    }

    @Test fun rejectsAModelEffortCombinationAbsentFromTheCatalog() {
        val error = assertThrows(RigSpawnException::class.java) {
            rig().rigSessionCreation()!!.spawnConfiguration("claude:shared-model", null, "high")
        }
        assertTrue(error.message!!.contains("reasoning level is unavailable"))
    }

    @Test fun fallsBackToThePublishedFirstModeNotTheDisplaySortedFirst() {
        val creation = rig(
            defaults = false,
            modes = listOf(Triple("ask", "Default", "default"), Triple("full_access", "Full access", "yolo")),
        ).rigSessionCreation()!!
        assertEquals("ask", creation.defaultPermissionMode)
        assertEquals(listOf("full_access", "ask"), creation.permissionModes.map { it.key })
    }

    @Test fun anEmptyCatalogWithoutOperatingModes() {
        val creation = rig(modes = null).rigSessionCreation()!!
        assertEquals(emptyList<RigModeOption>(), creation.permissionModes)
        assertNull(creation.defaultPermissionMode)
        assertNull(creation.pendingRetryAfterMs)
        assertEquals(2_000L, rig(retry = 2_000).rigSessionCreation()!!.pendingRetryAfterMs)
    }

    @Test fun pendingRetryDelayIsNeverInstantAndStaysInItsWindow() {
        assertEquals(1_000L, resolveRigPendingRetryDelayMs(null, null))
        assertEquals(2_000L, resolveRigPendingRetryDelayMs(null, 2_000))
        assertEquals(250L, resolveRigPendingRetryDelayMs(0, null))
        assertEquals(250L, resolveRigPendingRetryDelayMs(-5_000, null))
        assertEquals(10_000L, resolveRigPendingRetryDelayMs(60_000, null))
        assertEquals(3_000L, resolveRigPendingRetryDelayMs(3_000, 250))
    }

    @Test fun permissionModesSortByTheirFirstWord() {
        val modes = listOf("Default", "Read only", "Something", "Auto", "Workspace write").map { RigModeOption(it, it, null, null) }
        assertEquals(listOf("Auto", "Workspace write", "Read only", "Something", "Default"), sortPermissionModes(modes).map { it.key })
        assertEquals("Workspace", permissionModeShortLabel("Workspace write"))
    }
}
