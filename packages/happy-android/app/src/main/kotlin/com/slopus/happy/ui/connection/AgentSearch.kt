package com.slopus.happy.ui.connection

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.slopus.happy.R
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import java.text.Normalizer
import java.util.Locale

/**
 * Home's search, as iOS's (StemCellsSearch, after desktop's ⌘K palette):
 * conversations that answer the query in home's own order, best first,
 * then at most six quick actions and six settings. Case and accents don't
 * count.
 */
object AgentSearch {
    const val SECTION_LIMIT = 6

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
}

/** Something search can take the person to. */
@Immutable
data class AgentSearchEntry(val id: String, val title: String, val icon: Ionicon, val run: () -> Unit)

@Immutable
sealed interface AgentSearchResult {
    val key: String

    data class Heading(val title: String) : AgentSearchResult {
        override val key get() = "heading-$title"
    }

    data class Conversation(val agentId: String, val title: String, val avatarId: String, val bot: Boolean, val thumbhash: String?) : AgentSearchResult {
        override val key get() = "agent-$agentId"
    }

    data class Entry(val entry: AgentSearchEntry) : AgentSearchResult {
        override val key get() = "entry-${entry.id}"
    }
}

/** What answers [query]: conversations, then quick actions, then settings, each under its heading. */
fun agentSearchResults(
    feed: AgentFeed,
    query: String,
    untitled: String,
    headings: Triple<String, String, String>,
    actions: List<AgentSearchEntry>,
    settings: List<AgentSearchEntry>,
): List<AgentSearchResult> {
    if (query.isBlank()) return emptyList()
    val out = ArrayList<AgentSearchResult>()
    val conversations = AgentSearch.ranked(feed.conversations, query) { it.title ?: untitled }
    if (conversations.isNotEmpty()) {
        out += AgentSearchResult.Heading(headings.first)
        conversations.forEach { out += AgentSearchResult.Conversation(it.agentId, it.title ?: untitled, it.avatarId, it.kind == ConversationKind.Bot, it.thumbhash) }
    }
    AgentSearch.ranked(actions, query, AgentSearch.SECTION_LIMIT) { it.title }.takeIf { it.isNotEmpty() }?.let { found ->
        out += AgentSearchResult.Heading(headings.second)
        found.forEach { out += AgentSearchResult.Entry(it) }
    }
    AgentSearch.ranked(settings, query, AgentSearch.SECTION_LIMIT) { it.title }.takeIf { it.isNotEmpty() }?.let { found ->
        out += AgentSearchResult.Heading(headings.third)
        found.forEach { out += AgentSearchResult.Entry(it) }
    }
    return out
}

object AgentSearchTags {
    const val FIELD = "agentSearch.field"
    const val CLEAR = "agentSearch.clear"
    const val RESULTS = "agentSearch.results"
    const val NO_RESULTS = "agentSearch.noResults"
    const val SCRIM = "agentSearch.scrim"
    fun result(key: String) = "agentSearch.result.$key"
}

object AgentSearchSpec {
    val field = happyTextStyle(fontSize = 17, lineHeight = 22)
    val heading = happyTextStyle(fontSize = 13, lineHeight = 18, weight = androidx.compose.ui.text.font.FontWeight.SemiBold)
    val rowTitle = happyTextStyle(fontSize = 16, lineHeight = 22)
    val rowPadding = 16.dp
    val icon = 28.dp
    const val ROW_LINE = 22
    const val HEADING_LINE = 18
}

/** The search field that takes the header's title while searching; focused when it appears. */
@Composable
fun AgentSearchField(query: String, onQueryChange: (String) -> Unit, modifier: Modifier = Modifier) {
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
                    Text(stringResource(R.string.agent_search_placeholder), style = style.copy(color = colors.input.placeholder), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                inner()
            }
        },
    )
}

/**
 * The results, a panel of its own laid over home rather than in its place:
 * as tall as what it shows, up to the keyboard. Nothing typed, it is not
 * there and home shows through; nothing found, it is one line saying so.
 * Home underneath keeps its rows and scroll.
 */
@Composable
fun AgentSearchResults(
    query: String,
    results: List<AgentSearchResult>,
    onOpenConversation: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (query.isBlank()) return
    val colors = HappyTheme.colors
    Box(modifier = modifier.fillMaxWidth().imePadding().navigationBarsPadding()) {
        // A Material surface lifted over home, its shadow the edge where home shows on.
        Surface(color = colors.surface, shadowElevation = 6.dp, modifier = Modifier.fillMaxWidth()) {
        LazyColumn(modifier = Modifier.fillMaxWidth().testTag(AgentSearchTags.RESULTS)) {
            if (results.isEmpty()) {
                item(key = "none") {
                    Text(
                        stringResource(R.string.agent_search_no_results, query.trim()),
                        style = AgentSearchSpec.rowTitle,
                        color = colors.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier
                            .contentMaxWidth(LocalWindowLayout.current)
                            .padding(horizontal = AgentSearchSpec.rowPadding, vertical = 14.dp)
                            .testTag(AgentSearchTags.NO_RESULTS),
                    )
                }
            }
            items(results, key = { it.key }) { result ->
                when (result) {
                    is AgentSearchResult.Heading -> Text(
                        result.title,
                        style = AgentSearchSpec.heading,
                        color = colors.grouped.sectionTitle,
                        modifier = Modifier
                            .contentMaxWidth(LocalWindowLayout.current)
                            .padding(start = AgentSearchSpec.rowPadding, end = AgentSearchSpec.rowPadding, top = 16.dp, bottom = 6.dp)
                            .semantics { heading() },
                    )
                    is AgentSearchResult.Conversation -> ResultRow(result.key, result.title, { onOpenConversation(result.agentId) }) {
                        Avatar(id = result.avatarId, size = AgentSearchSpec.icon, bot = result.bot, thumbhash = result.thumbhash)
                    }
                    is AgentSearchResult.Entry -> ResultRow(result.key, result.entry.title, result.entry.run) {
                        Icon(result.entry.icon, 22.dp, colors.text)
                    }
                }
            }
        }
        }
    }
}

@Composable
private fun ResultRow(key: String, title: String, onClick: () -> Unit, icon: @Composable () -> Unit) {
    val colors = HappyTheme.colors
    // Material's one-line list item: 56, more when the font is larger.
    val height = with(LocalDensity.current) { maxOf(56.dp, 22.dp + AgentSearchSpec.ROW_LINE.sp.toDp()) }
    Row(
        modifier = Modifier
            .contentMaxWidth(LocalWindowLayout.current)
            .heightIn(min = height)
            .testTag(AgentSearchTags.result(key))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = AgentSearchSpec.rowPadding),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(AgentSearchSpec.icon), contentAlignment = Alignment.Center) { icon() }
        Text(
            title,
            style = AgentSearchSpec.rowTitle,
            color = colors.text,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 12.dp),
        )
    }
}
