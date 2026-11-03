package com.slopus.happy.ui.connection

import com.slopus.happy.ui.tablet.MainPanelKey
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.geometry.Rect
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.slopus.happy.R
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.AgentFeedSection
import com.slopus.happy.agent.AgentPictures
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.agent.FolderMark
import com.slopus.happy.agent.WorkspaceLineChanges
import com.slopus.happy.model.compactCount
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.components.HomeCardRow
import com.slopus.happy.ui.components.HomeCardSpec
import com.slopus.happy.ui.components.HomeCardTags
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.MenuSpec
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.components.ShimmerSpec
import com.slopus.happy.ui.components.ShimmerText
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.components.avatar.PlaceholderAvatar
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.components.rememberThumbHash
import com.slopus.happy.ui.home.BlockedDotColor
import com.slopus.happy.ui.home.UnreadDotColor
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException

object AgentHomeTags {
    const val LIST = "agentHome.list"
    const val BAR = "agentHome.bar"
    const val TITLE = "agentHome.title"
    const val SPINNER = "agentHome.spinner"
    const val STATUS = "agentHome.status"
    const val EMPTY = "agentHome.empty"
    const val OFFLINE = "agentHome.offline"
    const val BANNER = "agentHome.banner"
    const val BANNER_ACTION = "agentHome.bannerAction"
    const val SEARCH = "agentHome.search"
    const val SETTINGS = "agentHome.settings"
    const val COMPOSE = "agentHome.compose"
    fun row(key: String) = "agentHome.row.$key"
    const val ROW_TITLE = "agentHome.rowTitle"
    const val ROW_MARK = "agentHome.rowMark"
    const val ROW_DIVIDER = HomeCardTags.DIVIDER
    const val ROW_DOT = "agentHome.rowDot"
    const val ROW_CHANGES = "agentHome.rowChanges"
    /** A Surface row's held menu: Leave. */
    const val LEAVE = "agentHome.leave"
}

/**
 * An agent connection's home list as iOS draws its home
 * (GroupedSidebarLayout.swift, GroupedSidebarTokens.swift): each section
 * (bots, tasks, projects) one quiet rounded card on the page's own surface,
 * with no title, 24 apart; inside, single-line rows edge to edge with a
 * hairline between each and the next from where its title starts. A nested
 * row stays in its parent's card, a mark and its gap further in a level.
 * Every row has a fixed height at the font scale ([rowHeight]): nothing an
 * idle update changes (status, unread) can move a row. Text is sp and
 * overflows its line rather than growing it, as Home's timestamp slot does.
 */
object AgentHomeSpec {
    /** The cards' inset from the window's sides, their corners, and the room between two. */
    val cardInset = HomeCardSpec.inset
    val cardRadius = HomeCardSpec.radius
    val cardGap = HomeCardSpec.gap
    /** Above the first card. */
    val contentTop = HomeCardSpec.contentTop
    /** A top-level mark's left edge, from its card's. */
    val markInset = 16.dp
    val paddingEnd = 16.dp
    val paddingVertical = 13.dp
    val mark = 30.dp
    val markGap = 12.dp
    /** A nested row's mark stands under its parent's title: a mark and its gap. */
    val indent = mark + markGap
    /** A glyph's tile: the mark's square, rounded, the glyph smaller inside; a picture's rounding too. */
    val tileRadius = 8.dp
    val tileGlyph = 18.dp
    val dot = HomeCardSpec.dot
    /** Between the title and the dot. */
    val cornerGap = 12.dp
    /** The bar's title, the agent's name: smaller than Material's large title. */
    val barTitle = happyTextStyle(fontSize = 18, lineHeight = 24, weight = FontWeight.SemiBold)
    /** The compose button's margin from the window's corner, and the room under the last card to scroll it clear. */
    val fabMargin = 16.dp
    val fabClearance = 96.dp
    const val TITLE_LINE = 22
    val title = happyTextStyle(fontSize = 17, lineHeight = TITLE_LINE)
    /** A time at a row's end, where a place lists one (home's rows show none). */
    val timestamp = happyTextStyle(fontSize = 13, lineHeight = TITLE_LINE).copy(fontFeatureSettings = "tnum")

    /** 13 + a 22 line + 13: 48 at the default font scale, iOS's row. */
    @Composable
    fun rowHeight(): Dp = with(LocalDensity.current) { paddingVertical * 2 + TITLE_LINE.sp.toDp() }

    /**
     * Whether a conversation wears a mark, as iOS's home has it
     * (SidebarRows.swift): a bot or a task does, a subtask or a project's
     * conversation doesn't, its title starting where a mark would.
     */
    fun hasMark(kind: ConversationKind): Boolean = kind == ConversationKind.Bot || kind == ConversationKind.Task

}

/**
 * The tint of a glyph's tile, one per kind of row (RowView.swift's
 * `tint`): its ink and its fill, the same colour very light; iOS's system
 * colours, light and dark.
 */
enum class RowTile(private val light: Pair<Long, Long>, private val dark: Pair<Long, Long>) {
    Blue(0xFF007AFF to 0x1C007AFF, 0xFF0A84FF to 0x330A84FF),
    Green(0xFF28A745 to 0x2434C759, 0xFF30D158 to 0x3330D158),
    Orange(0xFFF08C00 to 0x24FF9500, 0xFFFF9F0A to 0x33FF9F0A),
    Indigo(0xFF5856D6 to 0x1F5856D6, 0xFF7D7AFF to 0x3D5E5CE6),
    Purple(0xFFA347D6 to 0x1FAF52DE, 0xFFBF5AF2 to 0x33BF5AF2),
    Red(0xFFFF3B30 to 0x1CFF3B30, 0xFFFF453A to 0x33FF453A),
    Teal(0xFF1C9FB8 to 0x2430B0C7, 0xFF40C8E0 to 0x3340C8E0);

    fun ink(dark: Boolean) = Color(if (dark) this.dark.first else light.first)
    fun fill(dark: Boolean) = Color(if (dark) this.dark.second else light.second)

    companion object {
        /** A Surface's glyph and tile by its type (`Rows.surfaceGlyph`). */
        fun surface(type: String): Pair<Ionicon, RowTile> = when (type) {
            "todo" -> Ionicon.CheckboxOutline to Green
            "calendar" -> Ionicon.CalendarOutline to Red
            "system_monitor" -> Ionicon.PulseOutline to Teal
            "chat" -> Ionicon.PeopleOutline to Teal
            else -> Ionicon.DocumentTextOutline to Blue
        }
    }
}

/** [glyph] on its softly tinted tile, the mark's square at [size]. */
@Composable
internal fun TileMark(glyph: Ionicon, tile: RowTile, size: Dp = AgentHomeSpec.mark) {
    val dark = HappyTheme.colors.dark
    Box(
        Modifier.size(size).clip(RoundedCornerShape(AgentHomeSpec.tileRadius)).background(tile.fill(dark)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(glyph, AgentHomeSpec.tileGlyph * (size / AgentHomeSpec.mark), tile.ink(dark))
    }
}

/** Reads bots' and repos' pictures for the rows; null where nothing serves them (tests, fixtures). */
val LocalAgentPictures = staticCompositionLocalOf<AgentPictures?> { null }

/**
 * A conversation's mark at [size], as happy-ios's grouped home has it
 * (SidebarRows.swift, RowView.swift): the person's Happy wears Happy's
 * mark; a bot its picture over its ThumbHash; a bot without one, and every
 * task, the placeholder its own ID picks, a rounded square like a picture,
 * moving with Animated Avatars on. [radius] rounds a picture's and a
 * placeholder's corners.
 */
@Composable
internal fun ConversationMark(row: AgentFeedRow.Conversation, size: Dp, radius: Dp = AgentHomeSpec.tileRadius) {
    val picture = row.picture
    when {
        row.happy -> HappyMark(size)
        picture != null -> AgentPicture(picture, row.thumbhash, size, radius)
        else -> PlaceholderAvatar(row.seed ?: row.agentId, size, shape = RoundedCornerShape(radius))
    }
}

/** Happy's clay mark, as drawn, filling the mark's square. */
@Composable
private fun HappyMark(size: Dp) {
    Image(painterResource(R.drawable.clay_happy_mark), contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.size(size))
}

/**
 * A project's mark: its picture over its ThumbHash, desktop's home glyph
 * for the home project, or the placeholder its ID picks.
 */
@Composable
internal fun FolderMarkView(mark: FolderMark, size: Dp) {
    when (mark) {
        is FolderMark.Picture -> AgentPicture(mark.path, mark.thumbhash, size)
        FolderMark.Home -> TileMark(Ionicon.HomeOutline, RowTile.Blue, size)
        is FolderMark.Placeholder -> PlaceholderAvatar(mark.seed, size, shape = RoundedCornerShape(AgentHomeSpec.tileRadius))
    }
}

/** A picture the agent serves, read once ([AgentPictures]), a rounded square over its ThumbHash. */
@Composable
internal fun AgentPicture(path: String, thumbhash: String?, size: Dp, radius: Dp = AgentHomeSpec.tileRadius) {
    val pictures = LocalAgentPictures.current
    val bytes by produceState(pictures?.kept(path, thumbhash), pictures, path, thumbhash) {
        value = pictures?.kept(path, thumbhash) ?: try {
            pictures?.read(path, thumbhash)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // The ThumbHash stays in its place.
            null
        }
    }
    RemoteImage(
        model = bytes,
        contentDescription = null,
        modifier = Modifier.size(size).clip(RoundedCornerShape(radius)),
        background = HappyTheme.colors.surfaceHighest,
        cacheKey = pictures?.key(path, thumbhash),
        placeholder = rememberThumbHash(thumbhash),
    )
}

/** A row as home draws it: the feed's row with its place in its card. */
@Immutable
sealed interface AgentHomeItem {
    val key: String

    /** The room before a card: [first] the list's top, else the gap after the card before. */
    data class Gap(val section: AgentFeedSection, val first: Boolean) : AgentHomeItem {
        override val key get() = "section-${section.key}"
    }

    data class Row(
        /** An [AgentFeedRow.Conversation] or an [AgentFeedRow.Folder]. */
        val row: AgentFeedRow,
        /** It opens its card, and closes it; above the last, a hairline under each. */
        val first: Boolean,
        val last: Boolean,
    ) : AgentHomeItem {
        override val key get() = row.key
    }
}

/** The feed's rows, each knowing where it stands in its section's card. */
fun agentHomeItems(feed: AgentFeed): List<AgentHomeItem> {
    val out = ArrayList<AgentHomeItem>(feed.rows.size)
    for (row in feed.rows) {
        out += when (row) {
            is AgentFeedRow.Section -> AgentHomeItem.Gap(row.section, first = out.isEmpty())
            else -> AgentHomeItem.Row(row, first = out.lastOrNull() !is AgentHomeItem.Row, last = false)
        }
    }
    for (index in out.indices) {
        val item = out[index] as? AgentHomeItem.Row ?: continue
        if (out.getOrNull(index + 1) !is AgentHomeItem.Row) out[index] = item.copy(last = true)
    }
    return out
}

/** The rows of [items] into a lazy list, each animating in and out unless motion is reduced. */
fun LazyListScope.agentHomeRows(
    items: List<AgentHomeItem>,
    reduceMotion: Boolean,
    onOpen: (String) -> Unit,
    onOpenArtifacts: () -> Unit,
    onOpenSurface: (AgentFeedRow.Surface) -> Unit,
    /** A Surface row's hold offers Leave, which comes here; null offers nothing. */
    onLeaveSurface: ((AgentFeedRow.Surface) -> Unit)? = null,
    /** A conversation row's hold, with where the row is in the window: its preview ([ChatPreviewOverlay]); null offers nothing. */
    onHold: ((AgentFeedRow.Conversation, Rect) -> Unit)? = null,
    /** The tablet sidebar's selection, what its main panel shows ([MainPanelKey]). */
    selected: String? = null,
) {
    items(items, key = { it.key }, contentType = { (it as? AgentHomeItem.Row)?.row?.let { row -> row::class } ?: it::class }) { item ->
        val motion = if (reduceMotion) Modifier else Modifier.animateItem(
            fadeInSpec = tween(180),
            placementSpec = tween(220),
            fadeOutSpec = tween(140),
        )
        when (item) {
            is AgentHomeItem.Gap -> Spacer(
                motion
                    .contentMaxWidth(LocalWindowLayout.current)
                    .height(if (item.first) AgentHomeSpec.contentTop else AgentHomeSpec.cardGap)
                    .testTag(AgentHomeTags.row(item.key)),
            )
            is AgentHomeItem.Row -> CardRow(item, motion, selected != null && selected == panelKey(item.row)) {
                when (val row = item.row) {
                    is AgentFeedRow.Conversation -> ConversationRow(row, onOpen, onHold)
                    is AgentFeedRow.Folder -> FolderRow(row)
                    AgentFeedRow.Artifacts -> PlaceRow(stringResource(R.string.artifacts_title), Ionicon.DocumentTextOutline, RowTile.Purple, onOpenArtifacts)
                    is AgentFeedRow.Surface -> SurfaceRow(row, { onOpenSurface(row) }, onLeaveSurface)
                    is AgentFeedRow.Section -> Unit
                }
            }
        }
    }
}

/** One row's part of its card ([HomeCardRow]), 48 high at the default font scale, the hairline from its title. */
@Composable
private fun CardRow(item: AgentHomeItem.Row, modifier: Modifier, selected: Boolean, content: @Composable () -> Unit) {
    HomeCardRow(
        place = HomeCardPlace(item.first, item.last),
        height = AgentHomeSpec.rowHeight(),
        dividerStart = titleStart(item.row),
        modifier = modifier,
        tag = AgentHomeTags.row(item.key),
        selected = selected,
    ) { content() }
}

/** What a row opens, as the tablet's main panel names its root. */
private fun panelKey(row: AgentFeedRow): String? = when (row) {
    is AgentFeedRow.Conversation -> MainPanelKey.conversation(row.agentId)
    is AgentFeedRow.Surface -> MainPanelKey.surface(row.id)
    AgentFeedRow.Artifacts -> MainPanelKey.ARTIFACTS
    else -> null
}

/** Where a card row's title starts, from its card's edge: its level's lane, then its mark's when it wears one. */
private fun titleStart(row: AgentFeedRow): Dp {
    val (depth, marked) = when (row) {
        is AgentFeedRow.Conversation -> row.depth to AgentHomeSpec.hasMark(row.kind)
        is AgentFeedRow.Folder -> row.depth to (row.mark != null)
        AgentFeedRow.Artifacts, is AgentFeedRow.Surface -> 0 to true
        is AgentFeedRow.Section -> return 0.dp
    }
    return AgentHomeSpec.markInset + AgentHomeSpec.indent * depth + if (marked) AgentHomeSpec.mark + AgentHomeSpec.markGap else 0.dp
}

/**
 * One conversation, on one line: a bot's or task's 30 mark, the title 17/22
 * (desktop's sheen while it runs, [AgentFeedRow.Conversation.running]),
 * and a 10 dot 12 after it while it waits or is unread. No time. The whole
 * row opens it.
 */
@Composable
private fun ConversationRow(row: AgentFeedRow.Conversation, onOpen: (String) -> Unit, onHold: ((AgentFeedRow.Conversation, Rect) -> Unit)? = null) {
    val colors = HappyTheme.colors
    val haptics = LocalHapticFeedback.current
    // Where the row is, for the preview to grow out of; read only when held.
    val placed = remember { arrayOfNulls<LayoutCoordinates>(1) }
    val marked = AgentHomeSpec.hasMark(row.kind)
    val title = row.title ?: stringResource(R.string.session_new_chat)
    val working = stringResource(R.string.agent_home_working)
    Row(
        modifier = Modifier
            .fillMaxSize()
            .onPlaced { placed[0] = it }
            .combinedClickable(
                role = Role.Button,
                onLongClick = onHold?.let { hold ->
                    {
                        placed[0]?.takeIf { it.isAttached }?.let { at ->
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            hold(row, at.boundsInWindow())
                        }
                    }
                },
            ) { onOpen(row.agentId) }
            .then(if (row.working) Modifier.semantics { stateDescription = working } else Modifier)
            .padding(start = AgentHomeSpec.markInset + AgentHomeSpec.indent * row.depth, end = AgentHomeSpec.paddingEnd),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (marked) {
            Box(modifier = Modifier.size(AgentHomeSpec.mark).testTag(AgentHomeTags.ROW_MARK)) { ConversationMark(row, AgentHomeSpec.mark) }
        }
        Box(
            modifier = Modifier
                .padding(start = if (marked) AgentHomeSpec.markGap else 0.dp)
                .weight(1f)
                .testTag(AgentHomeTags.ROW_TITLE),
        ) {
            ShimmerText(
                text = title,
                style = AgentHomeSpec.title,
                baseColor = colors.text,
                highlightColor = ShimmerSpec.sheen(colors.text, colors.surfaceHigh),
                shimmering = row.running,
                modifier = Modifier.wrapContentHeight(unbounded = true).agentTitleBaseline(),
            )
        }
        WorkspaceCounts(row.lineChanges)
        Corner(row.blocked, row.unread, row.lineChanges?.visible == true)
    }
}

/**
 * A Surface's row. Held, it offers Leave in a drop-down under it, as iOS's
 * held row and desktop's menu do (the close glyph, not in red); the screen
 * asks before it leaves ([onLeave]).
 */
@Composable
private fun SurfaceRow(row: AgentFeedRow.Surface, onOpen: () -> Unit, onLeave: ((AgentFeedRow.Surface) -> Unit)?) {
    var menu by remember { mutableStateOf(false) }
    val (glyph, tile) = RowTile.surface(row.type)
    Box(Modifier.fillMaxSize()) {
        PlaceRow(row.name, glyph, tile, onOpen, onLongClick = onLeave?.let { { menu = true } })
        if (onLeave != null) {
            HappyDropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                HappyMenuItem(
                    label = stringResource(R.string.surface_leave),
                    leading = { Icon(Ionicon.Close, MenuSpec.icon, HappyTheme.colors.text) },
                    onClick = {
                        menu = false
                        onLeave(row)
                    },
                    modifier = Modifier.testTag(AgentHomeTags.LEAVE),
                )
            }
        }
    }
}

/** Artifacts, or a Surface: its glyph on its tile, and its name. */
@Composable
private fun PlaceRow(name: String, glyph: Ionicon, tile: RowTile, onClick: () -> Unit, onLongClick: (() -> Unit)? = null) {
    Row(
        modifier = Modifier
            .fillMaxSize()
            .combinedClickable(role = Role.Button, onClick = onClick, onLongClick = onLongClick)
            .padding(start = AgentHomeSpec.markInset, end = AgentHomeSpec.paddingEnd),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(modifier = Modifier.size(AgentHomeSpec.mark).testTag(AgentHomeTags.ROW_MARK)) { TileMark(glyph, tile) }
        Text(
            name,
            style = AgentHomeSpec.title,
            color = HappyTheme.colors.text,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .padding(start = AgentHomeSpec.markGap)
                .weight(1f)
                .wrapContentHeight(unbounded = true)
                .agentTitleBaseline()
                .testTag(AgentHomeTags.ROW_TITLE),
        )
    }
}

/**
 * A project or a worktree: its name, shimmering while work runs inside it,
 * and a project's mark before it ([FolderMarkView]). It opens nothing.
 */
@Composable
private fun FolderRow(row: AgentFeedRow.Folder) {
    val colors = HappyTheme.colors
    val mark = row.mark
    Row(
        modifier = Modifier
            .fillMaxSize()
            .semantics { heading() }
            .padding(start = AgentHomeSpec.markInset + AgentHomeSpec.indent * row.depth, end = AgentHomeSpec.paddingEnd),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (mark != null) {
            Box(modifier = Modifier.size(AgentHomeSpec.mark).testTag(AgentHomeTags.ROW_MARK)) { FolderMarkView(mark, AgentHomeSpec.mark) }
        }
        Box(
            modifier = Modifier
                .padding(start = if (mark != null) AgentHomeSpec.markGap else 0.dp)
                .weight(1f)
                .testTag(AgentHomeTags.ROW_TITLE),
        ) {
            ShimmerText(
                text = row.name,
                style = AgentHomeSpec.title,
                baseColor = colors.text,
                highlightColor = ShimmerSpec.sheen(colors.text, colors.surfaceHigh),
                shimmering = row.running,
                modifier = Modifier.wrapContentHeight(unbounded = true).agentTitleBaseline(),
            )
        }
        WorkspaceCounts(row.lineChanges)
    }
}

/** Quiet monospace digits matched to the title's x-height and shared baseline. */
@Composable
private fun WorkspaceCounts(changes: WorkspaceLineChanges?) {
    if (changes == null || !changes.visible) return
    val exact = listOfNotNull(
        if (!changes.countsExact) "≈" else null,
        if (changes.insertions > 0) "+${changes.insertions}" else null,
        if (changes.deletions > 0) "−${changes.deletions}" else null,
    ).joinToString(" ")
    AgentCountInk(
        parts = listOfNotNull(
            if (changes.insertions > 0) "+${compactCount(changes.insertions)}" else null,
            if (changes.deletions > 0) "−${compactCount(changes.deletions)}" else null,
        ),
        color = HappyTheme.colors.textSecondary,
        modifier = Modifier.padding(start = 8.dp).testTag(AgentHomeTags.ROW_CHANGES)
            .clearAndSetSemantics { contentDescription = exact },
    )
}

/**
 * A dot at the row's end while it needs something: orange waiting, blue
 * unread; nothing otherwise (home shows no times). The title gives way to
 * it, on the same line, so the row's height never changes.
 */
@Composable
private fun Corner(blocked: Boolean, unread: Boolean, hasCounts: Boolean = false) {
    if (!blocked && !unread) return
    val label = stringResource(if (blocked) R.string.status_input_required else R.string.status_unread)
    StatusDot(
        color = if (blocked) BlockedDotColor else UnreadDotColor,
        size = AgentHomeSpec.dot,
        modifier = Modifier
            .padding(start = if (hasCounts) 6.dp else AgentHomeSpec.cornerGap)
            .semantics { contentDescription = label }
            .testTag(AgentHomeTags.ROW_DOT),
    )
}

/** The list itself; [header] rows (a banner) go above the conversations. */
@Composable
fun AgentHomeList(
    items: List<AgentHomeItem>,
    state: LazyListState,
    onOpen: (String) -> Unit,
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
    onOpenArtifacts: () -> Unit = {},
    onOpenSurface: (AgentFeedRow.Surface) -> Unit = {},
    onLeaveSurface: ((AgentFeedRow.Surface) -> Unit)? = null,
    onHold: ((AgentFeedRow.Conversation, Rect) -> Unit)? = null,
    header: (LazyListScope.() -> Unit)? = null,
    bottom: @Composable () -> Unit = {},
    selected: String? = null,
) {
    val reduceMotion = rememberReduceMotion()
    LazyColumn(
        state = state,
        modifier = modifier.fillMaxSize().background(HappyTheme.colors.surface).testTag(AgentHomeTags.LIST),
        contentPadding = contentPadding,
    ) {
        header?.invoke(this)
        agentHomeRows(items, reduceMotion, onOpen, onOpenArtifacts, onOpenSurface, onLeaveSurface, onHold, selected)
        item(key = "bottom", contentType = "bottom") { bottom() }
    }
}
