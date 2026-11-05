package com.slopus.happy.ui.connection

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
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.agent.isNullish
import com.slopus.happy.agent.string
import com.slopus.happy.artifacts.ArtifactCatalog
import com.slopus.happy.artifacts.ArtifactCatalogFeed
import com.slopus.happy.artifacts.ArtifactRef
import com.slopus.happy.search.QuickSearchAnswer
import com.slopus.happy.search.QuickSearchFusion
import com.slopus.happy.search.QuickSearchHit
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.vaults.VaultNames
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.text.Normalizer
import java.util.Locale

/**
 * Home's search, quick search's phone half (happy-agent API.md, "Quick
 * search"): what the phone holds that answers the query, fused with what
 * the daemon finds in one card ([agentSearchResults]); then at most six
 * quick actions and six settings. Nothing typed, the bots and tasks last
 * active. Case and accents don't count, and a query of several words
 * finds them in any order.
 */
object AgentSearch {
    const val SECTION_LIMIT = 6

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

    /**
     * One result of quick search under its [key] (`<type>:<id>`): [local]
     * as the phone draws it, where it holds it; [hit] what the daemon said
     * of it. A content match's line is the daemon's alone, so it shows the
     * daemon's row; otherwise the phone's row stays as it was when the
     * daemon's answer comes in.
     */
    data class Found(override val key: String, val local: AgentSearchResult?, val hit: QuickSearchHit?, val place: HomeCardPlace) : AgentSearchResult {
        val drawn: AgentSearchResult? get() = local.takeIf { hit == null || quickSearchDetail(hit) == null }
    }
}

/**
 * What search finds beyond home's rows (desktop's ⌘K sources, 28342477),
 * only from what the phone already holds: every Surface in the catalog
 * with a page of its own, joined or not, newest first; the open todos of
 * the joined lists whose last read is kept; the artifact catalog as
 * [ArtifactCatalogFeed] keeps it, newest change first.
 */
@Immutable
data class AgentSearchSources(
    val surfaces: List<Surface> = emptyList(),
    val todos: List<Todo> = emptyList(),
    val artifacts: List<ArtifactRef> = emptyList(),
) {
    data class Surface(val row: AgentFeedRow.Surface, val joined: Boolean)

    data class Todo(val id: String, val text: String, val list: AgentFeedRow.Surface)

    companion object {
        val None = AgentSearchSources()

        /** Kinds with a page of their own; one that only points at an artifact, a bot or a task is found under its own name. */
        val KINDS = setOf(SurfaceReader.DOCUMENT, SurfaceReader.TODO, "calendar", "system_monitor", "vault", "chat")

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
                    updatedAt to Surface(AgentFeedRow.Surface(id, surface.string("name").orEmpty(), surface.string("type").orEmpty()), joined)
                }
                .sortedByDescending { it.first }
                .map { it.second }
            val ops = pending.mapNotNull(TodoOp::of).groupBy { it.surfaceId }
            val todos = surfaces.filter { it.joined && it.row.type == SurfaceReader.TODO }.flatMap { list ->
                val confirmed = kept(TodoLibrary.resource(list.row.id))?.get("todos").arr.orEmpty().mapNotNull(TodoItem::parse).associateBy { it.id }
                TodoReducer.overlay(confirmed, ops[list.row.id].orEmpty()).values
                    .filter { it.status == TodoItem.Status.Active && it.heading == null }
                    .map { Todo(it.id, it.text, list.row) }
            }
            val artifacts = kept(ArtifactCatalogFeed.RESOURCE)?.let(ArtifactCatalog::fromKept).orEmpty().map { it.ref }
            return AgentSearchSources(surfaces, todos, artifacts)
        }
    }
}

/** What search's sections are called, and the names of the kinds a query also finds a row by. */
@Immutable
class AgentSearchWords(
    val actions: String,
    val settings: String,
    val surfaceType: (String) -> String,
    val artifactType: (String) -> String,
)

/**
 * One thing the phone's own search found, under the key the daemon gives
 * it (API.md, "Quick search" › Result types): what it is called, what it
 * answers to below that, its tier among equals, and how it is drawn at its
 * place in the card.
 */
private class Local(val key: String, val title: String, val secondary: List<String>, val tier: Int, val result: (HomeCardPlace) -> AgentSearchResult)

/**
 * The phone's half of quick search for [query], ranked as the daemon ranks
 * its own: each kind's matches best first ([AgentSearch.ranked]), then
 * the kinds fused as the daemon fuses its providers, each match scored by
 * its place in its kind's list, equal places in the daemon's provider
 * order ([QuickSearchHit.TYPES]). From what the phone holds: home's
 * conversations, projects and worktrees; the catalog's documents and other
 * Surfaces, joined or not; the open todos kept; the artifacts kept; and
 * home's own pages after them, which only the phone has.
 */
private fun localQuickSearch(feed: AgentFeed, query: String, label: (AgentFeedRow) -> String?, words: AgentSearchWords, sources: AgentSearchSources): List<Local> {
    val surfaces = sources.surfaces.map { it.row to it.joined } +
        feed.rows.filterIsInstance<AgentFeedRow.Surface>().filter { row -> sources.surfaces.none { it.row.id == row.id } }.map { it to true }
    fun surface(row: AgentFeedRow.Surface, joined: Boolean) = Local(
        if (row.type == SurfaceReader.DOCUMENT) "document:${row.id}" else "surface:${row.id}",
        row.name,
        listOf(words.surfaceType(row.type)),
        if (joined) 0 else 1,
    ) { place -> AgentSearchResult.Home(AgentHomeItem.Row(row, place.first, place.last)) }
    fun home(row: AgentFeedRow, key: String) = label(row)?.let { title ->
        // A flat list: a subtask or a worktree stands at the card's edge like the rest.
        val flat = when (row) {
            is AgentFeedRow.Conversation -> row.copy(depth = 0)
            is AgentFeedRow.Folder -> row.copy(depth = 0)
            else -> row
        }
        Local(key, title, emptyList(), 0) { place -> AgentSearchResult.Home(AgentHomeItem.Row(flat, place.first, place.last)) }
    }
    val providers: Map<String, List<Local>> = mapOf(
        "document" to surfaces.filter { it.first.type == SurfaceReader.DOCUMENT }.map { surface(it.first, it.second) },
        "todo" to sources.todos.map { todo -> Local("todo:${todo.id}", todo.text, emptyList(), 0) { AgentSearchResult.Todo(todo, it) } },
        "artifact" to sources.artifacts.map { artifact ->
            Local("artifact:${artifact.id}", artifact.title, listOf(words.artifactType(artifact.type)), 0) { AgentSearchResult.Artifact(artifact, it) }
        },
        "surface" to surfaces.filter { it.first.type != SurfaceReader.DOCUMENT }.map { surface(it.first, it.second) },
        "agent" to feed.rows.filterIsInstance<AgentFeedRow.Conversation>().mapNotNull { home(it, "agent:${it.agentId}") },
        "project" to feed.rows.filterIsInstance<AgentFeedRow.Folder>().filter { it.depth == 0 }.mapNotNull { home(it, "project:${it.id}") },
        "workspace" to feed.rows.filterIsInstance<AgentFeedRow.Folder>().filter { it.depth > 0 }.mapNotNull { home(it, "workspace:${it.id}") },
        HOME_PAGES to feed.rows.filter { it == AgentFeedRow.Artifacts || it is AgentFeedRow.Feed || it == AgentFeedRow.Todos }.mapNotNull { home(it, "home:${it.key}") },
    )
    val order = QuickSearchHit.TYPES + HOME_PAGES
    return providers.entries
        .flatMap { (type, items) ->
            AgentSearch.ranked(items, query, secondary = { it.secondary }, tier = { it.tier }) { it.title }
                .mapIndexed { index, item -> Triple(index, order.indexOf(type), item) }
        }
        .distinctBy { it.third.key }
        // 1 / (60 + p) falls as p grows, so by place, then provider order.
        .sortedWith(compareBy({ it.first }, { it.second }))
        .map { it.third }
}

/** Home's own pages (Artifacts, Activity, Todos): only the phone has them, after the daemon's kinds. */
private const val HOME_PAGES = "home"

/**
 * What search shows for [query]: one card of what it finds, the phone's
 * own results ([localQuickSearch]) fused with the daemon's ([remote], for
 * this query) as every client fuses them ([QuickSearchFusion]); then the
 * quick actions and the settings that answer, each under its heading, at
 * most six, best first, which only the phone has. Nothing typed: the bots
 * and tasks last active, one card with no title.
 */
fun agentSearchResults(
    feed: AgentFeed,
    query: String,
    label: (AgentFeedRow) -> String?,
    words: AgentSearchWords,
    actions: List<AgentSearchEntry>,
    settings: List<AgentSearchEntry>,
    sources: AgentSearchSources = AgentSearchSources.None,
    remote: QuickSearchAnswer? = null,
): List<AgentSearchResult> {
    val out = ArrayList<AgentSearchResult>()
    if (query.isBlank()) {
        val recent = AgentSearch.recent(feed)
        recent.forEachIndexed { index, row -> out += AgentSearchResult.Home(AgentHomeItem.Row(row, first = index == 0, last = index == recent.lastIndex)) }
        return out
    }
    val fused = QuickSearchFusion.fuse(remote?.hits.orEmpty(), localQuickSearch(feed, query, label, words, sources), { it.key }, { it.rank }, { it.key })
    fused.forEachIndexed { index, found ->
        val place = HomeCardPlace(first = index == 0, last = index == fused.lastIndex)
        out += AgentSearchResult.Found(found.key, found.local?.result?.invoke(place), found.remote, place)
    }
    fun section(title: String, entries: List<AgentSearchEntry>) {
        val found = AgentSearch.ranked(entries, query, AgentSearch.SECTION_LIMIT) { it.title }
        if (found.isEmpty()) return
        out += AgentSearchResult.Heading(title)
        found.forEachIndexed { index, entry -> out += AgentSearchResult.Entry(entry, HomeCardPlace(first = index == 0, last = index == found.lastIndex)) }
    }
    section(words.actions, actions)
    section(words.settings, settings)
    return out
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
    onOpenHit: (QuickSearchHit) -> (() -> Unit)? = { null },
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
                // A quick search result is drawn as the phone's row where it has one, else as the daemon's.
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
                    is AgentSearchResult.Found -> result.hit?.let { hit ->
                        AgentSearchEntryRow(
                            quickSearchTitle(hit).ifBlank { stringResource(if (hit is QuickSearchHit.Artifact) R.string.agent_artifacts_untitled else R.string.session_new_chat) },
                            quickSearchGlyph(hit),
                            result.place,
                            tag,
                            detail = quickSearchDetail(hit),
                            onClick = onOpenHit(hit),
                        )
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
internal fun quickSearchTitle(hit: QuickSearchHit): String = when (hit) {
    is QuickSearchHit.VaultFile -> VaultNames.shown(hit.name)
    is QuickSearchHit.VaultFolder -> hit.name
    is QuickSearchHit.Document -> hit.name
    is QuickSearchHit.Todo -> hit.text
    is QuickSearchHit.CalendarEvent -> hit.title
    is QuickSearchHit.Artifact -> hit.title
    is QuickSearchHit.Surface -> hit.name
    is QuickSearchHit.Agent -> hit.title
    is QuickSearchHit.Project -> hit.name
    is QuickSearchHit.Workspace -> hit.name
}

/**
 * A daemon's result's second line: a content match's line, where a vault
 * item is, or when an event next is; null where it has none, and the row
 * is one line as the phone's own are.
 */
internal fun quickSearchDetail(hit: QuickSearchHit): String? {
    fun line(text: String?) = text?.replace(Regex("\\s+"), " ")?.trim()?.takeIf { it.isNotEmpty() }
    fun folder(path: String) = VaultNames.shownPath(path.substringBeforeLast('/')).ifEmpty { "/" }
    return when (hit) {
        is QuickSearchHit.VaultFile -> line(hit.snippet) ?: folder(hit.path)
        is QuickSearchHit.VaultFolder -> folder(hit.path)
        is QuickSearchHit.Document -> line(hit.snippet)
        is QuickSearchHit.Artifact -> line(hit.snippet)
        is QuickSearchHit.CalendarEvent -> hit.start.takeIf { it > 0 }?.let {
            val format = if (hit.allDay) java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM) else java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT)
            // An all-day event is a date, the same wherever the phone is.
            if (hit.allDay) format.timeZone = java.util.TimeZone.getTimeZone("UTC")
            format.format(java.util.Date(it))
        }
        else -> null
    }
}

/** A daemon's result's glyph, as the phone draws the same kind of thing. */
private fun quickSearchGlyph(hit: QuickSearchHit): Ionicon = when (hit) {
    is QuickSearchHit.VaultFile -> if (hit.kind == "artifact") Ionicon.AppsOutline else Ionicon.DocumentOutline
    is QuickSearchHit.VaultFolder -> Ionicon.FolderOutline
    is QuickSearchHit.Document -> Ionicon.DocumentTextOutline
    is QuickSearchHit.Todo -> Ionicon.CheckmarkCircleOutline
    is QuickSearchHit.CalendarEvent -> Ionicon.CalendarOutline
    is QuickSearchHit.Artifact -> artifactGlyph(hit.artifactType)
    is QuickSearchHit.Surface -> RowTile.surface(hit.surfaceType).first
    is QuickSearchHit.Agent -> if (hit.kind == "bot") Ionicon.PersonCircleOutline else Ionicon.ChatbubbleEllipsesOutline
    is QuickSearchHit.Project, is QuickSearchHit.Workspace -> Ionicon.FolderOutline
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
