package com.slopus.happy.ui.connection

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.AgentSharingState
import com.slopus.happy.agent.AutoJoinKind
import com.slopus.happy.ui.components.HappySwitch
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ProvideRowReveal
import com.slopus.happy.ui.components.revealRow
import kotlinx.serialization.Serializable

/** An agent connection's Notifications (it was Sharing); [reveal] as on settings. */
@Serializable data class AgentSharingRoute(val connectionId: String, val reveal: String? = null)

object AgentSharingTags {
    /** Settings' one Notifications row, on every agent connection ([CloudPushTags.ROW] is the same row). */
    const val ROW = "agentSettings.sharing"
    fun toggle(kind: AutoJoinKind) = "sharing.${kind.name}"
    /** A join switch's row, as search reveals it. */
    fun row(kind: AutoJoinKind) = "sharing.${kind.name}.row"
}

/**
 * Agent connection [connectionId]'s Notifications, whichever route opened
 * it: on a Happy Cloud server its push settings first ([CloudPushGroups]),
 * then on every connection the join switches; [reveal] scrolls one of their
 * rows into view and flashes it.
 */
@Composable
internal fun AgentNotificationsPage(graph: AppGraph, nav: NavHostController, connectionId: String, reveal: String? = null) {
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) }
    val state = session?.sharing?.collectAsStateWithLifecycle()?.value ?: AgentSharingState.Loading
    val cloud = session?.client?.cloud == true
    ProvideRowReveal(reveal) {
        AgentNotificationsScreen(
            sharing = state,
            onAutoJoin = { kind, enabled -> session?.setAutoJoin(kind, enabled) },
            onBack = { nav.popBackStack() },
            push = if (cloud) ({ CloudPushPanel(graph, connectionId) }) else null,
        )
    }
}

/** A local agent's Notifications: the join switches alone. */
@Composable
fun AgentSharingScreen(state: AgentSharingState, onAutoJoin: (AutoJoinKind, Boolean) -> Unit, onBack: () -> Unit) {
    AgentNotificationsScreen(state, onAutoJoin, onBack)
}

/**
 * Notifications, Steve's "Sharing is notifications": [push] first where the
 * connection is a Happy Cloud server (its switch, the device's permission,
 * enabling it here, with their footer), then joining other people's tasks
 * and docs, lists and calendars, with theirs. One page, one row in Settings.
 */
@Composable
fun AgentNotificationsScreen(
    sharing: AgentSharingState?,
    onAutoJoin: (AutoJoinKind, Boolean) -> Unit,
    onBack: () -> Unit,
    push: (@Composable () -> Unit)? = null,
) {
    AgentPage(stringResource(R.string.cloud_push_title), onBack, listModifier = Modifier.testTag(CloudPushTags.LIST)) {
        push?.invoke()
        when (sharing) {
            null -> Unit
            AgentSharingState.Loading -> ItemGroup { Item(stringResource(R.string.common_loading), loading = true) }
            AgentSharingState.Unsupported -> ItemGroup {
                Item(stringResource(R.string.sharing_unsupported), titleLines = 0)
            }
            is AgentSharingState.Ready -> {
                ItemGroup(footer = stringResource(R.string.sharing_footer)) {
                    AutoJoinRow(AutoJoinKind.Tasks, sharing.tasks, onAutoJoin)
                    sharing.surfaces?.let { AutoJoinRow(AutoJoinKind.Surfaces, it, onAutoJoin) }
                }
                if (sharing.surfaces == null) ItemGroup {
                    Item(stringResource(R.string.sharing_update), titleLines = 0)
                }
            }
        }
    }
}

@Composable
private fun AutoJoinRow(kind: AutoJoinKind, enabled: Boolean, onAutoJoin: (AutoJoinKind, Boolean) -> Unit) {
    val title = stringResource(if (kind == AutoJoinKind.Tasks) R.string.sharing_tasks else R.string.sharing_surfaces)
    Item(
        title = title,
        titleLines = 0,
        showChevron = false,
        modifier = Modifier.revealRow(AgentSharingTags.row(kind)),
        rightElement = {
            HappySwitch(enabled, { onAutoJoin(kind, it) }, Modifier.testTag(AgentSharingTags.toggle(kind)), label = title)
        },
    )
}
