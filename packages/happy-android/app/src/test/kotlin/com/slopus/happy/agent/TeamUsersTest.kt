package com.slopus.happy.agent

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.After
import org.junit.Test

/**
 * In a team a task wears its author's face (iOS a2597f4d6, TeamTaskAuthorTests):
 * the person's own from the profile, another member's read from
 * `/v0/users` and kept beside the catalog, a member without a picture their
 * own placeholder; standalone, nothing changes.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class TeamUsersTest {
    private val hash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"

    private fun task(id: String, owner: String?, archived: Boolean = false) =
        JsonObject(Wire.task(id, id.uppercase(), Wire.agent("a$id"), archived = archived) + ("ownerUserId" to JsonPrimitive(owner)))

    private fun catalog(vararg tasks: JsonObject, me: String? = Wire.USER, photo: String? = null): AgentCatalog {
        val bootstrap = JsonObject(
            Wire.bootstrap(tasks = tasks.toList(), memberships = tasks.map { Wire.membership(it["id"]!!.toString().trim('"'), "1") }) +
                ("profile" to buildJsonObject {
                    put("userId", me)
                    if (photo != null) put("photo", buildJsonObject { put("thumbhash", photo) })
                }),
        )
        return AgentCatalog().withBootstrap(AgentClient.json.decodeFromJsonElement(WireDesktopBootstrap.serializer(), bootstrap))
    }

    @Test fun `a team task wears its author's face`() {
        val team = catalog(task("t1", Wire.USER), task("t2", "u2"), task("t3", "u3"), photo = hash)
        val users = mapOf("u2" to TeamUser("u2", "Ann", hash), "u3" to TeamUser("u3", "Bo"))
        val rows = AgentFeed.derive(team, users = users).conversations.associateBy { it.agentId }
        // The person's own, from the profile.
        assertEquals("/v0/users/u1/photo", rows.getValue("at1").picture)
        assertEquals(hash, rows.getValue("at1").thumbhash)
        // Another member's, as read.
        assertEquals("/v0/users/u2/photo", rows.getValue("at2").picture)
        // One without a picture wears their own placeholder.
        assertNull(rows.getValue("at3").picture)
        assertEquals("u3", rows.getValue("at3").seed)
        // The members to read: the listed tasks' authors, not the person, not an archived task's.
        assertEquals(setOf("u2", "u3"), TeamUser.authors(catalog(task("t1", Wire.USER), task("t2", "u2"), task("t3", "u3"), task("t4", "u4", archived = true))))
    }

    @Test fun `standalone, a task keeps its own placeholder`() {
        val alone = catalog(task("t1", null), me = null, photo = hash)
        val row = AgentFeed.derive(alone).conversations.single()
        assertNull(row.picture)
        assertEquals("t1", row.seed)
        assertEquals(emptySet<String>(), TeamUser.authors(alone))
    }

    @Test fun `a standalone profile event brings the new photo`() {
        val before = catalog(task("t1", null), me = null)
        val event = AgentEvent(null, "profile.updated", buildJsonObject { put("profile", buildJsonObject { put("userId", null as String?); put("photo", buildJsonObject { put("thumbhash", hash) }) }) })
        assertEquals(hash, before.apply(event).catalog.profilePhoto)
    }

    private fun TestScope.directory(read: suspend (List<String>) -> List<TeamUser>, kept: JsonObject? = null, keep: (JsonObject) -> Unit = {}) =
        // Not backgroundScope: advanceUntilIdle leaves its work alone.
        TeamDirectory(CoroutineScope(StandardTestDispatcher(testScheduler) + Job().also { jobs += it }), read, kept = { kept }, keep = { keep(it) })

    private val jobs = mutableListOf<Job>()

    @After fun cancel() = jobs.forEach { it.cancel() }

    @Test fun `members are read once, a hundred at a time, kept, and asked again only once the link is back`() = runTest {
        val asked = mutableListOf<List<String>>()
        var saved: JsonObject? = null
        val known = (1..150).associate { "m$it" to TeamUser("m$it", "Member $it") }
        val team = directory({ ids -> asked += ids; ids.mapNotNull(known::get) }, keep = { saved = it })
        advanceUntilIdle()
        team.want(known.keys + "gone")
        advanceUntilIdle()
        assertEquals(listOf(100, 51), asked.map { it.size })
        assertEquals(150, team.users.value.size)
        // Asked again: neither the known nor the one the computer doesn't know.
        team.want(known.keys + "gone")
        advanceUntilIdle()
        assertEquals(2, asked.size)
        // Back online: everyone shown is read again, the unknown one too.
        team.connected()
        advanceUntilIdle()
        assertEquals(4, asked.size)
        assertEquals(true, "gone" in asked.last() || "gone" in asked[2])

        // A relaunch draws them from what was kept, before any read.
        val again = directory({ CompletableDeferred<List<TeamUser>>().await() }, kept = saved)
        advanceUntilIdle()
        assertEquals("Member 7", again.users.value["m7"]?.name)
    }

    @Test fun `a member whose profile changed is read again, and names are read where not known`() = runTest {
        var name = "Ann"
        var reads = 0
        val team = directory({ ids -> reads++; ids.map { TeamUser(it, if (it == "u2") name else "Bo") } })
        advanceUntilIdle()
        team.want(setOf("u2"))
        advanceUntilIdle()
        name = "Ann Lee"
        team.changed("u2")
        team.changed("nobody")
        advanceUntilIdle()
        assertEquals("Ann Lee", team.users.value["u2"]?.name)
        assertEquals(2, reads)
        assertEquals(mapOf("u2" to "Ann Lee", "u3" to "Bo"), team.names(setOf("u2", "u3")))
    }

    @Test fun `a read that fails leaves placeholders until the link is back`() = runTest {
        var failing = true
        var reads = 0
        val team = directory({ ids -> reads++; if (failing) throw java.io.IOException("offline") else ids.map { TeamUser(it, "N") } })
        advanceUntilIdle()
        team.want(setOf("u2"))
        advanceUntilIdle()
        team.want(setOf("u2"))
        advanceUntilIdle()
        assertEquals(1, reads)
        failing = false
        team.connected()
        advanceUntilIdle()
        assertEquals("N", team.users.value["u2"]?.name)
    }
}
