package com.slopus.happy.ui.feed

import android.content.res.Resources
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.slopus.happy.R
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.agent.FolderMark
import com.slopus.happy.agent.string
import com.slopus.happy.artifacts.DateBucket
import com.slopus.happy.feed.FeedCluster
import com.slopus.happy.feed.FeedFace
import com.slopus.happy.feed.FeedLibrary
import com.slopus.happy.feed.FeedRow
import com.slopus.happy.feed.FeedRows
import com.slopus.happy.feed.FeedSubjectKind
import com.slopus.happy.ui.artifacts.ArtifactListWords
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.artifacts.PlaceTags
import com.slopus.happy.ui.artifacts.rememberArtifactListWords
import com.slopus.happy.ui.cards.CardHeading
import com.slopus.happy.ui.cards.CardListSpec
import com.slopus.happy.ui.cards.CardNote
import com.slopus.happy.ui.cards.cardPlaces
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.HappySwitch
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.connection.AgentTopBar
import com.slopus.happy.ui.connection.BarIconButton
import com.slopus.happy.ui.connection.ConversationMark
import com.slopus.happy.ui.connection.FolderMarkView
import com.slopus.happy.ui.connection.RowTile
import com.slopus.happy.ui.conversation.ConversationScreenTags
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.tablet.BackOrSidebarToggle
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

object FeedTags {
    const val SCREEN = "feed.screen"
    const val LIST = "feed.list"
    const val ROW = "feed.row"
    const val TITLE = "feed.row.title"
    const val TIME = "feed.row.time"
    const val DOT = "feed.row.dot"
    const val FACE = "feed.row.face"
    const val MORE = "feed.row.more"
    const val SUMMARY = "feed.row.summary"
    const val TABS = "feed.tabs"
    const val READ_ALL = "feed.readAll"
    const val FOLLOWING = "feed.following"
    const val PLACE = "feed.place"

    fun tab(following: Boolean) = if (following) "feed.tab.following" else "feed.tab.activity"
    fun row(id: String) = "feed.row:$id"
    fun follow(cluster: String) = "feed.follow:$cluster"
}

/**
 * The Feed's rows (iOS `FeedMetrics`, desktop's `HappyAgentFeedRow`): the
 * subject's 40 avatar, the title with a short time and the unread dot, and
 * under them up to three overlapping faces of who changed it before what
 * they did; never under desktop's 64.
 */
object FeedSpec {
    val minHeight = 64.dp
    val lineGap = 4.dp
    val face = 18.dp
    val faceOverlap = 6.dp
    val faceRing = 1.5.dp
    val moreGap = 4.dp
    val summaryGap = 6.dp
    /** The unread dot, in a lane every row keeps, so reading an entry recolours it and moves nothing. */
    val dot = 8.dp
    val dotGap = 6.dp
    val clusterAvatar = 32.dp
    val clusterRow = 52.dp

    val tabsHeight = 32.dp
    val tabsWidth = 240.dp
    val tabsPadding = 2.dp
    val tabsRadius = 9.dp
    val tabRadius = 7.dp
    val tabLabel = happyTextStyle(fontSize = 13, weight = FontWeight.SemiBold)
}

/**
 * The Feed's words in the person's language (iOS `FeedWords`), resolved
 * from [resources], which reads its plurals off the main thread too.
 */
@Immutable
class FeedWords(private val resources: Resources) {
    val empty: String = resources.getString(R.string.feed_empty)
    val loading: String = resources.getString(R.string.feed_loading)
    val unavailable: String = resources.getString(R.string.feed_unavailable)
    val unsupported: String = resources.getString(R.string.feed_unsupported)
    val everywhere: String = resources.getString(R.string.feed_everywhere)
    val places: String = resources.getString(R.string.feed_places)
    val noClusters: String = resources.getString(R.string.feed_no_clusters)
    val loadingClusters: String = resources.getString(R.string.feed_loading_clusters)
    val clustersUnavailable: String = resources.getString(R.string.feed_clusters_unavailable)
    val unreadMark: String = resources.getString(R.string.feed_unread_mark)
    val everything: String = resources.getString(R.string.feed_everything)
    val team: String = resources.getString(R.string.feed_team)
    val muted: String = resources.getString(R.string.feed_muted)
    val following: String = resources.getString(R.string.feed_following)

    fun follow(name: String): String = resources.getString(R.string.feed_follow, name)
    fun mute(name: String): String = resources.getString(R.string.feed_mute, name)
    fun followFailed(reason: String): String = resources.getString(R.string.feed_follow_failed, reason).trim()

    /**
     * What happened, as the folded changes add up: made, changed some
     * number of times, or both. A todo list's changes are its new todos, a
     * document's its edits, an artifact's its new versions.
     */
    fun activity(created: Boolean, updates: Int, kind: FeedSubjectKind): String {
        val changes = if (updates <= 0) "" else {
            val plural = when (kind) {
                FeedSubjectKind.TodoList -> R.plurals.feed_new_todos
                FeedSubjectKind.Document -> R.plurals.feed_edits
                FeedSubjectKind.Artifact -> R.plurals.feed_versions
                else -> R.plurals.feed_updates
            }
            resources.getQuantityString(plural, updates, updates)
        }
        return when {
            created && changes.isNotEmpty() -> resources.getString(R.string.feed_created_with, changes)
            created -> resources.getString(R.string.feed_created)
            changes.isEmpty() -> resources.getString(R.string.feed_changed)
            else -> changes
        }
    }

    /** A row's second line: the newest change's own words where it has them (a new todo's text), else what happened. */
    fun summary(row: FeedRow): String = row.detail ?: activity(row.created, row.updates, row.kind)
}

@Composable
fun rememberFeedWords(): FeedWords {
    val resources = LocalResources.current
    return remember(resources, resources.configuration) { FeedWords(resources) }
}

/** One slot of the Feed: a date's heading over its card, an entry's row, or a note in place of them. */
@Immutable
sealed interface FeedListItem {
    val key: String

    data class Heading(val bucket: DateBucket, val text: String, val afterCard: Boolean) : FeedListItem {
        override val key: String get() = "heading:$bucket"
    }

    data class Row(val row: FeedRow, val place: HomeCardPlace, val time: String, val summary: String, val more: String?) : FeedListItem {
        override val key: String get() = row.id
    }

    data class Note(override val key: String, val text: String) : FeedListItem
}

/**
 * The Feed's slots (iOS `FeedListItems.items`): a heading for each date
 * bucket over a card of its entries, newest change first, as the artifacts
 * list groups them; or one note in their place. [rows] are the entries
 * joined with what the connection syncs ([FeedRows]); an entry it can't
 * show yet isn't one.
 */
fun feedListItems(state: FeedLibrary.State, rows: List<FeedRow>, catalogLoaded: Boolean, words: FeedWords, dates: ArtifactListWords, now: Long): List<FeedListItem> {
    if (rows.isEmpty()) {
        val text = when {
            state.available == false -> words.unsupported
            state.failed -> words.unavailable
            !state.loaded || state.available == null || state.refreshing -> words.loading
            // Entries whose subjects aren't read yet show once they are.
            state.items.isNotEmpty() && !catalogLoaded -> words.loading
            else -> words.empty
        }
        return listOf(FeedListItem.Note("note", text))
    }
    val items = ArrayList<FeedListItem>(rows.size + 8)
    DateBucket.group(rows, now, dates.zone) { it.lastAt }.forEachIndexed { index, (bucket, group) ->
        items += FeedListItem.Heading(bucket, dates.bucket(bucket, now), afterCard = index > 0)
        group.zip(cardPlaces(group.size)).forEach { (row, place) ->
            val rest = row.actorCount - row.actors.size
            items += FeedListItem.Row(row, place, dates.time(row.lastAt, now), words.summary(row), if (rest > 0) "+$rest" else null)
        }
    }
    if (state.loadingMore) items += FeedListItem.Note("more", words.loadingClusters)
    return items
}

/** What a place in Following wears: a bot's or task's mark, a project's, or its kind's glyph on its tile. */
@Immutable
sealed interface FeedPlaceFace {
    data class Mark(val mark: FeedFace.Mark) : FeedPlaceFace
    data class Project(val mark: FolderMark) : FeedPlaceFace
    data class Tile(val glyph: Ionicon, val tint: RowTile) : FeedPlaceFace
}

/** A place the feed gathers from, named from what the connection syncs (iOS `FeedPlace`). */
@Immutable
data class FeedPlace(val cluster: FeedCluster, val name: String, val face: FeedPlaceFace) {
    /** Everything, or the team: no one thing. */
    val broad: Boolean get() = cluster.cluster == "*" || cluster.kind == "team"

    companion object {
        /** [cluster] as [catalog] names it; null for a place it doesn't hold, or a kind this phone doesn't know. */
        fun of(cluster: FeedCluster, catalog: AgentCatalog, words: FeedWords): FeedPlace? {
            if (cluster.cluster == "*") return FeedPlace(cluster, words.everything, FeedPlaceFace.Tile(Ionicon.NewspaperOutline, RowTile.Red))
            if (cluster.kind == "team") return FeedPlace(cluster, words.team, FeedPlaceFace.Tile(Ionicon.PeopleOutline, RowTile.Teal))
            val id = cluster.placeId ?: return null
            return when (cluster.kind) {
                "task", "bot" -> {
                    val owner = (if (cluster.kind == "bot") catalog.bots else catalog.tasks)[id] ?: return null
                    val name = owner.string("name") ?: (owner["agent"] as? JsonObject)?.string("title")
                    if (name.isNullOrEmpty()) null else FeedPlace(cluster, name, FeedPlaceFace.Mark(FeedRows.mark(cluster.kind, owner)))
                }
                "project" -> {
                    val project = catalog.projects[id] ?: return null
                    val name = project.string("name")
                    if (name.isNullOrEmpty()) null else FeedPlace(cluster, name, FeedPlaceFace.Project(FolderMark.of(id, project)))
                }
                "workspace" -> catalog.workspaces[id]?.string("name")?.takeIf { it.isNotEmpty() }
                    ?.let { FeedPlace(cluster, it, FeedPlaceFace.Tile(Ionicon.GitBranchOutline, RowTile.Blue)) }
                "surface" -> catalog.surfaces[id]?.string("name")?.takeIf { it.isNotEmpty() }
                    ?.let { FeedPlace(cluster, it, FeedPlaceFace.Tile(Ionicon.DocumentTextOutline, RowTile.Blue)) }
                else -> null
            }
        }

        /** Followed: subscribed by choice, or following everything without one. */
        fun following(cluster: FeedCluster, everything: String?): Boolean = (cluster.state ?: everything ?: "subscribed") == "subscribed"
    }
}

/** Following, as the screen shows it: the places, read whole each time it shows. */
@Immutable
data class FeedFollowingState(
    val clusters: List<FeedCluster> = emptyList(),
    /** Places whose follow or mute is on its way. */
    val pending: Set<String> = emptySet(),
    val loaded: Boolean = false,
    val failed: Boolean = false,
    /** Why the last follow or mute didn't take, for its alert. */
    val refused: String? = null,
)

/** One slot of Following: a heading over its card, a place, or a note. */
@Immutable
sealed interface FeedFollowingItem {
    val key: String

    data class Heading(override val key: String, val text: String, val afterCard: Boolean) : FeedFollowingItem
    data class Place(val place: FeedPlace, val row: HomeCardPlace, val following: Boolean, val pending: Boolean) : FeedFollowingItem {
        override val key: String get() = place.cluster.cluster
    }
    data class Note(val text: String) : FeedFollowingItem {
        override val key: String get() = "note"
    }
}

/**
 * Following (iOS `FeedClusterItems`): everything and the team in one card,
 * each place in another, a switch on each to follow or mute it. A place
 * [catalog] doesn't hold isn't listed.
 */
fun feedFollowingItems(state: FeedFollowingState, catalog: AgentCatalog, words: FeedWords): List<FeedFollowingItem> {
    val shown = state.clusters.mapNotNull { FeedPlace.of(it, catalog, words) }
    if (shown.isEmpty()) {
        return listOf(FeedFollowingItem.Note(if (state.failed) words.clustersUnavailable else if (state.loaded) words.noClusters else words.loadingClusters))
    }
    val everything = state.clusters.firstOrNull { it.cluster == "*" }?.state
    val items = ArrayList<FeedFollowingItem>()
    for ((id, label, places) in listOf(Triple("everywhere", words.everywhere, shown.filter { it.broad }), Triple("places", words.places, shown.filterNot { it.broad }))) {
        if (places.isEmpty()) continue
        items += FeedFollowingItem.Heading("heading:$id", label, afterCard = items.isNotEmpty())
        places.zip(cardPlaces(places.size)).forEach { (place, row) ->
            items += FeedFollowingItem.Place(place, row, FeedPlace.following(place.cluster, everything), place.cluster.cluster in state.pending)
        }
    }
    return items
}

/** What the Feed's screen does. */
@Immutable
data class FeedActions(
    val onBack: () -> Unit,
    /** Opens an entry's subject, and counts it seen. */
    val onOpen: (FeedRow) -> Unit = {},
    val onRefresh: () -> Unit = {},
    val onLoadMore: () -> Unit = {},
    val onReadAll: () -> Unit = {},
    /** Following showed, or was pulled: its places are read again. */
    val onReadFollowing: () -> Unit = {},
    val onFollow: (cluster: String, follows: Boolean) -> Unit = { _, _ -> },
    val onRefusalSeen: () -> Unit = {},
)

/**
 * Desktop's Feed page (iOS `FeedViewController`): what happened on this
 * computer, newest first, in home's inset cards under a heading per date.
 * Opening an entry opens its subject and counts it seen; Mark All Read
 * reads everything up to the newest entry shown. The bar's switch turns
 * to Following, the places the feed gathers from, each followed or muted.
 * A pull reads the newest page again; the list's end reads the next one.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FeedScreen(
    state: FeedLibrary.State,
    rows: List<FeedRow>,
    catalog: AgentCatalog,
    following: FeedFollowingState,
    actions: FeedActions,
    clock: () -> Long = System::currentTimeMillis,
) {
    val words = rememberFeedWords()
    val dates = rememberArtifactListWords()
    var showsFollowing by rememberSaveable { mutableStateOf(false) }
    // Today may be yesterday by the time the screen comes back.
    var day by remember { mutableIntStateOf(0) }
    LifecycleResumeEffect(Unit) {
        day++
        onPauseOrDispose { }
    }
    val seed = remember { feedListItems(state, rows, catalog.loaded, words, dates, clock()) }
    val items by produceState(seed, state, rows, catalog.loaded, words, dates, day) {
        value = withContext(Dispatchers.Default) { feedListItems(state, rows, catalog.loaded, words, dates, clock()) }
    }
    val places = remember(following, catalog, words) { feedFollowingItems(following, catalog, words) }
    LaunchedEffect(showsFollowing) { if (showsFollowing) actions.onReadFollowing() }
    val colors = HappyTheme.colors
    val readAll = stringResource(R.string.feed_mark_all_read)
    PlaceScaffold(
        title = stringResource(R.string.feed_title),
        onBack = actions.onBack,
        tag = FeedTags.SCREEN,
        bar = {
            AgentTopBar(
                tag = PlaceTags.BAR,
                container = colors.surface,
                navigationIcon = {
                    BackOrSidebarToggle {
                        BarIconButton(Ionicon.ArrowBack, stringResource(R.string.common_back), actions.onBack, Modifier.testTag(ConversationScreenTags.BACK))
                    }
                },
                title = {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        FeedTabs(showsFollowing) { showsFollowing = it }
                    }
                },
                actions = {
                    if (!showsFollowing) {
                        BarIconButton(Ionicon.CheckmarkDoneOutline, readAll, actions.onReadAll, Modifier.testTag(FeedTags.READ_ALL))
                    } else {
                        // The bar keeps its middle where it was.
                        Spacer(Modifier.size(48.dp))
                    }
                },
            )
        },
    ) {
        if (showsFollowing) {
            FeedFollowingList(places, following, words, actions)
        } else {
            FeedActivityList(items, state, actions)
        }
    }
    following.refused?.let { reason ->
        HappyAlert(Alert(words.followFailed(reason), null, listOf(AlertButton(stringResource(R.string.common_ok)))), onDismiss = actions.onRefusalSeen)
    }
}

/** Activity | Following, in the bar's middle: the segmented control home's dock draws. */
@Composable
private fun FeedTabs(following: Boolean, onChange: (Boolean) -> Unit) {
    val colors = HappyTheme.colors
    Row(
        Modifier
            .testTag(FeedTags.TABS)
            .widthIn(max = FeedSpec.tabsWidth)
            .fillMaxWidth()
            .heightIn(min = FeedSpec.tabsHeight)
            .clip(RoundedCornerShape(FeedSpec.tabsRadius))
            .background(colors.glass.backgroundSubtle)
            .padding(FeedSpec.tabsPadding),
    ) {
        listOf(false to R.string.feed_activity, true to R.string.feed_following).forEach { (tab, label) ->
            val picked = tab == following
            Box(
                Modifier
                    .testTag(FeedTags.tab(tab))
                    .weight(1f)
                    .heightIn(min = FeedSpec.tabsHeight - FeedSpec.tabsPadding * 2)
                    .clip(RoundedCornerShape(FeedSpec.tabRadius))
                    .background(if (picked) colors.surfaceHighest else Color.Transparent)
                    .clickable(role = Role.Tab) { onChange(tab) }
                    .semantics { selected = picked },
                contentAlignment = Alignment.Center,
            ) {
                Text(stringResource(label), style = FeedSpec.tabLabel, color = if (picked) colors.text else colors.textSecondary, maxLines = 1)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FeedActivityList(items: List<FeedListItem>, state: FeedLibrary.State, actions: FeedActions) {
    var pulled by remember { mutableStateOf(false) }
    LaunchedEffect(state.refreshing) { if (!state.refreshing) pulled = false }
    val list = rememberLazyListState()
    // The next page, once the last entry held is on screen.
    val atEnd by remember {
        derivedStateOf {
            val info = list.layoutInfo
            info.totalItemsCount > 0 && (info.visibleItemsInfo.lastOrNull()?.index ?: -1) >= info.totalItemsCount - 2
        }
    }
    LaunchedEffect(atEnd, state.hasMore, state.loadingMore) { if (atEnd && state.hasMore && !state.loadingMore) actions.onLoadMore() }
    PullToRefreshBox(
        isRefreshing = pulled && state.refreshing,
        onRefresh = {
            pulled = true
            actions.onRefresh()
        },
        modifier = Modifier.fillMaxSize(),
    ) {
        val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
        LazyColumn(
            Modifier.fillMaxSize().testTag(FeedTags.LIST),
            state = list,
            contentPadding = PaddingValues(top = CardListSpec.contentTop, bottom = CardListSpec.contentBottom + bottom),
        ) {
            items(items, key = { it.key }, contentType = { it::class }) { item ->
                when (item) {
                    is FeedListItem.Heading -> CardHeading(item.text, item.afterCard)
                    is FeedListItem.Note -> CardNote(item.text)
                    is FeedListItem.Row -> FeedEntryRow(item, actions.onOpen)
                }
            }
        }
    }
}

/**
 * One entry (iOS `FeedRowLayout`):
 *
 *     |16| avatar |12| title ……………………… time |6| • |16|
 *                      ◯◯◯ +N |6| summary ……………………… |16|
 *
 * The title is set heavier while unread; the faces overlap, the first
 * leftmost, each ringed in the card's colour.
 */
@Composable
private fun FeedEntryRow(item: FeedListItem.Row, onOpen: (FeedRow) -> Unit) {
    val colors = HappyTheme.colors
    val words = rememberFeedWords()
    val row = item.row
    val target = row.target
    FeedCard(item.place, FeedSpec.minHeight, CardListSpec.inset + CardListSpec.tile + CardListSpec.tileGap, FeedTags.row(row.id), onClick = target?.let { { onOpen(row) } }) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = CardListSpec.inset, vertical = CardListSpec.padding)
                .semantics(mergeDescendants = true) {
                    stateDescription = listOfNotNull(if (row.unread) words.unreadMark else null, item.summary, item.time).joinToString(", ")
                },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(CardListSpec.tile), contentAlignment = Alignment.Center) { FeedFaceView(row.face, CardListSpec.tile) }
            Spacer(Modifier.width(CardListSpec.tileGap))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        row.title,
                        style = if (row.unread) CardListSpec.title.copy(fontWeight = FontWeight.SemiBold) else CardListSpec.title,
                        color = colors.text,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f).testTag(FeedTags.TITLE),
                    )
                    Spacer(Modifier.width(CardListSpec.trailingGap))
                    Text(item.time, style = CardListSpec.subtitle, color = colors.textSecondary, maxLines = 1, modifier = Modifier.testTag(FeedTags.TIME))
                    Spacer(Modifier.width(FeedSpec.dotGap))
                    Box(
                        Modifier
                            .size(FeedSpec.dot)
                            .clip(CircleShape)
                            .background(if (row.unread) RowTile.Blue.ink(colors.dark) else Color.Transparent)
                            .then(if (row.unread) Modifier.testTag(FeedTags.DOT) else Modifier),
                    )
                }
                Row(Modifier.padding(top = FeedSpec.lineGap), verticalAlignment = Alignment.CenterVertically) {
                    if (row.actors.isNotEmpty()) {
                        Box(Modifier.width(FeedSpec.face + (FeedSpec.face - FeedSpec.faceOverlap) * (row.actors.size - 1)).clearAndSetSemantics { }) {
                            // The first face lies on top, as iOS stacks them.
                            row.actors.withIndex().reversed().forEach { (index, face) ->
                                Box(Modifier.offset(x = (FeedSpec.face - FeedSpec.faceOverlap) * index).testTag(FeedTags.FACE)) {
                                    FeedFaceView(face, FeedSpec.face, ring = colors.surfaceHigh)
                                }
                            }
                        }
                    }
                    if (item.more != null) {
                        if (row.actors.isNotEmpty()) Spacer(Modifier.width(FeedSpec.moreGap))
                        Text(item.more, style = CardListSpec.subtitle, color = colors.textSecondary, maxLines = 1, modifier = Modifier.testTag(FeedTags.MORE))
                    }
                    if (row.actors.isNotEmpty() || item.more != null) Spacer(Modifier.width(FeedSpec.summaryGap))
                    Text(
                        item.summary,
                        style = CardListSpec.subtitle,
                        color = colors.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f).testTag(FeedTags.SUMMARY),
                    )
                }
            }
        }
    }
}

/**
 * A face on the Feed (iOS `FeedFaceView`): a mark as home draws one, round
 * for a person and a rounded square, its corners a tile's for its size,
 * for anything else; or a kind's glyph on its tile. [ring] parts an
 * actor's face from the one it overlaps.
 */
@Composable
internal fun FeedFaceView(face: FeedFace, size: Dp, ring: Color? = null) {
    val radius = when {
        face is FeedFace.Mark && face.round -> size / 2
        else -> CardListSpec.tileRadius * (size / CardListSpec.tile)
    }
    val shape = RoundedCornerShape(radius)
    val ringed = if (ring != null) Modifier.border(FeedSpec.faceRing, ring, shape) else Modifier
    Box(Modifier.size(size).clip(shape), contentAlignment = Alignment.Center) {
        when (face) {
            is FeedFace.Mark -> ConversationMark(
                AgentFeedRow.Conversation(agentId = face.seed, title = null, kind = ConversationKind.Bot, depth = 0, picture = face.picture, thumbhash = face.thumbhash, seed = face.seed, happy = face.happy),
                size,
                radius,
            )
            is FeedFace.Tile -> {
                val (glyph, tint) = feedTile(face.kind, face.artifactType)
                FeedTileView(glyph, tint, size, radius)
            }
        }
        Box(Modifier.size(size).then(ringed))
    }
}

@Composable
private fun FeedTileView(glyph: Ionicon, tint: RowTile, size: Dp, radius: Dp) {
    val dark = HappyTheme.colors.dark
    Box(Modifier.size(size).clip(RoundedCornerShape(radius)).background(tint.fill(dark)), contentAlignment = Alignment.Center) {
        Icon(glyph, CardListSpec.tileGlyph * (size / CardListSpec.tile), tint.ink(dark))
    }
}

/** A kind's glyph and tile (iOS `FeedListItems.tile`); an artifact's by its type, as the artifacts list has it. */
internal fun feedTile(kind: FeedSubjectKind, artifactType: String?): Pair<Ionicon, RowTile> = when (kind) {
    FeedSubjectKind.Task -> Ionicon.CheckboxOutline to RowTile.Orange
    FeedSubjectKind.Bot -> Ionicon.SparklesOutline to RowTile.Indigo
    FeedSubjectKind.Document -> Ionicon.DocumentTextOutline to RowTile.Blue
    FeedSubjectKind.TodoList -> Ionicon.CheckboxOutline to RowTile.Green
    FeedSubjectKind.Calendar -> Ionicon.CalendarOutline to RowTile.Red
    FeedSubjectKind.Surface -> Ionicon.LayersOutline to RowTile.Teal
    FeedSubjectKind.Artifact -> when (artifactType) {
        "markdown" -> Ionicon.DocumentTextOutline to RowTile.Purple
        "html" -> Ionicon.CodeSlashOutline to RowTile.Blue
        "image" -> Ionicon.ImageOutline to RowTile.Orange
        "image_series" -> Ionicon.AlbumsOutline to RowTile.Orange
        "video" -> Ionicon.FilmOutline to RowTile.Red
        else -> Ionicon.DocumentOutline to RowTile.Indigo
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FeedFollowingList(items: List<FeedFollowingItem>, state: FeedFollowingState, words: FeedWords, actions: FeedActions) {
    var pulled by remember { mutableStateOf(false) }
    LaunchedEffect(state.loaded, state.clusters) { pulled = false }
    PullToRefreshBox(
        isRefreshing = pulled,
        onRefresh = {
            pulled = true
            actions.onReadFollowing()
        },
        modifier = Modifier.fillMaxSize(),
    ) {
        val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
        LazyColumn(
            Modifier.fillMaxSize().testTag(FeedTags.FOLLOWING),
            contentPadding = PaddingValues(top = CardListSpec.contentTop, bottom = CardListSpec.contentBottom + bottom),
        ) {
            items(items, key = { it.key }, contentType = { it::class }) { item ->
                when (item) {
                    is FeedFollowingItem.Heading -> CardHeading(item.text, item.afterCard)
                    is FeedFollowingItem.Note -> CardNote(item.text)
                    is FeedFollowingItem.Place -> FeedPlaceRow(item, words, actions)
                }
            }
        }
    }
}

/** A place: its 32 face, its name, and a switch to follow or mute it, which the whole row flips too. */
@Composable
private fun FeedPlaceRow(item: FeedFollowingItem.Place, words: FeedWords, actions: FeedActions) {
    val colors = HappyTheme.colors
    val place = item.place
    val flip = { if (!item.pending) actions.onFollow(place.cluster.cluster, !item.following) }
    FeedCard(item.row, FeedSpec.clusterRow, CardListSpec.inset + FeedSpec.clusterAvatar + CardListSpec.tileGap, FeedTags.PLACE, onClick = flip) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = CardListSpec.inset, vertical = 6.dp)
                .semantics(mergeDescendants = true) { stateDescription = if (item.following) words.following else words.muted },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(FeedSpec.clusterAvatar), contentAlignment = Alignment.Center) {
                val radius = CardListSpec.tileRadius * (FeedSpec.clusterAvatar / CardListSpec.tile)
                when (val face = place.face) {
                    is FeedPlaceFace.Mark -> FeedFaceView(face.mark, FeedSpec.clusterAvatar)
                    is FeedPlaceFace.Project -> FolderMarkView(face.mark, FeedSpec.clusterAvatar)
                    is FeedPlaceFace.Tile -> FeedTileView(face.glyph, face.tint, FeedSpec.clusterAvatar, radius)
                }
            }
            Spacer(Modifier.width(CardListSpec.tileGap))
            Text(place.name, style = CardListSpec.title, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(CardListSpec.trailingGap))
            HappySwitch(
                checked = item.following,
                onCheckedChange = { follows -> actions.onFollow(place.cluster.cluster, follows) },
                enabled = !item.pending,
                label = words.follow(place.name),
                modifier = Modifier.testTag(FeedTags.follow(place.cluster.cluster)),
            )
        }
    }
}

/**
 * One row's part of its card, as [com.slopus.happy.ui.cards.CardRow]
 * draws it, never under [minHeight], growing with its text: the card's
 * ground rounded at the card's ends, a press highlighted within them, a
 * hairline under every row but the last from [dividerStart].
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FeedCard(place: HomeCardPlace, minHeight: Dp, dividerStart: Dp, tag: String, onClick: (() -> Unit)?, content: @Composable BoxScope.() -> Unit) {
    val colors = HappyTheme.colors
    val radius = CardListSpec.radius
    val shape = RoundedCornerShape(
        topStart = if (place.first) radius else 0.dp,
        topEnd = if (place.first) radius else 0.dp,
        bottomStart = if (place.last) radius else 0.dp,
        bottomEnd = if (place.last) radius else 0.dp,
    )
    Box(
        Modifier
            .contentMaxWidth(LocalWindowLayout.current)
            .testTag(tag)
            .padding(horizontal = CardListSpec.side),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(min = minHeight)
                .clip(shape)
                .background(colors.surfaceHigh)
                .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier),
            contentAlignment = Alignment.CenterStart,
        ) {
            content()
            if (!place.last) {
                Box(
                    Modifier
                        .align(Alignment.BottomStart)
                        .padding(start = dividerStart)
                        .fillMaxWidth()
                        .height(hairline())
                        .background(colors.divider),
                )
            }
        }
    }
}
