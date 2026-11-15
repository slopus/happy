package com.slopus.happy.agent

import androidx.compose.runtime.Immutable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** A member from the desktop bootstrap's teammates. */
@Immutable
@Serializable
data class TeamUser(val id: String, val name: String = "", val photo: String? = null) {
    companion object {
        fun photoPath(id: String) = "/v0/users/${AgentClient.escape(id)}/photo"

        fun parse(users: JsonArray?): List<TeamUser> = users.orEmpty().mapNotNull { element ->
            val user = element as? JsonObject ?: return@mapNotNull null
            val id = user.string("id") ?: return@mapNotNull null
            TeamUser(id, user.string("name").orEmpty(), (user["photo"] as? JsonObject)?.string("thumbhash"))
        }
    }
}

/** The bootstrap's people, kept so names and faces are also available offline. */
class TeamDirectory(
    scope: CoroutineScope,
    private val kept: suspend () -> JsonObject? = { null },
    private val keep: suspend (JsonObject) -> Unit = {},
) {
    private val usersState = MutableStateFlow<Map<String, TeamUser>>(emptyMap())
    val users: StateFlow<Map<String, TeamUser>> = usersState.asStateFlow()
    private val restored = scope.launch {
        kept()?.let { usersState.value = TeamUser.parse(it["users"] as? JsonArray).associateBy(TeamUser::id) }
    }

    suspend fun bootstrap(teammates: JsonArray?, profile: JsonObject?) {
        restored.join()
        val people = if (teammates != null) TeamUser.parse(teammates) else {
            profile?.string("userId")?.let { id ->
                listOf(TeamUser(id, profile.string("name").orEmpty(), (profile["photo"] as? JsonObject)?.string("thumbhash")))
            }.orEmpty()
        }
        val next = people.associateBy(TeamUser::id)
        if (next == usersState.value) return
        usersState.value = next
        keep(buildJsonObject { put("users", JsonArray(people.map { user ->
            buildJsonObject {
                put("id", user.id)
                put("name", user.name)
                user.photo?.let { hash -> put("photo", buildJsonObject { put("thumbhash", hash) }) }
            }
        })) })
    }

    fun names(ids: Set<String>): Map<String, String> = usersState.value.filterKeys(ids::contains)
        .mapNotNull { (id, user) -> user.name.takeIf(String::isNotEmpty)?.let { id to it } }.toMap()

    companion object { const val RESOURCE = "users" }
}