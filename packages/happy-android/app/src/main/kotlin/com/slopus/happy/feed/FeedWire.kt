package com.slopus.happy.feed

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.decode
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * What one Feed entry is about (API.md "Feed", iOS `FeedSubject`): a task,
 * bot, Surface or artifact by its ID. The set of types grows with the
 * product; one this phone doesn't know can't be shown, so its entry is left out.
 */
@Immutable
data class FeedSubject(val type: String, val id: String) {
    /** One string per subject: an intent's target. */
    val key: String get() = "$type:$id"

    companion object {
        fun surface(id: String) = FeedSubject("surface", id)
        fun artifact(id: String) = FeedSubject("artifact", id)
    }
}

/** Who made a change: a person ([userId], no agent), an agent, or nobody (standalone: the installation's one person). */
@Immutable
data class FeedActor(val userId: String? = null, val agentId: String? = null)

/**
 * The newest change folded into an entry, by reference: what it was
 * (`task.created`, `todo.created`, `artifact.updated`, …) and the todo or
 * artifact version it made. The first Feed daemons send none.
 */
@Immutable
data class FeedLatest(val type: String, val todoId: String? = null, val seq: Int? = null, val artifactVersion: Int? = null)

/**
 * One entry of the person's feed (iOS `FeedItem`): references and counts
 * only, never its subject's data. Of two copies the greater [version]
 * wins; [cursor] is the feed's order, newest first (UUIDv7s sort as text).
 */
@Immutable
data class FeedItem(
    val id: String,
    val version: String,
    val cursor: String,
    val subject: FeedSubject,
    val created: Boolean = false,
    val updates: Int = 0,
    /** The first five distinct actors, in the order they first acted. */
    val actors: List<FeedActor> = emptyList(),
    val actorCount: Int = actors.size,
    val latest: FeedLatest? = null,
    val firstAt: Long = 0,
    val lastAt: Long = firstAt,
    /** Null while the entry is open. */
    val seenAt: Long? = null,
) {
    val open: Boolean get() = seenAt == null

    fun json(): JsonObject = buildJsonObject {
        put("id", id)
        put("version", version)
        put("cursor", cursor)
        put("subject", buildJsonObject { put("type", subject.type); put("id", subject.id) })
        put("created", created)
        put("updates", updates)
        put("actors", buildJsonArray { actors.forEach { a -> add(buildJsonObject { a.userId?.let { put("userId", it) }; a.agentId?.let { put("agentId", it) } }) } })
        put("actorCount", actorCount)
        latest?.let { l ->
            put("latest", buildJsonObject {
                put("type", l.type)
                l.todoId?.let { put("todoId", it) }
                l.seq?.let { put("seq", it) }
                l.artifactVersion?.let { put("artifactVersion", it) }
            })
        }
        put("firstAt", firstAt)
        put("lastAt", lastAt)
        seenAt?.let { put("seenAt", it) }
    }

    companion object {
        /** An entry as the computer sends it, or as kept; a peek's has no id or version of its own. Null for one that can't be read. */
        fun parse(element: JsonElement?): FeedItem? {
            val o = element.obj ?: return null
            val subject = o["subject"].obj ?: return null
            val type = subject["type"].str ?: return null
            val subjectId = subject["id"].str ?: return null
            val cursor = o["cursor"].str ?: return null
            val s = FeedSubject(type, subjectId)
            val actors = o["actors"].arr.orEmpty().mapNotNull { a -> a.obj?.let { FeedActor(it["userId"].str, it["agentId"].str) } }
            val firstAt = o["firstAt"].num?.toLong() ?: 0
            return FeedItem(
                id = o["id"].str ?: s.key,
                version = o["version"].str.orEmpty(),
                cursor = cursor,
                subject = s,
                created = (o["created"] as? JsonPrimitive)?.booleanOrNull ?: false,
                updates = (o["updates"].num?.toInt() ?: 0).coerceAtLeast(0),
                actors = actors,
                actorCount = maxOf(actors.size, o["actorCount"].num?.toInt() ?: 0),
                latest = o["latest"].obj?.let { l -> l["type"].str?.let { FeedLatest(it, l["todoId"].str, l["seq"].num?.toInt(), l["artifactVersion"].num?.toInt()) } },
                firstAt = firstAt,
                lastAt = o["lastAt"].num?.toLong() ?: firstAt,
                seenAt = o["seenAt"].takeUnless { it is JsonNull }.num?.toLong(),
            )
        }

        fun list(element: JsonElement?): List<FeedItem> = element.arr.orEmpty().mapNotNull(::parse)

        /** Newest change first. */
        val newestFirst: Comparator<FeedItem> = Comparator { a, b -> if (a.cursor != b.cursor) b.cursor.compareTo(a.cursor) else a.id.compareTo(b.id) }
    }
}

/**
 * One place the feed gathers from (`The cluster object`): everything
 * (`*`), the team, or one task, bot, Surface, project or workspace. What
 * it is called comes from what the phone syncs.
 */
@Immutable
data class FeedCluster(
    val cluster: String,
    val kind: String,
    /** The person's own choice: `subscribed`, `muted`, or null to follow `*`. */
    val state: String? = null,
) {
    /** The ID of the thing a place's cluster (`<kind>:<id>`) names. */
    val placeId: String? get() = cluster.takeIf { it.startsWith("$kind:") }?.removePrefix("$kind:")

    companion object {
        fun parse(element: JsonElement?): FeedCluster? {
            val o = element.obj ?: return null
            val cluster = o["cluster"].str ?: return null
            return FeedCluster(cluster, o["kind"].str ?: kindOf(cluster), o["state"].str)
        }

        fun kindOf(cluster: String): String = when {
            cluster == "*" -> "everything"
            ':' in cluster -> cluster.substringBefore(':')
            else -> cluster
        }
    }
}

/**
 * Which entries the Feed shows (the Highlights filter): all of them, or
 * only those about artifacts and tasks. The person's choice is kept per
 * connection.
 */
enum class FeedFilter(val wire: String, val subjects: Set<String>?) {
    All("all", null),
    Highlights("highlights", setOf("artifact", "task"));

    fun admits(item: FeedItem): Boolean = subjects == null || item.subject.type in subjects

    companion object {
        fun of(wire: String?): FeedFilter = entries.firstOrNull { it.wire == wire } ?: All
    }
}

/**
 * `GET /v0/feed`. [unread] is the person's whole count; [filteredUnread]
 * the filtered list's, from a daemon that filters by subject.
 */
data class FeedPage(val items: List<FeedItem>, val unread: Int, val hasMore: Boolean, val cursor: String? = null, val filteredUnread: Int? = null)

/** What health says of the Feed: whether there is one, and whether it filters by subject (`feedSubjectFilter`). */
data class FeedCapabilities(val feed: Boolean, val subjectFilter: Boolean = false)

/** The Feed's routes (API.md "Feed"), as the library uses them: the computer's, or a test's fake. */
interface FeedRoutes {
    /** `capabilities.feed` and `capabilities.feedSubjectFilter`. */
    suspend fun capabilities(): FeedCapabilities
    /** One page; [subjects] limits it to entries about those types (only where health says the daemon filters). */
    suspend fun page(before: String?, limit: Int, subjects: Set<String>? = null): FeedPage
    /** The entries it closed, and what is open. */
    suspend fun seen(subject: FeedSubject, through: String?, mutationId: String): Pair<List<FeedItem>, Int>
    /** What stays open; [subjects] closes only entries about those types. */
    suspend fun readAll(through: String?, mutationId: String, subjects: Set<String>? = null): Int
    suspend fun clusters(): List<FeedCluster>
    /** Follows [cluster], or mutes it; what the computer says it is now. */
    suspend fun follow(cluster: String, follow: Boolean, mutationId: String): FeedCluster
    /** A place's newest entries, as Following peeks at them (`GET /v0/feed/clusters/:cluster`). */
    suspend fun peek(cluster: String, limit: Int): List<FeedItem>
}

/** The Feed's routes through [client]. */
class AgentFeedRoutes(private val client: AgentClient) : FeedRoutes {
    override suspend fun capabilities(): FeedCapabilities {
        val capabilities = client.decode<JsonObject>("GET", "/v0/health")["capabilities"].obj
        fun flag(name: String) = (capabilities?.get(name) as? JsonPrimitive)?.booleanOrNull == true
        return FeedCapabilities(flag("feed"), flag("feedSubjectFilter"))
    }

    override suspend fun page(before: String?, limit: Int, subjects: Set<String>?): FeedPage {
        val query = "/v0/feed?limit=${limit.coerceIn(1, 200)}" +
            (before?.let { "&before=${AgentClient.escape(it)}" } ?: "") +
            (subjects?.let { "&subjects=" + it.sorted().joinToString(",") { type -> AgentClient.escape(type) } } ?: "")
        val answer = client.decode<JsonObject>("GET", query)
        return FeedPage(
            FeedItem.list(answer["items"]),
            (answer["unread"].num?.toInt() ?: 0).coerceAtLeast(0),
            (answer["hasMore"] as? JsonPrimitive)?.booleanOrNull ?: false,
            answer["cursor"].str,
            answer["filteredUnread"].num?.toInt()?.coerceAtLeast(0),
        )
    }

    override suspend fun seen(subject: FeedSubject, through: String?, mutationId: String): Pair<List<FeedItem>, Int> {
        val entry = buildJsonObject {
            put("type", subject.type)
            put("id", subject.id)
            through?.let { put("through", it) }
        }
        val answer = client.decode<JsonObject>("POST", "/v0/feed/seen", buildJsonObject { put("subjects", JsonArray(listOf(entry))); put("mutationId", mutationId) })
        return FeedItem.list(answer["items"]) to (answer["unread"].num?.toInt() ?: 0).coerceAtLeast(0)
    }

    override suspend fun readAll(through: String?, mutationId: String, subjects: Set<String>?): Int {
        val answer = client.decode<JsonObject>("POST", "/v0/feed/read-all", buildJsonObject {
            put("mutationId", mutationId)
            through?.let { put("through", it) }
            subjects?.let { put("subjects", JsonArray(it.sorted().map(::JsonPrimitive))) }
        })
        return (answer["unread"].num?.toInt() ?: 0).coerceAtLeast(0)
    }

    override suspend fun clusters(): List<FeedCluster> =
        client.decode<JsonObject>("GET", "/v0/feed/clusters")["clusters"].arr.orEmpty().mapNotNull(FeedCluster::parse)

    override suspend fun follow(cluster: String, follow: Boolean, mutationId: String): FeedCluster {
        val answer = client.decode<JsonObject>(if (follow) "PUT" else "DELETE", "/v0/feed/subscriptions/${AgentClient.escape(cluster)}", buildJsonObject { put("mutationId", mutationId) })
        return FeedCluster.parse(answer["cluster"]) ?: FeedCluster(cluster, FeedCluster.kindOf(cluster), if (follow) "subscribed" else "muted")
    }

    override suspend fun peek(cluster: String, limit: Int): List<FeedItem> =
        FeedItem.list(client.decode<JsonObject>("GET", "/v0/feed/clusters/${AgentClient.escape(cluster)}?limit=${limit.coerceIn(1, 200)}")["entries"])
}
