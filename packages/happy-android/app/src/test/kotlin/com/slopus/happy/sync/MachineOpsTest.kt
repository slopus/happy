package com.slopus.happy.sync

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.data.SessionRecord
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList

/**
 * ops.ts machine operations against the fake server: ports of
 * ops.resume.test.ts, ops.rigSpawn.test.ts and ops.codexFork.test.ts.
 */
@RunWith(AndroidJUnit4::class)
class MachineOpsTest {
    private lateinit var h: AccountHarness
    private val server get() = h.server
    private val ops get() = h.account.machineOps

    private val sessionMetadata = buildJsonObject {
        put("path", "/project")
        put("host", "mac")
        put("machineId", "m1")
        put("claudeSessionId", "claude-1")
    }

    @Before
    fun setUp() {
        h = AccountHarness()
        server.addMachine("m1")
        server.addSession("s1", updatedAt = 100, metadata = sessionMetadata, seq = 12)
    }

    @After
    fun tearDown() = h.close()

    /** Answers `m1:<method>` with whatever [answer] returns for the call's params, keeping each. */
    private fun respond(method: String, answer: (JsonElement) -> JsonElement?): List<JsonElement> {
        val calls = CopyOnWriteArrayList<JsonElement>()
        server.rpc["m1:$method"] = { params ->
            val opened = server.openRpc("m1", params)
            calls += opened
            answer(opened)?.let { server.sealRpc("m1", it) } ?: JsonNull
        }
        return calls
    }

    private fun rpcCalls() = server.socketEvents.count { it.first == "rpc-call" }

    private fun success(sessionId: String) = buildJsonObject { put("type", "success"); put("sessionId", sessionId) }

    // ops.resume.test.ts

    @Test
    fun resumeSendsOnlyTheRequestedSessionsKeyAndMetadataToItsOwnMachine() = runBlocking {
        h.startAndSync()
        val calls = respond("resume-happy-session") { success("s1") }
        assertEquals(SpawnSessionResult.Success("s1"), ops.resumeSession("m1", "s1"))
        assertEquals(buildJsonObject {
            put("sessionId", "s1")
            putJsonObject("fallback") {
                put("metadata", sessionMetadata)
                put("metadataVersion", 1)
                put("agentStateVersion", 0)
                put("seq", 12)
                put("encryptionKey", encodeBase64(server.dataKey("s1")))
                put("encryptionVariant", "dataKey")
            }
            put("fallbackReason", "ok")
        }, calls.single())
    }

    @Test
    fun resumeWithholdsTheKeyWhenTheSessionBelongsToAnotherMachine() = runBlocking {
        server.addSession("s2", updatedAt = 100, metadata = buildJsonObject {
            put("path", "/p"); put("host", "mac"); put("machineId", "another")
        })
        server.addSession("s3", updatedAt = 100, metadata = buildJsonObject { put("path", "/p"); put("host", "mac") })
        h.startAndSync()
        val calls = respond("resume-happy-session") { success("x") }
        ops.resumeSession("m1", "s2")
        ops.resumeSession("m1", "s3")
        for (call in calls) {
            assertNull(call.jsonObject["fallback"])
            assertEquals(JsonPrimitive("client-session-machine-mismatch"), call.jsonObject["fallbackReason"])
        }
        assertEquals(2, calls.size)
    }

    @Test
    fun aSessionWhoseKeyDoesNotUnwrapStaysOnTheTrackedPath() {
        h.store.upsertSessions(listOf(SessionRecord(
            id = "legacy", seq = 0, createdAt = 1, updatedAt = 1, active = true, activeAt = 1,
            metadataJson = sessionMetadata.toString(), metadataVersion = 1, agentStateJson = null, agentStateVersion = 0,
            wrappedDataKey = encodeBase64(ByteArray(80)), projectId = null,
        )))
        assertEquals(null to "client-has-no-data-key", ops.resumeFallback("legacy", "m1"))
    }

    @Test
    fun theDaemonsResumeRefusalComesBackAsAnError() = runBlocking {
        h.startAndSync()
        respond("resume-happy-session") { buildJsonObject { put("error", "Legacy sessions can only be resumed while tracked.") } }
        assertEquals(
            SpawnSessionResult.Error("Legacy sessions can only be resumed while tracked."),
            ops.resumeSession("m1", "s1"),
        )
    }

    @Test
    fun resumeDoesNotSubstituteAnotherSessionWhenTheRowIsMissing() = runBlocking {
        h.startAndSync()
        val calls = respond("resume-happy-session") { success("missing") }
        ops.resumeSession("m1", "missing", model = "opus", permissionMode = "plan")
        assertEquals(buildJsonObject {
            put("sessionId", "missing")
            put("model", "opus")
            put("permissionMode", "plan")
            put("fallbackReason", "client-has-no-session-row")
        }, calls.single())
    }

    // ops.rigSpawn.test.ts

    @Test
    fun happyAgentSpawnSendsOnlyItsOwnIdempotentPayload() = runBlocking {
        h.startAndSync()
        val calls = respond("spawn-happy-session") {
            buildJsonObject { put("type", "pending"); put("clientRequestId", "request-1"); put("retryAfterMs", 2_000) }
        }
        val result = ops.spawnSession(SpawnSessionOptions(
            machineId = "m1",
            directory = "/work/project",
            approvedNewDirectoryCreation = false,
            agent = "rig",
            clientRequestId = "request-1",
            providerId = "codex",
            modelId = "gpt-5.6-sol",
            permissionMode = "auto",
            effort = "high",
            // These happy-cli fields must not leak into Happy Agent's contract.
            token = "unused",
            modelMode = "unused",
            effortLevel = "unused",
            resumeClaudeSessionId = "unused",
        ))
        assertEquals(SpawnSessionResult.Pending("request-1", 2_000), result)
        assertEquals(buildJsonObject {
            put("type", "spawn-in-directory")
            put("agent", "rig")
            put("directory", "/work/project")
            put("approvedNewDirectoryCreation", false)
            put("clientRequestId", "request-1")
            put("permissionMode", "auto")
            put("providerId", "codex")
            put("modelId", "gpt-5.6-sol")
            put("effort", "high")
        }, calls.single())
    }

    @Test
    fun happyAgentCreatesAndSpawnsInsideOneNativeWorkspace() = runBlocking {
        h.startAndSync()
        val calls = respond("spawn-happy-session") { success("remote-1") }
        ops.spawnSession(SpawnSessionOptions(
            machineId = "m1", directory = "/work/project", agent = "rig", clientRequestId = "request-2",
            providerId = "codex", modelId = "gpt-5.6-sol", permissionMode = "auto", effort = "high",
            happyAgentTarget = HappyAgentSpawnTarget.NewWorkspace("project-1"),
        ))
        ops.spawnSession(SpawnSessionOptions(
            machineId = "m1", directory = "/work/project", agent = "rig", clientRequestId = "request-3",
            effortLevel = "low", happyAgentTarget = HappyAgentSpawnTarget.Bot("Release Captain"),
        ))
        assertEquals(buildJsonObject {
            put("type", "happy-agent-spawn")
            put("clientRequestId", "request-2")
            putJsonObject("target") { put("kind", "newWorkspace"); put("projectId", "project-1") }
            putJsonObject("agentConfiguration") {
                put("type", "happy-agent")
                put("permissionMode", "auto")
                put("providerId", "codex")
                put("modelId", "gpt-5.6-sol")
                put("effort", "high")
            }
        }, calls[0])
        // effort falls back to effortLevel; a bot target is named, never invented.
        assertEquals(buildJsonObject {
            put("type", "happy-agent-spawn")
            put("clientRequestId", "request-3")
            putJsonObject("target") { put("kind", "bot"); put("name", "Release Captain") }
            putJsonObject("agentConfiguration") { put("type", "happy-agent"); put("effort", "low") }
        }, calls[1])
    }

    @Test
    fun aHappyAgentSpawnWithoutARequestIdIsRefusedBeforeCallingTheMachine() = runBlocking {
        h.startAndSync()
        assertEquals(
            SpawnSessionResult.Error("Rig session creation requires a client request ID"),
            ops.spawnSession(SpawnSessionOptions(machineId = "m1", directory = "/work/project", agent = "rig")),
        )
        assertEquals(
            SpawnSessionResult.Error("Happy Agent catalog targets require the Happy Agent harness"),
            ops.spawnSession(SpawnSessionOptions(
                machineId = "m1", directory = "/w", agent = "claude", happyAgentTarget = HappyAgentSpawnTarget.Project("p"),
            )),
        )
        assertEquals(0, rpcCalls())
    }

    @Test
    fun aRefusalIsReadFromMessageAsWellAsErrorMessage() = runBlocking {
        h.startAndSync()
        val answers = ArrayDeque(listOf(
            buildJsonObject { put("type", "error"); put("message", "That bot was archived.") },
            buildJsonObject { put("type", "error"); put("errorMessage", "That model is not available.") },
            buildJsonObject { put("type", "error") },
            JsonPrimitive("garbage"),
        ))
        respond("spawn-happy-session") { answers.removeFirst() }
        val request = SpawnSessionOptions(
            machineId = "m1", directory = "/work/project", agent = "rig", clientRequestId = "request-1",
            happyAgentTarget = HappyAgentSpawnTarget.Bot("Release Captain"),
        )
        assertEquals(SpawnSessionResult.Error("That bot was archived."), ops.spawnSession(request))
        assertEquals(SpawnSessionResult.Error("That model is not available."), ops.spawnSession(request))
        assertEquals(SpawnSessionResult.Error("Failed to spawn session"), ops.spawnSession(request))
        assertEquals(SpawnSessionResult.Error(SpawnSessionResult.UNREADABLE), ops.spawnSession(request))
    }

    @Test
    fun anUnreachableMachineIsAnErrorResult() = runBlocking {
        h.startAndSync()
        assertEquals(
            SpawnSessionResult.Error("RPC method not available"),
            ops.spawnSession(SpawnSessionOptions(machineId = "m1", directory = "/w", agent = "claude")),
        )
        assertEquals(
            SpawnSessionResult.Error("Machine encryption not found for nope"),
            ops.spawnSession(SpawnSessionOptions(machineId = "nope", directory = "/w")),
        )
    }

    // ops.codexFork.test.ts

    @Test
    fun newSessionModeDefaultsPassThroughTheSpawn() = runBlocking {
        h.startAndSync()
        val calls = respond("spawn-happy-session") { success("happy-new") }
        val result = ops.spawnSession(SpawnSessionOptions(
            machineId = "m1", directory = "/tmp/project", agent = "claude",
            permissionMode = "bypassPermissions", modelMode = "opus", effortLevel = "xhigh",
        ))
        assertEquals(SpawnSessionResult.Success("happy-new"), result)
        assertEquals(buildJsonObject {
            put("type", "spawn-in-directory")
            put("directory", "/tmp/project")
            put("approvedNewDirectoryCreation", false)
            put("agent", "claude")
            put("permissionMode", "bypassPermissions")
            put("modelMode", "opus")
            put("effortLevel", "xhigh")
        }, calls.single())
    }

    @Test
    fun aCodexForkSpawnsASessionResumedIntoTheNewThreadAndRefreshes() = runBlocking {
        h.startAndSync()
        val forks = respond("codex-fork-thread") { buildJsonObject { put("type", "success"); put("newCodexThreadId", "thread-forked") } }
        val spawns = respond("spawn-happy-session") {
            server.addSession("happy-forked", updatedAt = 200)
            success("happy-forked")
        }
        val result = ops.forkAndSpawn(ForkSource.Codex("happy-source", "m1", "/tmp/project", "thread-source"))
        assertEquals(SpawnSessionResult.Success("happy-forked"), result)
        assertEquals(buildJsonObject { put("directory", "/tmp/project"); put("codexThreadId", "thread-source") }, forks.single())
        val spawn = spawns.single().jsonObject
        assertEquals(JsonPrimitive("codex"), spawn["agent"])
        assertEquals(JsonPrimitive("thread-forked"), spawn["resumeCodexThreadId"])
        assertEquals(JsonPrimitive("happy-source"), spawn["parentSessionId"])
        assertNull(spawn["resumeClaudeSessionId"])
        // Refreshed before returning, so the caller can open it straight away.
        assertNotNull(h.store.session("happy-forked"))
    }

    @Test
    fun aCodexDuplicateCutsAtTheChosenItemBeforeSpawning() = runBlocking {
        h.startAndSync()
        val cuts = respond("codex-duplicate-thread") { buildJsonObject { put("type", "success"); put("newCodexThreadId", "thread-cut") } }
        val spawns = respond("spawn-happy-session") { success("happy-cut") }
        val result = ops.forkAndSpawn(
            ForkSource.Codex("happy-source", "m1", "/tmp/project", "thread-source"),
            ForkOptions(cutAfterItemId = "user-item-2", forkedFromMessageId = "message-2"),
        )
        assertEquals(SpawnSessionResult.Success("happy-cut"), result)
        assertEquals(buildJsonObject {
            put("directory", "/tmp/project"); put("codexThreadId", "thread-source"); put("cutAfterItemId", "user-item-2")
        }, cuts.single())
        assertEquals(JsonPrimitive("thread-cut"), spawns.single().jsonObject["resumeCodexThreadId"])
        assertEquals(JsonPrimitive("message-2"), spawns.single().jsonObject["forkedFromMessageId"])
    }

    @Test
    fun aClaudeSideChatForksThenSpawnsAHiddenChild() = runBlocking {
        h.startAndSync()
        respond("claude-fork-session") { buildJsonObject { put("type", "success"); put("newClaudeSessionId", "claude-2") } }
        val spawns = respond("spawn-happy-session") { success("side") }
        assertEquals(
            SpawnSessionResult.Success("side"),
            ops.spawnSideChat(ForkSource.Claude("s1", "m1", "/project", "claude-1")),
        )
        val spawn = spawns.single().jsonObject
        assertEquals(JsonPrimitive("claude"), spawn["agent"])
        assertEquals(JsonPrimitive("claude-2"), spawn["resumeClaudeSessionId"])
        assertEquals(JsonPrimitive(true), spawn["isSideChat"])
    }

    @Test
    fun aFailedForkNeverSpawns() = runBlocking {
        h.startAndSync()
        respond("claude-duplicate-session") { buildJsonObject { put("type", "error"); put("errorMessage", "uuid not found") } }
        val spawns = respond("spawn-happy-session") { success("never") }
        assertEquals(
            SpawnSessionResult.Error("uuid not found"),
            ops.forkAndSpawn(ForkSource.Claude("s1", "m1", "/project", "claude-1"), ForkOptions(cutAfterUuid = "u1")),
        )
        assertTrue(spawns.isEmpty())
    }

    @Test
    fun rewindPointsAreReadFromTheTranscript() = runBlocking {
        h.startAndSync()
        respond("claude-list-rewind-points") {
            buildJsonObject {
                put("type", "success")
                putJsonArray("points") { add(buildJsonObject { put("uuid", "u1"); put("text", "hi"); put("timestamp", 5) }) }
            }
        }
        assertEquals(
            RewindPointsResult.Success(listOf(RewindPoint("u1", "hi", 5.0))),
            ops.claudeRewindPoints("m1", "/project", "claude-1"),
        )
        assertEquals(
            RewindPointsResult.Error("RPC method not available"),
            ops.codexRewindPoints("m1", "/project", "thread-1"),
        )
    }

    // The rest of ops.ts's machine calls.

    @Test
    fun stopSessionAndStopDaemonAskTheDaemon() = runBlocking {
        h.startAndSync()
        val stops = respond("stop-session") { buildJsonObject { put("message", "Stopped") } }
        respond("stop-daemon") { buildJsonObject { put("message", "Daemon stopping") } }
        assertEquals(OpResult(true, "Stopped"), ops.stopSession("m1", "s1"))
        assertEquals(buildJsonObject { put("sessionId", "s1") }, stops.single())
        assertEquals("Daemon stopping", ops.stopDaemon("m1"))
        server.rpc.remove("m1:stop-session")
        assertEquals(OpResult(false, "RPC method not available"), ops.stopSession("m1", "s1"))
    }

    @Test
    fun machineBashFailsSoftly() = runBlocking {
        h.startAndSync()
        assertEquals(BashResult(false, "", "RPC method not available", -1), ops.bash("m1", "ls", "/"))
    }

    @Test
    fun deleteRemovesTheMachineRow() = runBlocking {
        h.startAndSync()
        assertEquals(OpResult(true), ops.delete("m1"))
        assertNull(server.machine("m1"))
        assertEquals(OpResult(false, """{"error":"Machine not found"}"""), ops.delete("m1"))
    }

    @Test
    fun aRenameOnAStaleVersionKeepsTheServersMetadataAndRetries() = runBlocking {
        h.startAndSync()
        val renamed = buildJsonObject { put("host", "old"); put("displayName", "Studio") }
        assertEquals(2L, ops.updateMetadata("m1", renamed, expectedVersion = 0))
        val expected = buildJsonObject { put("host", "m1"); put("displayName", "Studio") }
        assertEquals(expected, server.encryption.dataKeyCipher(server.dataKey("m1")).decryptFromBase64(server.machine("m1")!!.metadata))
        val stored = h.store.machine("m1")!!
        assertEquals(2L, stored.metadataVersion)
        assertEquals(expected.toString(), stored.metadataJson)
    }

    @Test
    fun aRenameGivesUpAfterItsRetries() = runBlocking {
        h.startAndSync()
        try {
            ops.updateMetadata("m1", JsonObject(mapOf("displayName" to JsonPrimitive("x"))), expectedVersion = 7, maxRetries = 1)
            fail("a conflict on every try should fail")
        } catch (e: RpcException) {
            assertEquals("Failed to update after 1 retries due to version conflicts", e.message)
        }
        assertFalse(server.machine("m1")!!.metadataVersion > 1)
    }
}
