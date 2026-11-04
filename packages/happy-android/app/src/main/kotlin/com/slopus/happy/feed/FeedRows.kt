package com.slopus.happy.feed

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.decode
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.agent.string
import com.slopus.happy.artifacts.ArtifactRef
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/** What a Feed entry is about, as far as its glyph and its changes' noun go (desktop's `feedSubjectKind`). */
enum class FeedSubjectKind {
    Task, Bot, Artifact, Document, TodoList, Calendar, Surface;

    companion object {
        fun of(subject: String, surfaceType: String? = null): FeedSubjectKind? = when (subject) {
            "task" -> Task
            "bot" -> Bot
            "artifact" -> Artifact
            "surface" -> when (surfaceType) {
                "todo" -> TodoList
                "document" -> Document
                "calendar" -> Calendar
                else -> Surface
            }
            else -> null
        }
    }
}

/**
 * An avatar on the Feed (iOS `FeedFace`): a mark as home draws one (a
 * bot's picture over its ThumbHash, Happy's own, or the placeholder its
 * [seed] picks), round for a person and a rounded square for anything
 * else; or a kind's glyph on its tile.
 */
@Immutable
sealed interface FeedFace {
    data class Mark(val seed: String, val round: Boolean, val picture: String? = null, val thumbhash: String? = null, val happy: Boolean = false) : FeedFace
    data class Tile(val kind: FeedSubjectKind, val artifactType: String? = null) : FeedFace
}

/** Where opening a Feed entry goes. */
@Immutable
sealed interface FeedTarget {
    /** A task's or bot's chat, by its conversation. */
    data class Chat(val agentId: String, val title: String) : FeedTarget
    data class Surface(val id: String, val type: String, val name: String) : FeedTarget
    data class Artifact(val ref: ArtifactRef) : FeedTarget
}

/**
 * One Feed row, joined from its entry and what the connection syncs:
 * everything the row draws and opens, so two equal rows draw the same and
 * a rename changes exactly the rows that show the renamed thing.
 */
@Immutable
data class FeedRow(
    /** The entry's ID. */
    val id: String,
    val title: String,
    val face: FeedFace,
    val kind: FeedSubjectKind,
    /** The newest change's own words: a new todo's text. */
    val detail: String?,
    val created: Boolean,
    val updates: Int,
    /** Who acted, the first few, in the order they first did. */
    val actors: List<FeedFace>,
    val actorCount: Int,
    /** When it last changed, ms. */
    val lastAt: Long,
    val unread: Boolean,
    /** Null where nothing opens it (a deleted artifact). */
    val target: FeedTarget?,
)

/**
 * What the Feed names that the connection doesn't sync whole (iOS
 * `FeedLookups`): artifacts, read by ID, and the todo an entry's newest
 * change made. Each is read once it is named and read again when an event
 * says it changed, so a row follows it. A thing the computer says isn't
 * there isn't asked for again. Held for as long as the connection.
 */
class FeedLookups(
    private val scope: CoroutineScope,
    /** `GET /v0/artifacts/:id`'s artifact, a tombstone too. */
    private val readArtifact: suspend (String) -> JsonObject,
    /** `GET /v0/surfaces/todo/:surfaceId/:todoId`'s todo. */
    private val readTodo: suspend (surfaceId: String, todoId: String) -> JsonObject,
) {
    /** An artifact as a row shows it. */
    @Immutable
    data class Artifact(val title: String, val type: String, val latestVersion: Int, val deleted: Boolean)

    @Immutable
    data class Found(
        val artifacts: Map<String, Artifact> = emptyMap(),
        /** Todos' words by `surfaceId/todoId`. */
        val todos: Map<String, String> = emptyMap(),
        /** Asked and not there: never shown. */
        val missing: Set<String> = emptySet(),
    )

    private val foundState = MutableStateFlow(Found())
    val found: StateFlow<Found> = foundState.asStateFlow()
    private val asked = HashSet<String>()

    /** Reads what [items] name and isn't held yet. */
    fun want(items: List<FeedItem>) {
        for (item in items) {
            when (item.subject.type) {
                "artifact" -> ask("artifact:${item.subject.id}") { artifact(item.subject.id) }
                "surface" -> {
                    val todoId = item.latest?.todoId?.takeIf { item.latest.type == "todo.created" } ?: continue
                    ask("todo:${todoKey(item.subject.id, todoId)}") { todo(item.subject.id, todoId) }
                }
            }
        }
    }

    /** An artifact held changed: its title, its deletion follow. */
    fun receive(event: AgentEvent) {
        if (event.type != "artifact.updated" && event.type != "artifact.deleted") return
        val id = event.data["artifactId"].str ?: return
        if (foundState.value.artifacts[id] == null) return
        scope.launch { artifact(id) }
    }

    private fun ask(key: String, read: suspend () -> Unit) {
        synchronized(asked) { if (!asked.add(key)) return }
        scope.launch {
            try {
                read()
            } catch (e: CancellationException) {
                throw e
            } catch (e: AgentApiException) {
                if (e.status == 404) foundState.update { it.copy(missing = it.missing + key) } else synchronized(asked) { asked.remove(key) }
            } catch (_: Exception) {
                // Asked again by the next change that names it.
                synchronized(asked) { asked.remove(key) }
            }
        }
    }

    private suspend fun artifact(id: String) {
        val o = readArtifact(id)
        val read = Artifact(o["title"].str.orEmpty(), o["type"].str.orEmpty(), o["latestVersion"].num?.toInt() ?: 1, o["status"].str == "deleted")
        foundState.update { it.copy(artifacts = it.artifacts + (id to read)) }
    }

    private suspend fun todo(surfaceId: String, todoId: String) {
        val text = readTodo(surfaceId, todoId)["text"].str ?: return
        // A heading (`# Groceries`) reads as its label.
        val shown = if (text.startsWith("#")) text.trimStart('#').trim() else text
        foundState.update { it.copy(todos = it.todos + (todoKey(surfaceId, todoId) to shown)) }
    }

    companion object {
        fun todoKey(surfaceId: String, todoId: String) = "$surfaceId/$todoId"

        /** Lookups through [client]. */
        fun of(scope: CoroutineScope, client: AgentClient, readArtifact: suspend (String) -> JsonObject) = FeedLookups(
            scope,
            readArtifact,
            readTodo = { surfaceId, todoId ->
                client.decode<JsonObject>("GET", "/v0/surfaces/todo/${AgentClient.escape(surfaceId)}/${AgentClient.escape(todoId)}")["todo"].obj ?: JsonObject(emptyMap())
            },
        )
    }
}

/** Feed rows from entries and what the connection syncs (iOS `FeedRows`). */
object FeedRows {
    /** The faces a row shows of who acted. */
    const val MAX_FACES = 3

    /**
     * A row for each entry that can be shown, in their order. An entry
     * whose subject isn't held is left out, never shown with a stand-in.
     */
    fun make(items: List<FeedItem>, unread: (FeedItem) -> Boolean, catalog: AgentCatalog, found: FeedLookups.Found, personSeed: String): List<FeedRow> {
        val owners = owners(catalog)
        return items.mapNotNull { row(it, unread(it), catalog, found, owners, personSeed) }
    }

    /** A bot's or task's conversation: the face it wears, by agent ID. */
    internal class Owner(val face: FeedFace.Mark)

    internal fun owners(catalog: AgentCatalog): Map<String, Owner> {
        val owners = HashMap<String, Owner>()
        for ((kind, list) in listOf("task" to catalog.tasks.values, "bot" to catalog.bots.values)) {
            for (owner in list) {
                val agentId = (owner["agent"] as? JsonObject)?.string("id") ?: continue
                owners[agentId] = Owner(mark(kind, owner))
            }
        }
        return owners
    }

    /** A bot's or task's mark, as home's rows wear it. */
    internal fun mark(kind: String, owner: JsonObject): FeedFace.Mark {
        val id = owner.string("id").orEmpty()
        val avatar = owner["avatar"] as? JsonObject
        return FeedFace.Mark(
            seed = id,
            round = false,
            picture = if (kind == "bot" && avatar != null) "/v0/bots/${AgentClient.escape(id)}/avatar" else null,
            thumbhash = avatar?.string("thumbhash"),
            happy = kind == "bot" && owner.string("systemKey") == "chief_of_staff",
        )
    }

    private fun row(item: FeedItem, unread: Boolean, catalog: AgentCatalog, found: FeedLookups.Found, owners: Map<String, Owner>, personSeed: String): FeedRow? {
        val id = item.subject.id
        val title: String
        val face: FeedFace
        val kind: FeedSubjectKind
        var detail: String? = null
        val target: FeedTarget?
        when (item.subject.type) {
            "task", "bot" -> {
                val isBot = item.subject.type == "bot"
                val owner = (if (isBot) catalog.bots else catalog.tasks)[id] ?: return null
                val name = owner.string("name") ?: (owner["agent"] as? JsonObject)?.string("title")
                if (name.isNullOrEmpty()) return null
                title = name
                face = mark(item.subject.type, owner)
                kind = if (isBot) FeedSubjectKind.Bot else FeedSubjectKind.Task
                target = (owner["agent"] as? JsonObject)?.string("id")?.let { FeedTarget.Chat(it, name) }
            }
            "surface" -> {
                val surface = catalog.surfaces[id] ?: return null
                val name = surface.string("name")
                if (name.isNullOrEmpty()) return null
                val type = surface.string("type").orEmpty()
                title = name
                kind = FeedSubjectKind.of("surface", type) ?: return null
                face = FeedFace.Tile(kind)
                val latest = item.latest
                if (latest?.type == "todo.created" && latest.todoId != null) detail = found.todos[FeedLookups.todoKey(id, latest.todoId)]
                target = FeedTarget.Surface(id, type, name)
            }
            "artifact" -> {
                val artifact = found.artifacts[id] ?: return null
                if (artifact.title.isEmpty()) return null
                title = artifact.title
                kind = FeedSubjectKind.Artifact
                face = FeedFace.Tile(kind, artifact.type)
                // A deleted one's versions are gone: it shows, and opens nothing.
                target = if (artifact.deleted) null else FeedTarget.Artifact(ArtifactRef(id, artifact.latestVersion, artifact.type, artifact.title, followsLatest = true))
            }
            else -> return null
        }
        return FeedRow(
            id = item.id,
            title = title,
            face = face,
            kind = kind,
            detail = detail?.trim()?.replace('\n', ' ')?.takeIf { it.isNotEmpty() },
            created = item.created,
            updates = item.updates,
            actors = item.actors.take(MAX_FACES).map { face(it, catalog, owners, personSeed) },
            actorCount = maxOf(item.actorCount, item.actors.size),
            lastAt = item.lastAt,
            unread = unread,
            target = target,
        )
    }

    /**
     * Who made a change: an agent wears its bot's or task's face, else its
     * own placeholder; a person their placeholder, round; nobody
     * (standalone) the installation's one person.
     */
    internal fun face(actor: FeedActor, catalog: AgentCatalog, owners: Map<String, Owner>, personSeed: String): FeedFace {
        actor.agentId?.let { agentId -> return owners[agentId]?.face ?: FeedFace.Mark(agentId, round = false) }
        return FeedFace.Mark(actor.userId ?: catalog.userId ?: personSeed, round = true)
    }
}
