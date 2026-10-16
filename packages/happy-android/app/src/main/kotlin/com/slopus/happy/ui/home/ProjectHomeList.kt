package com.slopus.happy.ui.home

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.expand
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.FlatRowTopRight
import com.slopus.happy.model.ProjectHomeEntry
import com.slopus.happy.model.ProjectHomeRow
import com.slopus.happy.model.ProjectHomeSection
import com.slopus.happy.model.ProjectWorktree
import com.slopus.happy.model.SessionRowData
import com.slopus.happy.model.VisibleGitChanges
import com.slopus.happy.model.WorkspaceOrigin
import com.slopus.happy.model.WorktreeToggle
import com.slopus.happy.model.compactCount
import com.slopus.happy.model.projectGitChanges
import com.slopus.happy.model.resolveFlatRowPresentation
import com.slopus.happy.model.workspaceOrigin
import com.slopus.happy.ui.chat.light
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.ShimmerText
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object ProjectListTags {
    const val SECTION = "projectList.section"
    const val MACHINE = "projectList.machine"
    const val PROJECT = "projectList.project"
    const val PROJECT_ADD = "projectList.projectAdd"
    const val WORKTREE = "projectList.worktree"
    const val TOGGLE = "projectList.toggle"
    const val CHAT = "projectList.chat"
    const val TREE_STEM = "projectList.treeStem"
    const val TREE_TRUNK = "projectList.treeTrunk"
}

/** ProjectHomeList.tsx */
object ProjectListSpec {
    val rowPaddingX = 16.dp
    val avatar = 28.dp
    val avatarGap = 12.dp
    val projectRow = 52.dp
    val projectRowTop = 8.dp
    val worktreeRow = 48.dp
    val botRow = 48.dp
    val trailingGap = 8.dp
    val statusDot = 7.dp
    val chatDot = 10.dp
    val addButtonWidth = 28.dp
    val addButtonHeight = 32.dp
    val section = happyTextStyle(fontSize = 11, lineHeight = 14, letterSpacing = 0.6f, weight = FontWeight.SemiBold)
    val machine = happyTextStyle(fontSize = 11, lineHeight = 14)
    val projectName = happyTextStyle(fontSize = 17, lineHeight = 22)
    val worktreeName = happyTextStyle(fontSize = 16, lineHeight = 21)
    val toggle = happyTextStyle(fontSize = 15, lineHeight = 20)
    val timestamp = happyTextStyle(fontSize = 13, lineHeight = 18)
    val gitCount = happyTextStyle(fontSize = 13, lineHeight = 18, weight = FontWeight.SemiBold)
    val gitApproximate = happyTextStyle(fontSize = 11, lineHeight = 18)
    const val ARCHIVED_ALPHA = 0.6f
}

/** StyleSheet.hairlineWidth * 2: the tree lines. */
@Composable
private fun treeLine(): Dp = with(LocalDensity.current) { 2f.toDp() }

/**
 * One row of the project hierarchy: under each computer its bots and
 * projects; a project card (28 avatar, 52 high) with its worktrees hanging
 * off a tree line (48 high), then the toggle that shows them all or fewer;
 * the archive tail drawn the way the flat list draws it.
 */
@Composable
fun ProjectHomeRowContent(row: ProjectHomeRow, callbacks: HomeListCallbacks) {
    when (row) {
        is ProjectHomeRow.Section -> SectionRow(stringResource(if (row.section == ProjectHomeSection.Bots) R.string.sidebar_bots else R.string.sidebar_projects))
        is ProjectHomeRow.MachineHeader -> MachineHeaderRow(row.machineId, row.machineName, callbacks)
        is ProjectHomeRow.Bot -> ChatRow(row.session, bot = true, archived = false, callbacks)
        is ProjectHomeRow.ProjectCard -> ProjectCardRow(row.project, callbacks)
        is ProjectHomeRow.Worktree -> WorktreeRow(row.worktree, row.last, callbacks)
        is ProjectHomeRow.Toggle -> WorktreeToggleRow(row.toggle, callbacks)
        is ProjectHomeRow.ArchiveToggle -> ArchiveToggleRow(row.hidden, banded = false, callbacks)
        is ProjectHomeRow.ArchiveHeader -> SectionRow(dayTitleText(row.title))
        is ProjectHomeRow.Archived -> ChatRow(row.session, bot = false, archived = true, callbacks)
    }
}

@Composable
private fun SectionRow(label: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(ProjectListTags.SECTION)
            .padding(start = ProjectListSpec.rowPaddingX, end = 12.dp, top = 18.dp, bottom = 6.dp),
    ) {
        Text(text = label.uppercase(), style = ProjectListSpec.section, color = HappyTheme.colors.grouped.sectionTitle)
    }
}

/** The computer everything below runs on: desktop glyph (12), its name (11), a line to the edge. */
@Composable
private fun MachineHeaderRow(machineId: String?, machineName: String, callbacks: HomeListCallbacks) {
    val colors = HappyTheme.colors
    val name = if (machineId == null) "<${stringResource(R.string.status_unknown)}>" else machineName
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(ProjectListTags.MACHINE)
            .then(if (machineId != null) Modifier.clickable(role = Role.Button) { callbacks.onOpenMachine(machineId) } else Modifier)
            .padding(start = ProjectListSpec.rowPaddingX, end = ProjectListSpec.rowPaddingX, top = 14.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(Ionicon.DesktopOutline, size = 12.dp, color = colors.textSecondary)
        Text(
            text = name,
            style = ProjectListSpec.machine,
            color = colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 220.dp),
        )
        Box(Modifier.weight(1f).height(treeLine()).background(colors.textSecondary))
    }
}

/** The avatar lane every row shares: 28 wide, 12 before the name, full row height. */
@Composable
private fun RowScope.AvatarLane(content: @Composable BoxScope.() -> Unit) {
    Box(
        modifier = Modifier.padding(end = ProjectListSpec.avatarGap).width(ProjectListSpec.avatar).fillMaxHeight(),
        contentAlignment = Alignment.Center,
        content = content,
    )
}

@Composable
private fun RowScope.RowName(text: String, working: Boolean, style: TextStyle) {
    val colors = HappyTheme.colors
    Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
        if (working) {
            ShimmerText(text = text, style = style, baseColor = colors.textSecondary, highlightColor = colors.text)
        } else {
            Text(text = text, style = style, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Blocked: a pulsing orange 7 dot; else unread: a blue 7 dot. */
@Composable
private fun AttentionDot(blocked: Boolean, unread: Boolean) {
    when {
        blocked -> StatusDot(color = BlockedDotColor, pulsing = true, size = ProjectListSpec.statusDot)
        unread -> Box(Modifier.size(ProjectListSpec.statusDot).clip(CircleShape).background(UnreadDotColor))
    }
}

@Composable
private fun ProjectGitChanges(session: SessionRowData?) {
    val changes: VisibleGitChanges = session?.let(::projectGitChanges) ?: return
    val colors = HappyTheme.colors
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        if (changes.approximate) Text("≈", style = ProjectListSpec.gitApproximate, color = colors.textSecondary)
        if (changes.insertions > 0) Text("+${compactCount(changes.insertions)}", style = ProjectListSpec.gitCount, color = gitAddedColor(colors))
        if (changes.deletions > 0) Text("-${compactCount(changes.deletions)}", style = ProjectListSpec.gitCount, color = gitRemovedColor(colors))
    }
}

/**
 * A project's card: it goes by the project's name and opens the project's
 * own checkout. The trailing `+` (and a long press) creates a workspace in
 * it; a stem drops from the avatar to the first worktree.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ProjectCardRow(project: ProjectHomeEntry, callbacks: HomeListCallbacks) {
    LocalHomeRowObserver.current?.let { observe -> SideEffect { observe(project.id) } }
    val colors = HappyTheme.colors
    val session = project.session
    val origin: WorkspaceOrigin? = (session ?: project.avatarSession)?.let(::workspaceOrigin)
    val stem = treeLine()
    Row(
        modifier = Modifier
            .padding(top = ProjectListSpec.projectRowTop)
            .fillMaxWidth()
            .height(ProjectListSpec.projectRow)
            .testTag(ProjectListTags.PROJECT)
            .sessionPressDown(session?.id, callbacks)
            .combinedClickable(
                enabled = session != null || origin != null,
                role = Role.Button,
                onClick = { session?.let { callbacks.onOpen(it.id) } },
                onLongClick = origin?.let { { callbacks.onProjectMenu(project.name, it) } },
            )
            .padding(horizontal = ProjectListSpec.rowPaddingX),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AvatarLane {
            project.avatarSession?.let {
                Avatar(id = it.avatarId, size = ProjectListSpec.avatar, imageUri = it.projectAvatarUri, thumbhash = it.projectAvatarThumbhash)
            }
            if (project.worktreeCount > 0) {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .testTag(ProjectListTags.TREE_STEM)
                        .width(stem)
                        .height((ProjectListSpec.projectRow - ProjectListSpec.avatar) / 2)
                        .background(colors.textSecondary),
                )
            }
        }
        RowName(project.name, project.working, ProjectListSpec.projectName)
        Row(
            modifier = Modifier.padding(start = ProjectListSpec.trailingGap),
            horizontalArrangement = Arrangement.spacedBy(ProjectListSpec.trailingGap),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AttentionDot(project.blocked, project.unread)
            ProjectGitChanges(session)
            if (origin != null) {
                Box(
                    modifier = Modifier
                        .size(ProjectListSpec.addButtonWidth, ProjectListSpec.addButtonHeight)
                        .testTag(ProjectListTags.PROJECT_ADD)
                        .clickable(role = Role.Button) { callbacks.onCreateWorkspace(origin) },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Ionicon.Add, size = 18.dp, color = colors.textSecondary, contentDescription = stringResource(R.string.home_create_workspace_in, project.name))
                }
            }
        }
    }
}

/** The tree for a row under a card: the trunk down the avatar lane (stopping at the elbow on the last), the elbow to the name. */
@Composable
private fun BoxScope.TreeBranch(last: Boolean) {
    val colors = HappyTheme.colors
    val line = treeLine()
    Box(
        modifier = Modifier
            .align(Alignment.TopCenter)
            .testTag(ProjectListTags.TREE_TRUNK)
            .width(line)
            .then(if (last) Modifier.height(ProjectListSpec.worktreeRow / 2) else Modifier.fillMaxHeight())
            .background(colors.textSecondary),
    )
    Box(
        modifier = Modifier
            .align(Alignment.CenterStart)
            .offset(x = ProjectListSpec.avatar / 2)
            .width(ProjectListSpec.avatar / 2)
            .height(line)
            .background(colors.textSecondary),
    )
}

/** One worktree, hanging off its project's tree line; opens the chat worked on most recently. */
@Composable
private fun WorktreeRow(worktree: ProjectWorktree, last: Boolean, callbacks: HomeListCallbacks) {
    LocalHomeRowObserver.current?.let { observe -> SideEffect { observe(worktree.id) } }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(ProjectListSpec.worktreeRow)
            .testTag(ProjectListTags.WORKTREE)
            .sessionPressDown(worktree.session.id, callbacks)
            .clickable(role = Role.Button) { callbacks.onOpen(worktree.session.id) }
            .padding(horizontal = ProjectListSpec.rowPaddingX),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AvatarLane { TreeBranch(last) }
        RowName(worktree.workspaceName ?: worktree.projectName, worktree.working, ProjectListSpec.worktreeName)
        Row(
            modifier = Modifier.padding(start = ProjectListSpec.trailingGap),
            horizontalArrangement = Arrangement.spacedBy(ProjectListSpec.trailingGap),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AttentionDot(worktree.blocked, worktree.unread)
            ProjectGitChanges(worktree.session)
        }
    }
}

/** Ends a project's worktrees: "Show all N workspaces" or "Show fewer", speaking for the held-back ones. */
@Composable
private fun WorktreeToggleRow(toggle: WorktreeToggle, callbacks: HomeListCallbacks) {
    val colors = HappyTheme.colors
    val label = if (toggle.expanded) stringResource(R.string.sidebar_show_fewer_workspaces)
    else stringResource(R.string.sidebar_show_all_workspaces, toggle.worktreeCount)
    val haptics = LocalHapticFeedback.current
    // ProjectHomeList.tsx's toggle: a light tick, then the list changes.
    val flip = {
        haptics.light()
        callbacks.onToggleProject(toggle.projectId)
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(ProjectListSpec.worktreeRow)
            .testTag(ProjectListTags.TOGGLE)
            .clickable(role = Role.Button, onClick = flip)
            .semantics {
                // accessibilityState={{ expanded }}
                if (toggle.expanded) collapse { flip(); true }
                else expand { flip(); true }
            }
            .padding(horizontal = ProjectListSpec.rowPaddingX),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AvatarLane { TreeBranch(last = true) }
        Row(modifier = Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            Icon(if (toggle.expanded) Ionicon.ChevronUp else Ionicon.ChevronDown, size = 13.dp, color = colors.textSecondary)
            Text(text = label, style = ProjectListSpec.toggle, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Box(modifier = Modifier.padding(start = ProjectListSpec.trailingGap)) {
            AttentionDot(toggle.blocked, toggle.unread)
        }
    }
}

/** A bot, or an archived chat: avatar, name, then the timestamp or a 10 dot. Archived rows are faded to 0.6. */
@Composable
private fun ChatRow(session: SessionRowData, bot: Boolean, archived: Boolean, callbacks: HomeListCallbacks) {
    LocalHomeRowObserver.current?.let { observe -> SideEffect { observe(session.id) } }
    val colors = HappyTheme.colors
    val presentation = resolveFlatRowPresentation(session.state, session.hasUnread, archived || session.machineOffline)
    val dot = presentation.topRight as? FlatRowTopRight.Dot
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(ProjectListSpec.botRow)
            .alpha(if (archived) ProjectListSpec.ARCHIVED_ALPHA else 1f)
            .testTag(ProjectListTags.CHAT)
            .sessionPressDown(session.id, callbacks)
            .clickable(role = Role.Button) { callbacks.onOpen(session.id) }
            .padding(horizontal = ProjectListSpec.rowPaddingX),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AvatarLane { Avatar(id = session.avatarId, size = ProjectListSpec.avatar, bot = bot, imageUri = session.avatarUri, thumbhash = session.avatarThumbhash) }
        RowName(session.name ?: stringResource(R.string.session_new_chat), presentation.shimmerTitle, ProjectListSpec.projectName)
        Box(modifier = Modifier.padding(start = ProjectListSpec.trailingGap)) {
            if (dot != null) {
                StatusDot(color = if (dot.blocked) BlockedDotColor else UnreadDotColor, size = ProjectListSpec.chatDot)
            } else {
                Text(text = formatSessionListTimestamp(session.lastActivityAt), style = ProjectListSpec.timestamp, color = colors.textSecondary, maxLines = 1)
            }
        }
    }
}
