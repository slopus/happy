package com.slopus.happy.ui.connection

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.draw.rotate
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
import com.slopus.happy.ui.components.ItemGroupSpec
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
import kotlin.math.roundToInt

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
    fun toggle(agentId: String) = "agentHome.toggle.$agentId"
    const val ROW_TITLE = "agentHome.rowTitle"
    const val ROW_MARK = "agentHome.rowMark"
    const val ROW_DIVIDER = "agentHome.rowDivider"
}

/**
 * An agent connection's home list, grouped as Gmail's lists are: each
 * section (bots, tasks, each project) a heading over one rounded card of
 * single-line rows, on the grouped background. Every row has a fixed height
 * for its kind at the font scale ([conversationHeight], [sectionHeight]):
 * nothing an idle update changes (status, unread, time) can move a row.
 * Text is sp and overflows its line rather than growing it, as Home's
 * timestamp slot does.
 */
object AgentHomeSpec {
    /** The cards' inset from the window's sides: ItemGroup's 4 and 12. */
    val cardInset = ItemGroupSpec.paddingHorizontal + ItemGroupSpec.cardMarginHorizontal
    val cardRadius = ItemGroupSpec.cardRadius
    val paddingHorizontal = 16.dp
    val paddingVertical = 13.dp
    val mark = 28.dp
    /** Each subtask level moves its row in by this much. */
    val indent = 28.dp
    val markGap = 16.dp
    val toggleWidth = 48.dp
    val toggleIcon = 16.dp
    val dot = 10.dp
    val cornerMinWidth = 48.dp
    const val TITLE_LINE = 22
    val title = happyTextStyle(fontSize = 16, lineHeight = TITLE_LINE, weight = FontWeight.Medium)
    val timestamp = happyTextStyle(fontSize = 13, lineHeight = TITLE_LINE).copy(fontFeatureSettings = "tnum")
    val count = happyTextStyle(fontSize = 13, lineHeight = TITLE_LINE, weight = FontWeight.Medium).copy(fontFeatureSettings = "tnum")
    const val SECTION_LINE = 20
    val section = ItemGroupSpec.header
    /** The heading starts where ItemGroup's does. */
    val sectionPaddingStart = ItemGroupSpec.paddingHorizontal + ItemGroupSpec.headerPaddingHorizontal
    val sectionPaddingTop = ItemGroupSpec.headerPaddingTop
    val sectionPaddingBottom = ItemGroupSpec.headerPaddingBottom

    /** 13 + a 22 line + 13: 48 at the default font scale. */
    @Composable
    fun conversationHeight(): Dp = with(LocalDensity.current) { paddingVertical * 2 + TITLE_LINE.sp.toDp() }

    /** 16 + a 20 line + 8: 44 at the default font scale. */
    @Composable
    fun sectionHeight(): Dp = with(LocalDensity.current) { sectionPaddingTop + SECTION_LINE.sp.toDp() + sectionPaddingBottom }

    /**
     * The side of the mark before a row's title, or null for none: a bot
     * wears its picture and a subtask the checkbox, as on iOS
     * (SidebarRows.swift); a task and a project's conversation wear
     * nothing, their title starting where a mark would.
     */
    fun markSize(kind: ConversationKind): Dp? = when (kind) {
        ConversationKind.Bot, ConversationKind.Subtask -> mark
        ConversationKind.Task, ConversationKind.Project -> null
    }
}

/** Reads bots' pictures for the rows; null where nothing serves them (tests, fixtures). */
val LocalAgentPictures = staticCompositionLocalOf<AgentPictures?> { null }

/**
 * A row's mark at [size]: a bot's picture over its ThumbHash, or iOS's
 * person glyph for a bot without one; the checkbox for a subtask.
 */
@Composable
internal fun ConversationMark(row: AgentFeedRow.Conversation, size: Dp) {
    val picture = row.picture
    if (picture != null) {
        BotPicture(picture, row.thumbhash, size)
        return
    }
    Box(Modifier.size(size), contentAlignment = Alignment.Center) {
        val glyph = if (row.kind == ConversationKind.Bot) Ionicon.PersonCircleOutline else Ionicon.CheckboxOutline
        Icon(glyph, (size.value * 0.8f).roundToInt().dp, HappyTheme.colors.text)
    }
}

@Composable
private fun BotPicture(path: String, thumbhash: String?, size: Dp) {
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
        modifier = Modifier.size(size).clip(CircleShape),
        background = HappyTheme.colors.surfaceHigh,
        cacheKey = pictures?.key(path, thumbhash),
        placeholder = rememberThumbHash(thumbhash),
    )
}

/** A row as home draws it: the feed's row with what showing it needs. */
@Immutable
sealed interface AgentHomeItem {
    val key: String

    data class Section(val section: AgentFeedSection) : AgentHomeItem {
        override val key get() = "section-${section.key}"
    }

    data class Conversation(
        val row: AgentFeedRow.Conversation,
        /** Its subtasks are showing. */
        val expanded: Boolean,
        /** A hidden subtask is unread or waits for the person. */
        val hiddenUnread: Boolean,
        val hiddenBlocked: Boolean,
        /** It opens its section's card, and closes it; between, a hairline under it. */
        val first: Boolean,
        val last: Boolean,
    ) : AgentHomeItem {
        override val key get() = row.key
    }
}

/**
 * The feed's rows with the subtasks of collapsed conversations left out
 * (a collapsed parent carries their unread and waiting marks), each knowing
 * where it stands in its section's card.
 */
fun agentHomeItems(feed: AgentFeed, expanded: Set<String>): List<AgentHomeItem> {
    val out = ArrayList<AgentHomeItem>(feed.rows.size)
    val hidden = HashSet<String>()
    val rows = feed.rows
    for ((index, row) in rows.withIndex()) {
        when (row) {
            is AgentFeedRow.Section -> out += AgentHomeItem.Section(row.section)
            is AgentFeedRow.Conversation -> {
                if (row.parentId != null && (row.parentId in hidden || row.parentId !in expanded)) {
                    hidden += row.agentId
                    continue
                }
                val open = row.agentId in expanded && row.childCount > 0
                val children = if (open || row.childCount == 0) emptyList() else
                    rows.subList(index + 1, (index + 1 + row.childCount).coerceAtMost(rows.size)).filterIsInstance<AgentFeedRow.Conversation>()
                out += AgentHomeItem.Conversation(
                    row = row,
                    expanded = open,
                    hiddenUnread = children.any { it.unread },
                    hiddenBlocked = children.any { it.blocked },
                    first = out.lastOrNull() !is AgentHomeItem.Conversation,
                    last = false,
                )
            }
        }
    }
    for (index in out.indices) {
        val item = out[index] as? AgentHomeItem.Conversation ?: continue
        if (out.getOrNull(index + 1) !is AgentHomeItem.Conversation) out[index] = item.copy(last = true)
    }
    return out
}

/** The rows of [items] into a lazy list, each animating in and out unless motion is reduced. */
fun LazyListScope.agentHomeRows(
    items: List<AgentHomeItem>,
    now: Long,
    reduceMotion: Boolean,
    onOpen: (String) -> Unit,
    onToggle: (String) -> Unit,
) {
    items(items, key = { it.key }, contentType = { it::class }) { item ->
        val motion = if (reduceMotion) Modifier else Modifier.animateItem(
            fadeInSpec = tween(180),
            placementSpec = tween(220),
            fadeOutSpec = tween(140),
        )
        when (item) {
            is AgentHomeItem.Section -> SectionRow(item.section, motion)
            is AgentHomeItem.Conversation -> ConversationRow(item, now, reduceMotion, onOpen, onToggle, motion)
        }
    }
}

@Composable
private fun SectionRow(section: AgentFeedSection, modifier: Modifier) {
    val colors = HappyTheme.colors
    val title = when (section) {
        AgentFeedSection.Bots -> stringResource(R.string.agent_home_bots)
        AgentFeedSection.Tasks -> stringResource(R.string.agent_home_tasks)
        is AgentFeedSection.Project -> section.name
    }
    Box(
        modifier = modifier
            .contentMaxWidth(LocalWindowLayout.current)
            .height(AgentHomeSpec.sectionHeight())
            .testTag(AgentHomeTags.row("section-${section.key}"))
            .padding(start = AgentHomeSpec.sectionPaddingStart, end = AgentHomeSpec.sectionPaddingStart, top = AgentHomeSpec.sectionPaddingTop),
    ) {
        Text(
            title,
            style = AgentHomeSpec.section,
            color = colors.grouped.sectionTitle,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.wrapContentHeight(unbounded = true).semantics { heading() },
        )
    }
}

/**
 * One conversation, on one line, as its part of its section's card (the
 * first rounds the card's top, the last its bottom): its mark
 * ([AgentHomeSpec.markSize]: 28 for a bot or a subtask, the subtask
 * indented 28 a level; none for a task), the title 16/22 (shimmering while
 * it works), and the time or a 10 dot in a 48-minimum corner. A
 * conversation with subtasks has a 48 toggle at the end that shows or
 * hides them. A hairline runs from the text to the card's edge under every
 * row but the card's last.
 */
@Composable
private fun ConversationRow(
    item: AgentHomeItem.Conversation,
    now: Long,
    reduceMotion: Boolean,
    onOpen: (String) -> Unit,
    onToggle: (String) -> Unit,
    modifier: Modifier,
) {
    val colors = HappyTheme.colors
    val row = item.row
    val markSize = AgentHomeSpec.markSize(row.kind)
    val start = AgentHomeSpec.paddingHorizontal + AgentHomeSpec.indent * row.depth
    val textStart = if (markSize == null) 0.dp else markSize + AgentHomeSpec.markGap
    val title = row.title ?: stringResource(R.string.session_new_chat)
    val working = stringResource(R.string.agent_home_working)
    val blocked = row.blocked || item.hiddenBlocked
    val unread = row.unread || item.hiddenUnread
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
            .height(AgentHomeSpec.conversationHeight())
            .testTag(AgentHomeTags.row(row.key))
            .padding(horizontal = AgentHomeSpec.cardInset),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .clip(shape)
                .background(colors.surface)
                .clickable(role = Role.Button) { onOpen(row.agentId) }
                .then(if (row.working) Modifier.semantics { stateDescription = working } else Modifier),
        ) {
            Row(
                modifier = Modifier.fillMaxSize().padding(start = start),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (markSize != null) {
                    Box(modifier = Modifier.size(markSize).testTag(AgentHomeTags.ROW_MARK)) { ConversationMark(row, markSize) }
                }
                Box(
                    modifier = Modifier
                        .padding(start = if (markSize == null) 0.dp else AgentHomeSpec.markGap)
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
                Box(Modifier.padding(end = if (row.childCount > 0) 0.dp else AgentHomeSpec.paddingHorizontal)) {
                    Corner(row.activityAt, now, blocked, unread)
                }
                if (row.childCount > 0) SubtaskToggle(row.agentId, row.childCount, item.expanded, reduceMotion, onToggle)
            }
            if (!item.last) {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .padding(start = start + textStart)
                        .fillMaxWidth()
                        .height(hairline())
                        .testTag(AgentHomeTags.ROW_DIVIDER)
                        .background(colors.divider),
                )
            }
        }
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

@Composable
private fun SubtaskToggle(agentId: String, count: Int, expanded: Boolean, reduceMotion: Boolean, onToggle: (String) -> Unit) {
    val colors = HappyTheme.colors
    val turn by animateFloatAsState(if (expanded) 180f else 0f, if (reduceMotion) tween(0) else tween(220), label = "subtaskChevron")
    val action = stringResource(if (expanded) R.string.agent_home_hide_subtasks else R.string.agent_home_show_subtasks)
    Row(
        modifier = Modifier
            .width(AgentHomeSpec.toggleWidth)
            .fillMaxHeight()
            .testTag(AgentHomeTags.toggle(agentId))
            .clickable(role = Role.Button, onClickLabel = action) { onToggle(agentId) }
            .semantics { stateDescription = action; contentDescription = "$count" },
        horizontalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("$count", style = AgentHomeSpec.count, color = colors.textSecondary, maxLines = 1, modifier = Modifier.wrapContentHeight(unbounded = true))
        Icon(Ionicon.ChevronDown, AgentHomeSpec.toggleIcon, colors.textSecondary, Modifier.rotate(turn))
    }
}

/** The list itself; [header] rows (a banner) go above the conversations. */
@Composable
fun AgentHomeList(
    items: List<AgentHomeItem>,
    state: LazyListState,
    now: Long,
    onOpen: (String) -> Unit,
    onToggle: (String) -> Unit,
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
    header: (LazyListScope.() -> Unit)? = null,
    bottom: @Composable () -> Unit = {},
) {
    val reduceMotion = rememberReduceMotion()
    LazyColumn(
        state = state,
        modifier = modifier.fillMaxSize().background(HappyTheme.colors.grouped.background).testTag(AgentHomeTags.LIST),
        contentPadding = contentPadding,
    ) {
        header?.invoke(this)
        agentHomeRows(items, now, reduceMotion, onOpen, onToggle)
        item(key = "bottom", contentType = "bottom") { bottom() }
    }
}
