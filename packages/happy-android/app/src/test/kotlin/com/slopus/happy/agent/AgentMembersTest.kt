package com.slopus.happy.agent

import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** A Happy Cloud team's members on the server itself (members contract, `/v0/members`), as the Members page reads them. */
@OptIn(ExperimentalCoroutinesApi::class)
class AgentMembersTest {
    private class Routes(val answers: Map<String, Pair<Int, String>>) : Transport {
        val asked = mutableListOf<String>()
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            asked += "$method $path"
            val (status, text) = answers["$method $path"] ?: (404 to """{"error":"Not found","code":"not_found"}""")
            return TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())
        }

        override suspend fun close() {}
    }

    private val members = """{"members":[
        {"accountId":"a1","userId":"u1","name":"QA android","role":"owner","joinedAt":"2026-11-07T14:07:45.077367Z"},
        {"accountId":"a2","userId":null,"name":null,"role":"reviewer","joinedAt":"2026-11-07T14:07:47Z"}]}"""
    private val roles = """{"roles":[{"builtIn":true,"id":"owner","name":"Owner","permissions":[]},{"builtIn":false,"id":"reviewer","name":"Reviewers","permissions":["content.write"]}]}"""

    @Test
    fun theTeamReadsItsMembersAndWhatItCallsItsRoles() = runBlocking {
        val team = TeamMembers.read(AgentClient(Routes(mapOf("GET /v0/members" to (200 to members), "GET /v0/roles" to (200 to roles))), "t"))
        assertEquals(listOf(TeamMember("a1", "u1", "QA android", "owner", "2026-11-07T14:07:45.077367Z"), TeamMember("a2", null, null, "reviewer", "2026-11-07T14:07:47Z")), team.members)
        assertEquals("Reviewers", team.roleName("reviewer"))
        assertEquals(null, team.roleName("viewer"))
        // A team whose roles can't be read still lists its members.
        val bare = TeamMembers.read(AgentClient(Routes(mapOf("GET /v0/members" to (200 to members), "GET /v0/roles" to (403 to """{"error":"x","code":"forbidden"}"""))), "t"))
        assertEquals(2, bare.members.size)
        assertEquals(emptyList<TeamRole>(), bare.roles)
    }

    @Test
    fun leavingAsksTheServerAndItsLastOwnerIsTold() = runBlocking {
        val routes = Routes(mapOf("POST /v0/members/leave" to (204 to "")))
        TeamMembers.leave(AgentClient(routes, "t"))
        assertEquals(listOf("POST /v0/members/leave"), routes.asked)
        try {
            TeamMembers.leave(AgentClient(Routes(mapOf("POST /v0/members/leave" to (409 to """{"code":"last_owner","error":"The team needs another owner first."}"""))), "t"))
            fail("the last owner left")
        } catch (e: AgentApiException) {
            assertTrue(TeamMembers.lastOwner(e))
        }
        assertFalse(TeamMembers.lastOwner(AgentApiException(409, "conflict", null)))
    }

    @Test
    fun theTeamIsReadAgainOnEveryConnectAndMemberRoleOrNameChange() = runTest {
        val events = MutableSharedFlow<AgentEvent>(extraBufferCapacity = 16)
        val answers = ArrayDeque<() -> Team>()
        var reads = 0
        answers += { Team(listOf(TeamMember("a1", role = "owner"))) }
        val source = TeamSource({ reads += 1; answers.removeFirst()() }, events, backgroundScope)
        assertEquals(TeamSource.State.Loading, source.team.value)
        runCurrent()
        assertEquals(1, (source.team.value as TeamSource.State.Loaded).team.members.size)
        for (type in listOf("member.updated", "member.removed", "role.updated", "profile.updated", AgentEvent.HELLO)) {
            answers += { Team(listOf(TeamMember("a1", role = "owner"), TeamMember("a2", role = "viewer"))) }
            events.emit(AgentEvent(null, type, JsonObject(emptyMap())))
            runCurrent()
        }
        events.emit(AgentEvent(null, "agent.updated", JsonObject(emptyMap())))
        runCurrent()
        assertEquals(6, reads)
        // A failed read keeps what was shown; failing before anything was, it says so.
        answers += { throw AgentApiException(500, "internal", null) }
        source.retry()
        runCurrent()
        assertEquals(2, (source.team.value as TeamSource.State.Loaded).team.members.size)
        val failing = TeamSource({ throw AgentApiException(503, "unavailable", null) }, events, backgroundScope)
        runCurrent()
        assertEquals(TeamSource.State.Failed, failing.team.value)
    }
}
