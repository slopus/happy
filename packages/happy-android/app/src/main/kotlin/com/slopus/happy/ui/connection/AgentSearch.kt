package com.slopus.happy.ui.connection

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
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import java.text.Normalizer
import java.util.Locale

/**
 * Home's search, as iOS's (HappyCore/Agents/Search.swift, after desktop's
 * ⌘K palette): home's rows that answer the query in home's own order,
 * then at most six quick actions and six settings, best first; nothing
 * typed, the bots and tasks last active. Case and accents don't count.
 */
object AgentSearch {
    const val SECTION_LIMIT = 6

    /** How many bots and tasks an empty search shows. */
    const val RECENT_LIMIT = 8

    /** 0: [text] starts with [query]; 1: a word in it does; 2: it holds it anywhere; null: it doesn't. */
    fun rank(text: String, query: String): Int? {
        val needle = fold(query.trim())
        if (needle.isEmpty()) return null
        val haystack = fold(text)
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

    private fun fold(text: String): String =
        Normalizer.normalize(text, Normalizer.Form.NFKD).replace(Regex("\\p{Mn}+"), "").lowercase(Locale.ROOT)

    /** [items] that answer [query], best first and, among equals, in their own order. */
    fun <T> ranked(items: List<T>, query: String, limit: Int = Int.MAX_VALUE, title: (T) -> String): List<T> =
        items.withIndex()
            .mapNotNull { (index, item) -> rank(title(item), query)?.let { Triple(it, index, item) } }
            .sortedWith(compareBy({ it.first }, { it.second }))
            .take(limit)
            .map { it.third }

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

    /**
     * Home's rows that answer [query] (iOS `Search.rows`), in home's own
     * order, with what makes sense of each: a nested match keeps the rows
     * it nests under. [label] is what a row goes by.
     */
    fun rows(feed: AgentFeed, query: String, label: (AgentFeedRow) -> String?): List<AgentFeedRow> {
        val rows = feed.rows
        val kept = BooleanArray(rows.size)
        // The rows each depth's latest row nests under, down from the top.
        val ancestors = ArrayList<Int>()
        rows.forEachIndexed { index, row ->
            if (row is AgentFeedRow.Section) {
                ancestors.clear()
                return@forEachIndexed
            }
            while (ancestors.size > row.depth) ancestors.removeAt(ancestors.lastIndex)
            if (label(row)?.let { rank(it, query) } != null) {
                kept[index] = true
                ancestors.forEach { kept[it] = true }
            }
            ancestors += index
        }
        return rows.filterIndexed { index, _ -> kept[index] }
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
}

/**
 * What search shows for [query]: home's rows that answer it, one card;
 * then the quick actions and the settings that do, each under its heading.
 * Nothing typed: the bots and tasks last active, one card with no title.
 */
fun agentSearchResults(
    feed: AgentFeed,
    query: String,
    label: (AgentFeedRow) -> String?,
    headings: Pair<String, String>,
    actions: List<AgentSearchEntry>,
    settings: List<AgentSearchEntry>,
): List<AgentSearchResult> {
    val home = if (query.isBlank()) AgentSearch.recent(feed) else AgentSearch.rows(feed, query, label)
    val out = ArrayList<AgentSearchResult>()
    home.forEachIndexed { index, row -> out += AgentSearchResult.Home(AgentHomeItem.Row(row, first = index == 0, last = index == home.lastIndex)) }
    if (query.isBlank()) return out
    fun section(title: String, found: List<AgentSearchEntry>) {
        if (found.isEmpty()) return
        out += AgentSearchResult.Heading(title)
        found.forEachIndexed { index, entry -> out += AgentSearchResult.Entry(entry, HomeCardPlace(first = index == 0, last = index == found.lastIndex)) }
    }
    section(headings.first, AgentSearch.ranked(actions, query, AgentSearch.SECTION_LIMIT) { it.title })
    section(headings.second, AgentSearch.ranked(settings, query, AgentSearch.SECTION_LIMIT) { it.title })
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
    onPull: () -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    /** The tablet sidebar's selection, what its main panel shows. */
    selected: String? = null,
    /** Room under the last result to scroll clear of what stands at the foot (the sidebar's settings and compose). */
    bottomClearance: Dp = 0.dp,
) {
    val colors = HappyTheme.colors
    val density = LocalDensity.current
    val pull = remember(density) { PullToClose(density) }
    pull.onPull = onPull
    pull.onClose = onClose
    // Other results than before start at the top; the same ones keep their place.
    val state = rememberLazyListState()
    LaunchedEffect(results.map { it.key }) { state.scrollToItem(0) }
    Box(modifier = modifier.fillMaxSize().background(colors.surface).testTag(AgentSearchTags.RESULTS)) {
        LazyColumn(
            state = state,
            modifier = Modifier.fillMaxSize().nestedScroll(pull),
            contentPadding = PaddingValues(top = AgentHomeSpec.contentTop),
        ) {
            items(results, key = { it.key }) { result ->
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
                        tag = AgentSearchTags.result(result.key),
                        onOpen = onOpenConversation,
                        onOpenArtifacts = onOpenArtifacts,
                        onOpenSurface = onOpenSurface,
                    )
                    is AgentSearchResult.Entry -> AgentSearchEntryRow(
                        result.entry.title,
                        result.entry.icon,
                        result.place,
                        AgentSearchTags.result(result.key),
                        result.entry.run,
                    )
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
