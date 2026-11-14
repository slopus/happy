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
    /** What `GET /v0/computers` sends a manager: shared and private computers, one revoked, one with an access from the future, one missing its view. */
    private val computers = """{"computers":[
        {"id":"n-shared","name":null,"hostname":"build-01","status":"online","os":"linux","arch":"x86_64","since":1730000000000,"description":"GPU box, CUDA 12.4","access":"shared","owner":null,"concurrency":8,"maxConcurrency":16,"agents":[{"id":"agent-7","title":"Ship the release"},{"id":"agent-9","title":null}],"boundary":{"available":true,"reason":null}},
        {"id":"n-full","name":"Mac mini","hostname":"mini.local","status":"online","os":"macos","arch":"aarch64","since":1730000200000,"description":"","access":"shared","owner":null,"concurrency":1,"maxConcurrency":null,"agents":[{"id":"agent-3","title":"Profile"}],"boundary":{"available":false,"reason":"bwrap: no user namespaces"}},
        {"id":"n-mine","name":"Laptop","hostname":"laptop","status":"enrolling","os":"windows","arch":"x86_64","since":1730000300000,"description":"My own","access":"private","owner":"user-me","concurrency":1,"maxConcurrency":4,"agents":[],"boundary":{"available":true,"reason":null}},
        {"id":"n-theirs","name":"Ana's desk","hostname":"desk","status":"draining","os":"linux","arch":"x86_64","access":"private","owner":"user-ana","concurrency":2,"agents":[],"boundary":{"available":true}},
        {"id":"n-ownerless","hostname":null,"name":null,"status":"offline","access":"private","owner":null,"concurrency":1,"agents":[],"boundary":{"available":true,"reason":null}},
        {"id":"n-revoked","name":"Old","status":"revoked","access":"shared","concurrency":8,"agents":[],"boundary":{"available":true}},
        {"id":"n-future","name":"Next","status":"online","access":"team","concurrency":8,"agents":[],"boundary":{"available":true}},
        {"id":"n-old","name":"Before","status":"online","mode":"sandbox","sandboxCapacity":{"used":1,"total":4}}
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

    private val available = ComputeBoundary(true, null)

    @Test
    fun eachComputerCarriesItsAccessOwnerPlacesAndBoundary() = runTest {
        val server = Server(::answer)
        val snapshot = Computers.read(client(server), readerId = "user-me")
        assertEquals(
            listOf(
                Computer("n-shared", "build-01", ComputeStatus.Online, "build-01", "linux", "x86_64", ComputeAccess.Shared, null, 8, 16,
                    listOf(ComputeAgent("agent-7", "Ship the release"), ComputeAgent("agent-9", null)), available, "GPU box, CUDA 12.4", 1730000000000),
                Computer("n-full", "Mac mini", ComputeStatus.Online, "mini.local", "macos", "aarch64", ComputeAccess.Shared, null, 1, null,
                    listOf(ComputeAgent("agent-3", "Profile")), ComputeBoundary(false, "bwrap: no user namespaces"), null, 1730000200000),
                Computer("n-theirs", "Ana's desk", ComputeStatus.Draining, "desk", "linux", "x86_64", ComputeAccess.Private, ComputeOwner.Member("user-ana", null), 2, null, emptyList(), available, null, null),
                Computer("n-mine", "Laptop", ComputeStatus.Enrolling, "laptop", "windows", "x86_64", ComputeAccess.Private, ComputeOwner.Reader, 1, 4, emptyList(), available, "My own", 1730000300000),
                Computer("n-ownerless", "n-ownerl", ComputeStatus.Offline, null, null, null, ComputeAccess.Private, null, 1, null, emptyList(), available, null, null),
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
    fun aComputerIsFullOnceAgentsHoldEveryPlace() = runTest {
        val computers = Computers.read(client(Server(::answer)), readerId = "user-me").computers.associateBy { it.id }
        assertEquals(listOf("n-full"), computers.values.filter { it.full }.map { it.id })
        assertTrue(computers.getValue("n-shared").copy(concurrency = 2).full)
    }

    @Test
    fun aManagerOrThePrivateOwnerManagesAComputer() = runTest {
        val computers = Computers.read(client(Server(::answer)), readerId = "user-me").computers.associateBy { it.id }
        assertEquals(computers.keys, computers.values.filter { it.manageable(ComputeRole.Manage) }.map { it.id }.toSet())
        assertEquals(listOf("n-mine"), computers.values.filter { it.manageable(ComputeRole.Use) }.map { it.id })
        assertEquals(emptyList<String>(), computers.values.filter { it.manageable(ComputeRole.None) }.map { it.id })
    }

    @Test
    fun concurrencyIsHeldToTheComputersLimitAndTheClusters() = runTest {
        val computers = Computers.read(client(Server(::answer)), readerId = "user-me").computers.associateBy { it.id }
        assertEquals(16, computers.getValue("n-shared").concurrencyLimit)
        assertEquals(64, computers.getValue("n-full").concurrencyLimit)
        assertEquals(4, computers.getValue("n-mine").concurrencyLimit)
        assertEquals(64, computers.getValue("n-shared").copy(maxConcurrency = 128).concurrencyLimit)
    }

    @Test
    fun roleFollowsComputeUseThenPoolsManage() {
        assertEquals(ComputeRole.None, ComputeRole.of(true, ServerPermissions.Unknown))
        assertEquals(ComputeRole.None, ComputeRole.of(true, ServerPermissions(true, setOf("pools.manage"))))
        assertEquals(ComputeRole.None, ComputeRole.of(false, ServerPermissions(true, setOf("compute.use", "pools.manage"))))
        assertEquals(ComputeRole.Use, ComputeRole.of(true, ServerPermissions(true, setOf("compute.use"))))
        assertEquals(ComputeRole.Manage, ComputeRole.of(true, ServerPermissions(true, setOf("compute.use", "pools.manage"))))
    }

    @Test
    fun theSourceNamesOtherMembersPrivateComputers() = runTest {
        val asked = mutableListOf<Set<String>>()
        val source = ComputeSource(client(Server(::answer)), readerId = "user-me") { ids -> asked += ids; mapOf("user-ana" to "Ana") }
        source.refresh()
        val computers = (source.state.value as ComputeSource.State.Loaded).snapshot.computers.associateBy { it.id }
        assertEquals(ComputeOwner.Member("user-ana", "Ana"), computers.getValue("n-theirs").owner)
        assertEquals(ComputeOwner.Reader, computers.getValue("n-mine").owner)
        assertEquals(listOf(setOf("user-ana")), asked)
    }

    @Test
    fun installKeepsCommandsVerbatimInMillisecondsAndNeverPrintsThem() {
        val install = Computers.install(json("""{"access":"private","concurrency":1,"token":"jt-secret","expiresAt":1730003600000,"clusterUrl":"https://acme.happy-clusters.com","commands":{"unix":"curl -fsSL https://get.example/install.sh | HAPPY_JOIN_TOKEN='jt-secret' sh","windows":"irm https://get.example/install.ps1 | iex"},"platforms":["linux-x86_64","linux-aarch64","solaris-sparc"],"notice":"macOS and Windows computers are not available yet."}"""))!!
        assertEquals(ComputeAccess.Private, install.access)
        assertEquals(1, install.concurrency)
        assertEquals("curl -fsSL https://get.example/install.sh | HAPPY_JOIN_TOKEN='jt-secret' sh", install.commands!!.unix)
        assertEquals("irm https://get.example/install.ps1 | iex", install.commands.windows)
        assertEquals(setOf(ComputeSystem.Linux), install.systems)
        assertEquals("macOS and Windows computers are not available yet.", install.notice)
        assertEquals("jt-secret", install.token)
        assertEquals("https://acme.happy-clusters.com", install.clusterUrl)
        assertEquals(1730003600000, install.expiresAt)
        assertFalse(install.toString().contains("jt-secret"))
        assertFalse(ComputerAdd.Shown(install).toString().contains("jt-secret"))

        val bare = Computers.install(json("""{"access":"shared","concurrency":8,"token":"jt-2","expiresAt":1730003600000,"clusterUrl":"https://acme.happy-clusters.com","commands":null,"platforms":[],"notice":null}"""))!!
        assertNull(bare.commands)
        assertNull(bare.notice)
        assertEquals("jt-2", bare.token)
        assertNull(Computers.install(json("""{"access":"shared","concurrency":8,"expiresAt":1}""")))
        assertNull(Computers.install(json("""{"mode":"sandbox","token":"t","expiresAt":1}""")))
    }

    @Test
    fun aJoinTokenIsMintedWithTheAccessAndOnlyAPickedConcurrency() = runTest {
        val server = Server { 201 to """{"access":"private","concurrency":1,"token":"jt","expiresAt":1730003600000,"clusterUrl":"https://c","commands":null,"platforms":[],"notice":null}""" }
        Computers.create(client(server), ComputeDraft(ComputeAccess.Private))
        Computers.create(client(server), ComputeDraft(ComputeAccess.Shared, concurrency = 12))
        assertEquals(listOf("POST /v0/computers/join-tokens", "POST /v0/computers/join-tokens"), server.asked.map { it.first })
        assertEquals(json("""{"access":"private"}"""), json(server.asked[0].second!!))
        assertEquals(json("""{"access":"shared","concurrency":12}"""), json(server.asked[1].second!!))
    }

    @Test
    fun mutationsUseTheComputerRoutesWithEscapedIds() = runTest {
        val server = Server { 200 to "{}" }
        val client = client(server)
        Computers.setConcurrency(client, "n-shared", 12)
        Computers.removeAgent(client, "n-shared", "agent/7")
        Computers.answer(client, ComputeApproval("n-mine", null, "agent/2", null, 0), approve = true)
        Computers.answer(client, ComputeApproval("n-mine", null, "agent-1", null, 0), approve = false)
        assertEquals(
            listOf(
                "PATCH /v0/computers/n-shared" to """{"concurrency":12}""",
                "DELETE /v0/computers/n-shared/agents/agent%2F7" to null,
                "POST /v0/computers/approvals/n-mine/agent%2F2" to """{"approve":true}""",
                "POST /v0/computers/approvals/n-mine/agent-1" to """{"approve":false}""",
            ),
            server.asked,
        )
    }

    @Test
    fun addingStartsOnTheAccessTheReaderMayPickAndOnlyAManagerPicksShared() {
        assertNull(ComputerAdd.open(ComputeRole.None))
        val member = ComputerAdd.open(ComputeRole.Use)!!
        assertEquals(ComputerAdd.Choosing(ComputeDraft(ComputeAccess.Private)), member)
        assertSame(member, member.edit(ComputeRole.Use) { it.copy(access = ComputeAccess.Shared) })

        val manager = ComputerAdd.open(ComputeRole.Manage)!!
        assertEquals(ComputerAdd.Choosing(ComputeDraft(ComputeAccess.Shared)), manager)
        assertEquals(ComputerAdd.Choosing(ComputeDraft(ComputeAccess.Private)), manager.edit(ComputeRole.Manage) { it.copy(access = ComputeAccess.Private) })
    }

    @Test
    fun concurrencyDefaultsByAccessUntilPickedAndStaysInRange() {
        assertEquals(8, ComputeDraft(ComputeAccess.Shared).agents)
        assertEquals(1, ComputeDraft(ComputeAccess.Private).agents)
        val picked = ComputerAdd.Choosing(ComputeDraft(ComputeAccess.Shared)).edit(ComputeRole.Manage) { it.copy(concurrency = 3) }
        assertEquals(ComputerAdd.Choosing(ComputeDraft(ComputeAccess.Shared, 3)), picked)
        assertEquals(3, picked.edit(ComputeRole.Manage) { it.copy(access = ComputeAccess.Private) }.form!!.agents)
        assertSame(picked, picked.edit(ComputeRole.Manage) { it.copy(concurrency = 0) })
        assertSame(picked, picked.edit(ComputeRole.Manage) { it.copy(concurrency = 65) })
    }

    @Test
    fun aRequestUnderWayHoldsTheFormAndARefusalGoesBackToIt() {
        val draft = ComputeDraft(ComputeAccess.Shared)
        val creating = ComputerAdd.Choosing(draft).create()!!
        assertEquals(ComputerAdd.Creating(draft), creating)
        assertFalse(creating.closable)
        assertNull(creating.create())
        assertSame(creating, creating.edit(ComputeRole.Manage) { it.copy(access = ComputeAccess.Private) })

        val failed = ComputerAdd.Failed(draft, "Compute nodes are not configured on this deployment.")
        assertTrue(failed.closable)
        assertEquals(ComputerAdd.Creating(draft), failed.create())
        assertEquals(ComputerAdd.Choosing(ComputeDraft(ComputeAccess.Private)), failed.edit(ComputeRole.Manage) { it.copy(access = ComputeAccess.Private) })
        assertEquals(draft, failed.form)
    }

    @Test
    fun publishedPlatformsNameTheirSystem() {
        assertEquals(ComputeSystem.Linux, ComputeSystem.ofPlatform("linux-x86_64"))
        assertEquals(ComputeSystem.MacOS, ComputeSystem.ofPlatform("macos-aarch64"))
        assertEquals(ComputeSystem.Windows, ComputeSystem.ofPlatform("windows-x86_64"))
        assertNull(ComputeSystem.ofPlatform("freebsd-x86_64"))
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
        val computer = Computers.read(client(Server(::answer)), "user-me").computers.first { it.id == "n-shared" }
        source.setConcurrency(computer, 4)
        source.removeAgent(computer, computer.agents.first())
        assertEquals(
            listOf(
                "POST /v0/computers/approvals/n-mine/agent-1", "GET /v0/computers", "GET /v0/computers/approvals",
                "PATCH /v0/computers/n-shared", "GET /v0/computers", "GET /v0/computers/approvals",
                "DELETE /v0/computers/n-shared/agents/agent-7", "GET /v0/computers", "GET /v0/computers/approvals",
            ),
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
