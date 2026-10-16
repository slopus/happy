package com.slopus.happy.ui.session

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.PendingChat
import com.slopus.happy.model.SessionRowData
import com.slopus.happy.model.SessionState
import com.slopus.happy.model.WorktreeTabs
import com.slopus.happy.model.neighbouringTabId
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.ShimmerText
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object WorktreeTabTags {
    const val STRIP = "worktreeTabs"
    const val PILL = "worktreeTabs.pill"
    const val ADD = "worktreeTabs.add"
    fun tab(id: String) = "worktreeTabs.tab.$id"
    fun dot(id: String) = "worktreeTabs.dot.$id"
}

/** WorktreeTabStrip.tsx on Android, which draws the solid pill (no glass off iOS). */
object WorktreeTabSpec {
    val pillHeight = 40.dp
    val gapAbove = 10.dp
    val gapBelow = 6.dp
    /** WORKTREE_TAB_STRIP_HEIGHT: what the strip costs the layout. */
    val height = pillHeight + gapAbove + gapBelow
    val paddingHorizontal = 16.dp
    val tabsPaddingHorizontal = 4.dp
    val tabGap = 2.dp
    val tabHeight = pillHeight - 8.dp
    val tabPaddingHorizontal = 10.dp
    val tabMaxWidth = 200.dp
    val tabContentGap = 6.dp
    val tabText = happyTextStyle(fontSize = 14, lineHeight = 18)
    val dot = 7.dp
    val dividerHeight = 20.dp
    val addWidth = 40.dp
    val addIcon = 20.dp
    const val PRESSED_OPACITY = 0.55f
    /** A tab scrolled to keeps this much room either side (TAB_SCROLL_MARGIN). */
    val scrollMargin = 8.dp
    val unread = Color(0xFF007AFF)
    val blocked = Color(0xFFFF9500)
    fun selected(dark: Boolean) = if (dark) Color.White.copy(alpha = 0.14f) else Color.Black.copy(alpha = 0.07f)
}

/**
 * WorktreeTabStrip: one checkout's chats as tabs under the session header,
 * in the project layout. Spec: 10 above and 6 below, 16 in from the
 * screen's edges (held to the header's max width on a tablet); a 40 high
 * capsule in surfaceHigh with a hairline divider border. Inside, scrolling
 * sideways, 4 in and 2 apart: each tab 32 high, 10 in, radius 16, at most
 * 200 wide; the open one filled (white 14% in dark, black 7% in light),
 * its name 14/18 semibold in the header tint, the rest textSecondary at
 * 0.55 while pressed; a working chat's name shimmers; 6 on, a pulsing 7
 * orange dot for a chat stopped on the user, else a 7 blue dot for unread
 * (not on the open tab). Then the chats being started ("New chat",
 * shimmering). A hairline divider 20 high, then the 40 wide `+`, add 20
 * in the header tint. A long press opens the session's actions.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun WorktreeTabStrip(
    tabs: WorktreeTabs,
    selectedId: String,
    onSelect: (String) -> Unit,
    onMenu: (sessionId: String, neighbourId: String?) -> Unit,
    onNewTab: () -> Unit,
    listState: LazyListState,
    modifier: Modifier = Modifier,
) {
    val colors = HappyTheme.colors
    val layout = LocalWindowLayout.current
    val shape = RoundedCornerShape(WorktreeTabSpec.pillHeight / 2)
    val keys = tabs.tabs.map { it.id } + tabs.pending.map { it.id }
    // Keep the open tab in view by the smallest scroll that shows it, and leave the strip alone otherwise.
    LaunchedEffect(selectedId, keys.size) {
        val index = keys.indexOf(selectedId)
        if (index < 0) return@LaunchedEffect
        val visible = listState.layoutInfo.visibleItemsInfo.find { it.index == index }
        val viewport = listState.layoutInfo.viewportEndOffset
        if (visible == null || visible.offset < 0 || visible.offset + visible.size > viewport) listState.animateScrollToItem(index)
    }
    Box(
        modifier = modifier
            .testTag(WorktreeTabTags.STRIP)
            .fillMaxWidth()
            .padding(top = WorktreeTabSpec.gapAbove, bottom = WorktreeTabSpec.gapBelow)
            .wrapContentWidth(Alignment.CenterHorizontally)
            .then(if (layout.isTablet) Modifier.widthIn(max = layout.headerMaxWidth) else Modifier)
            .padding(horizontal = WorktreeTabSpec.paddingHorizontal),
    ) {
        Row(
            modifier = Modifier
                .testTag(WorktreeTabTags.PILL)
                .fillMaxWidth()
                .height(WorktreeTabSpec.pillHeight)
                .clip(shape)
                .background(colors.surfaceHigh)
                .border(hairline(), colors.divider, shape),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            LazyRow(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxHeight(),
                contentPadding = PaddingValues(horizontal = WorktreeTabSpec.tabsPaddingHorizontal),
                horizontalArrangement = Arrangement.spacedBy(WorktreeTabSpec.tabGap),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                items(tabs.tabs, key = { it.id }) { tab ->
                    val neighbour = remember(tabs.tabs, tab.id) { neighbouringTabId(tabs.tabs, tab.id) }
                    SessionTab(tab, selected = tab.id == selectedId, onSelect = { onSelect(tab.id) }, onMenu = { onMenu(tab.id, neighbour) })
                }
                items(tabs.pending, key = { it.id }) { chat -> PendingTab(chat, selected = chat.id == selectedId, onSelect = { onSelect(chat.id) }) }
            }
            Box(Modifier.width(hairline()).height(WorktreeTabSpec.dividerHeight).background(colors.divider))
            val interaction = remember { MutableInteractionSource() }
            val pressed by interaction.collectIsPressedAsState()
            val label = stringResource(R.string.sidebar_new_session)
            Box(
                modifier = Modifier
                    .testTag(WorktreeTabTags.ADD)
                    .width(WorktreeTabSpec.addWidth)
                    .fillMaxHeight()
                    .alpha(if (pressed) WorktreeTabSpec.PRESSED_OPACITY else 1f)
                    .clickable(interaction, indication = null, role = Role.Button, onClick = onNewTab)
                    .semantics { contentDescription = label },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Ionicon.Add, WorktreeTabSpec.addIcon, colors.header.tint)
            }
        }
    }
}

@Composable
private fun SessionTab(session: SessionRowData, selected: Boolean, onSelect: () -> Unit, onMenu: () -> Unit) {
    val name = session.name ?: stringResource(R.string.session_new_chat)
    val working = session.state == SessionState.Thinking
    val blocked = session.state == SessionState.PermissionRequired || session.state == SessionState.InputRequired
    TabChip(WorktreeTabTags.tab(session.id), selected, name, onSelect, onMenu) {
        TabLabel(name, selected, shimmer = working, Modifier.weight(1f, fill = false))
        when {
            blocked -> StatusDot(WorktreeTabSpec.blocked, Modifier.testTag(WorktreeTabTags.dot(session.id)), pulsing = true, size = WorktreeTabSpec.dot)
            session.hasUnread && !selected -> Box(
                Modifier.testTag(WorktreeTabTags.dot(session.id)).size(WorktreeTabSpec.dot).clip(CircleShape).background(WorktreeTabSpec.unread),
            )
        }
    }
}

@Composable
private fun PendingTab(chat: PendingChat, selected: Boolean, onSelect: () -> Unit) {
    val label = stringResource(R.string.session_new_chat)
    TabChip(WorktreeTabTags.tab(chat.id), selected, label, onSelect, onLongClick = null) {
        TabLabel(label, selected, shimmer = true, Modifier.weight(1f, fill = false))
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TabChip(
    tag: String,
    selected: Boolean,
    description: String,
    onClick: () -> Unit,
    onLongClick: (() -> Unit)?,
    content: @Composable RowScope.() -> Unit,
) {
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(WorktreeTabSpec.tabHeight / 2)
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Row(
        modifier = Modifier
            .testTag(tag)
            .height(WorktreeTabSpec.tabHeight)
            .widthIn(max = WorktreeTabSpec.tabMaxWidth)
            .alpha(if (pressed && !selected) WorktreeTabSpec.PRESSED_OPACITY else 1f)
            .clip(shape)
            .background(if (selected) WorktreeTabSpec.selected(colors.dark) else Color.Transparent)
            .combinedClickable(interaction, indication = null, role = Role.Tab, onLongClick = onLongClick, onClick = onClick)
            .semantics {
                this.selected = selected
                contentDescription = description
            }
            .padding(horizontal = WorktreeTabSpec.tabPaddingHorizontal),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(WorktreeTabSpec.tabContentGap),
        content = content,
    )
}

@Composable
private fun TabLabel(text: String, selected: Boolean, shimmer: Boolean, modifier: Modifier) {
    val colors = HappyTheme.colors
    val style = if (selected) WorktreeTabSpec.tabText.copy(fontWeight = FontWeight.SemiBold) else WorktreeTabSpec.tabText
    if (shimmer) {
        ShimmerText(text, style, baseColor = colors.textSecondary, highlightColor = colors.header.tint, modifier = modifier)
    } else {
        Text(
            text,
            style = style,
            color = if (selected) colors.header.tint else colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = modifier,
        )
    }
}
