package com.slopus.happy.ui.home

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.FlatRowTopRight
import com.slopus.happy.model.FlatSessionRowData
import com.slopus.happy.model.SessionRowData
import com.slopus.happy.model.SessionState
import com.slopus.happy.model.VisibleGitChanges
import com.slopus.happy.model.compactCount
import com.slopus.happy.model.resolveFlatRowPresentation
import com.slopus.happy.model.visibleGitChanges
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.AvatarBadgeLocation
import com.slopus.happy.ui.components.HomeCardSpec
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.ShimmerSpec
import com.slopus.happy.ui.components.ShimmerText
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.theme.HappyColors
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.delay

object FlatRowTags {
    const val ROW = "flatRow.row"
    const val AVATAR = "flatRow.avatar"
    const val TITLE = "flatRow.title"
    const val TOP_RIGHT = "flatRow.topRight"
    const val DOT = "flatRow.dot"
    const val PROJECT = "flatRow.project"
    const val WORKSPACE = "flatRow.workspace"
    const val DRAFT = "flatRow.draft"
    const val GIT = "flatRow.git"
    const val DIVIDER = "flatRow.divider"
    const val ARCHIVE_ACTION = "flatRow.archiveAction"
}

/** FlatSessionRow.tsx */
object FlatRowSpec {
    val avatar = 60.dp
    /** In home's inset card, a smaller avatar (iOS's `HomeCardLayout.Metrics.sessionAvatar`). */
    val cardAvatar = 40.dp
    val paddingLeft = 16.dp
    val paddingRight = 16.dp
    val paddingVertical = 10.dp
    val avatarGap = 12.dp
    val topRightDot = 20.dp
    val topRightHeight = 22.dp
    val topRightGap = 8.dp
    val workspaceMinHeight = 18.dp
    val workspaceGap = 4.dp
    val metaIcon = 13.dp
    val swipeAction = 112.dp
    val swipeIcon = 20.dp
    const val UNREAD_DOT_CLEAR_GRACE_MS = 350L
    const val AVATAR_FADED = 0.5f
    const val CONTENT_FADED = 0.6f
    val title = happyTextStyle(fontSize = 17, lineHeight = 22, weight = FontWeight.SemiBold)
    val project = happyTextStyle(fontSize = 15, lineHeight = 20)
    val workspace = happyTextStyle(fontSize = 13, lineHeight = 18)
    val swipeText = happyTextStyle(fontSize = 12, weight = FontWeight.SemiBold)
    val gitCount = happyTextStyle(fontSize = 11, weight = FontWeight.SemiBold)

    /**
     * A row in home's card, whatever it says: 10 above and below the taller
     * of the 40 avatar and the three lines (title 22, project 20, 1, the
     * workspace line's 18), each line following the font scale.
     * Nothing a row shows (a workspace or not, a dot, counts) moves it.
     */
    @Composable
    fun cardRowHeight(): Dp =
        paddingVertical * 2 + maxOf(cardAvatar, maxOf(line(title), topRightHeight) + line(project) + 1.dp + cardWorkspaceLine())

    /** The workspace line in a card, held whether or not there is a workspace. */
    @Composable
    fun cardWorkspaceLine(): Dp = maxOf(line(workspace), workspaceMinHeight)

    // Text keeps a line's ratio to its font size, and the nonlinear scale
    // grows a 17 font less than a 22 line's own sp would say.
    @Composable
    private fun line(style: TextStyle): Dp = with(LocalDensity.current) {
        style.fontSize.toDp() * (style.lineHeight.value / style.fontSize.value)
    }
}

/** The flat list paints one colour, rows and page alike: white in light, the page's own black in dark. */
fun flatListBackground(colors: HappyColors): Color = if (colors.dark) colors.grouped.background else Color.White

/** The status colours a row's corner dot uses (#FF9500 blocked, #007AFF results). */
val BlockedDotColor = Color(0xFFFF9500)
val UnreadDotColor = Color(0xFF007AFF)

/** theme.ts gitAddedText / gitRemovedText. */
fun gitAddedColor(colors: HappyColors) = if (colors.dark) Color(0xFF34C759) else Color(0xFF22C55E)
fun gitRemovedColor(colors: HappyColors) = if (colors.dark) Color(0xFFFF453A) else Color(0xFFEF4444)

/**
 * One session in the flat home list: 60 avatar centred in a row padded 16
 * either side and 10 above and below; title 17/22 semibold (shimmering while
 * the agent works) with a 20 dot after it while it waits or is unread (its
 * slot kept, so the title never moves; no time); the project 15/20; the
 * worktree 13/18 with a 13 branch glyph, then the draft glyph and line
 * counts. A hairline runs from the text (x = 88) to the edge. Archived rows,
 * and rows whose machine is gone, keep the geometry and fade: avatar 0.5 and
 * monochrome, text 0.6. Swiping left uncovers a 112 Archive action; a long
 * press opens the session menu.
 *
 * [carded], in home's inset card (iOS's SessionRowCell at a71eea391): a 40
 * avatar, a 10 dot, the card's ground, [FlatRowSpec.cardRowHeight] high, and
 * the card draws the hairline.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun FlatSessionRow(
    row: FlatSessionRowData,
    showBorder: Boolean,
    archived: Boolean,
    callbacks: HomeListCallbacks,
    modifier: Modifier = Modifier,
    archiving: Boolean = false,
    selected: Boolean = false,
    carded: Boolean = false,
) {
    LocalHomeRowObserver.current?.let { observe -> SideEffect { observe(row.session.id) } }
    val session = row.session
    val colors = HappyTheme.colors
    val faded = archived || session.machineOffline

    // The dot outlives the read state by a moment so the transition covers it.
    var showUnreadDot by remember { mutableStateOf(session.hasUnread) }
    LaunchedEffect(session.hasUnread) {
        if (session.hasUnread) {
            showUnreadDot = true
        } else if (showUnreadDot) {
            delay(FlatRowSpec.UNREAD_DOT_CLEAR_GRACE_MS)
            showUnreadDot = false
        }
    }
    val presentation = resolveFlatRowPresentation(session.state, showUnreadDot, faded)
    val name = session.name ?: stringResource(R.string.session_new_chat)
    val avatarSize = if (carded) FlatRowSpec.cardAvatar else FlatRowSpec.avatar
    val ground = when {
        selected -> colors.surfaceSelected
        carded -> colors.surfaceHigh
        else -> flatListBackground(colors)
    }

    // A task's swipe leaves it, where its machine takes that; it never archives.
    SwipeToArchive(
        enabled = !archiving && (!session.task || session.leavesTask),
        onArchive = { callbacks.onArchive(session.id) },
        leave = session.task,
        modifier = if (carded) modifier.fillMaxHeight() else modifier,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .then(if (carded) Modifier.fillMaxHeight() else Modifier)
                .testTag(FlatRowTags.ROW)
                .background(ground)
                .then(if (selected) Modifier.semantics { this.selected = true } else Modifier)
                .sessionPressDown(session.id, callbacks)
                .combinedClickable(
                    onClick = { callbacks.onOpen(session.id) },
                    onLongClick = { callbacks.onMenu(session.id) },
                )
                .padding(
                    start = FlatRowSpec.paddingLeft,
                    end = FlatRowSpec.paddingRight,
                    top = FlatRowSpec.paddingVertical,
                    bottom = FlatRowSpec.paddingVertical,
                ),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .testTag(FlatRowTags.AVATAR)
                    .size(avatarSize)
                    .alpha(if (faded) FlatRowSpec.AVATAR_FADED else 1f),
            ) {
                Avatar(
                    id = session.avatarId,
                    size = avatarSize,
                    bot = session.botId != null,
                    monochrome = faded,
                    flavor = session.flavor,
                    clientId = session.clientId,
                    // A task wears no harness badge (happy-ios TaskAvatarViewTests).
                    badgeLocation = if (session.task) AvatarBadgeLocation.None else AvatarBadgeLocation.SessionList,
                    imageUri = session.avatarUri,
                    thumbhash = session.avatarThumbhash,
                )
            }
            Column(
                modifier = Modifier
                    .padding(start = FlatRowSpec.avatarGap)
                    .weight(1f)
                    .alpha(if (faded) FlatRowSpec.CONTENT_FADED else 1f),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(modifier = Modifier.weight(1f).testTag(FlatRowTags.TITLE)) {
                        val ink = if (faded) colors.textSecondary else colors.text
                        // A carded row's ground is its card's.
                        val ground = when {
                            selected -> colors.surfaceSelected
                            carded -> colors.surfaceHigh
                            else -> flatListBackground(colors)
                        }
                        ShimmerText(
                            text = name,
                            style = FlatRowSpec.title,
                            baseColor = ink,
                            highlightColor = ShimmerSpec.sheen(ink, ground),
                            shimmering = presentation.shimmerTitle,
                            modifier = Modifier.wrapContentHeight(unbounded = carded),
                        )
                    }
                    TopRight(presentation.topRight, session.state, if (carded) HomeCardSpec.dot else FlatRowSpec.topRightDot)
                }
                Text(
                    text = row.projectName,
                    style = FlatRowSpec.project,
                    color = colors.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.testTag(FlatRowTags.PROJECT),
                )
                Row(
                    modifier = Modifier.padding(top = 1.dp).heightIn(min = if (carded) FlatRowSpec.cardWorkspaceLine() else FlatRowSpec.workspaceMinHeight),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(
                        modifier = Modifier.weight(1f),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(FlatRowSpec.workspaceGap),
                    ) {
                        row.workspaceName?.let { workspace ->
                            Text(
                                text = workspace,
                                style = FlatRowSpec.workspace,
                                color = colors.textSecondary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f, fill = false).testTag(FlatRowTags.WORKSPACE),
                            )
                            Icon(Ionicon.GitBranchOutline, size = FlatRowSpec.metaIcon, color = colors.textSecondary)
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (session.hasDraft) {
                            Icon(
                                Ionicon.CreateOutline,
                                size = FlatRowSpec.metaIcon,
                                color = colors.textSecondary,
                                modifier = Modifier.testTag(FlatRowTags.DRAFT),
                            )
                        }
                        GitChanges(session, Modifier.padding(start = 8.dp))
                    }
                }
            }
        }
        if (showBorder && !carded) {
            Box(
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .padding(start = FlatRowSpec.paddingLeft + FlatRowSpec.avatar + FlatRowSpec.avatarGap)
                    .fillMaxWidth()
                    .height(hairline())
                    .testTag(FlatRowTags.DIVIDER)
                    .background(colors.divider),
            )
        }
    }
}

/** The dot while the chat waits on the user (orange) or is unread (blue), in a slot that keeps its width either way. */
@Composable
private fun TopRight(topRight: FlatRowTopRight, state: SessionState, dotSize: Dp) {
    val dot = topRight as? FlatRowTopRight.Dot
    val label = when {
        dot == null -> null
        state == SessionState.InputRequired -> stringResource(R.string.status_input_required)
        state == SessionState.PermissionRequired -> stringResource(R.string.status_permission_required)
        else -> stringResource(R.string.status_unread)
    }
    Box(
        modifier = Modifier
            .padding(start = FlatRowSpec.topRightGap)
            .testTag(FlatRowTags.TOP_RIGHT)
            .width(dotSize)
            .height(FlatRowSpec.topRightHeight)
            .then(if (label != null) Modifier.semantics { contentDescription = label } else Modifier),
        contentAlignment = Alignment.CenterEnd,
    ) {
        if (dot != null) {
            StatusDot(
                color = if (dot.blocked) BlockedDotColor else UnreadDotColor,
                size = dotSize,
                modifier = Modifier.testTag(FlatRowTags.DOT),
            )
        }
    }
}

/** GitLineChanges: ≈ when approximate, +insertions, -deletions, 11 semibold, 4 apart. */
@Composable
fun GitChanges(session: SessionRowData, modifier: Modifier = Modifier) {
    visibleGitChanges(session)?.let { GitChanges(it, modifier) }
}

/** GitLineChanges for counts from anywhere (the list rows, session info). */
@Composable
fun GitChanges(changes: VisibleGitChanges, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    Row(
        modifier = modifier.testTag(FlatRowTags.GIT),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (changes.approximate) Text("≈", style = FlatRowSpec.gitCount.copy(fontWeight = FontWeight.Normal), color = colors.textSecondary)
        if (changes.insertions > 0) Text("+${compactCount(changes.insertions)}", style = FlatRowSpec.gitCount, color = gitAddedColor(colors))
        if (changes.deletions > 0) Text("-${compactCount(changes.deletions)}", style = FlatRowSpec.gitCount, color = gitRemovedColor(colors))
    }
}
