package com.slopus.happy.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.ChatListItem
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.WorkGroupExpansion
import com.slopus.happy.chat.chatListItems
import com.slopus.happy.chat.groupChatRowsForDisplay
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Octicon
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonDisplay
import com.slopus.happy.ui.components.RoundButtonSize
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

object ChatListTags {
    const val LIST = "chat.list"
    const val OLDER_END = "chat.list.older"
    const val OLDER_INSET = "chat.list.olderInset"
    const val FOOTER = "chat.list.footer"
    const val CONTROLLED_WARNING = "chat.list.controlledWarning"
    const val SCROLL_BUTTON = "chat.list.scrollToBottom"
}

/** ChatList.tsx / ChatFooter.tsx. */
object ChatListSpec {
    /** Past this distance from the newest message the scroll-to-bottom button shows. */
    val scrollThreshold = 300.dp
    val scrollButton = 32.dp
    val scrollIcon = 14.dp
    const val SCROLL_BUTTON_OPACITY = 0.9f
    /** The button's gap above the floating composer's card (`SCROLL_BUTTON_COMPOSER_GAP`). */
    val scrollButtonGap = 16.dp
    /** Its gap above the list's end where the composer sits below the list (`SCROLL_BUTTON_DOCK_GAP`). */
    val scrollButtonDockGap = 4.dp
    /** `DOCK_DETAILS_SHOW_OFFSET` / `DOCK_DETAILS_HIDE_OFFSET`: the dock's details hide past 48 from the newest message and come back within 16. */
    val dockDetailsShowOffset = 16.dp
    val dockDetailsHideOffset = 48.dp
    /** Below the newest row (the inverted list's top padding). */
    val newestPadding = 8.dp
    val olderStatusHeight = 32.dp
    /** Beyond the older-end slot in landscape on a phone, where the header doesn't overlap the list. */
    val olderInsetLandscape = 12.dp
    /** On a tablet the spacer is a header, the status bar and this more (OlderEnd's default inset). */
    val olderInsetTabletExtra = 32.dp
    const val MAX_INVISIBLE_OLDER_PAGES = 5
    val footerPaddingTop = 4.dp
    val footerPaddingBottom = 2.dp
    val warningMarginHorizontal = 32.dp
    val warningMarginTop = 4.dp
    val warningPaddingHorizontal = 12.dp
    val warningPaddingVertical = 4.dp
    val warningRadius = 8.dp
    val warningIcon = 16.dp
    val warningGap = 6.dp
    val warningText = happyTextStyle(fontSize = 12)
}

/** Why paging back stopped until the user asks again. */
enum class OlderBlock { Error, Limit }

/**
 * Pages older history in from the server as the reader nears it (ChatList's
 * `fillOlder`, EmptyMessages' loop). A page that brings no visible row
 * counts against a budget of five; past it the list waits for "Load more".
 * A failure waits for "Retry".
 */
@Stable
class OlderPager(private val load: suspend () -> Boolean) {
    var blocked by mutableStateOf<OlderBlock?>(null)
        private set
    private var pending = false
    private var invisiblePages = 0

    /** Fetches one page unless one is in flight or paging is blocked. [oldest] reads the oldest visible row's key. */
    suspend fun request(oldest: () -> String?) {
        if (pending || blocked != null) return
        pending = true
        val before = oldest()
        try {
            if (!load()) return
            // The page lands in the store, then the feed re-reduces: give it a moment to show.
            val after = withTimeoutOrNull(1_000) { snapshotFlow { oldest() }.first { it != before } } ?: before
            if (after == before) {
                invisiblePages += 1
                if (invisiblePages >= ChatListSpec.MAX_INVISIBLE_OLDER_PAGES) blocked = OlderBlock.Limit
            } else {
                invisiblePages = 0
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            blocked = OlderBlock.Error
        } finally {
            pending = false
        }
    }

    fun retry() {
        blocked = null
    }

    fun loadMore() {
        invisiblePages = 0
        blocked = null
    }
}

/** What the older end of the list shows (ChatList `olderStatus`). */
enum class OlderStatus { Idle, Loading, Error, LoadMore }

fun olderStatus(blocked: OlderBlock?, hasMoreOlder: Boolean, isLoadingOlder: Boolean): OlderStatus = when {
    blocked == OlderBlock.Error && hasMoreOlder -> OlderStatus.Error
    blocked == OlderBlock.Limit && hasMoreOlder -> OlderStatus.LoadMore
    isLoadingOlder -> OlderStatus.Loading
    else -> OlderStatus.Idle
}

/**
 * The transcript (ChatList.tsx). Spec: an inverted list, newest row at the
 * bottom, opening there with no scroll; 8 below the newest row. Just past
 * the newest row the footer (ChatFooter), just past the oldest a 32-high
 * slot: a spinner while a page loads, "Retry" after a failure, "Load more"
 * once five pages in a row brought nothing visible (small inverted
 * RoundButtons), with a spacer beyond it ([olderInset]). History is fetched whenever the oldest row is within a
 * viewport of the screen. Past 300 from the newest row a 32 round button
 * (surface at 0.9, 1 divider border, Octicons arrow-down 14), centred,
 * scrolls back down: 16 above the composer card when the dock floats over
 * the list ([scrollButtonInset], the card's distance from the list's
 * bottom), else 4 above the list's end. [bottomInset] (the floating dock)
 * is added under the newest row so it scrolls clear of the dock.
 * [onNewestVisibleChange] reports whether the reader is at the newest
 * message: false past 48 from it, true again within 16.
 *
 * Work groups (useGroupedMessages, with [groupToolCalls] on): a finished
 * turn's work folds under one "Worked …" header above its answer (the
 * current turn only once [currentTurnComplete]); tapping it lays the work
 * out flat under it with a "Hide" header where the tap was. Turns watched
 * live stay open when they finish; going to the background folds what
 * has finished. Invisible rows are dropped either way.
 */
@Composable
fun ChatList(
    rows: List<ChatRow>,
    hasMoreOlder: Boolean,
    isLoadingOlder: Boolean,
    controlledByUser: Boolean,
    bubble: BubblePalette,
    callbacks: MessageCallbacks,
    pager: OlderPager,
    modifier: Modifier = Modifier,
    state: LazyListState = rememberLazyListState(),
    bottomInset: Dp = 0.dp,
    scrollButtonInset: Dp? = null,
    onNewestVisibleChange: ((Boolean) -> Unit)? = null,
    sessionId: String = "",
    groupToolCalls: Boolean = false,
    currentTurnComplete: Boolean = true,
    foreground: Boolean = true,
) {
    val colors = HappyTheme.colors
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val thresholdPx = with(density) { ChatListSpec.scrollThreshold.roundToPx() }
    val currentRows by rememberUpdatedState(rows)
    val showScrollButton by remember {
        derivedStateOf {
            // Exact while the footer is on screen; once it has scrolled away the
            // reader is a row or more back, which reads as "far" past the first.
            when (state.firstVisibleItemIndex) {
                0 -> state.firstVisibleItemScrollOffset > thresholdPx
                1 -> state.firstVisibleItemScrollOffset > thresholdPx / 2
                else -> true
            }
        }
    }
    val nearOldest by remember {
        derivedStateOf {
            val info = state.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: return@derivedStateOf true
            last >= info.totalItemsCount - 1 - info.visibleItemsInfo.size
        }
    }
    if (onNewestVisibleChange != null) {
        val report by rememberUpdatedState(onNewestVisibleChange)
        val showPx = with(density) { ChatListSpec.dockDetailsShowOffset.toPx() }
        val hidePx = with(density) { ChatListSpec.dockDetailsHideOffset.toPx() }
        LaunchedEffect(state) {
            var visible = true
            report(true)
            // The inverted list's offset from the newest end; a row or more back is far.
            snapshotFlow { if (state.firstVisibleItemIndex == 0) state.firstVisibleItemScrollOffset.toFloat() else Float.MAX_VALUE }
                .collect { distance ->
                    // Hysteresis: no flicker while resting or bouncing near the newest message.
                    val next = if (visible) distance <= hidePx else distance <= showPx
                    if (next != visible) {
                        visible = next
                        report(next)
                    }
                }
        }
        DisposableEffect(Unit) { onDispose { report(true) } }
    }
    val displayItems = remember(rows, groupToolCalls, currentTurnComplete) { groupChatRowsForDisplay(rows, groupToolCalls, currentTurnComplete) }
    var expansion by remember { mutableStateOf(WorkGroupExpansion()) }
    // ChatList.tsx's render-time bookkeeping: the same value back when nothing changed.
    val observed = expansion.observed(sessionId, foreground, rows, currentTurnComplete)
    SideEffect { if (observed !== expansion) expansion = observed }
    val latestItems by rememberUpdatedState(displayItems)
    LaunchedEffect(foreground) { if (!foreground) expansion = expansion.backgrounded(latestItems) }
    val listItems = remember(displayItems, observed) { chatListItems(displayItems, observed::isExpanded) }
    val blocked = pager.blocked
    LaunchedEffect(nearOldest, hasMoreOlder, isLoadingOlder, blocked, rows) {
        if (nearOldest && hasMoreOlder && !isLoadingOlder && blocked == null) {
            scope.launch { pager.request { currentRows.lastOrNull()?.key } }
        }
    }

    Box(modifier = modifier.fillMaxSize()) {
        LazyColumn(
            state = state,
            reverseLayout = true,
            contentPadding = PaddingValues(bottom = ChatListSpec.newestPadding + bottomInset),
            modifier = Modifier.testTag(ChatListTags.LIST).fillMaxSize(),
        ) {
            item(key = "footer", contentType = "footer") { ChatFooter(controlledByUser) }
            items(listItems, key = { it.key }, contentType = { item -> if (item is ChatListItem.Row) item.row::class else WORK_HEADER }) { item ->
                when (item) {
                    is ChatListItem.Row -> MessageView(item.row, bubble, callbacks)
                    // Toggled by the group, not the row: both headers of an open group drive one state.
                    is ChatListItem.WorkHeader -> AgentWorkGroupHeader(
                        group = item.group,
                        expanded = observed.isExpanded(item.group),
                        onToggle = { expansion = expansion.toggled(item.group) },
                        placement = item.placement,
                    )
                }
            }
            item(key = "older", contentType = "older") {
                OlderEnd(olderStatus(blocked, hasMoreOlder, isLoadingOlder), olderInset(), onRetry = pager::retry, onLoadMore = pager::loadMore)
            }
        }
        if (showScrollButton) {
            val scrollLabel = stringResource(R.string.chat_scroll_to_bottom)
            Box(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = scrollButtonInset?.let { it + ChatListSpec.scrollButtonGap } ?: (ChatListSpec.scrollButtonDockGap + bottomInset))
                    .testTag(ChatListTags.SCROLL_BUTTON)
                    .size(ChatListSpec.scrollButton)
                    .clip(CircleShape)
                    .alpha(ChatListSpec.SCROLL_BUTTON_OPACITY)
                    .background(colors.surface)
                    .border(1.dp, colors.divider, CircleShape)
                    .clickable(role = Role.Button) { scope.launch { state.animateScrollToItem(0) } }
                    .semantics { contentDescription = scrollLabel },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Octicon.ArrowDown, ChatListSpec.scrollIcon, colors.text)
            }
        }
    }
}

private const val WORK_HEADER = "workHeader"

/**
 * SessionView's `chatListTopContentInset` as the spacer beyond the oldest
 * row. A phone in portrait runs the list under its 64 header with 52 + 12
 * of inset, which ends where the header does: nothing here, as the list
 * starts below the header. Landscape keeps 12. A tablet passes no inset,
 * so OlderEnd's default holds: the header, the status bar and 32.
 */
@Composable
private fun olderInset(): Dp {
    val layout = LocalWindowLayout.current
    return when {
        layout.isTablet -> layout.headerHeight + WindowInsets.statusBars.asPaddingValues().calculateTopPadding() + ChatListSpec.olderInsetTabletExtra
        layout.isLandscape -> ChatListSpec.olderInsetLandscape
        else -> 0.dp
    }
}

/** OlderEnd: the spacer, then the 32 status slot against the oldest row. */
@Composable
private fun OlderEnd(status: OlderStatus, inset: Dp, onRetry: () -> Unit, onLoadMore: () -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        if (inset > 0.dp) Spacer(Modifier.testTag(ChatListTags.OLDER_INSET).fillMaxWidth().height(inset))
        OlderStatusSlot(status, onRetry, onLoadMore)
    }
}

@Composable
private fun OlderStatusSlot(status: OlderStatus, onRetry: () -> Unit, onLoadMore: () -> Unit) {
    Box(
        modifier = Modifier.testTag(ChatListTags.OLDER_END).fillMaxWidth().heightIn(min = ChatListSpec.olderStatusHeight),
        contentAlignment = Alignment.Center,
    ) {
        when (status) {
            OlderStatus.Loading -> CircularProgressIndicator(Modifier.size(20.dp), color = HappyTheme.colors.textSecondary, strokeWidth = 2.dp)
            OlderStatus.Error -> RoundButton(
                stringResource(R.string.common_retry),
                onRetry,
                size = RoundButtonSize.Small,
                display = RoundButtonDisplay.Inverted,
            )
            OlderStatus.LoadMore -> RoundButton(
                stringResource(R.string.common_load_more),
                onLoadMore,
                size = RoundButtonSize.Small,
                display = RoundButtonDisplay.Inverted,
            )
            OlderStatus.Idle -> Unit
        }
    }
}

/**
 * ChatFooter.tsx. Spec: 4 above, 2 below. When the terminal controls the
 * session (not a Happy Agent session), a warning box: boxWarning
 * background, radius 8, padding 12/4, 32 side margins and 4 above;
 * information-circle 16 and 12pt text in the warning text colour.
 */
@Composable
fun ChatFooter(controlledByUser: Boolean, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    Column(
        modifier = modifier
            .testTag(ChatListTags.FOOTER)
            .fillMaxWidth()
            .padding(top = ChatListSpec.footerPaddingTop, bottom = ChatListSpec.footerPaddingBottom),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (controlledByUser) {
            Row(
                modifier = Modifier
                    .padding(horizontal = ChatListSpec.warningMarginHorizontal)
                    .padding(top = ChatListSpec.warningMarginTop)
                    .testTag(ChatListTags.CONTROLLED_WARNING)
                    .clip(RoundedCornerShape(ChatListSpec.warningRadius))
                    .background(colors.boxWarning.background)
                    .padding(horizontal = ChatListSpec.warningPaddingHorizontal, vertical = ChatListSpec.warningPaddingVertical),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(ChatListSpec.warningGap),
            ) {
                Icon(Ionicon.InformationCircle, ChatListSpec.warningIcon, colors.boxWarning.text)
                Text(
                    // Literal in happy-app (ChatFooter.tsx).
                    text = "Permissions shown in terminal only. Reset or send a message to control from app.",
                    style = ChatListSpec.warningText,
                    color = colors.boxWarning.text,
                )
            }
        }
    }
}
