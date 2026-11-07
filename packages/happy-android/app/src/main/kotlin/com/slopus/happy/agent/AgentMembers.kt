package com.slopus.happy.agent

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** Someone on a Happy Cloud team (`GET /v0/members`): [role] is a role's id, [name] null until they give one. */
@Serializable
data class TeamMember(val accountId: String, val userId: String? = null, val name: String? = null, val role: String, val joinedAt: String? = null)

/** One of the team's roles (`GET /v0/roles`): the built-in owner, admin, member and viewer, or one the team made. */
@Serializable
data class TeamRole(val id: String, val name: String, val builtIn: Boolean = false)

/** Who is on the team, and what each role is called. */
data class Team(val members: List<TeamMember>, val roles: List<TeamRole> = emptyList()) {
    /** [id]'s name as the team calls it; null for a role it didn't list. */
    fun roleName(id: String): String? = roles.firstOrNull { it.id == id }?.name
}

/** The Happy Cloud team's members, held by the cluster since the roles cutover (members contract, `/v0/members`). */
object TeamMembers {
    @Serializable private class Members(val members: List<TeamMember>)
    @Serializable private class Roles(val roles: List<TeamRole>)

    /** The members and the roles' names; the roles are a nicety, so a team that can't list them still lists its members. */
    suspend fun read(client: AgentClient): Team = coroutineScope {
        val roles = async {
            try {
                client.decode<Roles>("GET", "/v0/roles").roles
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                emptyList()
            }
        }
        Team(client.decode<Members>("GET", "/v0/members").members, roles.await())
    }

    /** Leaves the team; its last owner can't ([lastOwner]). */
    suspend fun leave(client: AgentClient) {
        client.send("POST", "/v0/members/leave", JsonObject(emptyMap()))
    }

    /** `409 last_owner`: the team needs another owner before this one goes. */
    fun lastOwner(e: AgentApiException): Boolean = e.status == 409 && e.code == "last_owner"

    /** Whether [event] may change who is on the team, their roles, or what roles are called; a reconnect may have missed any of it. */
    fun changes(event: AgentEvent): Boolean =
        event.type == AgentEvent.HELLO || event.type.startsWith("member.") || event.type.startsWith("role.")
}

/**
 * The team as a screen shows it: read at once, and again on every event
 * that may change it ([TeamMembers.changes]). There is no `member.added`,
 * so a join shows on the next read.
 */
class TeamSource(
    private val read: suspend () -> Team,
    events: SharedFlow<AgentEvent>,
    private val scope: CoroutineScope,
) {
    sealed interface State {
        data object Loading : State
        data class Loaded(val team: Team) : State
        data object Failed : State
    }

    private val state = MutableStateFlow<State>(State.Loading)
    val team: StateFlow<State> = state.asStateFlow()

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            events.collect { if (TeamMembers.changes(it)) reload() }
        }
        scope.launch { reload() }
    }

    /** Reads it again; what was shown stays until the new read is in, and a failed read keeps a team already shown. */
    fun retry() {
        scope.launch { reload() }
    }

    private suspend fun reload() {
        state.value = try {
            State.Loaded(read())
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            state.value.takeIf { it is State.Loaded } ?: State.Failed
        }
    }
}
