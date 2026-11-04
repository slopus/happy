package com.slopus.happy.ui.settings

import com.slopus.happy.ui.components.PageBackHandler as BackHandler
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.HappySwitch
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.revealRow
import com.slopus.happy.ui.connection.AgentSearchField
import com.slopus.happy.ui.connection.AgentSearchTags
import com.slopus.happy.ui.connection.AgentTopBar
import com.slopus.happy.ui.connection.BarIconButton
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

/**
 * One row of Settings, as iOS's `SettingsIndex` and `SettingsRow` have it:
 * what the page draws and what search finds are the same entry, so the two
 * never name a setting differently. [id] is the row's test tag and what a
 * page reveals ([revealRow]).
 */
@Immutable
class SettingsEntry(
    val id: String,
    val title: String,
    val icon: (@Composable () -> Unit)? = null,
    val subtitle: String? = null,
    val subtitleLines: Int = 2,
    val detail: String? = null,
    val titleColor: Color = Color.Unspecified,
    val chevron: Boolean = true,
    /** The chosen one of a choice: a check where the chevron would be. */
    val checked: Boolean = false,
    /** A switch's state; null for a row without one. */
    val toggle: Boolean? = null,
    val onToggle: ((Boolean) -> Unit)? = null,
    /** The switch's own tag. */
    val toggleTag: String? = null,
    val loading: Boolean = false,
    val enabled: Boolean = true,
    val destructive: Boolean = false,
    val onClick: (() -> Unit)? = null,
    val onLongClick: (() -> Unit)? = null,
    /**
     * On a page of its own (Account, Voice…): found by search it closes the
     * search and opens that page, showing the row there ([onClick] does the
     * opening), with a chevron and no switch.
     */
    val page: Boolean = false,
    /** Found by search, it closes the search before it runs (an account, the picture's asks). */
    val closesSearch: Boolean = page,
) {
    fun copy(onClick: (() -> Unit)? = this.onClick, chevron: Boolean = this.chevron, toggle: Boolean? = this.toggle) = SettingsEntry(
        id, title, icon, subtitle, subtitleLines, detail, titleColor, chevron, checked, toggle, onToggle, toggleTag, loading, enabled, destructive, onClick, onLongClick, page, closesSearch,
    )
}

/** A card of entries and the line under it. */
@Immutable
class SettingsSection(val rows: List<SettingsEntry>, val footer: String? = null, val title: String? = null)

/** [entry] as a settings row. */
@Composable
fun SettingsRow(entry: SettingsEntry) {
    val colors = HappyTheme.colors
    Item(
        title = entry.title,
        modifier = Modifier.revealRow(entry.id).then(if (entry.checked) Modifier.semantics { selected = true } else Modifier),
        subtitle = entry.subtitle,
        subtitleLines = entry.subtitleLines,
        detail = entry.detail,
        icon = entry.icon,
        rightElement = when {
            entry.toggle != null -> {
                {
                    HappySwitch(
                        checked = entry.toggle,
                        onCheckedChange = entry.onToggle,
                        modifier = if (entry.toggleTag != null) Modifier.testTag(entry.toggleTag) else Modifier,
                        label = entry.title,
                    )
                }
            }
            entry.checked -> { { Icon(Ionicon.Checkmark, SettingsPageSpec.check, colors.textLink) } }
            else -> null
        },
        onClick = entry.onClick,
        onLongClick = entry.onLongClick,
        enabled = entry.enabled,
        loading = entry.loading,
        destructive = entry.destructive,
        showChevron = entry.chevron,
        titleColor = entry.titleColor,
    )
}

/** [section]'s card. */
@Composable
fun SettingsCard(section: SettingsSection) {
    ItemGroup(title = section.title, footer = section.footer) {
        for (row in section.rows) SettingsRow(row)
    }
}

object SettingsSearchTags {
    const val OPEN = "settings.search.open"
    const val RESULTS = "settings.search.results"
    const val NOTHING_FOUND = "settings.search.nothingFound"
    fun profile(id: String) = "settings.search.profile.$id"
}

/** SettingsLayout's search metrics. */
object SettingsSearchSpec {
    /** The results' card: 8 under the bar, where the picture was. */
    val resultsTop = 8.dp
    /** "Nothing found": 32 under that, 24 high, centred. */
    val emptyTop = 40.dp
    val emptyHeight = 24.dp
    val empty = happyTextStyle(fontSize = 17, lineHeight = 22)
}

/** Whether the page is searching, and for what; kept through a recreation. */
@Stable
class SettingsSearchState internal constructor(searching: MutableState<Boolean>, query: MutableState<String>) {
    var searching by searching
        private set
    var query by query

    fun open() {
        searching = true
    }

    fun close() {
        searching = false
        query = ""
    }
}

/** Search's state; system back closes it first. */
@Composable
fun rememberSettingsSearch(): SettingsSearchState {
    val searching = rememberSaveable { mutableStateOf(false) }
    val query = rememberSaveable { mutableStateOf("") }
    val state = remember { SettingsSearchState(searching, query) }
    val focus = LocalFocusManager.current
    BackHandler(enabled = state.searching) {
        focus.clearFocus()
        state.close()
    }
    return state
}

/** The bar's search button, beside nothing else: iOS's integrated search button. */
@Composable
fun SettingsSearchButton(search: SettingsSearchState) {
    BarIconButton(Ionicon.SearchOutline, stringResource(R.string.settings_search_placeholder), search::open, Modifier.testTag(SettingsSearchTags.OPEN))
}

/**
 * The bar while searching, as home's search bar: back closes the search
 * (iOS hides Back meanwhile; its Cancel is this), the field focused in the
 * title's place, ✕ clearing it once there is something to clear.
 */
@Composable
fun SettingsSearchBar(search: SettingsSearchState, tag: String) {
    val focus = LocalFocusManager.current
    AgentTopBar(
        tag = tag,
        container = HappyTheme.colors.grouped.background,
        navigationIcon = {
            BarIconButton(Ionicon.ArrowBack, stringResource(R.string.common_back), {
                focus.clearFocus()
                search.close()
            })
        },
        title = { AgentSearchField(search.query, { search.query = it }, placeholder = stringResource(R.string.settings_search_placeholder)) },
        actions = {
            if (search.query.isNotEmpty()) {
                BarIconButton(Ionicon.Close, stringResource(R.string.agent_search_clear), { search.query = "" }, Modifier.testTag(AgentSearchTags.CLEAR))
            }
        },
    )
}

/**
 * What search shows of [query] (iOS's `searchRows`): the accounts and agent
 * connections whose name holds it first, then [asks] (the picture's menu),
 * then the page's [rows] and the rows of its own pages, each title once.
 * Case doesn't count. Nothing that signs out or disconnects is offered.
 */
fun settingsSearchResults(query: String, profiles: List<SettingsEntry>, asks: List<SettingsEntry>, rows: List<SettingsEntry>): List<SettingsEntry> {
    if (query.isEmpty()) return emptyList()
    fun matches(entry: SettingsEntry) = entry.title.contains(query, ignoreCase = true)
    val titles = HashSet<String>()
    return profiles.filter(::matches) + asks.filter(::matches) + rows.filter { matches(it) && !it.destructive && titles.add(it.title) }
}

/**
 * Every account and agent connection as search shows one: its picture, its
 * name, what kind it is. Tapped, the search closes and it opens (the open
 * one stays).
 */
@Composable
fun settingsProfileEntries(accounts: AccountMenu, onSwitch: (String) -> Unit): List<SettingsEntry> {
    val agentKind = stringResource(R.string.account_kind_agent)
    val cliKind = stringResource(R.string.account_kind_cli)
    return accounts.entries.map { entry ->
        SettingsEntry(
            id = SettingsSearchTags.profile(entry.id),
            title = entry.name ?: if (entry.agent) agentKind else cliKind,
            icon = { Avatar(entry.seed, SettingsPageSpec.accountAvatar, imageUri = entry.imageUrl, thumbhash = entry.thumbhash, animated = entry.liveSeed != null) },
            detail = if (entry.agent) agentKind else cliKind,
            onClick = { if (!entry.active) onSwitch(entry.id) },
            closesSearch = true,
        )
    }
}

/**
 * The page while searching: the picture, name and every card give way to
 * what was found, in one card 8 under the bar; nothing typed, nothing; and
 * nothing found, "Nothing found" centred 40 under the bar. A found row runs
 * as it does on the page; one from a page of its own closes the search and
 * opens that page there ([SettingsEntry.page]); others that leave it
 * ([SettingsEntry.closesSearch]) close the search first too.
 */
@Composable
fun SettingsSearchResults(search: SettingsSearchState, results: List<SettingsEntry>) {
    val colors = HappyTheme.colors
    val focus = LocalFocusManager.current
    ItemList(modifier = Modifier.testTag(SettingsSearchTags.RESULTS)) {
        when {
            search.query.isEmpty() -> Unit
            results.isEmpty() -> Text(
                stringResource(R.string.settings_nothing_found),
                style = SettingsSearchSpec.empty,
                color = colors.textSecondary,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .padding(top = SettingsSearchSpec.emptyTop)
                    .fillMaxWidth()
                    .heightIn(min = SettingsSearchSpec.emptyHeight)
                    .testTag(SettingsSearchTags.NOTHING_FOUND),
            )
            else -> ItemGroup(noTitleSpacer = SettingsSearchSpec.resultsTop) {
                for (entry in results) {
                    val run = entry.onClick
                    val closing = run?.let { { focus.clearFocus(); search.close(); it() } }
                    SettingsRow(
                        when {
                            entry.page -> entry.copy(chevron = true, toggle = null, onClick = closing)
                            entry.closesSearch -> entry.copy(onClick = closing)
                            else -> entry
                        },
                    )
                }
            }
        }
    }
}
