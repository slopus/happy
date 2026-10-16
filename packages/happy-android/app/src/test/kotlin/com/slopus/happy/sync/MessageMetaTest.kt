package com.slopus.happy.sync

import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.settings.AgentDefaultOverrides
import com.slopus.happy.net.HappyJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** messageMeta.ts: a port of messageMeta.test.ts. */
class MessageMetaTest {
    private fun metadata(flavor: String? = null, version: String? = null): SessionMetadata = SessionMetadata.parse(buildJsonObject {
        put("path", "/repo")
        put("host", "mac")
        flavor?.let { put("flavor", it) }
        version?.let { put("version", it) }
    })!!

    private val rig: SessionMetadata = SessionMetadata.parse(
        HappyJson.parseToJsonElement(SessionComposerTest.RIG_METADATA_FIXTURE).jsonObject,
    )!!

    private val receipts: SessionMetadata = run {
        val json = HappyJson.parseToJsonElement(SessionComposerTest.RIG_METADATA_FIXTURE).jsonObject
        val capabilities = JsonObject(json["capabilities"]!!.jsonObject + ("messageReceipts" to JsonPrimitive(true)))
        SessionMetadata.parse(JsonObject(json + ("capabilities" to capabilities)))!!
    }

    private fun overrides(json: String) = AgentDefaultOverrides.parse(HappyJson.parseToJsonElement(json))

    private fun mode(
        metadata: SessionMetadata,
        permissionMode: String? = null,
        modelMode: String? = null,
        effortLevel: String? = null,
        overrides: AgentDefaultOverrides? = null,
    ) = MessageMetaResolver.mode(metadata, ComposerMirror(permissionMode = permissionMode, modelMode = modelMode, effortLevel = effortLevel), overrides)

    private fun meta(permissionMode: String? = null, model: String? = null, effort: String? = null) =
        MessageModeMeta(permissionMode = permissionMode, model = model?.let { Present(it) }, effort = effort?.let { Present(it) })

    // resolveMessageDeliveryMeta

    private fun delivery(
        metadata: SessionMetadata = receipts,
        thinking: Boolean = false,
        agentState: String? = null,
        isNewSession: Boolean = false,
        pending: Boolean = false,
    ) = MessageMetaResolver.delivery(metadata, agentState, thinking, isNewSession, pending)

    @Test
    fun anIdleAgentTracksAcceptanceWithoutAQueueStatus() {
        assertEquals(MessageDeliveryMeta(expectsAcceptance = true, queuedWhileBusy = false), delivery())
    }

    @Test
    fun sendingDuringATurnOrBehindAPendingMessageIsQueued() {
        assertEquals(MessageDeliveryMeta(true, true), delivery(thinking = true))
        assertEquals(MessageDeliveryMeta(true, true), delivery(pending = true))
    }

    @Test
    fun aBlockedPermissionRequestIsBusyButAnOpenQuestionIsNot() {
        assertEquals(true, delivery(agentState = """{"requests":{"permission":{"tool":"Bash","arguments":{}}}}""").queuedWhileBusy)
        val question = """{"requests":{},"communications":{"question":{"kind":"form","form":{"questions":[
            {"id":"choice","header":"Choice","question":"Pick one","options":[{"label":"One"}]}]}}}}"""
        assertEquals(false, delivery(thinking = true, agentState = question).queuedWhileBusy)
    }

    @Test
    fun theFirstMessageIsNeverQueuedDuringStartup() {
        for (thinking in listOf(false, true)) {
            assertEquals(MessageDeliveryMeta(true, false), delivery(thinking = thinking, isNewSession = true))
        }
    }

    @Test
    fun aSessionThatCannotAcknowledgeIsNotMarked() {
        assertEquals(MessageDeliveryMeta(), delivery(metadata = rig, thinking = true))
        assertEquals(MessageDeliveryMeta(), delivery(metadata = metadata("claude"), thinking = true))
    }

    // resolveMessageModeMeta

    @Test
    fun codexAndAgyAlwaysSendTheDisplayedDefaults() {
        assertEquals(meta("auto", "gpt-6.1-sol", "medium"), mode(metadata("codex")))
        assertEquals(meta("default", "Gemini 3.8 Flash", "medium"), mode(metadata("agy")))
    }

    @Test
    fun theCodexCodeDefaultFollowsTheCliVersion() {
        assertEquals("default", mode(metadata("codex", "1.2.0")).permissionMode)
        assertEquals("auto", mode(metadata("codex", "1.2.1-beta.2")).permissionMode)
        assertEquals("yolo", mode(metadata("codex", "1.2.0"), overrides = overrides("""{"codex":{"permissionMode":"yolo"}}""")).permissionMode)
    }

    @Test
    fun aRetiredDontAskIsSentAsAcceptEdits() {
        assertEquals("acceptEdits", mode(metadata("claude"), permissionMode = "dontAsk").permissionMode)
        assertEquals("acceptEdits", mode(metadata("claude"), overrides = overrides("""{"claude":{"permissionMode":"dontAsk"}}""")).permissionMode)
    }

    @Test
    fun autoOnACliTooOldForItIsRefusedNotSubstituted() {
        assertThrows(UnsupportedPermissionModeException::class.java) {
            mode(metadata("claude", "1.2.1-beta.1"), permissionMode = "auto")
        }
        assertThrows(UnsupportedPermissionModeException::class.java) {
            mode(metadata("codex", "1.2.0"), overrides = overrides("""{"codex":{"permissionMode":"auto"}}"""))
        }
        assertThrows(UnsupportedPermissionModeException::class.java) {
            mode(metadata("claude", "1.2.0"), overrides = overrides("""{"claude":{"permissionMode":"auto"}}"""))
        }
        val refusal = assertThrows(UnsupportedPermissionModeException::class.java) {
            mode(metadata("claude", "1.2.0"), permissionMode = "auto")
        }
        assertTrue(refusal.message!!.contains("'auto'"))
        assertTrue(refusal.message!!.contains("1.2.0"))
    }

    @Test
    fun autoGoesOutOnANewCliOrWhenNoVersionIsReported() {
        assertEquals("auto", mode(metadata("claude", "1.2.1-beta.2"), permissionMode = "auto").permissionMode)
        assertEquals("auto", mode(metadata("claude"), permissionMode = "auto").permissionMode)
    }

    @Test
    fun sessionPicksBeatSettingsWhichBeatNothing() {
        assertEquals(meta("read-only", "gpt-5.6-terra", "high"), mode(metadata("codex"), "read-only", "gpt-5.6-terra", "high"))
        assertEquals(
            meta("bypassPermissions", "opus", "medium"),
            mode(metadata("claude"), overrides = overrides("""{"claude":{"permissionMode":"bypassPermissions","modelMode":"opus","effortLevel":"medium"}}""")),
        )
        assertEquals(
            meta("default", "gpt-5.6-terra", "xhigh"),
            mode(metadata("codex"), "default", "gpt-5.6-terra", "xhigh",
                overrides("""{"codex":{"permissionMode":"yolo","modelMode":"gpt-5.6-luna","effortLevel":"medium"}}""")),
        )
        assertEquals(
            meta("read-only", "gpt-5.6-terra", "high"),
            mode(metadata("codex"), permissionMode = "read-only",
                overrides = overrides("""{"codex":{"permissionMode":"auto","modelMode":"gpt-5.6-terra","effortLevel":"high"}}""")),
        )
    }

    @Test
    fun aCustomCodexModelPassesThrough() {
        assertEquals(meta("auto", "my-workspace-model", "medium"), mode(metadata("codex"), modelMode = "my-workspace-model"))
        assertEquals(meta("auto", "my-workspace-model", "medium"), mode(metadata("codex"), overrides = overrides("""{"codex":{"modelMode":"my-workspace-model"}}""")))
    }

    @Test
    fun claudeModelPicks() {
        // An explicit default is a reset: model null on the wire.
        assertEquals(MessageModeMeta(model = Present(null)), mode(metadata("claude"), modelMode = "default"))
        // The code default seeds new sessions only; a running session is never re-modeled.
        assertEquals(MessageModeMeta(), mode(metadata("claude"), overrides = overrides("{}")))
        assertEquals(meta(model = "claude-sonnet-5-5[1m]"), mode(metadata("claude"), modelMode = "claude-sonnet-5-5[1m]"))
        assertEquals(meta(model = "claude-opus-5"), mode(metadata("claude"), overrides = overrides("""{"claude":{"modelMode":"claude-opus-5[1m]"}}""")))
    }

    @Test
    fun happyAgentSendsItsModeCodeAndQualifiedModel() {
        assertEquals(
            MessageModeMeta(
                permissionMode = "auto", model = Present("shared-model"), modelProviderId = "claude", effort = Present("max"),
            ),
            mode(rig, "auto", "claude:shared-model", "max"),
        )
        // An effort the new model does not offer falls back to the session's.
        assertEquals(Present("high"), mode(rig, modelMode = "claude:shared-model", effortLevel = "medium").effort)
    }
}
