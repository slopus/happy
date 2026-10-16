package com.slopus.happy.model.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** happy-app sync/agentDefaults.test.ts and utils/versionUtils.ts. */
class AgentDefaultsTest {
    private fun overrides(vararg agents: Pair<AgentKey, AgentDefaultOverride>) = AgentDefaultOverrides(agents.toMap())

    @Test
    fun autoIsTheCodeDefaultForClaudeAndCodex() {
        assertEquals("auto", AgentDefaults.codeDefaults("claude").permissionMode)
        assertEquals("auto", AgentDefaults.codeDefaults("codex").permissionMode)
    }

    @Test
    fun oldClisFallBackToDefault() {
        for (flavor in listOf("claude", "codex")) {
            assertEquals("default", AgentDefaults.codeDefaults(flavor, "1.2.0").permissionMode)
            assertEquals("default", AgentDefaults.resolve(AgentDefaultOverrides(), flavor, "1.2.1-beta.1").permissionMode)
            assertEquals("default", AgentDefaults.resolve(AgentDefaultOverrides(), flavor, "not-a-version").permissionMode)
            assertEquals("auto", AgentDefaults.resolve(AgentDefaultOverrides(), flavor, "1.2.1-beta.2").permissionMode)
            assertEquals("auto", AgentDefaults.resolve(AgentDefaultOverrides(), flavor, "1.3.0").permissionMode)
            assertEquals("auto", AgentDefaults.resolve(AgentDefaultOverrides(), flavor).permissionMode)
        }
    }

    @Test
    fun explicitOverridesAreNotRewritten() {
        assertEquals(
            "bypassPermissions",
            AgentDefaults.resolve(overrides(AgentKey.Claude to AgentDefaultOverride(permissionMode = "bypassPermissions")), "claude", "1.2.0").permissionMode,
        )
        assertEquals("yolo", AgentDefaults.resolve(overrides(AgentKey.Codex to AgentDefaultOverride(permissionMode = "yolo")), "codex", "1.2.0").permissionMode)
        assertEquals("auto", AgentDefaults.resolve(overrides(AgentKey.Claude to AgentDefaultOverride(permissionMode = "auto")), "claude", "1.2.0").permissionMode)
    }

    @Test
    fun claudeModelFollowsTheCliVersion() {
        for (version in listOf("1.2.6-beta.0", "1.2.6-beta.1", "1.2.6", "1.3.0")) {
            assertEquals(version, "claude-opus-5-5", AgentDefaults.codeDefaults("claude", version).modelMode)
        }
        for (version in listOf("1.2.5", "1.2.5-beta.2", "1.2.0", "not-a-version", null)) {
            assertEquals("$version", "claude-opus-5", AgentDefaults.resolve(AgentDefaultOverrides(), "claude", version).modelMode)
        }
        for (version in listOf("1.2.5", "1.2.6-beta.0", "1.3.0", null)) {
            for (model in listOf("claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-haiku-5-5")) {
                assertEquals(model, AgentDefaults.resolve(overrides(AgentKey.Claude to AgentDefaultOverride(modelMode = model)), "claude", version).modelMode)
            }
        }
    }

    @Test
    fun retiredClaudeModelsMapOntoTheirRows() {
        for ((saved, row) in listOf("claude-opus-5-5[1m]" to "claude-opus-5-5", "claude-opus-5[1m]" to "claude-opus-5", "claude-sonnet-5-5[1m]" to "claude-sonnet-5-5")) {
            val o = overrides(AgentKey.Claude to AgentDefaultOverride(modelMode = saved, effortLevel = "high"))
            assertEquals(row, AgentDefaults.retireModelMode("claude", saved))
            assertEquals(AgentDefaultOverride(modelMode = row, effortLevel = "high"), AgentDefaults.override(o, "claude"))
            assertEquals(row, AgentDefaults.overrideValue(o, "claude", AgentDefaultField.ModelMode))
            assertEquals(row, AgentDefaults.resolve(o, "claude", "1.2.6").modelMode)
        }
        assertEquals("claude-sonnet-5", AgentDefaults.retireModelMode("claude", "claude-sonnet-5"))
        assertEquals("claude-opus-5", AgentDefaults.retireModelMode(null, "claude-opus-5[1m]"))
        assertEquals("claude-opus-5[1m]", AgentDefaults.retireModelMode("codex", "claude-opus-5[1m]"))
        assertEquals("claude-opus-5[1m]", AgentDefaults.retireModelMode("agy", "claude-opus-5[1m]"))
        assertEquals("claude-opus-5[1m]", AgentDefaults.retireModelMode("rig", "claude-opus-5[1m]"))
        assertEquals(null, AgentDefaults.retireModelMode("claude", null))
        assertEquals("acceptEdits", AgentDefaults.retirePermissionMode("dontAsk"))
    }

    @Test
    fun otherAgentsAreNotGated() {
        assertEquals("gpt-6.1-sol", AgentDefaults.codeDefaults("codex", "1.2.0").modelMode)
        assertEquals("Gemini 3.8 Flash", AgentDefaults.codeDefaults("agy").modelMode)
        for (flavor in listOf("gemini", "openclaw", "agy")) assertEquals("default", AgentDefaults.resolve(null, flavor, "1.0.0").permissionMode)
        assertEquals(AgentKey.Claude, AgentKey.normalize("something-else"))
        assertEquals(AgentKey.Claude, AgentKey.normalize(null))
    }

    @Test
    fun settingAndClearingOverrides() {
        var o = AgentDefaults.set(null, "codex", AgentDefaultField.ModelMode, "gpt-5.4")
        assertEquals(overrides(AgentKey.Codex to AgentDefaultOverride(modelMode = "gpt-5.4")), o)
        assertTrue(AgentDefaults.hasOverride(o, "codex", AgentDefaultField.ModelMode))
        assertFalse(AgentDefaults.hasOverride(o, "codex", AgentDefaultField.EffortLevel))
        o = AgentDefaults.set(o, "codex", AgentDefaultField.EffortLevel, "high")
        o = AgentDefaults.set(o, "codex", AgentDefaultField.ModelMode, null)
        assertEquals(overrides(AgentKey.Codex to AgentDefaultOverride(effortLevel = "high")), o)
        o = AgentDefaults.set(o, "codex", AgentDefaultField.EffortLevel, null)
        assertEquals(AgentDefaultOverrides(), o)
    }

    @Test
    fun versionOrder() {
        assertEquals(0, Versions.compare("0.10.0-1", "0.10.0"))
        assertEquals(1, Versions.compare("1.10", "1.9.9"))
        assertEquals(1, Versions.compareWithPrerelease("1.2.1", "1.2.1-beta.2"))
        assertEquals(1, Versions.compareWithPrerelease("1.2.1-beta.10", "1.2.1-beta.9"))
        assertEquals(-1, Versions.compareWithPrerelease("1.2.1-beta", "1.2.1-beta.2"))
        assertEquals(-1, Versions.compareWithPrerelease("1.2.1-1", "1.2.1-alpha"))
        assertEquals(0, Versions.compareWithPrerelease("1.2.1+abc", "1.2.1"))
        assertTrue(Versions.isWellFormed("1.2.6-beta.0+build"))
        assertFalse(Versions.isWellFormed("1.2"))
    }
}
