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

/**
 * Someone on a Happy Cloud server (`GET /v0/members`): [teams] the custom
 * teams they are directly in and [owner] their owner flag (docs/teams.md);
 * [name] null until they give one. [role] is the field a server from before
 * teams sends alone (`owner`, `member` or a custom role's id), kept by newer
 * ones for compatibility.
 */
@Serializable
data class TeamMember(
    val accountId: String,
    val userId: String? = null,
    val name: String? = null,
    val role: String? = null,
    val joinedAt: String? = null,
    val teams: List<String>? = null,
    val owner: Boolean? = null,
) {
    /** Whether they own the server: the flag, or before teams the owner role. */
    val isOwner: Boolean get() = owner ?: (role == "owner")
}

/** One of the server's teams (`GET /v0/teams`): the derived `owners` and `members`, or one its people made. */
@Serializable
data class ServerTeam(val id: String, val name: String, val kind: String = "custom")

/** One of a pre-teams server's roles (`GET /v0/roles`): the built-in owner, admin, member and viewer, or one the server made. */
@Serializable
data class TeamRole(val id: String, val name: String, val builtIn: Boolean = false)

/** Who is on the server, and what its teams (or, before teams, its roles) are called. */
data class Team(val members: List<TeamMember>, val teams: List<ServerTeam> = emptyList(), val roles: List<TeamRole> = emptyList()) {
    /** Team [id]'s name; null for one the server didn't list. */
    fun teamName(id: String): String? = teams.firstOrNull { it.id == id }?.name

    /** Role [id]'s name as a pre-teams server calls it; null for a role it didn't list. */
    fun roleName(id: String): String? = roles.firstOrNull { it.id == id }?.name

    /** The member whose user is [userId]; null for someone not on the server (or not arrived). */
    fun member(userId: String): TeamMember? = members.firstOrNull { it.userId == userId }
}

/** The Happy Cloud server's members, held by the cluster (docs/teams.md §7, `/v0/members`). */
object TeamMembers {
    @Serializable private class Members(val members: List<TeamMember>)
    @Serializable private class Teams(val teams: List<ServerTeam>)
    @Serializable private class Roles(val roles: List<TeamRole>)

    /**
     * The members and their teams' names; the names are a nicety, so a
     * server that can't list them still lists its members. A server from
     * before teams has no `/v0/teams`, and its roles' names stand in.
     */
    suspend fun read(client: AgentClient): Team = coroutineScope {
        val names = async {
            val teams = quietly { teams(client) }
            teams to if (teams == null) quietly { roles(client) } else null
        }
        val members = client.decode<Members>("GET", "/v0/members").members
        val (teams, roles) = names.await()
        Team(members, teams.orEmpty(), roles.orEmpty())
    }

    /** The server's teams (`GET /v0/teams`). */
    suspend fun teams(client: AgentClient): List<ServerTeam> = client.decode<Teams>("GET", "/v0/teams").teams

    /** A pre-teams server's roles (`GET /v0/roles`, deprecated since teams). */
    suspend fun roles(client: AgentClient): List<TeamRole> = client.decode<Roles>("GET", "/v0/roles").roles

    private suspend fun <T> quietly(read: suspend () -> T): T? = try {
        read()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    /** Leaves the server; its last owner can't ([lastOwner]). */
    suspend fun leave(client: AgentClient) {
        client.send("POST", "/v0/members/leave", JsonObject(emptyMap()))
    }

    /** `409 last_owner`: the server needs another owner before this one goes. */
    fun lastOwner(e: AgentApiException): Boolean = e.status == 409 && e.code == "last_owner"

    /**
     * Whether [event] may change who is on the server, their teams or owner
     * flag, what teams (or a pre-teams server's roles) are called, or a
     * member's name (it is their profile's, and `member.*` carries none); a
     * reconnect may have missed any of it.
     */
    fun changes(event: AgentEvent): Boolean =
        event.type == AgentEvent.HELLO || event.type.startsWith("member.") || event.type.startsWith("team.") ||
            event.type.startsWith("role.") || event.type == "profile.updated"
}

/**
 * The server's members as a screen shows them: read at once, and again on
 * every event that may change them ([TeamMembers.changes]): `member.*`,
 * `team.*`, `role.*`, `profile.updated` and every reconnect. There is no `member.added`, so a
 * join shows on the next read.
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

    /** Reads them again; what was shown stays until the new read is in, and a failed read keeps members already shown. */
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
