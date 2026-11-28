package com.slopus.happy.agent

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A Happy Cloud server's permissions, as the apps gate their controls by them. */
@OptIn(ExperimentalCoroutinesApi::class)
class AgentPermissionsTest {
    private fun answer(vararg granted: String) = Json.parseToJsonElement(
        """{"role":"r","granted":[${granted.joinToString(",") { "\"$it\"" }}],"permissions":[]}""",
    ).jsonObject

    private fun event(type: String) = AgentEvent(null, type, JsonObject(emptyMap()))

    @Test
    fun aCloudServerAllowsOnlyWhatItGrantsAndAnyOtherAllowsEverything() {
        val member = ServerPermissions.parse(answer("content.write", "projects.manage"))!!
        assertTrue(member.canWrite)
        assertFalse(member.allows(Permission.BOTS_MANAGE))
        assertFalse(ServerPermissions.parse(answer())!!.canWrite)
        assertFalse(ServerPermissions.Unknown.canWrite)
        assertTrue(ServerPermissions.Ungated.allows(Permission.BOTS_MANAGE))
        assertEquals(null, ServerPermissions.parse(Json.parseToJsonElement("""{"role":"viewer"}""").jsonObject))
    }

    @Test
    fun theOwnerFlagAndTeamsAreReadAndAServerBeforeTeamsSaysItsRole() {
        val teamed = ServerPermissions.parse(Json.parseToJsonElement(
            """{"owner":false,"teams":["design","members"],"granted":["zones.manage"],"role":"design","permissions":[{"id":"zones.manage","description":"","member":false,"ownerOnly":false}]}""",
        ).jsonObject)!!
        assertFalse(teamed.owner)
        assertEquals(setOf("design", "members"), teamed.teams)
        assertTrue(teamed.allows("zones.manage"))
        assertTrue(teamed.knows("zones.manage"))
        assertTrue(ServerPermissions.parse(Json.parseToJsonElement("""{"owner":true,"teams":["owners","members"],"granted":[]}""").jsonObject)!!.owner)
        val before = ServerPermissions.parse(Json.parseToJsonElement("""{"role":"owner","granted":["content.write"]}""").jsonObject)!!
        assertTrue(before.owner)
        assertEquals(emptySet<String>(), before.teams)
        assertFalse(ServerPermissions.parse(answer())!!.owner)
    }

    @Test
    fun readOnEveryConnectAndRoleChangeAndNothingGrantedUntilThenOrWhenReadingFails() = runTest {
        val events = MutableSharedFlow<AgentEvent>(extraBufferCapacity = 16)
        val answers = ArrayDeque<() -> JsonObject>()
        var reads = 0
        val source = AgentPermissionsSource({ reads += 1; answers.removeFirst()() }, events, backgroundScope)
        assertEquals(ServerPermissions.Unknown, source.permissions.value)
        answers += { answer("content.write") }
        events.emit(event(AgentEvent.HELLO))
        runCurrent()
        assertEquals(setOf("content.write"), source.permissions.value.granted)
        events.emit(event("agent.updated"))
        runCurrent()
        assertEquals(1, reads)
        answers += { answer() }
        events.emit(event("role.updated"))
        runCurrent()
        assertFalse(source.permissions.value.canWrite)
        // What a team grants, or who is in it, changed.
        answers += { answer("content.write") }
        events.emit(event("team.updated"))
        runCurrent()
        assertTrue(source.permissions.value.canWrite)
        answers += { answer() }
        events.emit(event("team.removed"))
        runCurrent()
        assertFalse(source.permissions.value.canWrite)
        // Another role given to a member (this person, perhaps): read again.
        answers += { answer("content.write") }
        events.emit(event("member.updated"))
        runCurrent()
        assertTrue(source.permissions.value.canWrite)
        answers += { throw AgentApiException(500, "internal", null) }
        events.emit(event(AgentEvent.HELLO))
        runCurrent()
        assertEquals(ServerPermissions.Unknown, source.permissions.value)
        assertEquals(6, reads)
    }
}
