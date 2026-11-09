package com.slopus.happy.agent

import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** A Happy Cloud member's profile (cluster profile contract, `GET /v0/users/:id/profile`), as their profile page reads it. */
@OptIn(ExperimentalCoroutinesApi::class)
class MemberProfilesTest {
    private class Routes(val answers: Map<String, Pair<Int, String>>) : Transport {
        val asked = mutableListOf<String>()
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            asked += "$method $path"
            val (status, text) = answers["$method $path"] ?: (404 to """{"error":"No such user.","code":"not_found"}""")
            return TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())
        }

        override suspend fun close() {}
    }

    /** The cluster's answer, shaped as its `user_profiles` test sees it. */
    private val profile = """{
        "user":{"id":"u1","name":"Ada Lovelace","photo":{"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"},"version":"3","updatedAt":1767225600000,
                "kind":"member","canLogIn":true,"role":"Staff engineer","follows":null,"teamRole":"owner"},
        "stats":{
          "tasks":{"total":12,"active":3},
          "lastActivityAt":1767225600000,
          "activeDays":9,
          "usage":{
            "hour":{},
            "day":{"anthropic":{"claude-opus":{"input":1200,"cacheRead":800,"cacheWrite":100,"output":300,"reasoning":50}}},
            "week":{"anthropic":{"claude-opus":{"input":10000,"cacheRead":0,"cacheWrite":0,"output":2000,"reasoning":0}},
                    "openai":{"gpt-5":{"input":500,"cacheRead":0,"cacheWrite":0,"output":500,"reasoning":400,"images":2}}}
          }
        },
        "recentTasks":[
          {"id":"t1","name":"Fix login redirect","status":"active","archivedAt":null,
           "agent":{"id":"a1","workspaceId":"w1","title":"Login","status":"working","version":"1","updatedAt":1767225000000,"lastActivityAt":1767225500000}},
          {"id":"t2","name":"","status":"archived","archivedAt":1767000000000,
           "agent":{"id":"a2","workspaceId":"w2","title":"Release notes","status":"idle","version":"1","updatedAt":1767100000000}},
          {"id":"t3","name":"No agent"}
        ]
    }"""

    @Test
    fun theProfileReadsTheMemberTheirStatisticsAndTheirTasks() = runBlocking {
        val routes = Routes(mapOf("GET /v0/users/u%201/profile?limit=10" to (200 to profile)))
        val read = MemberProfiles.read(AgentClient(routes, "t", cloud = true), "u 1")
        assertEquals(listOf("GET /v0/users/u%201/profile?limit=10"), routes.asked)
        assertEquals(MemberProfileUser("u1", "Ada Lovelace", "1QcSHQRnh493V4dIh4eXh1h4kJUI", "Staff engineer", "owner"), read.user)
        assertEquals(listOf(12, 3, 9), listOf(read.totalTasks, read.activeTasks, read.activeDays))
        assertEquals(1767225600000, read.lastActivityAt)
        // Every provider and model summed; input holds the cache, output the reasoning, so neither counts twice.
        assertEquals(mapOf("hour" to 0L, "day" to 1500L, "week" to 13000L, "month" to 0L), read.usage.mapValues { it.value.tokens })
        // Newest first as sent; a task with no name is its agent's title, and one with no agent doesn't read.
        assertEquals(
            listOf(
                MemberProfileTask("t1", "a1", "Fix login redirect", 1767225500000, archived = false, working = true),
                MemberProfileTask("t2", "a2", "Release notes", 1767100000000, archived = true, working = false),
            ),
            read.recentTasks,
        )
    }

    @Test
    fun aMemberWithNothingYetReadsAsNothing() {
        val bare = MemberProfiles.parse(AgentClient.json.parseToJsonElement("""{"user":{"id":"u2","name":"New","photo":null,"role":null,"teamRole":null},"stats":{"tasks":{"total":0,"active":0},"lastActivityAt":null,"activeDays":0,"usage":{}},"recentTasks":[]}""") as kotlinx.serialization.json.JsonObject)!!
        assertEquals(MemberProfileUser("u2", "New"), bare.user)
        assertNull(bare.lastActivityAt)
        assertEquals(MemberProfile.WINDOWS.associateWith { 0L }, bare.usage.mapValues { it.value.tokens })
        assertNull(MemberProfiles.parse(kotlinx.serialization.json.JsonObject(emptyMap())))
    }

    @Test
    fun anUnknownMemberIsSaidApartFromAFailureAndARetryKeepsWhatWasShown() = runTest {
        val unknown = MemberProfileSource({ MemberProfiles.read(AgentClient(Routes(emptyMap()), "t"), "gone") }, backgroundScope)
        runCurrent()
        assertEquals(MemberProfileSource.State.Unknown, unknown.profile.value)

        val answers = ArrayDeque<() -> MemberProfile>()
        answers += { MemberProfile(MemberProfileUser("u1", "Ada")) }
        answers += { error("offline") }
        val source = MemberProfileSource({ answers.removeFirst()() }, backgroundScope)
        assertEquals(MemberProfileSource.State.Loading, source.profile.value)
        runCurrent()
        assertEquals("Ada", (source.profile.value as MemberProfileSource.State.Loaded).profile.user.name)
        source.retry()
        runCurrent()
        assertEquals("Ada", (source.profile.value as MemberProfileSource.State.Loaded).profile.user.name)

        val failed = MemberProfileSource({ error("offline") }, backgroundScope)
        runCurrent()
        assertEquals(MemberProfileSource.State.Failed, failed.profile.value)
    }
}
