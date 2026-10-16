package com.slopus.happy.model

import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.rigMetadata
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** resumeCommand.test.ts, versionUtils.test.ts's isVersionSupported, and info.tsx's formatting helpers. */
class SessionInfoTest {
    private val claudeId = "93a9705e-bc6a-406d-8dce-8acc014dedbd"

    @Test fun neverOffersANativeResumeForHappyAgentSessions() {
        assertNull(rigMetadata(path = "/tmp/project") { put("flavor", "codex"); put("codexThreadId", "thread-1") }.resumeCommand())
    }

    @Test fun claudeResumeEntersTheSessionDirectoryFirst() {
        val meta = metadata(path = "/tmp/project") { put("os", "darwin"); put("flavor", "claude"); put("claudeSessionId", claudeId) }
        assertEquals("cd '/tmp/project' && happy claude --resume $claudeId", meta.resumeCommand())
        assertEquals(
            ResumeCommandBlock(listOf("cd '/tmp/project'", "happy claude --resume $claudeId"), "cd '/tmp/project'\nhappy claude --resume $claudeId"),
            meta.resumeCommandBlock(),
        )
    }

    @Test fun windowsCodexResumeUsesPowerShell() {
        val meta = metadata(path = "C:\\Users\\test\\project") { put("os", "win32"); put("flavor", "codex"); put("codexThreadId", "019ccca5") }
        assertEquals("Set-Location -LiteralPath 'C:\\Users\\test\\project'; happy codex --resume 019ccca5", meta.resumeCommand())
    }

    @Test fun bareResumeWithoutAPathAndNothingWithoutAnId() {
        assertEquals("happy claude --resume $claudeId", metadata(path = "") { put("flavor", "claude"); put("claudeSessionId", claudeId) }.resumeCommand())
        assertNull(metadata(path = "/tmp/project") { put("flavor", "claude") }.resumeCommand())
        assertEquals("cd 'it'\\''s' && happy claude --resume x", metadata(path = "it's") { put("claudeSessionId", "x") }.resumeCommand())
    }

    @Test fun flagsAnOutdatedCli() {
        assertTrue(isCliOutdated("0.9.9"))
        assertFalse(isCliOutdated("0.10.0"))
        assertFalse(isCliOutdated(null))
    }

    @Test fun sandboxAndPermissionSummaries() {
        assertEquals(SandboxSummary.Disabled, sandboxSummary(null, null))
        assertEquals(SandboxSummary.Disabled, sandboxSummary(JsonNull, null))
        assertEquals(SandboxSummary.Text("strict"), sandboxSummary(JsonPrimitive("strict"), null))
        assertEquals(SandboxSummary.Disabled, sandboxSummary(buildJsonObject { put("enabled", false) }, null))
        assertEquals(
            SandboxSummary.Enabled("session", "none", "~/w"),
            sandboxSummary(buildJsonObject { put("sessionIsolation", "session"); put("networkMode", "none"); put("workspaceRoot", "/Users/dev/w") }, "/Users/dev"),
        )
        assertEquals(InfoSetting.Enabled, dangerouslySkipPermissions(true, null, null))
        assertEquals(InfoSetting.Disabled, dangerouslySkipPermissions(false, "claude", null))
        assertEquals(InfoSetting.Enabled, dangerouslySkipPermissions(null, "claude", buildJsonObject { put("enabled", true) }))
        assertEquals(InfoSetting.Unknown, dangerouslySkipPermissions(null, "codex", buildJsonObject { put("enabled", true) }))
    }

    @Test fun providerNamesAndShortIds() {
        assertEquals("Claude", metadata().aiProviderName())
        assertEquals("Codex", metadata { put("flavor", "openai") }.aiProviderName())
        assertEquals("custom", metadata { put("flavor", "custom") }.aiProviderName())
        assertEquals("abcdefgh...stuvwxyz", shortId("abcdefghijklmnopqrstuvwxyz"))
    }

    @Test fun gitPresentationReadsHappyAgentsSummaryOnly() {
        assertEquals(SessionGitPresentation(null, null), metadata().gitPresentation())
        val rig = rigMetadata {
            put("rigMetadataVersion", 1)
            putJsonObject("git") { put("changedFiles", 3); put("countsExact", false); put("insertions", 10); put("deletions", 2) }
        }
        assertEquals(SessionGitPresentation(3, VisibleGitChanges(true, 10, 2)), rig.gitPresentation())
    }
}
