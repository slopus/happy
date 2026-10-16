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
import kotlinx.serialization.json.putJsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList

/** happyAgentGit.ts against the fake server's session RPCs: a port of happyAgentGit.test.ts. */
@RunWith(AndroidJUnit4::class)
class HappyAgentGitTest {
    private lateinit var h: AccountHarness
    private val server get() = h.server
    private val git get() = h.account.git

    private val base = "a".repeat(40)
    private val hash = "b".repeat(64)
    private val gitMethods = listOf("abort", "bash", "readFile", "writeFile", "ripgrep", "gitState", "readFileAtRevision")
    private val native = rigMetadataJson(rpcMethods = gitMethods)

    /** Every RPC the agent received, as `method params`. */
    private val calls = CopyOnWriteArrayList<Pair<String, JsonElement>>()

    @Before
    fun setUp() {
        h = AccountHarness()
        server.addSession("g", updatedAt = 100, metadata = native)
    }

    @After
    fun tearDown() = h.close()

    private fun answer(method: String, response: (JsonElement) -> JsonElement) {
        server.rpc["g:$method"] = { params ->
            val opened = server.openRpc("g", params)
            calls += method to opened
            server.sealRpc("g", response(opened))
        }
    }

    private fun b64(text: String) = Base64.getEncoder().encodeToString(text.toByteArray(Charsets.ISO_8859_1))
    private fun b64Utf8(text: String) = Base64.getEncoder().encodeToString(text.toByteArray(Charsets.UTF_8))

    private fun textResponse(content: String) = buildJsonObject { put("success", true); put("content", content); put("hash", hash) }
    private fun revisionResponse(content: String) = buildJsonObject { put("success", true); put("content", content) }

    private fun reads(before: String?, after: String?) {
        answer("readFileAtRevision") { revisionResponse(before ?: error("before side read")) }
        answer("readFile") { textResponse(after ?: error("after side read")) }
    }

    private fun file(
        path: String = "src/file.ts",
        status: String = "modified",
        previousPath: String? = null,
        binary: Boolean = false,
    ) = GitFile(path = path, previousPath = previousPath, status = status, staged = false, unstaged = true, binary = binary)

    private fun gitStateJson(files: JsonArray = JsonArray(emptyList())) = buildJsonObject {
        putJsonObject("facts") {
            put("branch", "feature/mobile-changes"); put("detached", false); put("head", base)
            put("upstream", "origin/feature/mobile-changes"); put("ahead", 1); put("behind", 2)
        }
        put("comparison", "ready")
        put("base", base)
        put("changedFiles", files.size)
        put("insertions", 3)
        put("deletions", 1)
        put("countsExact", true)
        put("conflicted", false)
        put("files", files)
        put("filesTruncated", false)
        put("scannedAt", 123)
    }

    private suspend fun expectError(message: String, call: suspend () -> Unit) {
        try {
            call()
            fail("expected \"$message\"")
        } catch (e: RpcException) {
            assertEquals(message, e.message)
        }
    }

    @Test
    fun gitNeedsNativeV1ReadableFilesAndEveryGitMethod() {
        assertTrue(HappyAgentGit.supportsHappyAgentGit(SessionMetadata.parse(native)))
        assertFalse(HappyAgentGit.supportsHappyAgentGit(SessionMetadata.parse(JsonObject(native + ("rigMetadataVersion" to JsonPrimitive(0))))))
        assertFalse(HappyAgentGit.supportsHappyAgentGit(SessionMetadata.parse(JsonObject(native - "rigMetadataVersion"))))
        assertFalse(HappyAgentGit.supportsHappyAgentGit(SessionMetadata.parse(rigMetadataJson(rpcMethods = listOf("readFile", "gitState")))))
        val unreadable = JsonObject(native + ("capabilities" to JsonObject((native["capabilities"] as JsonObject) + (
            "files" to buildJsonObject { put("browse", true); put("read", false); put("search", true); put("write", true) }
        ))))
        assertFalse(HappyAgentGit.supportsHappyAgentGit(SessionMetadata.parse(unreadable)))
    }

    @Test
    fun unsupportedSessionsNeverReachTheAgent() = runBlocking {
        server.addSession("v0", updatedAt = 100, metadata = JsonObject(native + ("rigMetadataVersion" to JsonPrimitive(0))))
        server.addSession("cli", updatedAt = 100, metadata = buildJsonObject { put("path", "/r"); put("host", "h") })
        h.startAndSync()
        for (id in listOf("v0", "cli", "missing")) {
            expectError("Git changes are not available for this session.") { git.state(id) }
        }
        assertEquals(0, server.socketEvents.count { it.first == "rpc-call" })
    }

    @Test
    fun theStateIsAnEmptySessionScopedRequestAndKeepsCommittedFiles() = runBlocking {
        h.startAndSync()
        val files = JsonArray(listOf(
            buildJsonObject { put("path", "committed.ts"); put("status", "modified"); put("staged", false); put("unstaged", false); put("binary", false) },
            buildJsonObject { put("path", "staged.ts"); put("status", "modified"); put("staged", true); put("unstaged", false); put("binary", false); put("insertions", 2) },
        ))
        answer("gitState") { buildJsonObject { put("success", true); put("git", gitStateJson(files)) } }
        val state = git.state("g")
        assertEquals(listOf("gitState" to JsonObject(emptyMap())), calls.toList())
        assertEquals(GitFacts("feature/mobile-changes", false, base, "origin/feature/mobile-changes", 1, 2), state.facts)
        assertEquals("ready", state.comparison)
        assertEquals(base, state.base)
        assertEquals(123.0, state.scannedAt, 0.0)
        assertEquals(
            listOf(
                GitFile("committed.ts", null, "modified", staged = false, unstaged = false, binary = false),
                GitFile("staged.ts", null, "modified", staged = true, unstaged = false, binary = false, insertions = 2),
            ),
            state.files,
        )
    }

    @Test
    fun aNativeFailureIsTheErrorAndAMalformedStateIsRefused() = runBlocking {
        h.startAndSync()
        answer("gitState") {
            buildJsonObject { put("success", false); put("code", "unavailable"); put("error", "Git is unavailable for this workspace.") }
        }
        expectError("Git is unavailable for this workspace.") { git.state("g") }
        answer("gitState") { buildJsonObject { put("success", true); putJsonObject("git") { put("comparison", "unknown") } } }
        expectError("Happy Agent returned an invalid Git state.") { git.state("g") }
        // A ready comparison must say what it compares against.
        answer("gitState") { buildJsonObject { put("success", true); put("git", JsonObject(gitStateJson() + ("base" to kotlinx.serialization.json.JsonNull))) } }
        expectError("Happy Agent returned an invalid Git state.") { git.state("g") }
    }

    @Test
    fun aModifiedFileReadsTheBaseAndTheWorkingTree() = runBlocking {
        h.startAndSync()
        reads(b64("old text\n"), b64("new text\n"))
        assertEquals(GitFileContent.Text("old text\n", "new text\n"), git.readFile("g", base, file()))
        assertEquals(
            setOf(
                "readFileAtRevision" to buildJsonObject { put("path", "src/file.ts"); put("revision", base) },
                "readFile" to buildJsonObject { put("path", "src/file.ts") },
            ),
            calls.toSet(),
        )
    }

    @Test
    fun renamesReadThePreviousPathAndAddsOrDeletesSkipTheMissingSide() = runBlocking {
        h.startAndSync()
        reads(b64("before\n"), b64("after\n"))
        assertEquals(
            GitFileContent.Text("before\n", "after\n"),
            git.readFile("g", base, file(path = "new/name.ts", previousPath = "old/name.ts", status = "renamed")),
        )
        assertEquals(
            setOf(
                "readFileAtRevision" to buildJsonObject { put("path", "old/name.ts"); put("revision", base) },
                "readFile" to buildJsonObject { put("path", "new/name.ts") },
            ),
            calls.toSet(),
        )

        calls.clear()
        reads(null, b64("added\n"))
        assertEquals(GitFileContent.Text("", "added\n"), git.readFile("g", base, file(status = "added")))
        assertEquals(listOf("readFile"), calls.map { it.first })

        calls.clear()
        reads(b64("deleted\n"), null)
        assertEquals(GitFileContent.Text("deleted\n", ""), git.readFile("g", base, file(status = "deleted")))
        assertEquals(listOf("readFileAtRevision"), calls.map { it.first })
    }

    @Test
    fun emptyAndEqualContentStaysText() = runBlocking {
        h.startAndSync()
        reads("", "")
        assertEquals(GitFileContent.Text("", ""), git.readFile("g", base, file()))
    }

    @Test
    fun aByteOrderMarkIsKeptSoAddingOneIsAVisibleChange() = runBlocking {
        h.startAndSync()
        reads(b64("hello\n"), b64Utf8("\ufeffhello\n"))
        assertEquals(GitFileContent.Text("hello\n", "\ufeffhello\n"), git.readFile("g", base, file()))
        reads(null, b64Utf8("\ufeff"))
        assertEquals(GitFileContent.Text("", "\ufeff"), git.readFile("g", base, file(status = "added")))
    }

    @Test
    fun unsupportedAndNonImageBinaryFilesAreExplainedWithoutReading() = runBlocking {
        h.startAndSync()
        for (status in listOf("conflicted", "submodule", "type_changed")) {
            assertTrue(git.readFile("g", base, file(status = status)) is GitFileContent.Message)
        }
        assertEquals(
            GitFileContent.Message("Binary file changes cannot be previewed."),
            git.readFile("g", base, file(path = "archive.dat", binary = true)),
        )
        assertTrue(calls.isEmpty())
    }

    @Test
    fun aBinaryRenameOfImagesComesBackAsDataUrisOfEachPathsType() = runBlocking {
        h.startAndSync()
        reads(b64("\u0089PNG\r\n"), b64("GIF89a"))
        assertEquals(
            GitFileContent.Image("data:image/png;base64,iVBORw0K", "data:image/jpeg;base64,R0lGODlh"),
            git.readFile("g", base, file(path = "new/photo.jpg", previousPath = "old/photo.png", status = "renamed", binary = true)),
        )
    }

    @Test
    fun missingAndOversizedFilesAreHumanErrors() = runBlocking {
        h.startAndSync()
        answer("readFileAtRevision") {
            buildJsonObject { put("success", false); put("code", "missing"); put("error", "The file does not exist at this revision.") }
        }
        answer("readFile") { textResponse(b64("new\n")) }
        expectError("The file does not exist at this revision.") { git.readFile("g", base, file()) }

        reads(null, b64("x".repeat(512 * 1024 + 1)))
        expectError("This file is too large to preview on the phone.") { git.readFile("g", base, file(status = "added")) }

        val atLimit = "x".repeat(512 * 1024)
        reads(null, b64(atLimit))
        assertEquals(GitFileContent.Text("", atLimit), git.readFile("g", base, file(status = "added")))
    }

    @Test
    fun malformedReadsAreRefusedAndTransportErrorsComeThrough() = runBlocking {
        h.startAndSync()
        answer("readFile") { buildJsonObject { put("success", true); put("content", 7); put("hash", hash) } }
        expectError("Happy Agent returned an invalid file response.") { git.readFile("g", base, file(status = "added")) }
        answer("readFile") { buildJsonObject { put("success", true); put("content", "") } }
        expectError("Happy Agent returned an invalid file response.") { git.readFile("g", base, file(status = "added")) }
        server.rpc.remove("g:readFile")
        expectError("RPC method not available") { git.readFile("g", base, file(status = "added")) }
    }

    @Test
    fun theBaseSidesFailureIsReportedAfterBothSidesSettle() = runBlocking {
        h.startAndSync()
        answer("readFileAtRevision") {
            buildJsonObject { put("success", false); put("code", "invalid"); put("error", "base read failed") }
        }
        answer("readFile") {
            Thread.sleep(200)
            textResponse(b64("after\n"))
        }
        expectError("base read failed") { git.readFile("g", base, file()) }
        assertEquals(setOf("readFileAtRevision", "readFile"), calls.map { it.first }.toSet())
    }

    @Test
    fun binaryLookingTextAndEmptyImagesAreMessages() = runBlocking {
        h.startAndSync()
        reads(null, b64("a\u0000b"))
        assertEquals(
            GitFileContent.Message("This file contains binary data and cannot be shown as text."),
            git.readFile("g", base, file(status = "added")),
        )
        reads(null, "")
        assertEquals(
            GitFileContent.Message("Image content is empty."),
            git.readFile("g", base, file(path = "empty.png", status = "added", binary = true)),
        )
        reads(null, b64("\u00ff\u00fe"))
        assertEquals(GitFileContent.Message("This file is not valid UTF-8 text."), git.readFile("g", base, file(status = "added")))
    }

    @Test
    fun twentyThousandCombinedLinesAreShownAndMoreAreNot() = runBlocking {
        h.startAndSync()
        val tenThousand = "x\n".repeat(10_000)
        reads(b64(tenThousand), b64(tenThousand))
        assertEquals(GitFileContent.Text(tenThousand, tenThousand), git.readFile("g", base, file()))
        reads(null, b64("x\n".repeat(20_001)))
        assertEquals(
            GitFileContent.Message("This file has too many lines to preview here."),
            git.readFile("g", base, file(status = "added")),
        )
    }
}
