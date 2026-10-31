package com.slopus.happy.ui.connection

import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
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
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.components.ShimmerText
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.components.rememberThumbHash
import com.slopus.happy.ui.home.BlockedDotColor
import com.slopus.happy.ui.home.UnreadDotColor
import com.slopus.happy.ui.home.formatSessionListTimestamp
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
    const val SEARCH = "agentHome.search"
    const val SETTINGS = "agentHome.settings"
    const val COMPOSE = "agentHome.compose"
    fun row(key: String) = "agentHome.row.$key"
    const val ROW_TITLE = "agentHome.rowTitle"
    const val ROW_MARK = "agentHome.rowMark"
    const val ROW_DIVIDER = "agentHome.rowDivider"
}

/**
 * An agent connection's home list as iOS draws its home
 * (GroupedSidebarLayout.swift, GroupedSidebarTokens.swift): each section
 * (bots, tasks, projects) one quiet rounded card on the page's own surface,
 * with no title, 24 apart; inside, single-line rows edge to edge with a
 * hairline between each and the next from where its title starts. A nested
 * row stays in its parent's card, a mark and its gap further in a level.
 * Every row has a fixed height at the font scale ([rowHeight]): nothing an
 * idle update changes (status, unread, time) can move a row. Text is sp and
 * overflows its line rather than growing it, as Home's timestamp slot does.
 */
object AgentHomeSpec {
    /** The cards' inset from the window's sides, their corners, and the room between two. */
    val cardInset = 16.dp
    val cardRadius = 26.dp
    val cardGap = 24.dp
    /** Above the first card. */
    val contentTop = 8.dp
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
    val dot = 10.dp
    val cornerMinWidth = 48.dp
    const val TITLE_LINE = 22
    val title = happyTextStyle(fontSize = 17, lineHeight = TITLE_LINE, weight = FontWeight.Medium)
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

    /** A glyph tile's ink and fill, one tint per kind: iOS's indigo for a bot, orange for a task. */
    fun tile(kind: ConversationKind, dark: Boolean): Pair<Color, Color> = when (kind) {
        ConversationKind.Bot -> if (dark) Color(0xFF7D7AFF) to Color(0x3D5E5CE6) else Color(0xFF5856D6) to Color(0x1F5856D6)
        else -> if (dark) Color(0xFFFF9F0A) to Color(0x33FF9F0A) else Color(0xFFF08C00) to Color(0x24FF9500)
    }
}

/** Reads bots' and repos' pictures for the rows; null where nothing serves them (tests, fixtures). */
val LocalAgentPictures = staticCompositionLocalOf<AgentPictures?> { null }

/**
 * A conversation's mark at [size]: a bot's picture over its ThumbHash, or
 * its kind's glyph on a softly tinted tile: iOS's person for a bot without
 * a picture, the checkbox for a task.
 */
@Composable
internal fun ConversationMark(row: AgentFeedRow.Conversation, size: Dp) {
    val picture = row.picture
    if (picture != null) {
        AgentPicture(picture, row.thumbhash, size)
        return
    }
    val (ink, fill) = AgentHomeSpec.tile(row.kind, HappyTheme.colors.dark)
    Box(
        Modifier.size(size).clip(RoundedCornerShape(AgentHomeSpec.tileRadius)).background(fill),
        contentAlignment = Alignment.Center,
    ) {
        val glyph = if (row.kind == ConversationKind.Bot) Ionicon.PersonCircleOutline else Ionicon.CheckboxOutline
        Icon(glyph, AgentHomeSpec.tileGlyph * (size / AgentHomeSpec.mark), ink)
    }
}

/** A picture the agent serves, read once ([AgentPictures]), a rounded square over its ThumbHash. */
@Composable
private fun AgentPicture(path: String, thumbhash: String?, size: Dp) {
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
        modifier = Modifier.size(size).clip(RoundedCornerShape(AgentHomeSpec.tileRadius)),
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
    now: Long,
    reduceMotion: Boolean,
    onOpen: (String) -> Unit,
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
            is AgentHomeItem.Row -> CardRow(item, motion) {
                when (val row = item.row) {
                    is AgentFeedRow.Conversation -> ConversationRow(row, now, reduceMotion, onOpen)
                    is AgentFeedRow.Folder -> FolderRow(row)
                    is AgentFeedRow.Section -> Unit
                }
            }
        }
    }
}

/**
 * One row's part of its card: the card's ground, its top corners rounded
 * on its first row and its bottom ones on its last, a pressed row's
 * highlight clipped to them, and the hairline under every row but the
 * last, from [content]'s title to the card's edge.
 */
@Composable
private fun CardRow(item: AgentHomeItem.Row, modifier: Modifier, content: @Composable () -> Unit) {
    val colors = HappyTheme.colors
    val radius = AgentHomeSpec.cardRadius
    val shape = RoundedCornerShape(
        topStart = if (item.first) radius else 0.dp,
        topEnd = if (item.first) radius else 0.dp,
        bottomStart = if (item.last) radius else 0.dp,
        bottomEnd = if (item.last) radius else 0.dp,
    )
    Box(
        modifier = modifier
            .contentMaxWidth(LocalWindowLayout.current)
            .height(AgentHomeSpec.rowHeight())
            .testTag(AgentHomeTags.row(item.key))
            .padding(horizontal = AgentHomeSpec.cardInset),
    ) {
        Box(Modifier.fillMaxSize().clip(shape).background(colors.surfaceHigh)) {
            content()
            if (!item.last) {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .padding(start = titleStart(item.row))
                        .fillMaxWidth()
                        .height(hairline())
                        .testTag(AgentHomeTags.ROW_DIVIDER)
                        .background(colors.divider),
                )
            }
        }
    }
}

/** Where a card row's title starts, from its card's edge: its level's lane, then its mark's when it wears one. */
private fun titleStart(row: AgentFeedRow): Dp {
    val (depth, marked) = when (row) {
        is AgentFeedRow.Conversation -> row.depth to AgentHomeSpec.hasMark(row.kind)
        is AgentFeedRow.Folder -> row.depth to (row.picture != null)
        is AgentFeedRow.Section -> return 0.dp
    }
    return AgentHomeSpec.markInset + AgentHomeSpec.indent * depth + if (marked) AgentHomeSpec.mark + AgentHomeSpec.markGap else 0.dp
}

/**
 * One conversation, on one line: a bot's or task's 30 mark, the title 17/22
 * (shimmering while it works), and the time or a 10 dot in a 48-minimum
 * corner. The whole row opens it.
 */
@Composable
private fun ConversationRow(row: AgentFeedRow.Conversation, now: Long, reduceMotion: Boolean, onOpen: (String) -> Unit) {
    val colors = HappyTheme.colors
    val marked = AgentHomeSpec.hasMark(row.kind)
    val title = row.title ?: stringResource(R.string.session_new_chat)
    val working = stringResource(R.string.agent_home_working)
    Row(
        modifier = Modifier
            .fillMaxSize()
            .clickable(role = Role.Button) { onOpen(row.agentId) }
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
            if (row.working && !reduceMotion) {
                ShimmerText(text = title, style = AgentHomeSpec.title, baseColor = colors.textSecondary, highlightColor = colors.text)
            } else {
                Text(
                    title,
                    style = AgentHomeSpec.title,
                    color = colors.text,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.wrapContentHeight(unbounded = true),
                )
            }
        }
        Corner(row.activityAt, now, row.blocked, row.unread)
    }
}

/** A project or a worktree: its name, and a cloned repo's picture before it. It opens nothing. */
@Composable
private fun FolderRow(row: AgentFeedRow.Folder) {
    val picture = row.picture
    Row(
        modifier = Modifier
            .fillMaxSize()
            .semantics { heading() }
            .padding(start = AgentHomeSpec.markInset + AgentHomeSpec.indent * row.depth, end = AgentHomeSpec.paddingEnd),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (picture != null) {
            Box(modifier = Modifier.size(AgentHomeSpec.mark).testTag(AgentHomeTags.ROW_MARK)) { AgentPicture(picture, null, AgentHomeSpec.mark) }
        }
        Text(
            row.name,
            style = AgentHomeSpec.title,
            color = HappyTheme.colors.text,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .padding(start = if (picture != null) AgentHomeSpec.markGap else 0.dp)
                .weight(1f)
                .wrapContentHeight(unbounded = true)
                .testTag(AgentHomeTags.ROW_TITLE),
        )
    }
}

/** The time of the last activity, or in its place a dot: orange waiting, blue unread. The slot keeps its width. */
@Composable
private fun Corner(activityAt: Long, now: Long, blocked: Boolean, unread: Boolean) {
    val colors = HappyTheme.colors
    val stamp = remember(activityAt, now / 60_000) { if (activityAt > 0) formatSessionListTimestamp(activityAt, now) else "" }
    val dot = blocked || unread
    val label = when {
        blocked -> stringResource(R.string.status_input_required)
        unread -> stringResource(R.string.status_unread)
        else -> null
    }
    Box(
        modifier = Modifier
            .padding(start = 8.dp)
            .widthIn(min = AgentHomeSpec.cornerMinWidth)
            .then(if (label != null) Modifier.semantics { contentDescription = label } else Modifier),
        contentAlignment = Alignment.CenterEnd,
    ) {
        if (dot) {
            StatusDot(color = if (blocked) BlockedDotColor else UnreadDotColor, size = AgentHomeSpec.dot)
        } else {
            Text(
                stamp,
                style = AgentHomeSpec.timestamp,
                color = colors.textSecondary,
                textAlign = TextAlign.End,
                maxLines = 1,
                modifier = Modifier.wrapContentHeight(unbounded = true),
            )
        }
    }
}

/** The list itself; [header] rows (a banner) go above the conversations. */
@Composable
fun AgentHomeList(
    items: List<AgentHomeItem>,
    state: LazyListState,
    now: Long,
    onOpen: (String) -> Unit,
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
    header: (LazyListScope.() -> Unit)? = null,
    bottom: @Composable () -> Unit = {},
) {
    val reduceMotion = rememberReduceMotion()
    LazyColumn(
        state = state,
        modifier = modifier.fillMaxSize().background(HappyTheme.colors.surface).testTag(AgentHomeTags.LIST),
        contentPadding = contentPadding,
    ) {
        header?.invoke(this)
        agentHomeRows(items, now, reduceMotion, onOpen)
        item(key = "bottom", contentType = "bottom") { bottom() }
    }
}
