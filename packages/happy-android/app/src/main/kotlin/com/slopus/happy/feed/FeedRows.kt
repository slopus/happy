package com.slopus.happy.feed

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.TeamUser
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.decode
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.agent.string
import com.slopus.happy.artifacts.ArtifactCover
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

/**
 * An artifact's cover as a Feed post shows it: its latest version's
 * picture, read through the artifact's file route, its shape, and the
 * [background] colour it sits on (`#rrggbb`-style, checked), if any.
 */
@Immutable
data class FeedCover(
    val artifactId: String,
    val version: Int,
    val path: String,
    val mimeType: String,
    val aspect: ArtifactCover.Aspect,
    val background: String? = null,
    val thumbhash: String? = null,
) {
    /** What the picture is kept under: the artifact file's own key, as the media library keeps it. */
    val key: String get() = "artifact/$artifactId/$version/$path"
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
    /** What those of them this phone knows are called, in the same order, for TalkBack. */
    val actorNames: List<FeedActorName> = emptyList(),
    val actorCount: Int,
    /** When it last changed, ms. */
    val lastAt: Long,
    val unread: Boolean,
    /** Null where nothing opens it (a deleted artifact). */
    val target: FeedTarget?,
    /** An artifact's cover: with it, or with a [summary], the row is a post. */
    val cover: FeedCover? = null,
    /** An artifact's summary, under the post's header: post-length, its line breaks kept. */
    val summary: String? = null,
)

/** What an actor is called (iOS `FeedActorName`): the person reading, or a name. */
@Immutable
sealed interface FeedActorName {
    data object You : FeedActorName
    data class Named(val name: String) : FeedActorName
}

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
    /** An artifact as a row shows it: its latest version's cover, summary and background too, where the computer has them. */
    @Immutable
    data class Artifact(
        val title: String,
        val type: String,
        val latestVersion: Int,
        val deleted: Boolean,
        val cover: ArtifactCover? = null,
        val summary: String? = null,
        val background: String? = null,
    ) {
        companion object {
            /** An artifact object (`GET /v0/artifacts/:id`), a tombstone too; a missing `cover` or `summary` (an older daemon) is none. */
            fun parse(o: JsonObject) = Artifact(
                title = o["title"].str.orEmpty(),
                type = o["type"].str.orEmpty(),
                latestVersion = o["latestVersion"].num?.toInt() ?: 1,
                deleted = o["status"].str == "deleted",
                cover = ArtifactCover.parse(o["cover"]),
                summary = ArtifactCover.summary(o["summary"]),
                background = ArtifactCover.background(o["background"]),
            )
        }
    }

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
        val read = Artifact.parse(readArtifact(id))
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
    /**
     * [photo] is the person's own profile photo's ThumbHash, which their
     * face wears (desktop 0ffabe03); [users] the team members read so far
     * ([com.slopus.happy.agent.TeamDirectory]), whose faces and names theirs.
     */
    fun make(
        items: List<FeedItem>, unread: (FeedItem) -> Boolean, catalog: AgentCatalog, found: FeedLookups.Found, personSeed: String,
        photo: String? = null, users: Map<String, TeamUser> = emptyMap(),
    ): List<FeedRow> {
        val owners = owners(catalog, photo, users)
        return items.mapNotNull { row(it, unread(it), catalog, found, owners, personSeed, photo, users) }
    }

    /**
     * The team members [items] show (iOS `FeedDirectory.named.people`): who
     * acted, and a task's author, other than the person; none outside a team.
     */
    fun people(items: List<FeedItem>, catalog: AgentCatalog): Set<String> {
        val me = catalog.userId ?: return emptySet()
        val people = HashSet<String>()
        for (item in items) {
            if (item.subject.type == "task") catalog.tasks[item.subject.id]?.string("ownerUserId")?.let(people::add)
            item.actors.mapNotNullTo(people) { it.userId }
        }
        return people - me
    }

    /** A bot's or task's conversation: the face it wears and what it is called, by agent ID. */
    internal class Owner(val face: FeedFace.Mark, val name: String?)

    internal fun owners(catalog: AgentCatalog, photo: String? = null, users: Map<String, TeamUser> = emptyMap()): Map<String, Owner> {
        val owners = HashMap<String, Owner>()
        for ((kind, list) in listOf("task" to catalog.tasks.values, "bot" to catalog.bots.values)) {
            for (owner in list) {
                val agentId = (owner["agent"] as? JsonObject)?.string("id") ?: continue
                val name = owner.string("name") ?: (owner["agent"] as? JsonObject)?.string("title")
                owners[agentId] = Owner(mark(kind, owner, catalog, photo, users), name)
            }
        }
        return owners
    }

    /**
     * A bot's or task's mark, as home's rows wear it: in a team, a task its
     * author's face (iOS `SidebarRows.ownerMark`), the person's own from
     * [photo], another member's from [users], else that member's placeholder.
     */
    internal fun mark(kind: String, owner: JsonObject, catalog: AgentCatalog, photo: String?, users: Map<String, TeamUser>): FeedFace.Mark {
        val author = owner.string("ownerUserId")?.takeIf { kind == "task" && catalog.userId != null } ?: return mark(kind, owner)
        val face = if (author == catalog.userId) photo else users[author]?.photo
        return FeedFace.Mark(author, round = false, picture = face?.let { TeamUser.photoPath(author) }, thumbhash = face)
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

    private fun row(
        item: FeedItem, unread: Boolean, catalog: AgentCatalog, found: FeedLookups.Found, owners: Map<String, Owner>, personSeed: String,
        photo: String?, users: Map<String, TeamUser>,
    ): FeedRow? {
        val id = item.subject.id
        val title: String
        val face: FeedFace
        val kind: FeedSubjectKind
        var detail: String? = null
        var cover: FeedCover? = null
        var summary: String? = null
        val target: FeedTarget?
        when (item.subject.type) {
            "task", "bot" -> {
                val isBot = item.subject.type == "bot"
                val owner = (if (isBot) catalog.bots else catalog.tasks)[id] ?: return null
                val name = owner.string("name") ?: (owner["agent"] as? JsonObject)?.string("title")
                if (name.isNullOrEmpty()) return null
                title = name
                face = mark(item.subject.type, owner, catalog, photo, users)
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
                // A cover this phone can draw, or a summary, makes the row a post; a deleted one keeps the row.
                if (!artifact.deleted) {
                    cover = artifact.cover?.takeIf { it.drawable }?.let { c -> FeedCover(id, artifact.latestVersion, c.path, c.mimeType, c.aspect, artifact.background, c.thumbhash) }
                    summary = artifact.summary
                }
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
            actors = item.actors.take(MAX_FACES).map { face(it, catalog, owners, personSeed, photo, users) },
            actorNames = item.actors.mapNotNull { name(it, catalog, owners, users) },
            actorCount = maxOf(item.actorCount, item.actors.size),
            lastAt = item.lastAt,
            unread = unread,
            target = target,
            cover = cover,
            summary = summary,
        )
    }

    /**
     * Who made a change (iOS `FeedDirectory.face`): an agent wears its bot's
     * or task's face, else its own placeholder; a person their picture over
     * its ThumbHash (the person's own from [photo], a member's as read into
     * [users]), else their placeholder, round; nobody (standalone) the
     * installation's one person.
     */
    internal fun face(
        actor: FeedActor, catalog: AgentCatalog, owners: Map<String, Owner>, personSeed: String,
        photo: String? = null, users: Map<String, TeamUser> = emptyMap(),
    ): FeedFace {
        actor.agentId?.let { agentId -> return owners[agentId]?.face ?: FeedFace.Mark(agentId, round = false) }
        val id = actor.userId ?: return FeedFace.Mark(catalog.userId ?: personSeed, round = true, picture = photo?.let { PROFILE_PHOTO }, thumbhash = photo)
        val face = if (id == catalog.userId) photo else users[id]?.photo
        return FeedFace.Mark(id, round = true, picture = face?.let { TeamUser.photoPath(id) }, thumbhash = face)
    }

    /** What [actor] is called (iOS `FeedDirectory.name`); null while this phone doesn't know. */
    internal fun name(actor: FeedActor, catalog: AgentCatalog, owners: Map<String, Owner>, users: Map<String, TeamUser>): FeedActorName? {
        actor.agentId?.let { agentId ->
            val name = owners[agentId]?.name ?: catalog.agent(agentId)?.title
            return name?.takeIf { it.isNotEmpty() }?.let(FeedActorName::Named)
        }
        val id = actor.userId
        if (id != null && id != catalog.userId) return users[id]?.name?.takeIf { it.isNotEmpty() }?.let(FeedActorName::Named)
        return FeedActorName.You
    }

    /** The person's own photo, as the agent serves it. */
    const val PROFILE_PHOTO = "/v0/profile/photo"
}
