package com.slopus.happy.ui.feed

import android.content.res.Resources
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.Constraints
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
import androidx.compose.foundation.layout.aspectRatio
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextAlign
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
import com.slopus.happy.feed.FeedActorName
import com.slopus.happy.feed.FeedFace
import com.slopus.happy.feed.FeedCover
import com.slopus.happy.feed.FeedCovers
import com.slopus.happy.feed.FeedItem
import com.slopus.happy.feed.FeedFilter
import com.slopus.happy.feed.FeedLibrary
import com.slopus.happy.feed.FeedRow
import com.slopus.happy.feed.FeedRows
import com.slopus.happy.feed.FeedSubjectKind
import com.slopus.happy.ui.artifacts.ArtifactListWords
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.artifacts.PlaceTags
import com.slopus.happy.ui.artifacts.rememberArtifactListWords
import com.slopus.happy.ui.artifacts.ArtifactCoverImage
import com.slopus.happy.ui.artifacts.cssColor
import com.slopus.happy.ui.cards.CardHeading
import com.slopus.happy.ui.cards.CardBlock
import com.slopus.happy.ui.cards.CardListSpec
import com.slopus.happy.ui.cards.CardNote
import com.slopus.happy.ui.cards.CardListTags
import com.slopus.happy.ui.cards.cardPlaces
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.HappySwitch
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Octicon
import com.slopus.happy.ui.connection.AgentTopBar
import com.slopus.happy.ui.connection.BarIconButton
import com.slopus.happy.ui.connection.ConversationMark
import com.slopus.happy.ui.connection.FolderMarkView
import com.slopus.happy.ui.connection.RowTile
import com.slopus.happy.ui.conversation.ConversationScreenTags
import com.slopus.happy.ui.tablet.BackOrSidebarToggle
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
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
    const val PEEK = "feed.peek"
    const val FILTER = "feed.filter"
    const val COVER = "feed.post.cover"
    const val POST_SUMMARY = "feed.post.summary"
    const val SUMMARY_TOGGLE = "feed.post.summary.toggle"

    fun tab(following: Boolean) = if (following) "feed.tab.following" else "feed.tab.activity"
    fun filter(filter: FeedFilter) = "feed.filter.${filter.wire}"
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

    /** All | Highlights: across the cards' width, 8 above the list. */
    val filterTop = 8.dp

    /**
     * A covered artifact's post: its summary under the row's header, 16 in
     * as the header is, then the cover across the card inside the same 16,
     * rounded concentrically with the card (26 − 16), and 16 under it.
     */
    val coverRadius = CardListSpec.radius - CardListSpec.inset
    val coverGap = 10.dp
    val postBottom = CardListSpec.inset
    /** A summary shows four lines until it is opened, the fourth ending "… Show more". */
    const val SUMMARY_LINES = 4
    val postSummary = happyTextStyle(fontSize = 15, lineHeight = 20)

    /** On a tablet the cards, posts and their covers are at most desktop's 640 wide. */
    val postMaxWidth = 640.dp
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
    val peekEmpty: String = resources.getString(R.string.feed_peek_empty)
    val all: String = resources.getString(R.string.feed_all)
    val highlights: String = resources.getString(R.string.feed_highlights)
    val highlightsEmptyTitle: String = resources.getString(R.string.feed_highlights_empty_title)
    val highlightsEmpty: String = resources.getString(R.string.feed_highlights_empty)

    fun follow(name: String): String = resources.getString(R.string.feed_follow, name)

    /** Who acted, for TalkBack (iOS `FeedWords.actors`): one or two names in full, then how many more, counting those not known by name. */
    fun actors(names: List<FeedActorName>, count: Int): String {
        val shown = names.map { if (it is FeedActorName.Named) it.name else resources.getString(R.string.feed_you) }
        val total = maxOf(count, shown.size)
        val first = shown.firstOrNull() ?: return ""
        if (total == 1) return first
        if (total == 2 && shown.size >= 2) return resources.getString(R.string.feed_two, first, shown[1])
        return resources.getQuantityString(R.plurals.feed_others, total - 1, first, total - 1)
    }
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

    /** [title] heads it, over [text] that explains. */
    data class Note(override val key: String, val text: String, val title: String? = null) : FeedListItem
}

/**
 * The Feed's slots (iOS `FeedListItems.items`): a heading for each date
 * bucket over a card of its entries, newest change first, as the artifacts
 * list groups them; or one note in their place. [rows] are the entries
 * joined with what the connection syncs ([FeedRows]); an entry it can't
 * show yet isn't one. A place's newest entries, as Following [peek]s at
 * them, say so in their own words. Highlights with none says what shows
 * there, once no older page could hold one.
 */
fun feedListItems(state: FeedLibrary.State, rows: List<FeedRow>, catalogLoaded: Boolean, words: FeedWords, dates: ArtifactListWords, now: Long, peek: Boolean = false): List<FeedListItem> {
    if (rows.isEmpty()) {
        val text = when {
            peek -> if (state.failed) words.clustersUnavailable else if (state.loaded) words.peekEmpty else words.loadingClusters
            state.available == false -> words.unsupported
            state.failed -> words.unavailable
            !state.loaded || state.available == null || state.refreshing -> words.loading
            // Entries whose subjects aren't read yet show once they are.
            state.items.isNotEmpty() && !catalogLoaded -> words.loading
            state.filter == FeedFilter.Highlights && (state.hasMore || state.loadingMore) -> words.loading
            state.filter == FeedFilter.Highlights -> return listOf(FeedListItem.Note("note", words.highlightsEmpty, words.highlightsEmptyTitle))
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
    /** Everything: Activity's own pulse, as home's row wears it. */
    data object Everything : FeedPlaceFace
}

/** A place the feed gathers from, named from what the connection syncs (iOS `FeedPlace`). */
@Immutable
data class FeedPlace(val cluster: FeedCluster, val name: String, val face: FeedPlaceFace) {
    /** Everything, or the team: no one thing. */
    val broad: Boolean get() = cluster.cluster == "*" || cluster.kind == "team"

    companion object {
        /** [cluster] as [catalog] names it; null for a place it doesn't hold, or a kind this phone doesn't know. */
        fun of(cluster: FeedCluster, catalog: AgentCatalog, words: FeedWords): FeedPlace? {
            if (cluster.cluster == "*") return FeedPlace(cluster, words.everything, FeedPlaceFace.Everything)
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
    /** All or Highlights was picked. */
    val onFilter: (FeedFilter) -> Unit = {},
    /** Following showed, or was pulled: its places are read again. */
    val onReadFollowing: () -> Unit = {},
    val onFollow: (cluster: String, follows: Boolean) -> Unit = { _, _ -> },
    /** A place in Following was tapped: its newest entries. */
    val onPeek: (FeedCluster) -> Unit = {},
    val onRefusalSeen: () -> Unit = {},
)

/**
 * Desktop's Feed page (iOS `FeedViewController`): what happened on this
 * computer, newest first, in home's inset cards under a heading per date.
 * Opening an entry opens its subject and counts it seen; Mark All Read
 * reads everything up to the newest entry shown. Under the bar All |
 * Highlights picks what Activity shows; a covered artifact is a post with
 * its picture ([covers] reads them). The bar's switch turns to Following,
 * the places the feed gathers from, each followed or muted. A pull reads
 * the newest page again; the list's end reads the next one.
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
    covers: FeedCovers? = null,
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
                        FeedSegments(
                            listOf(false to stringResource(R.string.feed_activity), true to stringResource(R.string.feed_following)),
                            showsFollowing,
                            Modifier.testTag(FeedTags.TABS).widthIn(max = FeedSpec.tabsWidth).fillMaxWidth(),
                            tag = FeedTags::tab,
                        ) { showsFollowing = it }
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
            ProvideFeedWidth {
                Column(Modifier.fillMaxSize()) {
                    FeedSegments(
                        listOf(FeedFilter.All to words.all, FeedFilter.Highlights to words.highlights),
                        state.filter,
                        Modifier
                            .contentMaxWidth(LocalWindowLayout.current)
                            .testTag(FeedTags.FILTER)
                            .padding(top = FeedSpec.filterTop)
                            .padding(horizontal = CardListSpec.side)
                            .fillMaxWidth(),
                        tag = FeedTags::filter,
                        onChange = actions.onFilter,
                    )
                    FeedActivityList(items, state, actions, covers)
                }
            }
        }
    }
    following.refused?.let { reason ->
        HappyAlert(Alert(words.followFailed(reason), null, listOf(AlertButton(stringResource(R.string.common_ok)))), onDismiss = actions.onRefusalSeen)
    }
}

/** A peek at one place: its newest entries as the computer last gave them. */
@Immutable
data class FeedPeekState(val items: List<FeedItem> = emptyList(), val loaded: Boolean = false, val failed: Boolean = false, val refreshing: Boolean = false)

/**
 * A place's newest entries, as Following peeks at them (iOS
 * `FeedPeekViewController`): the Feed's rows without the dot, read from
 * the computer each time; [title] is the place's name as it is now. A pull
 * reads them again.
 */
@Composable
fun FeedPeekScreen(
    title: String,
    peek: FeedPeekState,
    rows: List<FeedRow>,
    catalog: AgentCatalog,
    actions: FeedActions,
    clock: () -> Long = System::currentTimeMillis,
    covers: FeedCovers? = null,
) {
    val words = rememberFeedWords()
    val dates = rememberArtifactListWords()
    var day by remember { mutableIntStateOf(0) }
    LifecycleResumeEffect(Unit) {
        day++
        onPauseOrDispose { }
    }
    val state = FeedLibrary.State(available = true, items = peek.items, loaded = peek.loaded, failed = peek.failed, refreshing = peek.refreshing)
    val seed = remember { feedListItems(state, rows, catalog.loaded, words, dates, clock(), peek = true) }
    val items by produceState(seed, state, rows, catalog.loaded, words, dates, day) {
        value = withContext(Dispatchers.Default) { feedListItems(state, rows, catalog.loaded, words, dates, clock(), peek = true) }
    }
    PlaceScaffold(title = title, onBack = actions.onBack, tag = FeedTags.PEEK) {
        ProvideFeedWidth { FeedActivityList(items, state, actions, covers) }
    }
}

/** The Feed's list held to [FeedSpec.postMaxWidth] between the cards' edges, as desktop's is: narrower than the tablet's 768 measure. */
@Composable
private fun ProvideFeedWidth(content: @Composable () -> Unit) {
    val layout = LocalWindowLayout.current
    val held = layout.content.maxContentWidth.coerceAtMost(FeedSpec.postMaxWidth)
    CompositionLocalProvider(LocalWindowLayout provides layout.copy(content = layout.content.copy(maxContentWidth = held)), content = content)
}

/**
 * The segmented control home's dock draws: Activity | Following in the
 * bar's middle, and All | Highlights over Activity's cards.
 */
@Composable
private fun <T> FeedSegments(options: List<Pair<T, String>>, current: T, modifier: Modifier, tag: (T) -> String, onChange: (T) -> Unit) {
    val colors = HappyTheme.colors
    Row(
        modifier
            .heightIn(min = FeedSpec.tabsHeight)
            .clip(RoundedCornerShape(FeedSpec.tabsRadius))
            .background(colors.glass.backgroundSubtle)
            .padding(FeedSpec.tabsPadding),
    ) {
        options.forEach { (tab, label) ->
            val picked = tab == current
            Box(
                Modifier
                    .testTag(tag(tab))
                    .weight(1f)
                    .heightIn(min = FeedSpec.tabsHeight - FeedSpec.tabsPadding * 2)
                    .clip(RoundedCornerShape(FeedSpec.tabRadius))
                    .background(if (picked) colors.surfaceHighest else Color.Transparent)
                    .clickable(role = Role.Tab) { onChange(tab) }
                    .semantics { selected = picked },
                contentAlignment = Alignment.Center,
            ) {
                Text(label, style = FeedSpec.tabLabel, color = if (picked) colors.text else colors.textSecondary, maxLines = 1)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FeedActivityList(items: List<FeedListItem>, state: FeedLibrary.State, actions: FeedActions, covers: FeedCovers? = null) {
    var pulled by remember { mutableStateOf(false) }
    LaunchedEffect(state.refreshing) { if (!state.refreshing) pulled = false }
    val list = rememberLazyListState()
    // Another filter starts at its top; coming back to the screen keeps the place.
    var listed by rememberSaveable { mutableStateOf(state.filter) }
    LaunchedEffect(state.filter) {
        if (state.filter != listed) {
            listed = state.filter
            list.scrollToItem(0)
        }
    }
    // The next page, once the last entry held is on screen: Highlights filtered here page on until they fill it.
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
                    is FeedListItem.Note -> if (item.title != null) FeedEmptyNote(item.title, item.text) else CardNote(item.text)
                    is FeedListItem.Row -> FeedEntryRow(item, actions.onOpen, covers)
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
 *
 * A covered artifact is a post: the same header, then its summary and its
 * cover ([FeedPost]). Its height comes from the card's width and the
 * cover's size, never from the picture, so nothing moves as it lands. A
 * tap anywhere on it opens the artifact.
 */
@Composable
private fun FeedEntryRow(item: FeedListItem.Row, onOpen: (FeedRow) -> Unit, covers: FeedCovers?) {
    val words = rememberFeedWords()
    val row = item.row
    val target = row.target
    val cover = row.cover
    FeedCard(item.place, FeedSpec.minHeight, CardListSpec.inset + CardListSpec.tile + CardListSpec.tileGap, FeedTags.row(row.id), onClick = target?.let { { onOpen(row) } }) {
        Column(
            Modifier
                .fillMaxWidth()
                .semantics(mergeDescendants = true) {
                    stateDescription = listOfNotNull(
                        if (row.unread) words.unreadMark else null, item.summary, words.actors(row.actorNames, row.actorCount).ifEmpty { null }, item.time,
                    ).joinToString(", ")
                },
        ) {
            FeedEntryHeader(item)
            if (cover != null || row.summary != null) {
                // Opened or not is this phone's, per entry, kept while the list keeps it.
                var opened by rememberSaveable(row.id) { mutableStateOf(false) }
                FeedPost(row.summary, opened, { opened = !opened }, cover, covers)
            }
        }
    }
}

/** An entry's header: its avatar, title, time and dot, and who did what. */
@Composable
private fun FeedEntryHeader(item: FeedListItem.Row) {
    val colors = HappyTheme.colors
    val row = item.row
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = CardListSpec.inset, vertical = CardListSpec.padding),
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

/**
 * A post's body under its header:
 *
 *     |16| summary, four lines … Show more ……… |16|
 *                         10
 *     |16| ┌ cover, 16:9 or 1:1 of the width ──┐ |16|
 *          └───────────────────────────────────┘
 *                         16
 *
 * Either may be missing: a summary without a cover is a post of words.
 */
@Composable
private fun FeedPost(summary: String?, opened: Boolean, onToggle: () -> Unit, cover: FeedCover?, covers: FeedCovers?) {
    Column(Modifier.fillMaxWidth().padding(start = CardListSpec.inset, end = CardListSpec.inset, bottom = FeedSpec.postBottom)) {
        if (summary != null) FeedSummary(summary, opened, onToggle, Modifier.padding(bottom = if (cover != null) FeedSpec.coverGap else 0.dp))
        if (cover != null) FeedCoverView(cover, covers)
    }
}

/**
 * A summary in the Feed's body style, its line breaks kept: whole when it
 * fits [FeedSpec.SUMMARY_LINES] lines; else cut so the last of them ends
 * "… Show more", which opens it in place, and opened it ends "Show less".
 * Only those words toggle; a tap anywhere else is the post's.
 */
@Composable
private fun FeedSummary(text: String, opened: Boolean, onToggle: () -> Unit, modifier: Modifier) {
    val colors = HappyTheme.colors
    val more = stringResource(R.string.feed_show_more)
    val less = stringResource(R.string.machine_launcher_show_less)
    val measurer = rememberTextMeasurer()
    val style = FeedSpec.postSummary
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val width = constraints.maxWidth
        val cut = remember(text, width, style, more, measurer) { feedSummaryCut(measurer, text, style, width, more) }
        val link = LinkAnnotation.Clickable(FeedTags.SUMMARY_TOGGLE, TextLinkStyles(SpanStyle(color = colors.textLink))) { onToggle() }
        val shown = buildAnnotatedString {
            when {
                cut == null -> append(text)
                opened -> {
                    append(text)
                    append(" ")
                    withLink(link) { append(less) }
                }
                else -> {
                    append(feedSummaryHead(text, cut))
                    append("\u2026 ")
                    withLink(link) { append(more) }
                }
            }
        }
        Text(
            shown,
            style = style,
            color = colors.text,
            modifier = Modifier
                .testTag(FeedTags.POST_SUMMARY)
                .semantics { if (cut != null) customActions = listOf(CustomAccessibilityAction(if (opened) less else more) { onToggle(); true }) },
        )
    }
}

/**
 * Where [text] is cut so it and "… [more]" fill [lines] lines [width]
 * pixels wide, as [measurer] lays them out; null when it fits whole.
 */
internal fun feedSummaryCut(measurer: TextMeasurer, text: String, style: TextStyle, width: Int, more: String, lines: Int = FeedSpec.SUMMARY_LINES): Int? {
    val constraints = Constraints(maxWidth = width)
    val whole = measurer.measure(text, style, maxLines = lines, constraints = constraints)
    if (!whole.hasVisualOverflow) return null
    var low = 0
    var high = whole.getLineEnd(lines - 1, visibleEnd = true)
    while (low < high) {
        val mid = (low + high + 1) / 2
        val tried = measurer.measure(feedSummaryHead(text, mid) + "\u2026 " + more, style, maxLines = lines, constraints = constraints)
        if (tried.hasVisualOverflow) high = mid - 1 else low = mid
    }
    return low
}

/** The first [length] characters of a summary as the ellipsis follows them: no space or stop before it. */
internal fun feedSummaryHead(text: String, length: Int): String = text.substring(0, length).trimEnd { it.isWhitespace() || it in ".,;:" }

/**
 * A cover across the post (spec "Covered artifact entries"): exactly its
 * shape, 16:9 or 1:1, of the width shown, which the content column holds
 * to the reading width on a fold or tablet. It sits on the artifact's
 * background, or a neutral ground, and the picture fades in over it once
 * read; one a pixel or two off its shape is cropped by those, centred.
 */
@Composable
private fun FeedCoverView(cover: FeedCover, covers: FeedCovers?) {
    val ground = cover.background?.let(::cssColor) ?: HappyTheme.colors.surfaceHighest
    Box(
        Modifier
            .fillMaxWidth()
            .aspectRatio(cover.aspect.ratio)
            .clip(RoundedCornerShape(FeedSpec.coverRadius))
            .background(ground)
            .testTag(FeedTags.COVER),
    ) {
        ArtifactCoverImage(cover, covers, ContentScale.Crop, use = "post", moves = true)
    }
}

/** A note with a heading (Highlights with none): the heading 16/20 semibold over what it explains. */
@Composable
private fun FeedEmptyNote(title: String, text: String) {
    val colors = HappyTheme.colors
    Column(
        Modifier
            .contentMaxWidth(LocalWindowLayout.current)
            .testTag(CardListTags.NOTE)
            .padding(horizontal = CardListSpec.side + CardListSpec.inset, vertical = CardListSpec.notePadding),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, style = CardListSpec.title.copy(fontWeight = FontWeight.SemiBold), color = colors.text, textAlign = TextAlign.Center)
        Text(text, style = CardListSpec.note, color = colors.textSecondary, textAlign = TextAlign.Center, modifier = Modifier.padding(top = CardListSpec.lineGap * 2))
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
private fun FeedTileView(glyph: Ionicon, tint: RowTile, size: Dp, radius: Dp) =
    FeedTileBox(tint, size, radius) { glyphSize, ink -> Icon(glyph, glyphSize, ink) }

@Composable
private fun FeedTileView(glyph: Octicon, tint: RowTile, size: Dp, radius: Dp) =
    FeedTileBox(tint, size, radius) { glyphSize, ink -> Icon(glyph, glyphSize, ink) }

@Composable
private fun FeedTileBox(tint: RowTile, size: Dp, radius: Dp, glyph: @Composable (Dp, Color) -> Unit) {
    val dark = HappyTheme.colors.dark
    Box(Modifier.size(size).clip(RoundedCornerShape(radius)).background(tint.fill(dark)), contentAlignment = Alignment.Center) {
        glyph(CardListSpec.tileGlyph * (size / CardListSpec.tile), tint.ink(dark))
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

/** A place: its 32 face, its name, and a switch to follow or mute it; a tap peeks at its newest entries. */
@Composable
private fun FeedPlaceRow(item: FeedFollowingItem.Place, words: FeedWords, actions: FeedActions) {
    val colors = HappyTheme.colors
    val place = item.place
    FeedCard(item.row, FeedSpec.clusterRow, CardListSpec.inset + FeedSpec.clusterAvatar + CardListSpec.tileGap, FeedTags.PLACE, onClick = { actions.onPeek(place.cluster) }) {
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
                    FeedPlaceFace.Everything -> FeedTileView(Octicon.Pulse, RowTile.Red, FeedSpec.clusterAvatar, radius)
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
 * Feed content uses the shared card shell, growing above [minHeight] with
 * its text, with a divider under every row but the last from [dividerStart].
 */
@Composable
private fun FeedCard(place: HomeCardPlace, minHeight: Dp, dividerStart: Dp, tag: String, onClick: (() -> Unit)?, content: @Composable BoxScope.() -> Unit) {
    CardBlock(place.copy(separated = !place.last), dividerStart = dividerStart, tag = tag) {
        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(min = minHeight)
                .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier),
            contentAlignment = Alignment.CenterStart,
            content = content,
        )
    }
}
