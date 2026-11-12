package com.slopus.happy.agent

import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ComputersTest {
    /** What `GET /v0/computers` sends a manager: one computer in each mode, one revoked, one in a mode from the future. */
    private val computers = """{"computers":[
        {"id":"n-sandbox","name":null,"hostname":"build-01","status":"online","os":"linux","arch":"x86_64","since":1730000000000,"mode":"sandbox","description":"GPU box, CUDA 12.4","owner":null,"exclusiveAgent":null,"sandboxError":"bwrap: no user namespaces","sandboxCapacity":{"used":1,"total":4},"activeSandboxes":[]},
        {"id":"n-shared","name":"Team box","hostname":"team","status":"offline","os":"linux","arch":"aarch64","since":1730000100000,"mode":"shared","description":null,"owner":null,"exclusiveAgent":null},
        {"id":"n-exclusive","name":"Mac mini","hostname":"mini.local","status":"online","os":"macos","arch":"aarch64","since":1730000200000,"mode":"exclusive","description":"","owner":null,"exclusiveAgent":{"id":"agent-7","title":"Ship the release"}},
        {"id":"n-hidden-holder","name":"Render","hostname":"render","status":"online","os":"linux","arch":"x86_64","mode":"exclusive","owner":null,"exclusiveAgent":{"id":"agent-9","title":null}},
        {"id":"n-mine","name":"Laptop","hostname":"laptop","status":"enrolling","os":"windows","arch":"x86_64","since":1730000300000,"mode":"private","description":"My own","owner":"user-me","exclusiveAgent":null},
        {"id":"n-theirs","name":"Ana's desk","hostname":"desk","status":"draining","os":"linux","arch":"x86_64","mode":"private","owner":"user-ana","exclusiveAgent":null},
        {"id":"n-legacy","hostname":null,"name":null,"status":"online","mode":"private","owner":null},
        {"id":"n-revoked","name":"Old","status":"revoked","mode":"sandbox"},
        {"id":"n-future","name":"Next","status":"online","mode":"teleport"}
    ]}"""
    private val approvals = """{"approvals":[
        {"computerId":"n-mine","computerName":"Laptop","agentId":"agent-1","agentTitle":"Fix the build","createdAt":1730000400000},
        {"computerId":"n-mine","computerName":null,"agentId":"agent/2","agentTitle":null,"createdAt":1730000500000}
    ]}"""

    private class Server(private val answer: suspend (String) -> Pair<Int, String>) : Transport {
        val asked = mutableListOf<Pair<String, String?>>()
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            val key = "$method $path"
            asked += key to body?.decodeToString()
            val (status, json) = answer(key)
            return TransportResponse(status, mapOf("content-type" to "application/json"), json.toByteArray())
        }
        override suspend fun close() {}
    }
    private fun answer(path: String): Pair<Int, String> = when (path) {
        "GET /v0/computers" -> 200 to computers
        "GET /v0/computers/approvals" -> 200 to approvals
        else -> 200 to "{}"
    }
    private fun client(server: Server) = AgentClient(server, "test", cloud = true)
    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    @Test
    fun eachModeCarriesItsHolderOrOwnerAndTheFieldsAgentsRead() = runTest {
        val server = Server(::answer)
        val snapshot = Computers.read(client(server), readerId = "user-me")
        assertEquals(
            listOf(
                Computer("n-sandbox", "build-01", ComputeStatus.Online, "build-01", "linux", "x86_64", ComputeMode.Sandbox, "GPU box, CUDA 12.4", "bwrap: no user namespaces", 1730000000000),
                Computer("n-exclusive", "Mac mini", ComputeStatus.Online, "mini.local", "macos", "aarch64", ComputeMode.Exclusive(ComputeHolder("agent-7", "Ship the release")), null, null, 1730000200000),
                Computer("n-legacy", "n-legacy", ComputeStatus.Online, null, null, null, ComputeMode.Private(null), null, null, null),
                Computer("n-hidden-holder", "Render", ComputeStatus.Online, "render", "linux", "x86_64", ComputeMode.Exclusive(ComputeHolder("agent-9", null)), null, null, null),
                Computer("n-theirs", "Ana's desk", ComputeStatus.Draining, "desk", "linux", "x86_64", ComputeMode.Private(ComputeOwner.Member("user-ana", null)), null, null, null),
                Computer("n-mine", "Laptop", ComputeStatus.Enrolling, "laptop", "windows", "x86_64", ComputeMode.Private(ComputeOwner.Reader), "My own", null, 1730000300000),
                Computer("n-shared", "Team box", ComputeStatus.Offline, "team", "linux", "aarch64", ComputeMode.Shared, null, null, 1730000100000),
            ),
            snapshot.computers,
        )
        assertEquals(listOf("GET /v0/computers", "GET /v0/computers/approvals"), server.asked.map { it.first })
    }

    @Test
    fun joinRequestsDecodeWithTheirKeyAndHiddenTitles() = runTest {
        val snapshot = Computers.read(client(Server(::answer)), readerId = "user-me")
        assertEquals(
            listOf(
                ComputeApproval("n-mine", "Laptop", "agent-1", "Fix the build", 1730000400000),
                ComputeApproval("n-mine", null, "agent/2", null, 1730000500000),
            ),
            snapshot.approvals,
        )
        assertEquals(listOf("n-mine/agent-1", "n-mine/agent/2"), snapshot.approvals.map { it.key })
    }

    @Test
    fun aComputerIsBusyOnlyWhileOnlineAndHeld() = runTest {
        val computers = Computers.read(client(Server(::answer)), readerId = "user-me").computers.associateBy { it.id }
        assertEquals(listOf("n-exclusive", "n-hidden-holder"), computers.values.filter { it.busy }.map { it.id })
        assertFalse(computers.getValue("n-exclusive").copy(status = ComputeStatus.Offline).busy)
    }

    @Test
    fun aManagerEditsAndReleasesEverythingAMemberOnlyEditsTheirOwn() = runTest {
        val computers = Computers.read(client(Server(::answer)), readerId = "user-me").computers.associateBy { it.id }
        assertEquals(computers.keys, computers.values.filter { it.editable(ComputeAccess.Manage) }.map { it.id }.toSet())
        assertEquals(listOf("n-mine"), computers.values.filter { it.editable(ComputeAccess.Use) }.map { it.id })
        assertEquals(setOf("n-exclusive", "n-hidden-holder"), computers.values.filter { it.releasable(ComputeAccess.Manage) }.map { it.id }.toSet())
        assertEquals(emptyList<String>(), computers.values.filter { it.releasable(ComputeAccess.Use) }.map { it.id })
    }

    @Test
    fun accessFollowsComputeUseThenPoolsManage() {
        assertEquals(ComputeAccess.None, ComputeAccess.of(true, ServerPermissions.Unknown))
        assertEquals(ComputeAccess.None, ComputeAccess.of(true, ServerPermissions(true, setOf("pools.manage"))))
        assertEquals(ComputeAccess.None, ComputeAccess.of(false, ServerPermissions(true, setOf("compute.use", "pools.manage"))))
        assertEquals(ComputeAccess.Use, ComputeAccess.of(true, ServerPermissions(true, setOf("compute.use"))))
        assertEquals(ComputeAccess.Manage, ComputeAccess.of(true, ServerPermissions(true, setOf("compute.use", "pools.manage"))))
    }

    @Test
    fun theSourceNamesOtherMembersPrivateComputers() = runTest {
        val asked = mutableListOf<Set<String>>()
        val source = ComputeSource(client(Server(::answer)), readerId = "user-me") { ids -> asked += ids; mapOf("user-ana" to "Ana") }
        source.refresh()
        val computers = (source.state.value as ComputeSource.State.Loaded).snapshot.computers.associateBy { it.id }
        assertEquals(ComputeMode.Private(ComputeOwner.Member("user-ana", "Ana")), computers.getValue("n-theirs").mode)
        assertEquals(ComputeMode.Private(ComputeOwner.Reader), computers.getValue("n-mine").mode)
        assertEquals(listOf(setOf("user-ana")), asked)
    }

    @Test
    fun installKeepsCommandsVerbatimInMillisecondsAndNeverPrintsThem() {
        val install = Computers.install(json("""{"mode":"private","token":"jt-secret","expiresAt":1730003600000,"clusterUrl":"https://acme.happy-clusters.com","commands":{"unix":"curl -fsSL https://get.example/install.sh | HAPPY_COMPUTE_MODE='private' sh","windows":"irm https://get.example/install.ps1 | iex"}}"""))!!
        assertEquals(ComputeModeKind.Private, install.mode)
        assertEquals("curl -fsSL https://get.example/install.sh | HAPPY_COMPUTE_MODE='private' sh", install.commands!!.unix)
        assertEquals("irm https://get.example/install.ps1 | iex", install.commands.windows)
        assertEquals("jt-secret", install.token)
        assertEquals("https://acme.happy-clusters.com", install.clusterUrl)
        assertEquals(1730003600000, install.expiresAt)
        assertFalse(install.toString().contains("jt-secret"))
        assertFalse(ComputerAdd.Shown(install).toString().contains("jt-secret"))

        val bare = Computers.install(json("""{"mode":"sandbox","token":"jt-2","expiresAt":1730003600000,"clusterUrl":"https://acme.happy-clusters.com","commands":null}"""))!!
        assertNull(bare.commands)
        assertEquals("jt-2", bare.token)
        assertNull(Computers.install(json("""{"mode":"sandbox","expiresAt":1}""")))
        assertNull(Computers.install(json("""{"mode":"pool","token":"t","expiresAt":1}""")))
    }

    @Test
    fun aMemberMintsAPrivateTokenWithTrimmedFieldsAndBlankOnesLeftOut() = runTest {
        val server = Server { 201 to """{"mode":"private","token":"jt","expiresAt":1730003600000,"clusterUrl":"https://c","commands":null}""" }
        Computers.create(client(server), ComputeDraft(ComputeModeKind.Private, "  Laptop ", " Use for iOS builds\n"))
        Computers.create(client(server), ComputeDraft(ComputeModeKind.Exclusive, "   ", ""))
        assertEquals(listOf("POST /v0/computers/join-tokens", "POST /v0/computers/join-tokens"), server.asked.map { it.first })
        assertEquals(json("""{"mode":"private","name":"Laptop","description":"Use for iOS builds"}"""), json(server.asked[0].second!!))
        assertEquals(json("""{"mode":"exclusive"}"""), json(server.asked[1].second!!))
    }

    @Test
    fun anEditSendsOnlyWhatChangedAndAnEmptiedDescriptionClearsIt() {
        val computer = Computer("n1", "Laptop", ComputeStatus.Online, "laptop", "linux", "x86_64", ComputeMode.Shared, "Old words", null, null)
        val edit = ComputerEdit.open(computer)
        assertEquals(ComputerEdit("n1", "Laptop", "Old words"), edit)
        assertNull(edit.patch(computer))
        assertNull(edit.copy(name = " Laptop ", description = "Old words  ").patch(computer))
        assertEquals(json("""{"name":"Builder"}"""), edit.copy(name = "Builder").patch(computer))
        assertEquals(json("""{"description":null}"""), edit.copy(description = "  ").patch(computer))
        assertEquals(json("""{"name":"Builder","description":"New words"}"""), edit.copy(name = "Builder ", description = " New words").patch(computer))
        assertNull(edit.copy(name = "  ").patch(computer))
        assertFalse(edit.copy(name = "  ").savable)
        assertFalse(edit.copy(phase = ComputerEdit.Phase.Saving).savable)
    }

    @Test
    fun mutationsUseTheComputerRoutesWithEscapedIds() = runTest {
        val server = Server { 200 to "{}" }
        val client = client(server)
        Computers.edit(client, "n 1", json("""{"name":"B"}"""))
        Computers.releaseLock(client, "n-exclusive")
        Computers.answer(client, ComputeApproval("n-mine", null, "agent/2", null, 0), approve = true)
        Computers.answer(client, ComputeApproval("n-mine", null, "agent-1", null, 0), approve = false)
        assertEquals(
            listOf(
                "PATCH /v0/computers/n%201" to """{"name":"B"}""",
                "POST /v0/computers/n-exclusive/release-lock" to "{}",
                "POST /v0/computers/approvals/n-mine/agent%2F2" to """{"approve":true}""",
                "POST /v0/computers/approvals/n-mine/agent-1" to """{"approve":false}""",
            ),
            server.asked,
        )
    }

    @Test
    fun addingStartsOnTheModesTheReaderMayPickAndOnlyAManagerLeavesPrivate() {
        assertNull(ComputerAdd.open(ComputeAccess.None))
        val member = ComputerAdd.open(ComputeAccess.Use)!!
        assertEquals(ComputerAdd.Choosing(ComputeDraft(ComputeModeKind.Private)), member)
        assertSame(member, member.edit(ComputeAccess.Use) { it.copy(mode = ComputeModeKind.Sandbox) })
        assertEquals(ComputerAdd.Choosing(ComputeDraft(ComputeModeKind.Private, name = "Laptop")), member.edit(ComputeAccess.Use) { it.copy(name = "Laptop") })

        val manager = ComputerAdd.open(ComputeAccess.Manage)!!
        assertEquals(ComputerAdd.Choosing(ComputeDraft(ComputeModeKind.Sandbox)), manager)
        assertEquals(ComputerAdd.Choosing(ComputeDraft(ComputeModeKind.Exclusive)), manager.edit(ComputeAccess.Manage) { it.copy(mode = ComputeModeKind.Exclusive) })
    }

    @Test
    fun aRequestUnderWayHoldsTheFormAndARefusalGoesBackToIt() {
        val draft = ComputeDraft(ComputeModeKind.Shared, "Team box")
        val creating = ComputerAdd.Choosing(draft).create()!!
        assertEquals(ComputerAdd.Creating(draft), creating)
        assertFalse(creating.closable)
        assertNull(creating.create())
        assertSame(creating, creating.edit(ComputeAccess.Manage) { it.copy(name = "Other") })

        val failed = ComputerAdd.Failed(draft, "Compute nodes are not configured on this deployment.")
        assertTrue(failed.closable)
        assertEquals(ComputerAdd.Creating(draft), failed.create())
        assertEquals(ComputerAdd.Choosing(draft.copy(name = "Team")), failed.edit(ComputeAccess.Manage) { it.copy(name = "Team") })
        assertEquals(draft, failed.form)
    }

    @Test
    fun installsRunOnTheSystemsEachModeSupports() {
        assertEquals(setOf(ComputeSystem.Linux), ComputeModeKind.Sandbox.systems)
        assertEquals(setOf(ComputeSystem.Linux), ComputeModeKind.Shared.systems)
        assertEquals(setOf(ComputeSystem.Linux, ComputeSystem.MacOS), ComputeModeKind.Exclusive.systems)
        assertEquals(setOf(ComputeSystem.Linux, ComputeSystem.MacOS, ComputeSystem.Windows), ComputeModeKind.Private.systems)
    }

    @Test
    fun visibleObservationPollsAndFollowsItsEventsButStopsWhenCancelled() = runTest {
        val server = Server(::answer)
        val source = ComputeSource(client(server), readerId = "user-me")
        val events = MutableSharedFlow<AgentEvent>()
        val observer = launch { source.observe(events) }
        runCurrent()
        assertEquals(2, server.asked.size)
        advanceTimeBy(4_001)
        assertEquals(4, server.asked.size)
        for (type in listOf("runners.updated", "compute.nodes.updated", "compute.approvals.updated")) {
            events.emit(AgentEvent("c1", type, JsonObject(emptyMap())))
            runCurrent()
        }
        assertEquals(10, server.asked.size)
        events.emit(AgentEvent("c1", "compute.pools.updated", JsonObject(emptyMap())))
        runCurrent()
        assertEquals(10, server.asked.size)
        observer.cancelAndJoin()
        advanceTimeBy(60_000)
        assertEquals(10, server.asked.size)
        assertEquals(setOf("GET /v0/computers", "GET /v0/computers/approvals"), server.asked.map { it.first }.toSet())
    }

    @Test
    fun leavingCancelsAnInFlightRead() = runTest {
        var cancelled = false
        val server = Server { try { awaitCancellation() } finally { cancelled = true } }
        val observer = launch { ComputeSource(client(server), null).observe(MutableSharedFlow()) }
        runCurrent()
        observer.cancelAndJoin()
        assertTrue(cancelled)
    }

    @Test
    fun aFailedReadKeepsWhatWasShownAndOnlyAFirstFailureSaysSo() = runTest {
        var down = false
        val source = ComputeSource(client(Server { if (down) 503 to """{"code":"unavailable"}""" else answer(it) }), "user-me")
        source.refresh()
        val shown = source.state.value
        assertTrue(shown is ComputeSource.State.Loaded)
        down = true
        source.refresh()
        assertSame(shown, source.state.value)
        val fresh = ComputeSource(client(Server { 503 to """{"code":"unavailable"}""" }), "user-me")
        fresh.refresh()
        assertEquals(ComputeSource.State.Failed, fresh.state.value)
    }

    @Test
    fun aChangeReadsTheListsAgain() = runTest {
        val server = Server(::answer)
        val source = ComputeSource(client(server), "user-me")
        source.answer(ComputeApproval("n-mine", "Laptop", "agent-1", "Fix the build", 0), approve = true)
        assertEquals(
            listOf("POST /v0/computers/approvals/n-mine/agent-1", "GET /v0/computers", "GET /v0/computers/approvals"),
            server.asked.map { it.first },
        )
    }

    @Test
    fun localConnectionsNeverCallCloudCompute() = runTest {
        val server = Server(::answer)
        val source = ComputeSource(AgentClient(server, "test", cloud = false), null)
        source.refresh()
        assertEquals(ComputeSource.State.Failed, source.state.value)
        assertTrue(server.asked.isEmpty())
    }
}
