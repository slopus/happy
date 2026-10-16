package com.slopus.happy.sync

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.SessionMetadata
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList

/** A v1 Happy Agent session's metadata: the capability part of happy-app's `rigMetadataFixture`. */
fun rigMetadataJson(
    rpcMethods: List<String> = listOf("abort", "bash", "readFile", "writeFile", "ripgrep"),
    abort: Boolean = true,
    filesWrite: Boolean = true,
    machineId: String = "m1",
    bot: Boolean = false,
): JsonObject = buildJsonObject {
    put("rigMetadataVersion", 1)
    putJsonObject("client") { put("id", "rig"); put("name", "Rig"); put("version", "0.0.30") }
    putJsonObject("capabilities") {
        put("abort", abort)
        putJsonObject("attachments") {
            put("enabled", true)
            put("maxBytes", 10 * 1024 * 1024)
            putJsonArray("mediaTypes") { add(JsonPrimitive("image/*")) }
        }
        putJsonObject("files") { put("browse", true); put("read", true); put("search", true); put("write", filesWrite) }
        put("modelSelection", true)
        put("reasoningSelection", true)
        put("permissionModeSelection", true)
        put("resume", false)
        put("rpcMethods", JsonArray(rpcMethods.map(::JsonPrimitive)))
        put("shell", true)
        put("steering", true)
    }
    if (bot) {
        putJsonObject("bot") {
            put("id", "bot-1"); put("name", "Release Captain"); put("username", "captain")
            put("workspaceId", "w1"); put("orderKey", "a0")
        }
    }
    put("path", "/tmp/rig-project")
    put("host", "rig-host")
    put("machineId", machineId)
}

/**
 * ops.ts session operations, against the fake server's socket and HTTP
 * routes: ports of ops.rig.test.ts, plus the payload each RPC carries.
 */
@RunWith(AndroidJUnit4::class)
class SessionOpsTest {
    private lateinit var h: AccountHarness
    private val server get() = h.server
    private val ops get() = h.account.sessionOps

    @Before
    fun setUp() {
        h = AccountHarness()
        server.addSession("cli", updatedAt = 100, metadata = buildJsonObject { put("path", "/repo"); put("host", "mac") })
        server.addSession("rig", updatedAt = 100, metadata = rigMetadataJson())
        server.addMachine("m1")
    }

    @After
    fun tearDown() = h.close()

    /** Answers `<sessionId>:<method>` with [answer], keeping what each call sent. */
    private fun respond(sessionId: String, method: String, answer: JsonElement? = JsonPrimitive(true)): List<JsonElement> {
        val calls = CopyOnWriteArrayList<JsonElement>()
        server.rpc["$sessionId:$method"] = { params ->
            calls += server.openRpc(sessionId, params)
            if (answer == null) kotlinx.serialization.json.JsonNull else server.sealRpc(sessionId, answer)
        }
        return calls
    }

    private fun rpcCalls() = server.socketEvents.count { it.first == "rpc-call" }

    @Test
    fun theFixtureParsesAsHappyAgentMetadata() {
        assertNotNull(SessionMetadata.parse(rigMetadataJson()))
        assertNotNull(SessionMetadata.parse(rigMetadataJson(bot = true))?.bot)
    }

    @Test
    fun abortOnAHappyCliSessionTellsTheAgentWhy() = runBlocking {
        h.startAndSync()
        val calls = respond("cli", "abort")
        ops.abort("cli")
        assertEquals(buildJsonObject { put("reason", SessionOps.ABORT_REASON) }, calls.single())
    }

    /** ops.rig.test.ts: calls the encrypted session-scoped abort RPC with an empty payload. */
    @Test
    fun abortOnHappyAgentSendsAnEmptyPayload() = runBlocking {
        h.startAndSync()
        val calls = respond("rig", "abort", buildJsonObject { put("aborted", true) })
        ops.abort("rig")
        assertEquals(JsonObject(emptyMap()), calls.single())
    }

    @Test
    fun abortThatHappyAgentDoesNotAdvertiseIsRefusedBeforeSending() = runBlocking {
        server.addSession("rig", updatedAt = 100, metadata = rigMetadataJson(abort = false))
        h.startAndSync()
        try {
            ops.abort("rig")
            fail("abort should be refused")
        } catch (e: RpcException) {
            assertEquals("Abort is not available for this session", e.message)
        }
        assertEquals(0, rpcCalls())
    }

    @Test
    fun allowCarriesModeToolsDecisionAndEditedInput() = runBlocking {
        h.startAndSync()
        val calls = respond("cli", "permission")
        ops.allow(
            "cli", "req-1", mode = "acceptEdits", allowedTools = listOf("Edit", "Bash(git:*)"),
            decision = PermissionDecision.APPROVED_FOR_SESSION, updatedInput = buildJsonObject { put("answer", "yes") },
        )
        ops.deny("cli", "req-2", decision = PermissionDecision.ABORT)
        assertEquals(buildJsonObject {
            put("id", "req-1")
            put("approved", true)
            put("mode", "acceptEdits")
            putJsonArray("allowTools") { add(JsonPrimitive("Edit")); add(JsonPrimitive("Bash(git:*)")) }
            put("decision", "approved_for_session")
            putJsonObject("updatedInput") { put("answer", "yes") }
        }, calls[0])
        // Fields left out stay out of the JSON, as undefined does.
        assertEquals(buildJsonObject {
            put("id", "req-2")
            put("approved", false)
            put("decision", "abort")
        }, calls[1])
    }

    @Test
    fun aQuestionIsAnsweredOrDismissedOnTheCommunicationChannel() = runBlocking {
        h.startAndSync()
        val calls = respond("cli", "communication")
        val answers = buildJsonObject { putJsonObject("q1") { put("value", "blue") } }
        ops.answerQuestion("cli", "c1", answers)
        ops.cancelCommunication("cli", "c2", kind = "survey")
        assertEquals(buildJsonObject {
            put("id", "c1"); put("kind", "form"); put("status", "answered"); put("answers", answers)
        }, calls[0])
        assertEquals(buildJsonObject { put("id", "c2"); put("kind", "survey"); put("status", "cancelled") }, calls[1])
    }

    @Test
    fun anRpcTheSessionDoesNotHandleFailsWithTheServersReason() = runBlocking {
        h.startAndSync()
        try {
            ops.allow("cli", "req-1")
            fail("an unhandled RPC should fail")
        } catch (e: RpcException) {
            assertEquals("RPC method not available", e.message)
        }
    }

    @Test
    fun killReportsWhatTheSessionAnswered() = runBlocking {
        h.startAndSync()
        assertEquals(OpResult(false, "RPC method not available"), ops.kill("cli"))
        respond("cli", "killSession", buildJsonObject { put("success", true); put("message", "Killing happy-cli process") })
        assertEquals(OpResult(true, "Killing happy-cli process"), ops.kill("cli"))
    }

    /** ops.rig.test.ts: does not server-archive or delete a bot conversation. */
    @Test
    fun aBotIsNeverArchivedOrDeletedFromHere() = runBlocking {
        server.addSession("bot", updatedAt = 100, metadata = rigMetadataJson(bot = true))
        h.startAndSync()
        val archive = ops.archive("bot")
        val delete = ops.delete("bot")
        assertFalse(archive.success)
        assertTrue(archive.message!!.contains("machine"))
        assertFalse(delete.success)
        assertTrue(delete.message!!.contains("continuous"))
        assertEquals(0, rpcCalls())
        assertNotNull(server.session("bot"))
    }

    @Test
    fun archiveDeactivatesTheSessionOnTheServer() = runBlocking {
        h.startAndSync()
        assertEquals(OpResult(true), ops.archive("cli"))
        assertFalse(server.session("cli")!!.active)
        assertEquals(OpResult(false, "Server error: 404"), ops.archive("missing"))
    }

    @Test
    fun deleteRemovesTheSessionAndPassesOnTheServersRefusal() = runBlocking {
        h.startAndSync()
        assertEquals(OpResult(true), ops.delete("cli"))
        assertEquals(null, server.session("cli"))
        assertEquals(OpResult(false, """{"error":"Session not found"}"""), ops.delete("cli"))
    }

    /** ops.rig.test.ts: does not call RPC methods that disappear after metadata refresh. */
    @Test
    fun aFileWriteHappyAgentStoppedAdvertisingIsNeverSent() = runBlocking {
        server.addSession("rig", updatedAt = 100, metadata = rigMetadataJson(
            rpcMethods = listOf("abort", "bash", "readFile", "ripgrep"),
            filesWrite = false,
        ))
        h.startAndSync()
        assertEquals(
            WriteFileResult(false, error = "File writing is not available for this session"),
            ops.writeFile("rig", "/tmp/a", "YQ==", null),
        )
        assertEquals(0, rpcCalls())
    }

    /** ops.rig.test.ts: never invokes unadvertised directory RPC helpers for Rig. */
    @Test
    fun unadvertisedDirectoryHelpersAreNeverSentToHappyAgent() = runBlocking {
        h.startAndSync()
        assertFalse(ops.listDirectory("rig", ".").success)
        assertFalse(ops.directoryTree("rig", ".", 2).success)
        assertEquals(0, rpcCalls())
    }

    @Test
    fun fileAndShellAnswersAreReadIntoTypedResults() = runBlocking {
        h.startAndSync()
        val reads = respond("cli", "readFile", buildJsonObject { put("success", true); put("content", "aGk=") })
        respond("cli", "listDirectory", buildJsonObject {
            put("success", true)
            putJsonArray("entries") {
                add(buildJsonObject { put("name", "src"); put("type", "directory") })
                add(buildJsonObject { put("name", "a.txt"); put("type", "file"); put("size", 3); put("modified", 1_700_000_000_000.5) })
            }
        })
        val bash = respond("cli", "bash", buildJsonObject {
            put("success", true); put("stdout", "ok\n"); put("stderr", ""); put("exitCode", 0)
        })
        assertEquals(ReadFileResult(true, content = "aGk="), ops.readFile("cli", "/repo/a"))
        assertEquals(buildJsonObject { put("path", "/repo/a") }, reads.single())
        assertEquals(
            listOf(DirectoryEntry("src", "directory"), DirectoryEntry("a.txt", "file", 3.0, 1_700_000_000_000.5)),
            ops.listDirectory("cli", "/repo").entries,
        )
        assertEquals(BashResult(true, "ok\n", "", 0), ops.bash("cli", "ls", cwd = "/repo"))
        assertEquals(buildJsonObject { put("command", "ls"); put("cwd", "/repo") }, bash.single())
    }

    @Test
    fun aPickReachesTheServerThroughUpdateMetadata() = runBlocking {
        h.startAndSync()
        h.account.composer.setAgentModes("cli", mapOf(AgentModeField.MODEL_MODE to "opus"))
        eventually(message = "metadata written") { server.session("cli")!!.metadataVersion == 2L }
        val written = server.encryption.dataKeyCipher(server.dataKey("cli")).decryptFromBase64(server.session("cli")!!.metadata)
        assertEquals(buildJsonObject { put("path", "/repo"); put("host", "mac"); put("modelMode", "opus") }, written)
        eventually(message = "stored") { h.store.session("cli")!!.metadataVersion == 2L }
        assertEquals("opus", h.account.composer.mirrors.value["cli"]?.modelMode)
    }

    @Test
    fun anUnreadableAnswerIsAFailureNotACrash() = runBlocking {
        h.startAndSync()
        respond("cli", "readFile", JsonPrimitive("nonsense"))
        assertEquals(ReadFileResult(false, error = SpawnSessionResult.UNREADABLE), ops.readFile("cli", "/repo/a"))
        respond("cli", "ripgrep", null)
        assertFalse(ops.ripgrep("cli", listOf("-n", "x")).success)
    }
}
