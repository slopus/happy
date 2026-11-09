package com.slopus.happy.ui.connection

import com.slopus.happy.agent.SurfaceType
import com.slopus.happy.chat.arr
import com.slopus.happy.agent.Intent
import com.slopus.happy.todos.TodoItem
import com.slopus.happy.todos.TodoLibrary
import com.slopus.happy.todos.TodoOp
import com.slopus.happy.todos.TodoReducer
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.agent.TeamUser
import com.slopus.happy.agent.isNullish
import com.slopus.happy.agent.string
import com.slopus.happy.artifacts.ArtifactCatalog
import com.slopus.happy.artifacts.ArtifactCatalogFeed
import com.slopus.happy.artifacts.ArtifactRef
import com.slopus.happy.search.SearchAnswer
import com.slopus.happy.search.SearchFusion
import com.slopus.happy.search.SearchHit
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.avatar.PlaceholderAvatar
import com.slopus.happy.vaults.VaultNames
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.text.Normalizer
import kotlin.coroutines.cancellation.CancellationException
import java.util.Locale

/**
 * Home's search, search's phone half (happy-agent API.md, "Search"): what the phone holds that answers the query, fused with what
 * the daemon finds in one card ([agentSearchResults]); then at most six
 * quick actions and six settings. Nothing typed, the bots and tasks last
 * active. Case and accents don't count, and a query of several words
 * finds them in any order.
 */
object AgentSearch {
    const val SECTION_LIMIT = 6

    /** How many found things search lists, and how many of its own the phone offers to the fusion: desktop's `FOUND_LIMIT`. */
    const val FOUND_LIMIT = 12

    /** How many bots and tasks an empty search shows. */
    const val RECENT_LIMIT = 8

    /** What a match in anything but the title loses: it ranks under every title match (desktop's `SECONDARY_PENALTY`). */
    const val SECONDARY_PENALTY = 3

    /**
     * How well [title] answers [query] (desktop's `rowRank`), lower first:
     * 0, it starts with the query; 1, a word in it does; 2, it holds it
     * anywhere; a query of several words ranks, in any order, as its
     * weakest word does, never 0. What a row answers to below its title
     * ([secondary]) ranks [SECONDARY_PENALTY] lower, and the words may be
     * split between the two. Null: it doesn't answer.
     */
    fun rank(title: String, query: String, secondary: List<String> = emptyList()): Int? {
        val needle = fold(query.trim())
        if (needle.isEmpty()) return null
        val words = needle.split(WHITESPACE).filter { it.isNotEmpty() }
        val heading = fold(title)
        val primary = textRank(heading, needle) ?: wordsRank(heading, words)
        if (primary == 0) return 0
        var best = primary
        fun demote(rank: Int?) {
            if (rank == null) return
            val demoted = rank + SECONDARY_PENALTY
            val current = best
            if (current == null || demoted < current) best = demoted
        }
        val supporting = secondary.map(::fold)
        supporting.forEach { demote(textRank(it, needle)) }
        if (supporting.isNotEmpty()) demote(wordsRank((listOf(heading) + supporting).joinToString(" "), words))
        return best
    }

    /** [needle] in [haystack], both folded: 0 at its start, 1 at a word's, 2 anywhere. */
    private fun textRank(haystack: String, needle: String): Int? {
        if (haystack.startsWith(needle)) return 0
        var from = 0
        var holds = false
        while (true) {
            val at = haystack.indexOf(needle, from)
            if (at < 0) break
            holds = true
            if (!haystack[at - 1].isLetterOrDigit()) return 1
            from = at + 1
        }
        return if (holds) 2 else null
    }

    /** Several [words] all in [haystack], in any order, as the weakest ranks; never a prefix, which only the whole query can be. */
    private fun wordsRank(haystack: String, words: List<String>): Int? {
        if (words.size < 2) return null
        var worst = 1
        for (word in words) worst = maxOf(worst, textRank(haystack, word) ?: return null)
        return worst
    }

    private val WHITESPACE = Regex("\\s+")

    private fun fold(text: String): String =
        Normalizer.normalize(text, Normalizer.Form.NFKD).replace(Regex("\\p{Mn}+"), "").lowercase(Locale.ROOT)

    /**
     * [items] that answer [query], best first; among equals the lower
     * [tier] (desktop: a Surface joined before one not), then their own
     * order.
     */
    fun <T> ranked(
        items: List<T>,
        query: String,
        limit: Int = Int.MAX_VALUE,
        secondary: (T) -> List<String> = { emptyList() },
        tier: (T) -> Int = { 0 },
        title: (T) -> String,
    ): List<T> =
        items.withIndex()
            .mapNotNull { (index, item) -> rank(title(item), query, secondary(item))?.let { Ranked(it, tier(item), index, item) } }
            .sortedWith(compareBy<Ranked<T>>({ it.rank }, { it.tier }, { it.index }))
            .take(limit)
            .map { it.item }

    private class Ranked<T>(val rank: Int, val tier: Int, val index: Int, val item: T)

    /**
     * What an empty search shows (iOS `Search.recent`): the bots and tasks
     * last active, newest first and, among equals, in home's order; at most
     * [limit]. A bot's or task's activity is its own or its subtasks',
     * whichever is latest, and it shows alone, without them. One never
     * active isn't recent.
     */
    fun recent(feed: AgentFeed, limit: Int = RECENT_LIMIT): List<AgentFeedRow.Conversation> {
        val rows = feed.rows
        val active = ArrayList<Triple<Int, Long, AgentFeedRow.Conversation>>()
        rows.forEachIndexed { index, row ->
            if (row !is AgentFeedRow.Conversation || row.depth != 0) return@forEachIndexed
            if (row.kind != ConversationKind.Bot && row.kind != ConversationKind.Task) return@forEachIndexed
            var latest = row.activityAt
            var end = index + 1
            while (end < rows.size && rows[end].depth > 0) {
                (rows[end] as? AgentFeedRow.Conversation)?.let { latest = maxOf(latest, it.activityAt) }
                end++
            }
            if (latest > 0) active += Triple(index, latest, row)
        }
        return active.sortedWith(compareByDescending<Triple<Int, Long, AgentFeedRow.Conversation>> { it.second }.thenBy { it.first })
            .take(limit)
            .map { it.third }
    }

    /** A pull from the results' top let go this far (or flung) closes search (iOS `HomeSearchPresentationLayout`). */
    fun pullCloses(distance: Dp, velocity: Dp): Boolean = distance >= 100.dp || (distance >= 24.dp && velocity >= 700.dp)
}

/** How deep a home row sits: a section, Artifacts and a Surface are at the top. */
private val AgentFeedRow.depth: Int
    get() = when (this) {
        is AgentFeedRow.Conversation -> depth
        is AgentFeedRow.Folder -> depth
        else -> 0
    }

/** Something search can take the person to. */
@Immutable
data class AgentSearchEntry(val id: String, val title: String, val icon: Ionicon, val run: () -> Unit)

@Immutable
sealed interface AgentSearchResult {
    val key: String

    /** A section's heading over its card. */
    data class Heading(val title: String) : AgentSearchResult {
        override val key get() = "heading-$title"
    }

    /** One of home's rows, drawn as home draws it, in the card of what answered. */
    data class Home(val item: AgentHomeItem.Row) : AgentSearchResult {
        override val key get() = item.key
    }

    data class Entry(val entry: AgentSearchEntry, val place: HomeCardPlace) : AgentSearchResult {
        override val key get() = "entry-${entry.id}"
    }

    /** An open todo; it opens its list. */
    data class Todo(val todo: AgentSearchSources.Todo, val place: HomeCardPlace) : AgentSearchResult {
        override val key get() = "todo-${todo.id}"
    }

    data class Artifact(val artifact: ArtifactRef, val place: HomeCardPlace) : AgentSearchResult {
        override val key get() = "artifact-${artifact.id}"
    }

    /** A team member the daemon found, under People; it opens their profile. */
    data class Person(val userId: String, val name: String, val place: HomeCardPlace) : AgentSearchResult {
        override val key get() = "user:$userId"
    }

    /**
     * One result of search under its [key] (`<type>:<id>`), as desktop's
     * palette draws it: its [title] and, under it, [detail], what it is and
     * where, or the words a content match was found in. [local] is the
     * phone's own result, where it holds it, which opens as home opens it;
     * [hit] what the daemon said of it. A thing both found is the phone's
     * row with the daemon's words under it.
     */
    data class Found(
        override val key: String,
        val local: AgentSearchResult?,
        val hit: SearchHit?,
        val place: HomeCardPlace,
        val title: String = "",
        val detail: String? = null,
    ) : AgentSearchResult {
        /** Home's own pages (Artifacts, Activity, Todos), which only the phone has, draw as home draws them. */
        val drawn: AgentSearchResult?
            get() = local.takeIf { (it as? Home)?.item?.row.let { row -> row == AgentFeedRow.Artifacts || row is AgentFeedRow.Feed || row == AgentFeedRow.Todos } }
    }
}

/**
 * What search finds beyond home's rows (desktop's ⌘K sources, 28342477):
 * every Surface in the catalog with a page of its own, joined or not,
 * newest first; the open todos of the joined lists, and how many each
 * has ([openTodos], by list, for the lists read); the artifact catalog,
 * newest change first. What the phone hasn't kept is read from the
 * computer as search opens ([reads]), as desktop's palette reads it.
 */
@Immutable
data class AgentSearchSources(
    val surfaces: List<Surface> = emptyList(),
    val todos: List<Todo> = emptyList(),
    val artifacts: List<Artifact> = emptyList(),
    val openTodos: Map<String, Int> = emptyMap(),
    /** The active tasks the person isn't in, which home doesn't list (desktop's task directory). */
    val tasks: List<Task> = emptyList(),
) {
    data class Surface(val row: AgentFeedRow.Surface, val joined: Boolean, val updatedAt: Long = 0)

    data class Todo(val id: String, val text: String, val list: AgentFeedRow.Surface, val updatedAt: Long = 0)

    data class Artifact(val ref: ArtifactRef, val updatedAt: Long = 0)

    data class Task(val id: String, val agentId: String, val name: String, val updatedAt: Long = 0)

    companion object {
        val None = AgentSearchSources()

        /** Kinds with a page of their own; one that only points at an artifact, a bot or a task is found under its own name. */
        val KINDS = setOf(SurfaceReader.DOCUMENT, SurfaceReader.TODO, "calendar", "system_monitor", "vault", "chat")

        /**
         * What desktop's palette reads while it is open that [kept] lacks,
         * from the computer ([get], a path's JSON), under the resource it
         * would be kept as: the artifact catalog's first page
         * (`GET /v0/artifacts`), and the open todos of each of [feed]'s
         * lists (`GET /v0/surfaces/todo/:id?scope=active`). One that fails
         * is left out.
         */
        suspend fun reads(feed: AgentFeed, kept: (String) -> JsonObject?, get: suspend (String) -> JsonObject): Map<String, JsonObject> = coroutineScope {
            val paths = LinkedHashMap<String, String>()
            if (kept(ArtifactCatalogFeed.RESOURCE) == null) paths[ArtifactCatalogFeed.RESOURCE] = "/v0/artifacts?limit=${ArtifactCatalogFeed.PAGE_SIZE}"
            for (row in feed.rows) {
                if (row !is AgentFeedRow.Surface || row.type != SurfaceReader.TODO) continue
                val resource = TodoLibrary.resource(row.id)
                if (kept(resource) == null) paths[resource] = "/v0/surfaces/todo/${AgentClient.escape(row.id)}?scope=active"
            }
            paths.map { (resource, path) ->
                async {
                    try {
                        resource to get(path)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        null
                    }
                }
            }.awaitAll().filterNotNull().toMap()
        }

        /**
         * The sources from [catalog] and what [kept] holds (an agent
         * session's `cachedResource`, so off the main thread). A Surface
         * being left ([feed] no longer lists it) is out already.
         */
        fun read(catalog: AgentCatalog, feed: AgentFeed, kept: (String) -> JsonObject?, pending: List<Intent> = emptyList()): AgentSearchSources {
            val listed = feed.rows.mapNotNullTo(HashSet()) { (it as? AgentFeedRow.Surface)?.id }
            val surfaces = catalog.surfaces.values
                .filter { it.string("status") != "archived" && it["archivedAt"].isNullish() && it.string("type") in KINDS }
                .mapNotNull { surface ->
                    val id = surface.string("id") ?: return@mapNotNull null
                    // A computer with no Happy account has one person, with no ID on either side (iOS SidebarRows).
                    val joined = (surface["members"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>().any { it.string("userId") == catalog.userId }
                    if (joined && id !in listed) return@mapNotNull null
                    val updatedAt = (surface["updatedAt"] as? JsonPrimitive)?.longOrNull ?: 0L
                    val type = surface.string("type").orEmpty()
                    val locked = com.slopus.happy.agent.Surface.parse(surface)?.showsLock == true
                    Surface(AgentFeedRow.Surface(id, surface.string("name").orEmpty(), type, locked), joined, updatedAt)
                }
                .sortedByDescending { it.updatedAt }
            val ops = pending.mapNotNull(TodoOp::of).groupBy { it.surfaceId }
            val openTodos = HashMap<String, Int>()
            val todos = surfaces.filter { it.joined && it.row.type == SurfaceReader.TODO }.flatMap { list ->
                val read = kept(TodoLibrary.resource(list.row.id)) ?: return@flatMap emptyList()
                val confirmed = read["todos"].arr.orEmpty().mapNotNull(TodoItem::parse).associateBy { it.id }
                val open = TodoReducer.overlay(confirmed, ops[list.row.id].orEmpty()).values
                    .filter { it.status == TodoItem.Status.Active && it.heading == null }
                openTodos[list.row.id] = open.size
                open.map { Todo(it.id, it.text, list.row, it.updatedAt.toLong()) }
            }
            val artifacts = kept(ArtifactCatalogFeed.RESOURCE)?.let(ArtifactCatalog::fromKept).orEmpty().map { Artifact(it.ref, it.updatedAt) }
            val tasks = catalog.tasks.values
                .filter { it.string("id") !in catalog.memberships && it.string("status") != "archived" && it["archivedAt"].isNullish() }
                .mapNotNull { task ->
                    val agent = task["agent"] as? JsonObject ?: return@mapNotNull null
                    val agentId = agent.string("id") ?: return@mapNotNull null
                    val updatedAt = ((catalog.agents[agentId] ?: agent)["updatedAt"] as? JsonPrimitive)?.longOrNull ?: 0L
                    Task(task.string("id") ?: return@mapNotNull null, agentId, task.string("name") ?: agent.string("title").orEmpty(), updatedAt)
                }
            return AgentSearchSources(surfaces, todos, artifacts, openTodos, tasks)
        }
    }
}

/**
 * What search's sections are called, the names of the kinds a query also
 * finds a row by, and the words of the line under a found thing (desktop's
 * meta): a conversation's kind, a done todo, an agent's message, a day.
 */
@Immutable
class AgentSearchWords(
    val actions: String,
    val settings: String,
    val surfaceType: (String) -> String,
    val artifactType: (String) -> String,
    val task: String = "Task",
    val subtask: String = "Subtask",
    val bot: String = "Bot",
    val chat: String = "Chat",
    val shared: String = "Shared",
    val done: String = "Done",
    val agent: String = "Agent",
    /** The heading over the team members found. */
    val people: String = "People",
    /** A found Surface the person isn't in (desktop's "not joined"). */
    val notJoined: String = "not joined",
    /** A found task the person isn't in (desktop's "Task you have not joined"). */
    val taskNotJoined: String = "Task you have not joined",
    /** A found list's open todos, "5 open". */
    val openTodos: (Int) -> String = { "$it open" },
    /** A day as a row's line says it, "Nov 8", with its time when [time]; an all-day event's ([utc]) is a date the same anywhere. */
    val day: (millis: Long, time: Boolean, utc: Boolean) -> String = ::searchDay,
)

/** "Nov 8", or "Nov 8, 2:00 PM", in the person's language. */
fun searchDay(millis: Long, time: Boolean, utc: Boolean, locale: Locale = Locale.getDefault()): String {
    val format = java.text.SimpleDateFormat(android.text.format.DateFormat.getBestDateTimePattern(locale, if (time) "MMMdjmm" else "MMMd"), locale)
    if (utc) format.timeZone = java.util.TimeZone.getTimeZone("UTC")
    return format.format(java.util.Date(millis))
}

/**
 * One thing the phone's own search found, under the key the daemon gives
 * it (API.md, "Search" › Result types): what it is called, what it
 * answers to below that, its tier among equals, when it last changed, and
 * how it is drawn at its place in the card.
 */
private class Local(
    val key: String,
    val title: String,
    val secondary: List<String>,
    val tier: Int,
    /** What it is and where, under its title (desktop's own rows' meta). */
    val detail: String? = null,
    val updatedAt: Long = 0,
    val result: (HomeCardPlace) -> AgentSearchResult,
) {
    /** How well its name answers the query ([AgentSearch.rank]), once ranked. */
    var rank = 0
}

/**
 * The phone's half of search for [query], as desktop's palette finds its
 * own (`localFound`): home's bots, tasks and conversations, each also by
 * its subtasks' titles (which aren't found apart); the catalog's
 * Surfaces with a page of their own, joined or not; the open todos kept or
 * read; the artifacts; and home's own pages, which only the phone has.
 * Best name first ([AgentSearch.rank], a Surface also by its kind and an
 * artifact by its type), then what is the person's own before what isn't
 * (desktop's tier: a project's conversation or a Surface not joined, then
 * a todo), then the latest changed.
 */
private fun localSearch(feed: AgentFeed, query: String, label: (AgentFeedRow) -> String?, words: AgentSearchWords, sources: AgentSearchSources): List<Local> {
    val surfaces = sources.surfaces +
        feed.rows.filterIsInstance<AgentFeedRow.Surface>().filter { row -> sources.surfaces.none { it.row.id == row.id } }.map { AgentSearchSources.Surface(it, joined = true) }
    val candidates = ArrayList<Local>()
    for (surface in surfaces) {
        val row = surface.row
        if (row.type !in AgentSearchSources.KINDS) continue
        val kind = words.surfaceType(row.type)
        val open = if (surface.joined && row.type == SurfaceReader.TODO) sources.openTodos[row.id]?.let(words.openTodos) else null
        val detail = listOfNotNull(kind, open, if (surface.joined) null else words.notJoined).joinToString(" · ")
        candidates += Local(
            if (row.type == SurfaceReader.DOCUMENT) "document:${row.id}" else "surface:${row.id}",
            row.name,
            listOf(kind),
            if (surface.joined) 0 else 1,
            detail,
            surface.updatedAt,
        ) { place -> AgentSearchResult.Home(AgentHomeItem.Row(row, place.first, place.last)) }
    }
    // A todo is found by what it says, never by its list's name, under every list that answers as well.
    for (todo in sources.todos) {
        candidates += Local("todo:${todo.id}", todo.text, emptyList(), 2, todo.list.name.ifEmpty { null }, todo.updatedAt) { AgentSearchResult.Todo(todo, it) }
    }
    for (artifact in sources.artifacts) {
        val kind = words.artifactType(artifact.ref.type)
        candidates += Local("artifact:${artifact.ref.id}", artifact.ref.title, listOf(kind), 0, kind, artifact.updatedAt) { AgentSearchResult.Artifact(artifact.ref, it) }
    }
    val folders = conversationFolders(feed)
    // The depth of the bot or task the rows under it are subtasks of, and the titles they add to what finds it.
    var owner: Pair<Int, MutableList<String>>? = null
    for (row in feed.rows) {
        if (row !is AgentFeedRow.Conversation) {
            // A heading or a project ends the bot's or task's rows.
            owner = null
            continue
        }
        val title = label(row) ?: continue
        owner = owner?.takeIf { row.depth > it.first }
        if (owner != null) {
            owner.second += title
            continue
        }
        // A flat list: a conversation stands at the card's edge like the rest.
        val flat = row.copy(depth = 0)
        val kind = when (row.kind) {
            ConversationKind.Bot -> words.bot
            ConversationKind.Task -> words.task
            ConversationKind.Subtask -> words.subtask
            ConversationKind.Project -> folders[row.agentId] ?: words.chat
        }
        val keywords = ArrayList<String>()
        // A project's conversation is one of its tabs on desktop, after what the sidebar lists.
        val local = Local("agent:${row.agentId}", title, keywords, if (row.kind == ConversationKind.Project) 1 else 0, kind, row.activityAt) { place ->
            AgentSearchResult.Home(AgentHomeItem.Row(flat, place.first, place.last))
        }
        if (row.kind == ConversationKind.Bot || row.kind == ConversationKind.Task) owner = row.depth to keywords
        candidates += local
    }
    // A task the person isn't in opens its conversation without joining it, as on desktop (c6982095).
    for (task in sources.tasks) {
        val row = AgentFeedRow.Conversation(task.agentId, task.name, ConversationKind.Task, 0, seed = task.id, activityAt = task.updatedAt)
        candidates += Local("agent:${task.agentId}", task.name, emptyList(), 1, words.taskNotJoined, task.updatedAt) { place ->
            AgentSearchResult.Home(AgentHomeItem.Row(row, place.first, place.last))
        }
    }
    for (row in feed.rows) {
        if (row != AgentFeedRow.Artifacts && row !is AgentFeedRow.Feed && row != AgentFeedRow.Todos) continue
        val title = label(row) ?: continue
        candidates += Local("home:${row.key}", title, emptyList(), 0) { place -> AgentSearchResult.Home(AgentHomeItem.Row(row, place.first, place.last)) }
    }
    return candidates.withIndex()
        .mapNotNull { (index, local) -> AgentSearch.rank(local.title, query, local.secondary)?.let { rank -> local.rank = rank; index to local } }
        .sortedWith(compareBy({ it.second.rank }, { it.second.tier }, { -it.second.updatedAt }, { it.first }))
        .map { it.second }
        .distinctBy { it.key }
}

/** Where each project conversation is, as desktop's `groupMeta` says it: its project, and its worktree after a slash. */
private fun conversationFolders(feed: AgentFeed): Map<String, String> {
    val out = HashMap<String, String>()
    val path = ArrayList<String>()
    for (row in feed.rows) {
        when (row) {
            is AgentFeedRow.Folder -> {
                while (path.size > row.depth) path.removeAt(path.lastIndex)
                path += row.name
            }
            is AgentFeedRow.Conversation -> if (row.kind == ConversationKind.Project && path.isNotEmpty()) out[row.agentId] = path.joinToString(" / ")
            is AgentFeedRow.Section -> path.clear()
            else -> Unit
        }
    }
    return out
}

/**
 * Whether the phone can open what the daemon found (desktop's `remoteRow`
 * leaves out what it has nowhere to open): not a project or a worktree,
 * which open nothing on the phone, nothing archived, and no conversation,
 * or message of one, in no workspace. People stand apart, under their own
 * heading; skills never parse.
 */
internal fun searchHitOpens(hit: SearchHit): Boolean = when (hit) {
    is SearchHit.Project, is SearchHit.Workspace, is SearchHit.User -> false
    is SearchHit.Agent -> !hit.archived && hit.workspaceId != null
    is SearchHit.Message -> hit.workspaceId != null
    else -> true
}

/**
 * What search shows for [query], as desktop's ⌘K palette lists it: one
 * card of at most [AgentSearch.FOUND_LIMIT] things found, the phone's own
 * best ([localSearch]) fused with the daemon's ([remote], for this query)
 * as every client fuses them ([SearchFusion]); and the quick actions and
 * the settings that answer, each under its heading, at most six, best
 * first, which only the phone has. Each section stands where its best
 * answer puts it; what was found comes first once the daemon has answered
 * with anything. Where [people] (a Happy Cloud server), the team members
 * the daemon found follow under People, at most six in its order.
 * Nothing typed: the bots and tasks last active, one card with no title.
 */
fun agentSearchResults(
    feed: AgentFeed,
    query: String,
    label: (AgentFeedRow) -> String?,
    words: AgentSearchWords,
    actions: List<AgentSearchEntry>,
    settings: List<AgentSearchEntry>,
    sources: AgentSearchSources = AgentSearchSources.None,
    remote: SearchAnswer? = null,
    people: Boolean = false,
): List<AgentSearchResult> {
    val out = ArrayList<AgentSearchResult>()
    if (query.isBlank()) {
        val recent = AgentSearch.recent(feed)
        recent.forEachIndexed { index, row -> out += AgentSearchResult.Home(AgentHomeItem.Row(row, first = index == 0, last = index == recent.lastIndex)) }
        return out
    }
    val local = localSearch(feed, query, label, words, sources).take(AgentSearch.FOUND_LIMIT)
    val hits = remote?.hits.orEmpty().filter(::searchHitOpens)
    val fused = SearchFusion.fuse(hits, local, { it.key }, { it.rank }, { it.key }).take(AgentSearch.FOUND_LIMIT)
    val names = SearchNames(feed, label, sources, words)
    val found = ArrayList<AgentSearchResult>()
    fused.forEachIndexed { index, one ->
        val place = HomeCardPlace(first = index == 0, last = index == fused.lastIndex)
        val hit = one.remote
        val mine = one.local
        // A thing both found is the phone's row, with the words the daemon found it by under it.
        val snippet = hit?.let(::searchHitSnippet)
        found += AgentSearchResult.Found(
            one.key,
            mine?.result?.invoke(place),
            hit,
            place,
            title = mine?.title ?: hit?.let(names::title).orEmpty(),
            detail = snippet ?: mine?.detail ?: hit?.let(names::detail),
        )
    }
    fun section(title: String, entries: List<AgentSearchEntry>): Pair<List<AgentSearchResult>, Int> {
        val ranked = AgentSearch.ranked(entries, query, AgentSearch.SECTION_LIMIT) { it.title }
        if (ranked.isEmpty()) return emptyList<AgentSearchResult>() to Int.MAX_VALUE
        val rows = listOf(AgentSearchResult.Heading(title)) +
            ranked.mapIndexed { index, entry -> AgentSearchResult.Entry(entry, HomeCardPlace(first = index == 0, last = index == ranked.lastIndex)) }
        return rows to ranked.minOf { AgentSearch.rank(it.title, query) ?: Int.MAX_VALUE }
    }
    val persons = if (people) remote?.hits.orEmpty().filterIsInstance<SearchHit.User>().distinctBy { it.userId }.take(AgentSearch.SECTION_LIMIT) else emptyList()
    val peopleRows = if (persons.isEmpty()) emptyList() else listOf(AgentSearchResult.Heading(words.people)) +
        persons.mapIndexed { index, hit -> AgentSearchResult.Person(hit.userId, hit.name, HomeCardPlace(first = index == 0, last = index == persons.lastIndex)) }
    val answered = hits.isNotEmpty() || persons.isNotEmpty()
    val foundBest = if (answered) Int.MIN_VALUE else local.minOfOrNull { it.rank } ?: Int.MAX_VALUE
    listOf(found to foundBest, peopleRows to Int.MIN_VALUE, section(words.actions, actions), section(words.settings, settings))
        .filter { it.first.isNotEmpty() }
        // Stable: among equals, what was found, then the actions, then the settings.
        .sortedBy { it.second }
        .forEach { out += it.first }
    return out
}

/** What the phone holds to name what the daemon found by ID, and the words for it. */
private class SearchNames(feed: AgentFeed, label: (AgentFeedRow) -> String?, sources: AgentSearchSources, private val words: AgentSearchWords) {
    private val surfaces: Map<String, AgentFeedRow.Surface> =
        feed.rows.filterIsInstance<AgentFeedRow.Surface>().associateBy { it.id } + sources.surfaces.associate { it.row.id to it.row }
    private val conversations: Map<String, String> =
        feed.rows.filterIsInstance<AgentFeedRow.Conversation>().mapNotNull { row -> label(row)?.let { row.agentId to it } }.toMap()
    private val projects: Map<String, String> = feed.rows.filterIsInstance<AgentFeedRow.Folder>().filter { it.depth == 0 }.associate { it.id to it.name }

    fun surfaceName(id: String): String? = surfaces[id]?.name?.ifEmpty { null }

    /** A daemon's result's name as its row shows it (desktop's `remoteRow` title); a message is its words. */
    fun title(hit: SearchHit): String = when (hit) {
        is SearchHit.Message -> searchLine(hit.snippet).orEmpty()
        else -> searchHitTitle(hit)
    }

    /** The line under a daemon's result that matched by name: what it is and where (desktop's `remoteRow` meta). */
    fun detail(hit: SearchHit): String? {
        fun joined(vararg parts: String?) = parts.filterNotNull().filter { it.isNotEmpty() }.joinToString(" · ").ifEmpty { null }
        return when (hit) {
            is SearchHit.VaultFile -> joined(surfaceName(hit.surfaceId), VaultNames.shownPath(hit.path))
            is SearchHit.VaultFolder -> joined(surfaceName(hit.surfaceId), VaultNames.shownPath(hit.path))
            is SearchHit.Document -> words.surfaceType(SurfaceReader.DOCUMENT)
            is SearchHit.Todo -> joined(if (hit.status == "completed") words.done else null, surfaceName(hit.surfaceId))
            is SearchHit.CalendarEvent -> joined(surfaceName(hit.surfaceId), hit.start.takeIf { it > 0 }?.let { words.day(it, !hit.allDay, hit.allDay) })
            is SearchHit.Message -> joined(
                conversations[hit.agentId] ?: words.chat,
                if (hit.role == "agent") words.agent else null,
                hit.createdAt.takeIf { it > 0 }?.let { words.day(it, false, false) },
            )
            is SearchHit.Artifact -> words.artifactType(hit.artifactType)
            is SearchHit.Surface -> (surfaces[hit.surfaceId]?.type ?: hit.surfaceType).takeIf { it in AgentSearchSources.KINDS }?.let(words.surfaceType) ?: words.shared
            is SearchHit.Agent -> joined(
                when (hit.kind) {
                    "task" -> words.task
                    "subtask" -> words.subtask
                    "bot" -> words.bot
                    else -> words.chat
                },
                hit.projectId?.let(projects::get),
            )
            is SearchHit.Project, is SearchHit.Workspace, is SearchHit.User -> null
        }
    }
}

object AgentSearchTags {
    const val FIELD = "agentSearch.field"
    const val CLEAR = "agentSearch.clear"
    const val RESULTS = "agentSearch.results"
    const val NO_RESULTS = "agentSearch.noResults"
    fun result(key: String) = "agentSearch.result.$key"
}

object AgentSearchSpec {
    val field = happyTextStyle(fontSize = 17, lineHeight = 22)
    /** A section's heading (GroupedSidebarMetrics): 13 on an 18 line, 7 above its card in a 36 box, 14 after the card before. */
    val heading = happyTextStyle(fontSize = 13, lineHeight = 18, weight = androidx.compose.ui.text.font.FontWeight.SemiBold)
    val headingHeight = 36.dp
    val headingBottom = 7.dp
    val headingGap = 14.dp
    /** Nothing found: one line in a capsule, `nothingFoundGap` under where the results start, 24 clear of the sides (SearchLayout). */
    val nothingFound = happyTextStyle(fontSize = 15, lineHeight = 20)
    val nothingFoundGap = 32.dp
    val nothingFoundSide = 24.dp
    val pillHorizontal = 14.dp
    val pillVertical = 8.dp
    /** The results fade in and out over home: iOS's 0.2 s ease-out. */
    const val FADE_MS = 200
    const val ROW_LINE = 22
    const val HEADING_LINE = 18
}

/** The search field that takes the header's title while searching; focused when it appears. */
@Composable
fun AgentSearchField(query: String, onQueryChange: (String) -> Unit, modifier: Modifier = Modifier, placeholder: String = stringResource(R.string.tools_names_search)) {
    val colors = HappyTheme.colors
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    val style = AgentSearchSpec.field.copy(color = colors.input.text)
    BasicTextField(
        value = query,
        onValueChange = onQueryChange,
        singleLine = true,
        textStyle = style,
        cursorBrush = SolidColor(colors.text),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(),
        modifier = modifier.fillMaxWidth().focusRequester(focus).testTag(AgentSearchTags.FIELD),
        decorationBox = { inner ->
            Box(contentAlignment = Alignment.CenterStart) {
                if (query.isEmpty()) {
                    Text(placeholder, style = style.copy(color = colors.input.placeholder), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                inner()
            }
        },
    )
}

/**
 * Search's results (iOS HomeSearchResultsView): they own the content
 * under the field on home's own ground, drawn as home is, grouped cards
 * of home's rows, and never move home underneath. Nothing typed, the bots
 * and tasks last active; nothing found, a line saying so in a small
 * capsule. They keep clear of the keyboard; pulled down from their top
 * the keyboard goes as the pull starts, and let go far enough
 * ([AgentSearch.pullCloses]) search closes.
 */
@Composable
fun AgentSearchResults(
    query: String,
    results: List<AgentSearchResult>,
    onOpenConversation: (String) -> Unit,
    onOpenArtifacts: () -> Unit,
    onOpenSurface: (AgentFeedRow.Surface) -> Unit,
    onOpenArtifact: (ArtifactRef) -> Unit,
    onPull: () -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    /** The tablet sidebar's selection, what its main panel shows. */
    selected: String? = null,
    /** Room under the last result to scroll clear of what stands at the foot (the sidebar's settings and compose). */
    bottomClearance: Dp = 0.dp,
    onOpenFeed: () -> Unit = {},
    onOpenTodos: () -> Unit = {},
    /** Opens what the daemon found that the phone draws no row of; null for what opens nothing (a project, as on home). */
    onOpenHit: (SearchHit) -> (() -> Unit)? = { null },
    /** The team members read so far ([com.slopus.happy.agent.TeamDirectory]), whose pictures People wear. */
    people: Map<String, TeamUser> = emptyMap(),
    onOpenPerson: (userId: String) -> Unit = {},
) {
    val colors = HappyTheme.colors
    val density = LocalDensity.current
    val pull = remember(density) { PullToClose(density) }
    pull.onPull = onPull
    pull.onClose = onClose
    // Another query starts at the top; the daemon's answer coming in moves nothing.
    val state = rememberLazyListState()
    LaunchedEffect(query) { state.scrollToItem(0) }
    Box(modifier = modifier.fillMaxSize().background(colors.surface).testTag(AgentSearchTags.RESULTS)) {
        LazyColumn(
            state = state,
            modifier = Modifier.fillMaxSize().nestedScroll(pull),
            contentPadding = PaddingValues(top = AgentHomeSpec.contentTop),
        ) {
            items(results, key = { it.key }) { found ->
                val tag = AgentSearchTags.result(found.key)
                // A search result is drawn as the phone's row where it has one, else as the daemon's.
                val result = if (found is AgentSearchResult.Found) found.drawn ?: found else found
                when (result) {
                    is AgentSearchResult.Heading -> Box(
                        modifier = Modifier
                            .contentMaxWidth(LocalWindowLayout.current)
                            .padding(top = AgentSearchSpec.headingGap)
                            .height(AgentSearchSpec.headingHeight)
                            .padding(start = AgentHomeSpec.cardInset + AgentHomeSpec.markInset, end = AgentHomeSpec.cardInset + AgentHomeSpec.paddingEnd, bottom = AgentSearchSpec.headingBottom),
                        contentAlignment = Alignment.BottomStart,
                    ) {
                        Text(
                            result.title,
                            style = AgentSearchSpec.heading,
                            color = colors.grouped.sectionTitle,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.semantics { heading() },
                        )
                    }
                    is AgentSearchResult.Home -> AgentHomeCardRow(
                        item = result.item,
                        modifier = Modifier,
                        selected = selected != null && selected == result.item.row.panelKey(),
                        tag = tag,
                        onOpen = onOpenConversation,
                        onOpenArtifacts = onOpenArtifacts,
                        onOpenTodos = onOpenTodos,
                        onOpenSurface = onOpenSurface,
                        onOpenFeed = onOpenFeed,
                    )
                    is AgentSearchResult.Entry -> AgentSearchEntryRow(
                        result.entry.title,
                        result.entry.icon,
                        result.place,
                        tag,
                        onClick = result.entry.run,
                    )
                    is AgentSearchResult.Todo -> AgentSearchEntryRow(
                        result.todo.text,
                        Ionicon.CheckmarkCircleOutline,
                        result.place,
                        tag,
                    ) { onOpenSurface(result.todo.list) }
                    is AgentSearchResult.Artifact -> AgentSearchEntryRow(
                        result.artifact.title.ifBlank { stringResource(R.string.agent_artifacts_untitled) },
                        artifactGlyph(result.artifact.type),
                        result.place,
                        tag,
                    ) { onOpenArtifact(result.artifact) }
                    is AgentSearchResult.Person -> AgentSearchEntryRow(
                        result.name.ifBlank { result.userId },
                        Ionicon.PersonCircleOutline,
                        result.place,
                        tag,
                        mark = { PersonMark(result.userId, people[result.userId]?.photo, AgentHomeSpec.mark) },
                    ) { onOpenPerson(result.userId) }
                    is AgentSearchResult.Found -> {
                        val hit = result.hit
                        val untitled = stringResource(if (hit is SearchHit.Artifact || result.local is AgentSearchResult.Artifact) R.string.agent_artifacts_untitled else R.string.session_new_chat)
                        // The phone's own result opens as home opens it, and wears home's mark; the daemon's its kind's glyph.
                        when (val local = result.local) {
                            is AgentSearchResult.Home -> when (val row = local.item.row) {
                                is AgentFeedRow.Conversation -> AgentSearchEntryRow(
                                    result.title.ifBlank { untitled }, Ionicon.ChatbubbleEllipsesOutline, result.place, tag, result.detail,
                                    onClick = { onOpenConversation(row.agentId) },
                                    mark = { if (AgentHomeSpec.hasMark(row.kind)) ConversationMark(row, AgentHomeSpec.mark) else Icon(Ionicon.ChatbubbleEllipsesOutline, 22.dp, colors.text) },
                                )
                                is AgentFeedRow.Surface -> {
                                    val (glyph, tile) = RowTile.surface(row.type).let { if (row.locked) Ionicon.LockClosedOutline to it.second else it }
                                    AgentSearchEntryRow(result.title, glyph, result.place, tag, result.detail, onClick = { onOpenSurface(row) }, mark = { TileMark(glyph, tile) })
                                }
                                else -> Unit
                            }
                            is AgentSearchResult.Todo -> AgentSearchEntryRow(result.title, Ionicon.CheckmarkCircleOutline, result.place, tag, result.detail) { onOpenSurface(local.todo.list) }
                            is AgentSearchResult.Artifact -> AgentSearchEntryRow(result.title.ifBlank { untitled }, artifactGlyph(local.artifact.type), result.place, tag, result.detail) {
                                onOpenArtifact(local.artifact)
                            }
                            else -> if (hit != null) AgentSearchEntryRow(result.title.ifBlank { untitled }, searchHitGlyph(hit), result.place, tag, result.detail, onClick = onOpenHit(hit))
                        }
                    }
                }
            }
            item(key = "bottom", contentType = "bottom") {
                Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.ime.union(WindowInsets.navigationBars)).padding(bottom = maxOf(24.dp, bottomClearance)))
            }
        }
        if (query.isNotBlank() && results.isEmpty()) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = AgentSearchSpec.nothingFoundGap - AgentSearchSpec.pillVertical, start = AgentSearchSpec.nothingFoundSide, end = AgentSearchSpec.nothingFoundSide)
                    .clip(CircleShape)
                    .background(colors.surfaceHigh)
                    .padding(horizontal = AgentSearchSpec.pillHorizontal, vertical = AgentSearchSpec.pillVertical),
            ) {
                Text(
                    stringResource(R.string.settings_nothing_found),
                    style = AgentSearchSpec.nothingFound,
                    color = colors.text,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.testTag(AgentSearchTags.NO_RESULTS),
                )
            }
        }
    }
}

/** An artifact's glyph by its type (desktop's `artifactGlyph`). */
private fun artifactGlyph(type: String): Ionicon = when (type) {
    "markdown" -> Ionicon.DocumentTextOutline
    "html" -> Ionicon.GlobeOutline
    "image", "image_series" -> Ionicon.ImageOutline
    "video" -> Ionicon.PlayCircleOutline
    "document" -> Ionicon.DocumentOutline
    else -> Ionicon.CubeOutline
}

/** A daemon's result's name, as its row shows it: a vault app without its ".artifact". Blank where it has none yet. */
internal fun searchHitTitle(hit: SearchHit): String = when (hit) {
    is SearchHit.VaultFile -> VaultNames.shown(hit.name)
    is SearchHit.VaultFolder -> hit.name
    is SearchHit.Document -> hit.name
    // Its conversation's title, which the row is given ([AgentSearchResult.Found.conversation]).
    is SearchHit.Message -> ""
    is SearchHit.Todo -> hit.text
    is SearchHit.CalendarEvent -> hit.title
    is SearchHit.Artifact -> hit.title
    is SearchHit.Surface -> hit.name
    is SearchHit.Agent -> hit.title
    is SearchHit.Project -> hit.name
    is SearchHit.Workspace -> hit.name
    is SearchHit.User -> hit.name
}

/**
 * The words a content match was found in, on one line, which take the line
 * under its title; null for any other match. A message's words are its
 * title ([searchLine]).
 */
internal fun searchHitSnippet(hit: SearchHit): String? = when (hit) {
    is SearchHit.VaultFile -> searchLine(hit.snippet).takeIf { hit.match == "content" }
    is SearchHit.Document -> searchLine(hit.snippet).takeIf { hit.match == "content" }
    is SearchHit.Artifact -> searchLine(hit.snippet).takeIf { hit.match == "content" }
    is SearchHit.CalendarEvent -> searchLine(hit.snippet).takeIf { hit.match == "content" }
    else -> null
}

/** [text] on one line; null when there is none. */
internal fun searchLine(text: String?): String? = text?.replace(Regex("\\s+"), " ")?.trim()?.takeIf { it.isNotEmpty() }

/** A daemon's result's glyph, as the phone draws the same kind of thing. */
private fun searchHitGlyph(hit: SearchHit): Ionicon = when (hit) {
    is SearchHit.VaultFile -> if (hit.kind == "artifact") Ionicon.AppsOutline else Ionicon.DocumentOutline
    is SearchHit.VaultFolder -> Ionicon.FolderOutline
    is SearchHit.Document -> Ionicon.DocumentTextOutline
    is SearchHit.Message -> Ionicon.ChatbubblesOutline
    is SearchHit.Todo -> Ionicon.CheckmarkCircleOutline
    is SearchHit.CalendarEvent -> Ionicon.CalendarOutline
    is SearchHit.Artifact -> artifactGlyph(hit.artifactType)
    is SearchHit.Surface -> RowTile.surface(hit.surfaceType).first
    is SearchHit.Agent -> if (hit.kind == "bot") Ionicon.PersonCircleOutline else Ionicon.ChatbubbleEllipsesOutline
    is SearchHit.Project, is SearchHit.Workspace -> Ionicon.FolderOutline
    is SearchHit.User -> Ionicon.PersonCircleOutline
}

/** A team member's round face: their picture over its ThumbHash, else the placeholder their ID picks. */
@Composable
internal fun PersonMark(userId: String, photo: String?, size: Dp) {
    if (photo != null) AgentPicture(TeamUser.photoPath(userId), photo, size, size / 2)
    else PlaceholderAvatar(userId, size, shape = CircleShape)
}

/**
 * A drag down past the results' top: the distance the list didn't take,
 * and at the finger's lift whether it closes search. A drag that moved
 * the list at all started away from the top and closes nothing.
 */
private class PullToClose(private val density: Density) : NestedScrollConnection {
    var onPull: () -> Unit = {}
    var onClose: () -> Unit = {}
    private var pulled = 0f
    private var moved = false

    override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
        if (source != NestedScrollSource.UserInput) return Offset.Zero
        if (consumed.y != 0f) moved = true
        if (!moved && available.y > 0f) {
            if (pulled == 0f) onPull()
            pulled += available.y
        }
        return Offset.Zero
    }

    override suspend fun onPreFling(available: Velocity): Velocity {
        val closes = !moved && pulled > 0f && with(density) { AgentSearch.pullCloses(pulled.toDp(), available.y.toDp()) }
        pulled = 0f
        moved = false
        if (closes) onClose()
        return Velocity.Zero
    }
}
