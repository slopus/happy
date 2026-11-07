package com.slopus.happy.ui.connection

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.TeamMembers
import com.slopus.happy.agent.TeamSource
import com.slopus.happy.connection.HappyCloud
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** A Happy Cloud server's members, from its connection's Settings. */
@Serializable data class CloudMembersRoute(val connectionId: String)

/**
 * Who is on the Happy Cloud server [connectionId] is connected to, each with
 * their role as the team names it, and Leave server. Both ask the server
 * itself (members contract, `/v0/members`), so no account pass is needed;
 * the list follows `member.*` and `role.*` events. Leaving, after a
 * confirmation, also forgets the server on this phone; its last owner is
 * told they can't.
 */
@Composable
internal fun CloudMembers(graph: AppGraph, nav: NavHostController, connectionId: String) {
    val connection = graph.agentConnections.accounts.collectAsStateWithLifecycle().value.firstOrNull { it.id == connectionId }
    val origin = connection?.server ?: return
    val handle = HappyCloud.handle(origin) ?: return
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) } ?: return
    val scope = rememberCoroutineScope()
    val source = remember(session, scope) { TeamSource({ TeamMembers.read(session.client) }, session.events, scope) }
    val team by source.team.collectAsStateWithLifecycle()
    var lastOwner by remember { mutableStateOf(false) }
    var leaveFailed by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }
    var leaving by remember { mutableStateOf(false) }
    CloudMembersScreen(
        handle = handle,
        team = team,
        footer = when {
            lastOwner -> stringResource(R.string.cloud_leave_last_owner)
            leaveFailed -> stringResource(R.string.cloud_failed)
            else -> null
        },
        leaving = leaving,
        onRetry = source::retry,
        onLeave = { confirming = true },
        onBack = { nav.popBackStack() },
    )
    if (confirming) {
        HappyAlert(
            Alert(
                title = stringResource(R.string.cloud_leave_confirm_title, handle),
                message = stringResource(R.string.cloud_leave_confirm_message),
                buttons = listOf(
                    AlertButton(stringResource(R.string.common_cancel)),
                    AlertButton(stringResource(R.string.cloud_leave), destructive = true) {
                        leaving = true
                        lastOwner = false
                        leaveFailed = false
                        scope.launch {
                            try {
                                TeamMembers.leave(session.client)
                                removeAgentConnection(graph, connectionId)
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: AgentApiException) {
                                if (TeamMembers.lastOwner(e)) lastOwner = true else leaveFailed = true
                            } catch (_: Exception) {
                                leaveFailed = true
                            } finally {
                                leaving = false
                            }
                        }
                    },
                ),
            ),
            onDismiss = { confirming = false },
        )
    }
}

/** [CloudMembers]' page: the members, or a retry when they couldn't be read, then Leave server with [footer] under it. */
@Composable
internal fun CloudMembersScreen(
    handle: String,
    team: TeamSource.State,
    footer: String?,
    leaving: Boolean,
    onRetry: () -> Unit,
    onLeave: () -> Unit,
    onBack: () -> Unit,
) {
    Screen(header = { StackHeader(stringResource(R.string.cloud_members), onBack) }) {
        ItemList {
            // No group title: titles are upper-cased, and a handle must read as typed.
            ItemGroup {
                when (team) {
                    TeamSource.State.Loading -> Item(title = handle, loading = true, showChevron = false)
                    TeamSource.State.Failed -> Item(
                        title = stringResource(R.string.cloud_failed),
                        subtitle = stringResource(R.string.team_server_try_again),
                        onClick = onRetry,
                        showChevron = false,
                    )
                    is TeamSource.State.Loaded -> team.team.members.forEach { member ->
                        Item(
                            title = member.name?.takeIf { it.isNotBlank() } ?: member.accountId,
                            detail = team.team.roleName(member.role) ?: builtInRoleName(member.role),
                            showChevron = false,
                            modifier = Modifier.testTag(CloudTags.member(member.accountId)),
                        )
                    }
                }
            }
            ItemGroup(footer = footer) {
                Item(
                    title = stringResource(R.string.cloud_leave),
                    destructive = true,
                    enabled = !leaving,
                    loading = leaving,
                    showChevron = false,
                    onClick = onLeave,
                    modifier = Modifier.testTag(CloudTags.LEAVE),
                )
            }
        }
    }
}

/** A built-in role's name in the app's language, for a team that didn't list its roles; any other role reads as its id. */
@Composable
private fun builtInRoleName(role: String): String = when (role) {
    "owner" -> stringResource(R.string.cloud_role_owner)
    "admin" -> stringResource(R.string.cloud_role_admin)
    "member" -> stringResource(R.string.cloud_role_member)
    "viewer" -> stringResource(R.string.cloud_role_viewer)
    else -> role
}
