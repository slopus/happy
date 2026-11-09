package com.slopus.happy.agent

import androidx.compose.runtime.Immutable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * A member of a Happy Cloud team as their profile shows them (cluster
 * profile contract, `ProfileUser`): [role] is their free-text job title,
 * [teamRole] their place on the team (`owner`, `member` or a custom role's
 * ID; null once they left it), [photo] their picture's ThumbHash, the bytes
 * at [TeamUser.photoPath].
 */
@Immutable
data class MemberProfileUser(
    val id: String,
    val name: String,
    val photo: String? = null,
    val role: String? = null,
    val teamRole: String? = null,
)

/** One of the member's own tasks, newest activity first, as `GET /v0/tasks` lists it; it opens its [agentId]'s conversation. */
@Immutable
data class MemberProfileTask(
    val id: String,
    val agentId: String,
    val name: String,
    val activityAt: Long = 0,
    val archived: Boolean = false,
    val working: Boolean = false,
)

/** What one window (`hour`, `day`, `week`, `month`) of a member's usage counts, summed over every provider and model. */
@Immutable
data class MemberUsage(val input: Long = 0, val output: Long = 0) {
    /** Tokens as the agent page counts them: input (cache reads and writes in it) and output (reasoning in it). */
    val tokens: Long get() = input + output
}

/** `GET /v0/users/:id/profile` (cluster profile contract): the member, their statistics and their recent tasks. */
@Immutable
data class MemberProfile(
    val user: MemberProfileUser,
    val totalTasks: Int = 0,
    val activeTasks: Int = 0,
    /** When they were last at work, Unix milliseconds; null when never. */
    val lastActivityAt: Long? = null,
    /** How many UTC days of the last 30 had usage. */
    val activeDays: Int = 0,
    /** By window, the four in [WINDOWS]; a window the server left out counted none. */
    val usage: Map<String, MemberUsage> = emptyMap(),
    val recentTasks: List<MemberProfileTask> = emptyList(),
) {
    companion object {
        /** The usage windows, shortest first. */
        val WINDOWS = listOf("hour", "day", "week", "month")
    }
}

object MemberProfiles {
    /** How many recent tasks the profile shows (the contract's default). */
    const val RECENT = 10

    /** Member [userId]'s profile with their [limit] latest tasks. */
    suspend fun read(client: AgentClient, userId: String, limit: Int = RECENT): MemberProfile =
        parse(client.decode<JsonObject>("GET", "/v0/users/${AgentClient.escape(userId)}/profile?limit=$limit"))
            ?: throw AgentApiException(500, "invalid_response", null)

    /** [body] as a profile; null where it has no member. A task, a window or a count it can't read is left out. */
    fun parse(body: JsonObject): MemberProfile? {
        val user = user(body["user"] as? JsonObject) ?: return null
        val stats = body["stats"] as? JsonObject
        val tasks = stats?.get("tasks") as? JsonObject
        val usage = stats?.get("usage") as? JsonObject
        return MemberProfile(
            user = user,
            totalTasks = tasks.long("total")?.toInt() ?: 0,
            activeTasks = tasks.long("active")?.toInt() ?: 0,
            lastActivityAt = stats.long("lastActivityAt"),
            activeDays = stats.long("activeDays")?.toInt() ?: 0,
            usage = MemberProfile.WINDOWS.associateWith { window -> sum(usage?.get(window) as? JsonObject) },
            recentTasks = (body["recentTasks"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.let(::task) },
        )
    }

    private fun user(user: JsonObject?): MemberProfileUser? {
        user ?: return null
        val id = user.string("id") ?: return null
        return MemberProfileUser(
            id = id,
            name = user.string("name").orEmpty(),
            photo = (user["photo"] as? JsonObject)?.string("thumbhash"),
            role = user.string("role")?.takeIf { it.isNotBlank() },
            teamRole = user.string("teamRole")?.takeIf { it.isNotBlank() },
        )
    }

    private fun task(task: JsonObject): MemberProfileTask? {
        val id = task.string("id") ?: return null
        val agent = task["agent"] as? JsonObject ?: return null
        val agentId = agent.string("id") ?: return null
        val wire = AgentCatalog.decodeAgent(agent)
        return MemberProfileTask(
            id = id,
            agentId = agentId,
            name = task.string("name")?.takeIf { it.isNotBlank() } ?: agent.string("title").orEmpty(),
            activityAt = agent.long("lastActivityAt") ?: wire?.updatedAt ?: 0,
            archived = task.string("status") == "archived" || !task["archivedAt"].isNullish(),
            working = wire?.working == true,
        )
    }

    /** One window's providers' models, summed. */
    private fun sum(window: JsonObject?): MemberUsage {
        var input = 0L
        var output = 0L
        for (provider in window?.values.orEmpty()) {
            for (model in (provider as? JsonObject)?.values.orEmpty()) {
                val counts = model as? JsonObject ?: continue
                input += counts.long("input") ?: 0
                output += counts.long("output") ?: 0
            }
        }
        return MemberUsage(input, output)
    }

    private fun JsonObject?.long(key: String): Long? = (this?.get(key) as? JsonPrimitive)?.let { it.longOrNull ?: it.content.toDoubleOrNull()?.toLong() }
}

/** A member's profile as its screen shows it: read at once, again on [retry]; a failed read keeps a profile already shown. */
class MemberProfileSource(private val read: suspend () -> MemberProfile, private val scope: CoroutineScope) {
    sealed interface State {
        data object Loading : State
        data class Loaded(val profile: MemberProfile) : State
        /** The server has no such member on this team (`404`). */
        data object Unknown : State
        data object Failed : State
    }

    private val state = MutableStateFlow<State>(State.Loading)
    val profile: StateFlow<State> = state.asStateFlow()

    init {
        scope.launch { reload() }
    }

    fun retry() {
        scope.launch { reload() }
    }

    private suspend fun reload() {
        state.value = try {
            State.Loaded(read())
        } catch (e: CancellationException) {
            throw e
        } catch (e: AgentApiException) {
            state.value.takeIf { it is State.Loaded } ?: if (e.status == 404) State.Unknown else State.Failed
        } catch (_: Exception) {
            state.value.takeIf { it is State.Loaded } ?: State.Failed
        }
    }
}
