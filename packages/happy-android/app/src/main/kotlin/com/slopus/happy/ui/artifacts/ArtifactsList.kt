package com.slopus.happy.ui.artifacts

import android.text.format.DateFormat
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.artifacts.ArtifactCover
import com.slopus.happy.feed.FeedCovers
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.slopus.happy.R
import com.slopus.happy.artifacts.ArtifactCatalog
import com.slopus.happy.artifacts.ArtifactCatalogFeed
import com.slopus.happy.artifacts.ArtifactSummary
import com.slopus.happy.artifacts.DateBucket
import com.slopus.happy.connection.LinkState
import com.slopus.happy.ui.cards.CardHeading
import com.slopus.happy.ui.chat.linkStatusWords
import com.slopus.happy.ui.cards.CardListSpec
import com.slopus.happy.ui.cards.CardNote
import com.slopus.happy.ui.cards.CardRow
import com.slopus.happy.ui.cards.cardPlaces
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.GlassSpec
import com.slopus.happy.ui.components.LocalBarInset
import com.slopus.happy.ui.components.MenuSpec
import com.slopus.happy.ui.components.StateAnimation
import com.slopus.happy.ui.components.StateArt
import com.slopus.happy.ui.connection.AgentSearchField
import com.slopus.happy.ui.connection.AgentSearchTags
import com.slopus.happy.ui.connection.AgentTopBar
import com.slopus.happy.ui.connection.BarIconButton
import com.slopus.happy.ui.connection.RowTile
import com.slopus.happy.ui.home.copyToClipboard
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

object ArtifactsTags {
    const val LIST = "artifacts.list"
    const val ROW = "artifacts.row"
    const val SEARCH = "artifacts.search"
    const val SEARCH_BAR = "artifacts.searchBar"
    const val THUMBNAIL = "artifacts.thumbnail"
    const val COVER = "artifacts.cover"
    const val GLYPH = "artifacts.glyph"
    const val PREVIEW = "artifacts.preview"
    const val MENU_OPEN = "artifacts.menu.open"
    const val MENU_COPY = "artifacts.menu.copy"
    const val NOTE = "artifacts.note"
}

object ArtifactListSpec {
    /** A row's picture fades in over its tile (iOS's `ArtifactThumbnailView.show`). */
    const val THUMBNAIL_FADE_MS = 200

    /**
     * Every row's leading slot, 16:9 at the tile's 40 height (spec "Covers
     * in the artifact lists"): a wide cover fills it, a square one stands
     * whole in its middle, and anything else is the kind's glyph centred
     * on its tile colour. The row keeps its 60.
     */
    val slotWidth = 72.dp
}

/**
 * The words and date formats the list says things in, resolved once in
 * the person's language, so the derivation can run off the main thread
 * (iOS's `Strings.Artifacts.DateWords`).
 */
@Immutable
class ArtifactListWords(
    val today: String,
    val yesterday: String,
    val previous7Days: String,
    val previous30Days: String,
    val untitled: String,
    /** Each type's name, as a row's subtitle says it; `""` names a type without one. */
    private val kinds: Map<String, String>,
    private val livePage: String,
    private val unknownKind: String,
    val notes: Notes,
    val locale: Locale,
    val zone: ZoneId,
    is24Hour: Boolean,
    /** The locale's own pattern for a skeleton (`DateFormat.getBestDateTimePattern`). */
    pattern: (Locale, String) -> String = DateFormat::getBestDateTimePattern,
) {
    @Immutable
    data class Notes(val loading: String, val empty: String, val noMatches: String, val unsupported: String, val unavailable: String)

    private val time = DateTimeFormatter.ofPattern(pattern(locale, if (is24Hour) "Hm" else "hm"), locale)
    private val weekday = DateTimeFormatter.ofPattern(pattern(locale, "EEEE"), locale)
    private val dayMonth = DateTimeFormatter.ofPattern(pattern(locale, "MMMd"), locale)
    private val fullDate = DateTimeFormatter.ofPattern(pattern(locale, "yMMMd"), locale)
    private val month = DateTimeFormatter.ofPattern(pattern(locale, "MMMM"), locale)
    private val monthYear = DateTimeFormatter.ofPattern(pattern(locale, "MMMMy"), locale)

    /** A kind's name; an unknown type as it came, its words capitalized. */
    fun kind(type: String, live: Boolean = false): String = when {
        live -> livePage
        type in kinds -> kinds.getValue(type)
        type.isEmpty() -> unknownKind
        else -> type.split('_').joinToString(" ") { word -> word.replaceFirstChar { it.titlecase(locale) } }
    }

    /** A row's subtitle: its kind, and how many files an image series holds. */
    fun subtitle(artifact: ArtifactSummary): String {
        val kind = kind(artifact.type, artifact.live)
        return if (artifact.type == "image_series" && artifact.fileCount > 1) "$kind · ${artifact.fileCount}" else kind
    }

    /** A date bucket's heading: an older month by its name, with its year once it isn't this one. */
    fun bucket(bucket: DateBucket, now: Long): String = when (bucket) {
        DateBucket.Today -> today
        DateBucket.Yesterday -> yesterday
        DateBucket.Previous7Days -> previous7Days
        DateBucket.Previous30Days -> previous30Days
        is DateBucket.Month -> {
            val thisYear = Instant.ofEpochMilli(now).atZone(zone).year
            (if (bucket.year == thisYear) month else monthYear).format(YearMonth.of(bucket.year, bucket.month))
        }
    }

    /**
     * When a row last changed, as short as its bucket allows: the time
     * today and yesterday, the weekday within the week, the day and month
     * this year, the whole date before.
     */
    fun time(millis: Long, now: Long): String {
        val date = Instant.ofEpochMilli(millis).atZone(zone)
        return when (DateBucket.of(millis, now, zone)) {
            DateBucket.Today, DateBucket.Yesterday -> time.format(date)
            DateBucket.Previous7Days -> weekday.format(date)
            else -> (if (date.year == Instant.ofEpochMilli(now).atZone(zone).year) dayMonth else fullDate).format(date)
        }
    }
}

/** The list's words in the person's language, their clock and time zone. */
@Composable
fun rememberArtifactListWords(): ArtifactListWords {
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0]
    val today = stringResource(R.string.session_history_today)
    val yesterday = stringResource(R.string.session_history_yesterday)
    val previous7 = stringResource(R.string.artifact_list_previous_7_days)
    val previous30 = stringResource(R.string.artifact_list_previous_30_days)
    val untitled = stringResource(R.string.artifact_untitled)
    val kinds = mapOf(
        "markdown" to stringResource(R.string.artifact_kind_markdown),
        "html" to stringResource(R.string.artifact_kind_html),
        "image" to stringResource(R.string.artifact_kind_image),
        "image_series" to stringResource(R.string.artifact_kind_image_series),
        "video" to stringResource(R.string.artifact_kind_video),
        "document" to stringResource(R.string.artifact_kind_document),
        "gen_ui" to stringResource(R.string.artifact_kind_gen_ui),
    )
    val live = stringResource(R.string.artifact_kind_live)
    val unknown = stringResource(R.string.artifact_kind_unknown)
    val notes = ArtifactListWords.Notes(
        loading = stringResource(R.string.artifacts_loading),
        empty = stringResource(R.string.artifact_list_empty),
        noMatches = stringResource(R.string.artifact_list_no_matches),
        unsupported = stringResource(R.string.artifact_list_unsupported),
        unavailable = stringResource(R.string.artifact_list_unavailable),
    )
    val is24Hour = DateFormat.is24HourFormat(context)
    return remember(locale, is24Hour, today, kinds, notes) {
        ArtifactListWords(today, yesterday, previous7, previous30, untitled, kinds, live, unknown, notes, locale, ZoneId.systemDefault(), is24Hour)
    }
}

/** One slot of the list: a date's heading over its card, an artifact's row, or a note in place of them (under its [Note.art], if any). */
@Immutable
sealed interface ArtifactListItem {
    val key: String

    data class Heading(val bucket: DateBucket, val text: String, val afterCard: Boolean) : ArtifactListItem {
        override val key: String get() = "heading:$bucket"
    }

    data class Row(val artifact: ArtifactSummary, val place: HomeCardPlace, val title: String, val subtitle: String, val time: String) : ArtifactListItem {
        override val key: String get() = artifact.id
    }

    data class Note(val text: String, val art: StateArt? = null) : ArtifactListItem {
        override val key: String get() = "note"
    }
}

/**
 * The list's slots (iOS's `ArtifactListItems.items`): the artifacts that
 * match [query], grouped by when each last changed under a heading per
 * bucket, newest first; or one note in their place: this Happy Agent keeps
 * none, nothing matches, it couldn't be read, it is being read, or it is
 * empty. Empty, the note sits under the yellow ticket ([StateArt.Tickets]).
 */
fun artifactListItems(state: ArtifactCatalogFeed.State, query: String, words: ArtifactListWords, now: Long): List<ArtifactListItem> {
    val shown = ArtifactCatalog.matching(query, state.items) { words.kind(it.type, it.live) }
    if (shown.isEmpty()) {
        val notes = words.notes
        return listOf(
            when {
                state.unsupported -> ArtifactListItem.Note(notes.unsupported)
                state.items.isNotEmpty() -> ArtifactListItem.Note(notes.noMatches)
                state.error != null -> ArtifactListItem.Note(notes.unavailable)
                !state.loaded -> ArtifactListItem.Note(notes.loading)
                else -> ArtifactListItem.Note(notes.empty, StateArt.Tickets)
            },
        )
    }
    val items = ArrayList<ArtifactListItem>(shown.size + 8)
    DateBucket.group(shown, now, words.zone) { it.updatedAt }.forEachIndexed { index, (bucket, group) ->
        items += ArtifactListItem.Heading(bucket, words.bucket(bucket, now), afterCard = index > 0)
        group.zip(cardPlaces(group.size)).forEach { (artifact, place) ->
            items += ArtifactListItem.Row(artifact, place, artifact.title.ifEmpty { words.untitled }, words.subtitle(artifact), words.time(artifact.updatedAt, now))
        }
    }
    return items
}

/** The glyph and tint a kind's tile shows when the row has no picture (iOS's `ArtifactListItems.tile`). */
internal fun artifactTile(artifact: ArtifactSummary): Pair<Ionicon, RowTile> = when {
    artifact.live -> Ionicon.GlobeOutline to RowTile.Teal
    artifact.type == "markdown" -> Ionicon.DocumentTextOutline to RowTile.Purple
    artifact.type == "html" -> Ionicon.CodeSlashOutline to RowTile.Blue
    artifact.type == "image" -> Ionicon.ImageOutline to RowTile.Orange
    artifact.type == "image_series" -> Ionicon.AlbumsOutline to RowTile.Orange
    artifact.type == "video" -> Ionicon.FilmOutline to RowTile.Red
    artifact.type == "gen_ui" -> Ionicon.CodeWorkingOutline to RowTile.Teal
    else -> Ionicon.DocumentOutline to RowTile.Indigo
}

/**
 * Desktop's fixed Artifacts row, as iOS's `ArtifactsViewController` shows
 * it: every artifact of the agent connection in home's inset grouped cards
 * ([CardRow]), under a heading per date bucket (Today, Yesterday, the
 * previous seven and thirty days, then by month), newest change first. A
 * row is its 16:9 slot ([ArtifactSlot]: the cover, or the kind's glyph
 * or an older daemon's picture itself, [ArtifactThumbnail]), the
 * title on up to two lines, the kind under it and when it changed beside
 * it. A tap opens the artifact on its latest version; a hold offers Open
 * and Copy Title. The bar's search filters by every word of the title or
 * kind. There is no pull to refresh: the catalog keeps itself current
 * ([ArtifactCatalogFeed]). A note in place of the rows stands in the
 * middle of the screen rather than of the room under the bar: centred in
 * the list's room inside its padding, then lifted by half the bar's height
 * (status bar included), never above the room's top. With none yet, it
 * sits under the yellow ticket's 128 box, 24 above its text.
 *
 * The slots are derived off the main thread whenever the catalog, the
 * search or the day changes; the first frame derives them in place.
 */
@Composable
fun ArtifactsScreen(
    state: ArtifactCatalogFeed.State,
    onBack: () -> Unit,
    onOpen: (ArtifactSummary) -> Unit,
    thumbnails: ArtifactThumbnails? = null,
    clock: () -> Long = System::currentTimeMillis,
    /** Reads the rows' covers: the Feed's, so both keep one copy. */
    covers: FeedCovers? = null,
    /** The connection's link, debounced: its status stands in the title while it is on its way (iOS `watchHeader`). */
    link: LinkState = LinkState.Online,
) {
    val words = rememberArtifactListWords()
    var searching by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    val focus = LocalFocusManager.current
    val closeSearch = {
        focus.clearFocus()
        searching = false
        query = ""
    }
    BackHandler(enabled = searching, onBack = closeSearch)
    // Today may be yesterday by the time the screen comes back.
    var day by remember { mutableIntStateOf(0) }
    LifecycleResumeEffect(Unit) {
        day++
        onPauseOrDispose { }
    }
    val seed = remember { artifactListItems(state, query, words, clock()) }
    val items by produceState(seed, state, query, words, day) {
        value = withContext(Dispatchers.Default) { artifactListItems(state, query, words, clock()) }
    }
    val searchLabel = stringResource(R.string.artifact_list_search)
    val locale = LocalConfiguration.current.locales[0]
    PlaceScaffold(
        title = linkStatusWords(link)?.replaceFirstChar { it.titlecase(locale) } ?: stringResource(R.string.artifacts_title),
        onBack = onBack,
        tag = ArtifactsTags.LIST,
        actions = { BarIconButton(Ionicon.SearchOutline, searchLabel, { searching = true }, Modifier.testTag(ArtifactsTags.SEARCH)) },
        bar = if (!searching) null else {
            {
                AgentTopBar(
                    tag = ArtifactsTags.SEARCH_BAR,
                    container = HappyTheme.colors.surface,
                    navigationIcon = { BarIconButton(Ionicon.ArrowBack, stringResource(R.string.common_back), closeSearch) },
                    title = { AgentSearchField(query, { query = it }, placeholder = searchLabel) },
                    actions = {
                        if (query.isNotEmpty()) {
                            BarIconButton(Ionicon.Close, stringResource(R.string.agent_search_clear), { query = "" }, Modifier.testTag(AgentSearchTags.CLEAR))
                        }
                    },
                )
            }
        },
    ) {
        val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
        // The bar's own height; read, not claimed, so the list stays held below the bar.
        val bar = LocalBarInset.current?.let { it.top - GlassSpec.feather } ?: 0.dp
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(top = CardListSpec.contentTop, bottom = CardListSpec.contentBottom + bottom),
        ) {
            items(items, key = { it.key }, contentType = { it::class }) { item ->
                when (item) {
                    is ArtifactListItem.Heading -> CardHeading(item.text, item.afterCard)
                    is ArtifactListItem.Note -> ArtifactNote(item, bar, Modifier.fillParentMaxSize())
                    is ArtifactListItem.Row -> ArtifactRow(item, thumbnails, covers, onOpen)
                }
            }
        }
    }
}

/** [item] in its [modifier]'s room, centred and then lifted by half of [bar], never above the room's top. */
@Composable
private fun ArtifactNote(item: ArtifactListItem.Note, bar: Dp, modifier: Modifier) {
    Column(
        modifier
            .testTag(ArtifactsTags.NOTE)
            .layout { measurable, constraints ->
                val placeable = measurable.measure(constraints.copy(minHeight = 0))
                val height = if (constraints.hasBoundedHeight) constraints.maxHeight else placeable.height
                val slack = (height - placeable.height).coerceAtLeast(0)
                layout(placeable.width, height) { placeable.place(0, (slack - bar.roundToPx()).coerceAtLeast(0) / 2) }
            }
            .fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (item.art != null) StateAnimation(item.art)
        CardNote(item.text)
    }
}

@Composable
private fun ArtifactRow(item: ArtifactListItem.Row, thumbnails: ArtifactThumbnails?, covers: FeedCovers?, onOpen: (ArtifactSummary) -> Unit) {
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    val colors = HappyTheme.colors
    var menu by remember { mutableStateOf(false) }
    CardRow(
        place = item.place,
        title = item.title,
        subtitle = item.subtitle,
        trailing = item.time,
        leadingWidth = ArtifactListSpec.slotWidth,
        leading = { ArtifactSlot(item.artifact, thumbnails, covers) },
        onClick = { onOpen(item.artifact) },
        onLongClick = {
            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
            menu = true
        },
        tag = ArtifactsTags.ROW,
        overlay = {
            HappyDropdownMenu(expanded = menu, onDismissRequest = { menu = false }, offset = MenuSpec.offset) {
                HappyMenuItem(
                    stringResource(R.string.artifact_list_open),
                    onClick = {
                        menu = false
                        onOpen(item.artifact)
                    },
                    leading = { Icon(Ionicon.ChevronForward, MenuSpec.icon, colors.text) },
                    modifier = Modifier.testTag(ArtifactsTags.MENU_OPEN),
                )
                HappyMenuItem(
                    stringResource(R.string.artifact_list_copy_title),
                    onClick = {
                        menu = false
                        copyToClipboard(context, item.title)
                    },
                    leading = { Icon(Ionicon.CopyOutline, MenuSpec.icon, colors.text) },
                    modifier = Modifier.testTag(ArtifactsTags.MENU_COPY),
                )
            }
        },
    )
}

/**
 * A row's 16:9 slot, rounded as the tile is, never moving: a wide cover
 * filling it, a square one whole at its height in the middle, both on the
 * artifact's background or the neutral fill; else a picture's or a
 * recording's still filling it. Each is the computer's preview where it
 * keeps one (a cover without one is read whole), over its ThumbHash, and
 * fades in. Without either, the kind's glyph centred on its tile colour,
 * and an older daemon's picture or recording read here over it as before.
 */
@Composable
private fun ArtifactSlot(artifact: ArtifactSummary, thumbnails: ArtifactThumbnails?, covers: FeedCovers?) {
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(CardListSpec.tileRadius)
    val cover = artifact.drawnCover
    if (cover != null) {
        val previewed = artifact.cover?.preview == true
        Box(Modifier.fillMaxSize().clip(shape).background(cover.background?.let(::cssColor) ?: colors.surfaceHighest).testTag(ArtifactsTags.COVER)) {
            ArtifactPicture(
                key = if (previewed) FeedCovers.previewKey(artifact.id, artifact.latestVersion, cover.path) else cover.key,
                thumbhash = cover.thumbhash,
                covers = covers,
                scale = if (cover.aspect == ArtifactCover.Aspect.Wide) ContentScale.Crop else ContentScale.Fit,
                use = "thumbnail",
            ) { if (previewed) it.preview(artifact.id, artifact.latestVersion, cover.path) else it.read(cover) }
        }
        return
    }
    val media = artifact.entry?.takeIf { !artifact.live && it.isVisual && it.preview }
    if (media != null) {
        Box(Modifier.fillMaxSize().clip(shape).background(colors.surfaceHighest).testTag(ArtifactsTags.PREVIEW)) {
            ArtifactPicture(FeedCovers.previewKey(artifact.id, artifact.latestVersion, media.path), media.thumbhash, covers, ContentScale.Crop, use = "thumbnail") {
                it.preview(artifact.id, artifact.latestVersion, media.path)
            }
        }
        return
    }
    val (glyph, tint) = artifactTile(artifact)
    Box(Modifier.fillMaxSize().clip(shape).background(tint.fill(colors.dark)).testTag(ArtifactsTags.GLYPH), contentAlignment = Alignment.Center) {
        Icon(glyph, CardListSpec.tileGlyph, tint.ink(colors.dark))
    }
    // The picture lands over its kind's tile, which stays while it loads.
    if (thumbnails != null && artifact.showsPicture) ArtifactThumbnail(artifact, thumbnails)
}
