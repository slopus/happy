package com.slopus.happy.agent

import androidx.compose.runtime.Immutable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * A team member as `GET /v0/users` describes them (iOS `TeamUser`): their
 * name and their picture's ThumbHash, the bytes being at [photoPath].
 */
@Immutable
@Serializable
data class TeamUser(val id: String, val name: String = "", val photo: String? = null) {
    companion object {
        /** Where member [id]'s picture is read. */
        fun photoPath(id: String) = "/v0/users/${AgentClient.escape(id)}/photo"

        /** Members as the agent lists them; one it can't read is left out, a picture it can't read is none. */
        fun parse(users: JsonArray?): List<TeamUser> = users.orEmpty().mapNotNull { element ->
            val user = element as? JsonObject ?: return@mapNotNull null
            val id = user.string("id") ?: return@mapNotNull null
            TeamUser(id, user.string("name").orEmpty(), (user["photo"] as? JsonObject)?.string("thumbhash"))
        }

        /**
         * The members whose faces the person's listed tasks wear (iOS
         * `SidebarRows.authors`), other than the person, whose own is the
         * profile's; none outside a team.
         */
        fun authors(catalog: AgentCatalog): Set<String> {
            val me = catalog.userId ?: return emptySet()
            return catalog.tasks.values
                .filter { task -> task.string("id") in catalog.memberships && task.string("status") != "archived" }
                .mapNotNullTo(HashSet()) { it.string("ownerUserId") } - me
        }
    }
}

/** Members by ID, at most 100 a read (`GET /v0/users?ids=`); unknown ones are left out. */
suspend fun AgentClient.teamUsers(ids: List<String>): List<TeamUser> {
    if (ids.isEmpty()) return emptyList()
    val answer = decode<JsonObject>("GET", "/v0/users?ids=" + ids.take(TeamDirectory.BATCH).joinToString(",") { AgentClient.escape(it) })
    return TeamUser.parse(answer["users"] as? JsonArray)
}

/**
 * The team members this phone shows (iOS SyncEngine `users`, `readAuthors`):
 * their names and faces, read as something names them and kept beside the
 * catalog, so a relaunch draws them before the computer answers. One read
 * at a time; what is asked meanwhile goes with the next. A member the
 * computer doesn't know, or one asked while it can't answer, wears their
 * placeholder until [connected] asks again. Outside a team the computer
 * answers 404 and nobody is read twice.
 */
class TeamDirectory(
    private val scope: CoroutineScope,
    private val read: suspend (List<String>) -> List<TeamUser>,
    private val kept: suspend () -> JsonObject? = { null },
    private val keep: suspend (JsonObject) -> Unit = {},
) {
    private val usersState = MutableStateFlow<Map<String, TeamUser>>(emptyMap())

    /** Every member read, by ID. */
    val users: StateFlow<Map<String, TeamUser>> = usersState.asStateFlow()

    private val lock = Any()
    private val wanted = HashSet<String>()
    private val missing = HashSet<String>()
    private val again = HashSet<String>()
    private val asks = Channel<Unit>(Channel.CONFLATED)

    init {
        scope.launch {
            kept()?.let { saved -> TeamUser.parse(saved["users"] as? JsonArray) }?.let { saved ->
                usersState.update { current -> saved.associateBy(TeamUser::id) + current }
            }
            for (ask in asks) readWanted()
        }
    }

    /** Reads those of [ids] not known yet. */
    fun want(ids: Collection<String>) {
        val asked = synchronized(lock) { wanted.addAll(ids) }
        if (asked || ids.any { it !in usersState.value }) asks.trySend(Unit)
    }

    /** Member [id]'s name or picture changed (`profile.updated` in a team): read again if shown. */
    fun changed(id: String) {
        synchronized(lock) {
            if (id !in wanted) return
            missing -= id
            again += id
        }
        asks.trySend(Unit)
    }

    /** The link is back: anyone may have changed meanwhile, and those not read are asked again. */
    fun connected() {
        synchronized(lock) {
            missing.clear()
            again += wanted
        }
        asks.trySend(Unit)
    }

    /** Names for [ids], read where not known yet (a revision's people). */
    suspend fun names(ids: Set<String>): Map<String, String> {
        want(ids)
        val unknown = ids.filter { it !in usersState.value }
        if (unknown.isNotEmpty()) readNow(unknown)
        return usersState.value.filterKeys(ids::contains).mapNotNull { (id, user) -> user.name.takeIf { it.isNotEmpty() }?.let { id to it } }.toMap()
    }

    private suspend fun readWanted() {
        val ids = synchronized(lock) {
            val known = usersState.value
            val ids = wanted.filter { (it !in known && it !in missing) || it in again }.sorted()
            again.removeAll(ids.toSet())
            ids
        }
        if (ids.isNotEmpty()) readNow(ids)
    }

    private suspend fun readNow(ids: List<String>) {
        val found = ArrayList<TeamUser>()
        try {
            for (batch in ids.chunked(BATCH)) found += read(batch)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Asked again when the link comes back; meanwhile they wear their placeholders.
            synchronized(lock) { missing += ids }
            return
        }
        synchronized(lock) { missing += ids.toSet() - found.map(TeamUser::id).toSet() }
        val next = usersState.value + found.associateBy(TeamUser::id)
        // A read that changed nothing redraws and writes nothing.
        if (next == usersState.value) return
        usersState.value = next
        keep(buildJsonObject { put("users", JsonArray(next.values.sortedBy(TeamUser::id).map(::json))) })
    }

    private fun json(user: TeamUser) = buildJsonObject {
        put("id", JsonPrimitive(user.id))
        put("name", JsonPrimitive(user.name))
        user.photo?.let { put("photo", buildJsonObject { put("thumbhash", JsonPrimitive(it)) }) }
    }

    companion object {
        const val BATCH = 100
        /** Where the members are kept beside the catalog ([AgentSession.keepResource]). */
        const val RESOURCE = "users"
    }
}
