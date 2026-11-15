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
    }

    @Test fun `standalone, a task keeps its own placeholder`() {
        val alone = catalog(task("t1", null), me = null, photo = hash)
        val row = AgentFeed.derive(alone).conversations.single()
        assertNull(row.picture)
        assertEquals("t1", row.seed)
    }

    @Test fun `a standalone profile event brings the new photo`() {
        val before = catalog(task("t1", null), me = null)
        val event = AgentEvent(null, "profile.updated", buildJsonObject { put("profile", buildJsonObject { put("userId", null as String?); put("photo", buildJsonObject { put("thumbhash", hash) }) }) })
        assertEquals(hash, before.apply(event).catalog.profilePhoto)
    }

    private fun TestScope.directory(kept: JsonObject? = null, keep: (JsonObject) -> Unit = {}) =
        // Not backgroundScope: advanceUntilIdle leaves its work alone.
        TeamDirectory(CoroutineScope(StandardTestDispatcher(testScheduler) + Job().also { jobs += it }), kept = { kept }, keep = { keep(it) })

    private val jobs = mutableListOf<Job>()

    @After fun cancel() = jobs.forEach { it.cancel() }

    @Test fun `bootstrap people are kept offline and a later bootstrap replaces them`() = runTest {
        var saved: JsonObject? = null
        val team = directory(keep = { saved = it })
        advanceUntilIdle()
        team.bootstrap(kotlinx.serialization.json.JsonArray(listOf(buildJsonObject { put("id", "u2"); put("name", "Ann") })), null)
        assertEquals(mapOf("u2" to "Ann"), team.names(setOf("u2", "missing")))
        val again = directory(kept = saved)
        advanceUntilIdle()
        assertEquals("Ann", again.users.value["u2"]?.name)
        again.bootstrap(null, buildJsonObject { put("userId", "u1"); put("name", "Me") })
        assertEquals(mapOf("u1" to "Me"), again.names(setOf("u1", "u2")))
    }
}
