package com.slopus.happy.ui.connection

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.agent.MemberProfile
import com.slopus.happy.agent.MemberProfileSource
import com.slopus.happy.agent.MemberProfileTask
import com.slopus.happy.agent.MemberProfiles
import com.slopus.happy.agent.TeamMembers
import com.slopus.happy.agent.TeamRole
import com.slopus.happy.connection.HappyCloud
import com.slopus.happy.conversation.DetailFormat
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.ProfileHeader
import com.slopus.happy.ui.components.ProfileHeaderSpec
import com.slopus.happy.ui.components.ProfileTile
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.barInsetTop
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.components.profileStartedText
import com.slopus.happy.ui.conversation.openConversation
import com.slopus.happy.ui.layout.ContentTokens
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable

/** Member [userId] of the Happy Cloud server [connectionId] is connected to. */
@Serializable data class MemberProfileRoute(val connectionId: String, val userId: String)

object MemberProfileTags {
    const val SCREEN = "memberProfile.screen"
    const val TILES = "memberProfile.tiles"
    const val TOKENS = "memberProfile.tokens"
    const val TASKS = "memberProfile.tasks"
    const val EMPTY = "memberProfile.empty"
    const val RETRY = "memberProfile.retry"
    fun task(id: String) = "memberProfile.task.$id"
}

/** The agent page's measures (AgentPageSpec), which this page shares. */
object MemberProfileSpec {
    val side = ContentTokens.inset
    val radius = 26.dp
    val cardGap = 24.dp
    val headingInset = 16.dp
    val headingGap = 8.dp
    val heading = happyTextStyle(fontSize = 13, lineHeight = 18)
    val bottom = 40.dp
}

/**
 * Member [userId]'s profile (cluster profile contract,
 * `GET /v0/users/:id/profile`), only on a Happy Cloud server: read as it
 * opens, the team's role names beside it (`GET /v0/roles`, a nicety). A
 * recent task opens its conversation.
 */
@Composable
internal fun MemberProfileEntry(graph: AppGraph, nav: NavHostController, route: MemberProfileRoute) {
    val connection = graph.agentConnections.accounts.collectAsStateWithLifecycle().value.firstOrNull { it.id == route.connectionId }
    if (!HappyCloud.isServer(connection?.server)) return
    val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) } ?: return
    val scope = rememberCoroutineScope()
    val source = remember(session, route.userId, scope) { MemberProfileSource({ MemberProfiles.read(session.client, route.userId) }, scope) }
    val state by source.profile.collectAsStateWithLifecycle()
    val roles by produceState(emptyList<TeamRole>(), session) {
        value = try {
            TeamMembers.roles(session.client)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyList()
        }
    }
    CompositionLocalProvider(LocalAgentPictures provides session.pictures) {
        MemberProfileScreen(
            state = state,
            roles = roles,
            onOpenTask = { agentId -> nav.openConversation(route.connectionId, agentId) },
            onRetry = source::retry,
            onBack = { nav.popBackStack() },
        )
    }
}

/**
 * A member's profile, laid out as the agent page is (iOS ProfileHeaderLayout):
 * their round 88 picture over its ThumbHash, or the placeholder their ID
 * picks, centred; their name (28/34) and, under it, their job title and
 * team role; then Usage's tiles (tasks, active tasks, active days of the
 * last 30, last active), Tokens' tiles (the past hour, day, week and
 * month, every provider and model summed), and Recent activity, their
 * latest tasks newest first, each opening its conversation. While it is
 * read the header and tiles shimmer in place.
 */
@Composable
fun MemberProfileScreen(
    state: MemberProfileSource.State,
    roles: List<TeamRole>,
    onOpenTask: (agentId: String) -> Unit,
    onRetry: () -> Unit,
    onBack: () -> Unit,
    now: Long = System.currentTimeMillis(),
) {
    val scroll = rememberScrollState()
    val density = LocalDensity.current
    val profile = (state as? MemberProfileSource.State.Loaded)?.profile
    val name = profile?.user?.name?.ifBlank { null }
    val nameTop = with(density) { (ProfileHeaderSpec.top + ProfileHeaderSpec.mark + ProfileHeaderSpec.nameGap).toPx() }
    val nameHeight = with(density) { ProfileHeaderSpec.name.lineHeight.toPx() }
    Screen(
        header = {
            StackHeader(
                title = name.orEmpty(),
                onBack = onBack,
                titleAlpha = { ((scroll.value - nameTop) / nameHeight).coerceIn(0f, 1f) },
            )
        },
        modifier = Modifier.testTag(MemberProfileTags.SCREEN),
    ) {
        when (state) {
            MemberProfileSource.State.Unknown -> Text(
                stringResource(R.string.member_profile_unknown),
                style = happyTextStyle(fontSize = 17, lineHeight = 22),
                color = HappyTheme.colors.textSecondary,
                textAlign = TextAlign.Center,
                modifier = Modifier.align(Alignment.Center).padding(32.dp),
            )
            MemberProfileSource.State.Failed -> ItemList {
                ItemGroup {
                    Item(
                        title = stringResource(R.string.cloud_failed),
                        subtitle = stringResource(R.string.team_server_try_again),
                        onClick = onRetry,
                        showChevron = false,
                        modifier = Modifier.testTag(MemberProfileTags.RETRY),
                    )
                }
            }
            else -> Column(Modifier.fillMaxSize().verticalScroll(scroll)) {
                Spacer(Modifier.height(barInsetTop()))
                Column(Modifier.contentMaxWidth(LocalWindowLayout.current)) {
                    Page(profile, roles, onOpenTask, now)
                }
            }
        }
    }
}

@Composable
private fun Page(profile: MemberProfile?, roles: List<TeamRole>, onOpenTask: (String) -> Unit, now: Long) {
    val user = profile?.user
    val teamRole = user?.teamRole?.let { id -> roles.firstOrNull { it.id == id }?.name ?: builtInRoleName(id) }
    ProfileHeader(user?.name?.ifBlank { null } ?: user?.id, listOfNotNull(user?.role, teamRole).joinToString(" · ")) {
        val photo = user?.photo
        when {
            user == null -> Box(Modifier.size(ProfileHeaderSpec.mark).clip(CircleShape).background(HappyTheme.colors.surfaceHighest))
            else -> PersonMark(user.id, photo, ProfileHeaderSpec.mark)
        }
    }
    Spacer(Modifier.height(ProfileHeaderSpec.tilesTop))
    Section(stringResource(R.string.member_profile_usage)) {
        Tiles(
            MemberProfileTags.TILES,
            listOf(
                profile?.totalTasks?.toString() to stringResource(R.string.member_profile_tasks),
                profile?.activeTasks?.toString() to stringResource(R.string.member_profile_active_tasks),
                profile?.activeDays?.toString() to stringResource(R.string.member_profile_active_days),
                (profile?.let { it.lastActivityAt?.let { at -> profileStartedText(at, now) } ?: stringResource(R.string.agent_page_none) }) to
                    stringResource(R.string.member_profile_last_active),
            ),
        )
    }
    Section(stringResource(R.string.member_profile_tokens)) {
        val labels = listOf(
            R.string.member_profile_window_hour,
            R.string.member_profile_window_day,
            R.string.member_profile_window_week,
            R.string.member_profile_window_month,
        )
        Tiles(
            MemberProfileTags.TOKENS,
            MemberProfile.WINDOWS.zip(labels).map { (window, label) ->
                profile?.let { DetailFormat.tokens(it.usage[window]?.tokens ?: 0) } to stringResource(label)
            },
        )
    }
    if (profile != null) {
        Section(stringResource(R.string.member_profile_recent)) {
            Card(MemberProfileTags.TASKS) {
                if (profile.recentTasks.isEmpty()) {
                    Text(
                        stringResource(R.string.member_profile_no_tasks),
                        style = AgentHomeSpec.title,
                        color = HappyTheme.colors.textSecondary,
                        modifier = Modifier.padding(horizontal = AgentHomeSpec.markInset, vertical = 15.dp).testTag(MemberProfileTags.EMPTY),
                    )
                }
                profile.recentTasks.forEachIndexed { index, task -> TaskRow(task, index == profile.recentTasks.lastIndex, now, onOpenTask) }
            }
        }
    }
    Spacer(Modifier.height(MemberProfileSpec.bottom - MemberProfileSpec.cardGap))
}

/** Two tiles to a row, 10 apart; a value not read yet shimmers. */
@Composable
private fun Tiles(tag: String, tiles: List<Pair<String?, String>>) {
    Column(
        Modifier.padding(horizontal = MemberProfileSpec.side).fillMaxWidth().testTag(tag),
        verticalArrangement = Arrangement.spacedBy(ProfileHeaderSpec.tileGap),
    ) {
        tiles.chunked(2).forEach { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(ProfileHeaderSpec.tileGap)) {
                pair.forEach { (value, label) -> ProfileTile(value, label, Modifier.weight(1f)) }
            }
        }
    }
}

/** A section's heading (13/18 capitals, 16 in) over its [content], 24 before the next. */
@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Text(
        title.uppercase(),
        style = MemberProfileSpec.heading,
        color = HappyTheme.colors.textSecondary,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .padding(horizontal = MemberProfileSpec.side + MemberProfileSpec.headingInset)
            .semantics { heading() },
    )
    Spacer(Modifier.height(MemberProfileSpec.headingGap))
    content()
    Spacer(Modifier.height(MemberProfileSpec.cardGap))
}

@Composable
private fun Card(tag: String, content: @Composable () -> Unit) {
    Column(
        Modifier
            .padding(horizontal = MemberProfileSpec.side)
            .fillMaxWidth()
            .testTag(tag)
            .clip(RoundedCornerShape(MemberProfileSpec.radius))
            .background(HappyTheme.colors.surface),
    ) { content() }
}

/** A task as home lists it, its seed's face and name, with when it was last at work (or that it works now) under; a tap opens it. */
@Composable
private fun TaskRow(task: MemberProfileTask, last: Boolean, now: Long, onOpen: (String) -> Unit) {
    val colors = HappyTheme.colors
    val row = remember(task) { AgentFeedRow.Conversation(task.agentId, task.name, ConversationKind.Task, 0, seed = task.id, working = task.working, activityAt = task.activityAt) }
    val detail = when {
        task.archived -> stringResource(R.string.member_profile_archived)
        task.working -> stringResource(R.string.conversation_status_working)
        task.activityAt > 0 -> profileStartedText(task.activityAt, now)
        else -> null
    }
    Box(
        Modifier
            .fillMaxWidth()
            .height(if (detail == null) AgentHomeSpec.rowHeight() else AgentHomeSpec.detailRowHeight())
            .testTag(MemberProfileTags.task(task.id))
            .clickable(role = Role.Button) { onOpen(task.agentId) },
    ) {
        Row(
            Modifier.fillMaxSize().padding(start = AgentHomeSpec.markInset, end = AgentHomeSpec.paddingEnd),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(AgentHomeSpec.mark)) { ConversationMark(row, AgentHomeSpec.mark) }
            Column(Modifier.padding(start = AgentHomeSpec.markGap).weight(1f)) {
                Text(task.name.ifBlank { stringResource(R.string.session_new_chat) }, style = AgentHomeSpec.title, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (detail != null) Text(detail, style = AgentHomeSpec.detail, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (!last) {
            Box(
                Modifier
                    .align(Alignment.BottomStart)
                    .padding(start = AgentHomeSpec.markInset + AgentHomeSpec.mark + AgentHomeSpec.markGap)
                    .fillMaxWidth()
                    .height(hairline())
                    .background(colors.divider),
            )
        }
    }
}
