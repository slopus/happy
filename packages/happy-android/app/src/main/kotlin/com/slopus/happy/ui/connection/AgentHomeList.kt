package com.slopus.happy.ui.connection

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.ShimmerText
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.home.BlockedDotColor
import com.slopus.happy.ui.home.UnreadDotColor
import com.slopus.happy.ui.home.formatSessionListTimestamp
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

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
    const val ROW_AVATAR = "agentHome.rowAvatar"
    const val ROW_DIVIDER = "agentHome.rowDivider"
}

/**
 * An agent connection's home list. Every row has a fixed height for its
 * kind at the font scale ([conversationHeight], [sectionHeight]): nothing an
 * idle update changes (status, unread, time) can move a row. Text is sp and
 * overflows its line rather than growing it, as Home's timestamp slot does.
 */
object AgentHomeSpec {
    val paddingHorizontal = 16.dp
    val paddingVertical = 10.dp
    val avatar = 44.dp
    val subtaskAvatar = 32.dp
    /** Each subtask level moves its row in by this much. */
    val indent = 28.dp
    val avatarGap = 12.dp
    val toggleWidth = 48.dp
    val toggleIcon = 16.dp
    val dot = 12.dp
    val cornerMinWidth = 48.dp
    const val TITLE_LINE = 22
    const val SUBTITLE_LINE = 18
    val title = happyTextStyle(fontSize = 17, lineHeight = TITLE_LINE, weight = FontWeight.SemiBold)
    val subtitle = happyTextStyle(fontSize = 14, lineHeight = SUBTITLE_LINE)
    val timestamp = happyTextStyle(fontSize = 13, lineHeight = TITLE_LINE).copy(fontFeatureSettings = "tnum")
    val count = happyTextStyle(fontSize = 13, lineHeight = SUBTITLE_LINE, weight = FontWeight.Medium).copy(fontFeatureSettings = "tnum")
    const val SECTION_LINE = 18
    val section = happyTextStyle(fontSize = 14, lineHeight = SECTION_LINE, letterSpacing = 0.1f, weight = FontWeight.SemiBold)
    val sectionPaddingTop = 20.dp
    val sectionPaddingBottom = 8.dp

    /** 10 + a 22 title line + an 18 subtitle line + 10: 60 at the default font scale. */
    @Composable
    fun conversationHeight(): Dp = with(LocalDensity.current) { paddingVertical * 2 + TITLE_LINE.sp.toDp() + SUBTITLE_LINE.sp.toDp() }

    /** 20 + an 18 line + 8: 46 at the default font scale. */
    @Composable
    fun sectionHeight(): Dp = with(LocalDensity.current) { sectionPaddingTop + SECTION_LINE.sp.toDp() + sectionPaddingBottom }

    fun avatarSize(depth: Int) = if (depth == 0) avatar else subtaskAvatar
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
        val showDivider: Boolean,
    ) : AgentHomeItem {
        override val key get() = row.key
    }
}

/**
 * The feed's rows with the subtasks of collapsed conversations left out
 * (a collapsed parent carries their unread and waiting marks), and a
 * divider under every conversation but the last before a heading or the end.
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
                    showDivider = true,
                )
            }
        }
    }
    for (index in out.indices) {
        val item = out[index] as? AgentHomeItem.Conversation ?: continue
        if (out.getOrNull(index + 1) !is AgentHomeItem.Conversation) out[index] = item.copy(showDivider = false)
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
            .background(colors.surface)
            .padding(start = AgentHomeSpec.paddingHorizontal, end = AgentHomeSpec.paddingHorizontal, top = AgentHomeSpec.sectionPaddingTop),
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
 * One conversation: avatar (44, a subtask's 32, indented 28 a level), the
 * title 17/22 semibold (shimmering while it works) with the time or a 12
 * dot in a 48-minimum corner, then one 14/18 line of what it is doing or
 * what it is. A conversation with subtasks has a 48 toggle at the end
 * that shows or hides them. A hairline runs from the text to the edge.
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
    val avatarSize = AgentHomeSpec.avatarSize(row.depth)
    val start = AgentHomeSpec.paddingHorizontal + AgentHomeSpec.indent * row.depth
    val title = row.title ?: stringResource(R.string.session_new_chat)
    val subtitle = when {
        row.blocked -> stringResource(R.string.agent_home_waiting)
        row.working -> stringResource(R.string.agent_home_working)
        row.detail != null -> row.detail
        else -> stringResource(
            when (row.kind) {
                ConversationKind.Bot -> R.string.agent_home_kind_bot
                ConversationKind.Task -> R.string.agent_home_kind_task
                ConversationKind.Project -> R.string.agent_home_kind_project
                ConversationKind.Subtask -> R.string.agent_home_kind_subtask
            },
        )
    }
    val blocked = row.blocked || item.hiddenBlocked
    val unread = row.unread || item.hiddenUnread
    Box(
        modifier = modifier
            .contentMaxWidth(LocalWindowLayout.current)
            .height(AgentHomeSpec.conversationHeight())
            .testTag(AgentHomeTags.row(row.key))
            .background(colors.surface)
            .clickable(role = Role.Button) { onOpen(row.agentId) },
    ) {
        Row(
            modifier = Modifier.fillMaxSize().padding(start = start),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(modifier = Modifier.size(avatarSize).testTag(AgentHomeTags.ROW_AVATAR)) {
                Avatar(id = row.avatarId, size = avatarSize, bot = row.kind == ConversationKind.Bot, thumbhash = row.thumbhash)
            }
            Column(
                modifier = Modifier
                    .padding(start = AgentHomeSpec.avatarGap, end = if (row.childCount > 0) 0.dp else AgentHomeSpec.paddingHorizontal)
                    .weight(1f),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(modifier = Modifier.weight(1f).testTag(AgentHomeTags.ROW_TITLE)) {
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
                    Corner(row.activityAt, now, blocked, unread)
                }
                Text(
                    subtitle,
                    style = AgentHomeSpec.subtitle,
                    color = if (row.blocked) BlockedDotColor else colors.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.wrapContentHeight(unbounded = true),
                )
            }
            if (row.childCount > 0) SubtaskToggle(row.agentId, row.childCount, item.expanded, reduceMotion, onToggle)
        }
        if (item.showDivider) {
            Box(
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .padding(start = start + avatarSize + AgentHomeSpec.avatarGap)
                    .fillMaxWidth()
                    .height(hairline())
                    .testTag(AgentHomeTags.ROW_DIVIDER)
                    .background(colors.divider),
            )
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
    Column(
        modifier = Modifier
            .width(AgentHomeSpec.toggleWidth)
            .fillMaxHeight()
            .testTag(AgentHomeTags.toggle(agentId))
            .clickable(role = Role.Button, onClickLabel = action) { onToggle(agentId) }
            .semantics { stateDescription = action; contentDescription = "$count" },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center,
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
        modifier = modifier.fillMaxSize().background(HappyTheme.colors.surface).testTag(AgentHomeTags.LIST),
        contentPadding = contentPadding,
    ) {
        header?.invoke(this)
        agentHomeRows(items, now, reduceMotion, onOpen, onToggle)
        item(key = "bottom", contentType = "bottom") { bottom() }
    }
}
