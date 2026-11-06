package com.slopus.happy.ui.connection

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import com.slopus.happy.connection.CloudAccount
import com.slopus.happy.connection.CloudAccountState
import com.slopus.happy.connection.CloudException
import com.slopus.happy.connection.CloudMember
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
 * their role, and Leave server. Both ask the accounts service with the
 * account's pass: signed out (or its hour up), the page offers the sign-in
 * instead and reads once it is back. Leaving, after a confirmation, also
 * forgets the server on this phone; its only owner is told they can't.
 */
@Composable
internal fun CloudMembers(graph: AppGraph, account: CloudAccount, nav: NavHostController, connectionId: String) {
    val connection = graph.agentConnections.accounts.collectAsStateWithLifecycle().value.firstOrNull { it.id == connectionId }
    val origin = connection?.server ?: return
    val handle = HappyCloud.handle(origin) ?: return
    val state by account.state.collectAsStateWithLifecycle()
    var serverId by remember { mutableStateOf<String?>(null) }
    var members by remember { mutableStateOf<List<CloudMember>?>(null) }
    var failure by remember { mutableStateOf<CloudException.Reason?>(null) }
    var confirming by remember { mutableStateOf(false) }
    var leaving by remember { mutableStateOf(false) }
    var reloads by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(state, reloads) {
        if (!account.signedIn()) return@LaunchedEffect
        failure = null
        try {
            val id = serverId ?: account.serverAt(origin).id.also { serverId = it }
            members = account.members(id)
        } catch (e: CloudException) {
            failure = e.reason
        }
    }
    Screen(header = { StackHeader(stringResource(R.string.cloud_members), { nav.popBackStack() }) }) {
        ItemList {
            if (state != CloudAccountState.SignedIn) {
                ItemGroup {
                    Item(title = stringResource(R.string.cloud_members_sign_in), onClick = { nav.navigate(CloudRoute) { launchSingleTop = true } })
                }
                return@ItemList
            }
            // No group title: titles are upper-cased, and a handle must read as typed.
            ItemGroup(footer = failure?.takeIf { it == CloudException.Reason.LastOwner }?.let { stringResource(cloudFailureText(it)) }) {
                val list = members
                when {
                    failure != null && failure != CloudException.Reason.LastOwner -> Item(
                        title = stringResource(cloudFailureText(failure!!)),
                        subtitle = stringResource(R.string.team_server_try_again),
                        onClick = { reloads++ },
                        showChevron = false,
                    )
                    list == null -> Item(title = handle, loading = true, showChevron = false)
                    else -> list.forEach { member ->
                        Item(
                            title = member.name?.takeIf { it.isNotBlank() } ?: member.accountId,
                            detail = stringResource(if (member.owner) R.string.cloud_role_owner else R.string.cloud_role_member),
                            showChevron = false,
                        )
                    }
                }
            }
            ItemGroup {
                Item(
                    title = stringResource(R.string.cloud_leave),
                    destructive = true,
                    enabled = serverId != null && !leaving,
                    loading = leaving,
                    showChevron = false,
                    onClick = { confirming = true },
                    modifier = Modifier.testTag(CloudTags.LEAVE),
                )
            }
        }
    }
    if (confirming) {
        HappyAlert(
            Alert(
                title = stringResource(R.string.cloud_leave_confirm_title, handle),
                message = stringResource(R.string.cloud_leave_confirm_message),
                buttons = listOf(
                    AlertButton(stringResource(R.string.common_cancel)),
                    AlertButton(stringResource(R.string.cloud_leave), destructive = true) {
                        val id = serverId ?: return@AlertButton
                        leaving = true
                        scope.launch {
                            try {
                                account.leave(id)
                                removeAgentConnection(graph, connectionId)
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: CloudException) {
                                failure = e.reason
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
