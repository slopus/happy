package com.slopus.happy.resume

import com.slopus.happy.chat.ChatActions
import com.slopus.happy.chat.UnavailableChatActions
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.settings.AgentDefaultOverrides
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.sync.ComposerMirror
import com.slopus.happy.sync.SpawnSessionResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * useSessionQuickActions.ts `performResume`: resume with the picks a message
 * would send with, refuse a permission mode the CLI can't parse, then refresh
 * the sessions and pin the permission mode on the resumed session before
 * opening it; a requested directory, an error or a pending spawn alerts, and
 * a second tap while one runs is dropped (useHappyAction).
 */
class SessionResumeTest {
    private val texts = ResumeTexts(unexpectedDirectory = "unexpected directory", unknownError = "unknown")

    private fun metadata(flavor: String = "claude", version: String? = null): SessionMetadata = SessionMetadata.parse(buildJsonObject {
        put("path", "/repo")
        put("host", "mac")
        put("machineId", "m1")
        put("flavor", flavor)
        version?.let { put("version", it) }
    })!!

    private class FakeOps(
        var mirror: ComposerMirror = ComposerMirror(),
        var result: SpawnSessionResult = SpawnSessionResult.Success("s1"),
    ) : ResumeOps {
        val calls = mutableListOf<String>()
        var gate: CompletableDeferred<Unit>? = null
        var refreshFails = false
        var resumeThrows: Exception? = null

        override fun mirror(sessionId: String) = mirror
        override fun overrides(): AgentDefaultOverrides? = null

        override suspend fun resume(machineId: String, sessionId: String, model: String?, permissionMode: String?): SpawnSessionResult {
            calls += "resume:$machineId/$sessionId model=$model permission=$permissionMode"
            gate?.await()
            resumeThrows?.let { throw it }
            return result
        }

        override suspend fun refreshSessions() {
            calls += "refresh"
            if (refreshFails) error("offline")
        }

        override suspend fun setPermissionMode(sessionId: String, mode: String) {
            calls += "pin:$sessionId=$mode"
        }
    }

    private fun resume(ops: ResumeOps?, metadata: SessionMetadata = metadata(), resumer: SessionResumer = SessionResumer()) =
        runBlocking { resumer.resume(ops, "s1", "m1", metadata, texts) }

    @Test
    fun resumesWithThePicksThenRefreshesAndPinsThePermissionMode() {
        val ops = FakeOps(ComposerMirror(permissionMode = "acceptEdits", modelMode = "opus"), SpawnSessionResult.Success("s2"))
        assertEquals(ResumeOutcome.Resumed("s2"), resume(ops))
        assertEquals(listOf("resume:m1/s1 model=opus permission=acceptEdits", "refresh", "pin:s2=acceptEdits"), ops.calls)
    }

    @Test
    fun withoutAPermissionPickNothingIsPinned() {
        val ops = FakeOps()
        assertEquals(ResumeOutcome.Resumed("s1"), resume(ops))
        assertEquals(listOf("resume:m1/s1 model=null permission=null", "refresh"), ops.calls)
    }

    @Test
    fun aModeTheCliCannotParseIsRefusedBeforeAsking() {
        val ops = FakeOps(ComposerMirror(permissionMode = "auto"))
        val outcome = resume(ops, metadata(version = "1.0.0"))
        assertEquals(
            ResumeOutcome.Failed(
                "This session's Happy CLI (v1.0.0) does not support the 'auto' permission mode. " +
                    "Pick a different mode for this session, or update the Happy CLI on that machine.",
            ),
            outcome,
        )
        assertEquals(emptyList<String>(), ops.calls)
    }

    @Test
    fun aFailedRefreshStillOpensTheResumedSession() {
        val ops = FakeOps(ComposerMirror(permissionMode = "plan")).apply { refreshFails = true }
        assertEquals(ResumeOutcome.Resumed("s1"), resume(ops))
        assertEquals(listOf("resume:m1/s1 model=null permission=plan", "refresh", "pin:s1=plan"), ops.calls)
    }

    @Test
    fun failuresSayWhy() {
        assertEquals(ResumeOutcome.Failed("unexpected directory"), resume(FakeOps(result = SpawnSessionResult.RequestToApproveDirectoryCreation("/repo"))))
        assertEquals(ResumeOutcome.Failed("Session not found"), resume(FakeOps(result = SpawnSessionResult.Error("Session not found"))))
        assertEquals(ResumeOutcome.Failed("unknown"), resume(FakeOps(result = SpawnSessionResult.Error(""))))
        assertEquals(ResumeOutcome.Failed("unknown"), resume(FakeOps(result = SpawnSessionResult.Pending("r1", 1_000))))
        assertEquals(ResumeOutcome.Failed("Not signed in"), resume(FakeOps().apply { resumeThrows = IllegalStateException("Not signed in") }))
        assertEquals(ResumeOutcome.Failed("unknown"), resume(null))
    }

    @Test
    fun aSecondResumeWhileOneRunsIsDropped() = runBlocking {
        val resumer = SessionResumer()
        val ops = FakeOps().apply { gate = CompletableDeferred() }
        val first = async { resumer.resume(ops, "s1", "m1", metadata(), texts) }
        while (ops.calls.isEmpty()) yield()
        assertEquals(ResumeOutcome.InFlight, resumer.resume(ops, "s1", "m1", metadata(), texts))
        ops.gate!!.complete(Unit)
        assertEquals(ResumeOutcome.Resumed("s1"), first.await())
        assertEquals(1, ops.calls.count { it.startsWith("resume:") })
        // Once it is over the session can be resumed again.
        assertEquals(ResumeOutcome.Resumed("s1"), resumer.resume(ops, "s1", "m1", metadata(), texts))
    }

    /** The chat resumes through its own seams, with the picks its composer shows. */
    @Test
    fun theChatGoesThroughItsActions() {
        val calls = mutableListOf<String>()
        val actions = object : ChatActions by UnavailableChatActions {
            override suspend fun resume(sessionId: String, machineId: String, model: String?, permissionMode: String?): SpawnSessionResult {
                calls += "resume:$sessionId/$machineId model=$model permission=$permissionMode"
                return SpawnSessionResult.Success("s2")
            }
            override suspend fun refreshSessions() {
                calls += "refresh"
            }
            override suspend fun setModes(sessionId: String, patch: Map<AgentModeField, String?>) {
                calls += "modes:$sessionId=$patch"
            }
        }
        val ops = ChatResumeOps(actions, { ComposerMirror(permissionMode = "plan", modelMode = "sonnet") }, { null })
        assertEquals(ResumeOutcome.Resumed("s2"), resume(ops))
        assertEquals(listOf("resume:s1/m1 model=sonnet permission=plan", "refresh", "modes:s2={PERMISSION_MODE=plan}"), calls)
    }
}
