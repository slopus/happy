package com.slopus.happy.references

import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.agent.decode
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlin.coroutines.CoroutineContext

/**
 * One connection's [References], live (iOS Store's `references`): the
 * entities from its [catalog], and the artifact titles and people's names
 * its messages named, read once each when a message is first built
 * ([read]) and kept for as long as the connection. An `artifact.updated`
 * or `artifact.deleted` changes a title already read, and an HTML
 * artifact's is read again, so a page shown inline follows its latest
 * version, entry and display.
 */
class ReferenceReader(
    private val scope: CoroutineScope,
    catalog: StateFlow<AgentCatalog>,
    events: Flow<AgentEvent>,
    /** `GET /v0/artifacts/:id`'s artifact. */
    private val readArtifact: suspend (String) -> JsonObject,
    /** `GET /v0/users?ids=`: the names of at most 100 people, by ID. */
    private val readUsers: suspend (List<String>) -> Map<String, String>,
    private val io: CoroutineContext = Dispatchers.IO,
    /** Where the readings are put together. */
    compute: CoroutineContext = Dispatchers.Default,
) {
    private val artifacts = MutableStateFlow<Map<String, References.Artifact>>(emptyMap())
    private val pages = MutableStateFlow<Map<String, References.Page>>(emptyMap())
    private val users = MutableStateFlow<Map<String, String>>(emptyMap())
    private val missingUsers = MutableStateFlow<Set<String>>(emptySet())
    private val wordState = MutableStateFlow(ReferenceWords.English)
    private val artifactReads = HashSet<String>()
    private val userReads = HashSet<String>()

    private class Entities(val agents: Map<String, References.Entity>, val workspaces: Map<String, References.Entity>, val me: String?) {
        override fun equals(other: Any?) = other is Entities && other.agents == agents && other.workspaces == workspaces && other.me == me
        override fun hashCode() = agents.hashCode() * 31 + workspaces.hashCode()
    }

    private fun entities(catalog: AgentCatalog) = References.entities(catalog).let { (agents, workspaces) -> Entities(agents, workspaces, catalog.userId) }

    /** What references read as now; equal readings are the same instance, so a row built with one is built again only when it changes. */
    val references: StateFlow<References> = combine(
        catalog.map(::entities).distinctUntilChanged(),
        combine(artifacts, pages, ::Pair), users, missingUsers, wordState,
    ) { entities, (artifacts, pages), users, missing, words ->
        References(entities.agents, entities.workspaces, artifacts, pages, users = users, me = entities.me, missingUsers = missing, words = words)
    }
        .distinctUntilChanged()
        .flowOn(compute)
        .stateIn(scope, SharingStarted.Eagerly, entities(catalog.value).let { References(it.agents, it.workspaces, me = it.me) })

    init {
        scope.launch { events.collect(::take) }
    }

    /** The words the app reads unnamed references in, from its strings. */
    fun setWords(words: ReferenceWords) {
        wordState.value = words
    }

    /** Reads the artifacts and people [text] names that haven't been read yet, once each. Any thread. */
    fun read(text: String) {
        if (!References.mayHold(text)) return
        val now = references.value
        val titles = now.unread(text)
        val people = now.unknownUsers(text).filter { it !in now.missingUsers }
        if (titles.isNotEmpty()) readArtifacts(titles)
        if (people.isNotEmpty()) readPeople(people)
    }

    /** Reads [ids]' titles, whether or not they were read before; one read at a time each. */
    fun readArtifacts(ids: List<String>) {
        val wanted = synchronized(artifactReads) { ids.filter(artifactReads::add) }
        if (wanted.isEmpty()) return
        scope.launch(io) {
            for (id in wanted) {
                var page: References.Page? = null
                val read = try {
                    readArtifact(id).let { artifact ->
                        page = References.page(artifact)
                        References.artifact(artifact)
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: AgentApiException) {
                    if (e.status == 404) References.Artifact.Missing else null
                } catch (_: Exception) {
                    null
                }
                synchronized(artifactReads) { artifactReads.remove(id) }
                // Not read (offline, refused): asked again by the next message that names it.
                if (read != null) {
                    pages.update { held -> page?.let { held + (id to it) } ?: (held - id) }
                    artifacts.update { it + (id to read) }
                }
            }
        }
    }

    private fun readPeople(ids: List<String>) {
        val wanted = synchronized(userReads) { ids.filter(userReads::add) }
        if (wanted.isEmpty()) return
        scope.launch(io) {
            val names = HashMap<String, String>()
            for (batch in wanted.chunked(100)) {
                try {
                    names.putAll(readUsers(batch))
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                }
            }
            synchronized(userReads) { userReads.removeAll(wanted.toSet()) }
            users.update { held -> held + names.filterValues { it.isNotEmpty() } }
            // An answer that named nobody may be a computer without people; only one that named some says who it doesn't know.
            if (names.isNotEmpty()) missingUsers.update { it + wanted.filter { id -> names[id].isNullOrEmpty() } }
        }
    }

    /** An artifact a message named changed: its title, or its deletion, follows; an HTML one's page is read again. */
    private fun take(event: AgentEvent) {
        if (event.type != "artifact.updated" && event.type != "artifact.deleted") return
        val id = event.data["artifactId"].str ?: return
        val changes = event.data["changes"].obj ?: JsonObject(emptyMap())
        val deleted = event.type == "artifact.deleted" || changes["status"].str == "deleted"
        artifacts.update { held ->
            val before = held[id] ?: return@update held
            val after = when {
                deleted -> References.Artifact.Deleted(
                    when (before) {
                        is References.Artifact.Active -> before.title
                        is References.Artifact.Deleted -> before.title
                        References.Artifact.Missing -> ""
                    },
                )
                before is References.Artifact.Active -> before.copy(
                    title = changes["title"].str ?: before.title,
                    latestVersion = changes["latestVersion"].num?.toInt() ?: before.latestVersion,
                )
                else -> before
            }
            if (after == before) held else held + (id to after)
        }
        if (deleted) {
            pages.update { it - id }
        } else if ((artifacts.value[id] as? References.Artifact.Active)?.type.let { it == "html" || it == "gen_ui" }) {
            readArtifacts(listOf(id))
        }
    }

    companion object {
        /** `GET /v0/users?ids=`: the names of [ids] (at most 100), by ID; "" for a person without one. */
        suspend fun userNames(client: AgentClient, ids: List<String>): Map<String, String> {
            if (ids.isEmpty()) return emptyMap()
            val answer = client.decode<JsonObject>("GET", "/v0/users?ids=" + ids.take(100).joinToString(",", transform = AgentClient::escape))
            return (answer["users"] as? JsonArray).orEmpty().mapNotNull { user ->
                val o = user.obj ?: return@mapNotNull null
                o["id"].str?.let { it to o["name"].str.orEmpty() }
            }.toMap()
        }
    }
}
