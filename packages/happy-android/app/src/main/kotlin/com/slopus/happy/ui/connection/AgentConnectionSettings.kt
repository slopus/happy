package com.slopus.happy.ui.connection

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

/** An agent connection's settings. */
@Serializable data class AgentConnectionSettingsRoute(val connectionId: String)

/** The agent connection screens beside home. HappyApp's NavHost calls this once. */
fun NavGraphBuilder.agentHomeRoutes(graph: AppGraph, nav: NavHostController, onAppearance: () -> Unit) {
    composable<AgentConnectionSettingsRoute> { entry ->
        AgentConnectionSettings(graph, entry.toRoute<AgentConnectionSettingsRoute>().connectionId, onBack = { nav.popBackStack() }, onAppearance = onAppearance)
    }
}

object AgentSettingsTags {
    const val STATUS = "agentSettings.status"
    const val APPEARANCE = "agentSettings.appearance"
    const val REMOVE = "agentSettings.remove"
}

/**
 * What iOS's settings show for an agent connection that this app has: the
 * agent's name and picture with how its link stands, Appearance, and
 * Remove connection. A device token can't reach the agent's device list
 * (API.md, "Credentials on the connector's socket"), so removing forgets
 * the agent here only; the footer says so.
 */
@Composable
fun AgentConnectionSettingsScreen(
    name: String,
    connectionId: String,
    thumbhash: String?,
    status: AgentLinkStatus,
    onBack: () -> Unit,
    onAppearance: () -> Unit,
    onRemove: () -> Unit,
) {
    val colors = HappyTheme.colors
    var confirming by remember { mutableStateOf(false) }
    Screen(header = { StackHeader(title = stringResource(R.string.settings_title), onBack = onBack) }) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            ItemGroup {
                Item(
                    title = name,
                    subtitle = stringResource(R.string.account_menu_agent),
                    icon = { Avatar(connectionId, 40.dp, thumbhash = thumbhash) },
                    showChevron = false,
                )
                Item(
                    title = stringResource(R.string.agent_settings_status),
                    detail = stringResource(
                        when (status) {
                            AgentLinkStatus.Connected -> R.string.agent_settings_connected
                            AgentLinkStatus.Connecting -> R.string.agent_settings_connecting
                            AgentLinkStatus.Offline -> R.string.agent_settings_offline
                            AgentLinkStatus.Revoked -> R.string.agent_settings_revoked
                            AgentLinkStatus.UpdateRequired -> R.string.agent_settings_update
                        },
                    ),
                    icon = { Icon(Ionicon.LaptopOutline, 28.dp, colors.text) },
                    showChevron = false,
                    modifier = Modifier.testTag(AgentSettingsTags.STATUS),
                )
            }
            ItemGroup {
                Item(
                    title = stringResource(R.string.settings_appearance),
                    icon = { Icon(Ionicon.ColorPaletteOutline, 28.dp, colors.text) },
                    onClick = onAppearance,
                    modifier = Modifier.testTag(AgentSettingsTags.APPEARANCE),
                )
            }
            ItemGroup(footer = stringResource(R.string.agent_settings_remove_footer)) {
                Item(
                    title = stringResource(R.string.agent_settings_remove),
                    icon = { Icon(Ionicon.TrashOutline, 28.dp, colors.textDestructive) },
                    destructive = true,
                    showChevron = false,
                    onClick = { confirming = true },
                    modifier = Modifier.testTag(AgentSettingsTags.REMOVE),
                )
            }
        }
    }
    if (confirming) {
        HappyAlert(
            Alert(
                title = stringResource(R.string.agent_settings_remove_title, name),
                message = stringResource(R.string.agent_settings_remove_message),
                buttons = listOf(
                    AlertButton(stringResource(R.string.common_cancel)),
                    AlertButton(stringResource(R.string.agent_settings_remove), destructive = true, onClick = onRemove),
                ),
            ),
            onDismiss = { confirming = false },
        )
    }
}

@Composable
private fun AgentConnectionSettings(graph: AppGraph, connectionId: String, onBack: () -> Unit, onAppearance: () -> Unit) {
    val agents by graph.agentConnections.accounts.collectAsStateWithLifecycle()
    val agent = agents.firstOrNull { it.id == connectionId } ?: return
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) }
    val status = session?.status?.collectAsStateWithLifecycle()?.value ?: AgentLinkStatus.Offline
    val scope = rememberCoroutineScope()
    AgentConnectionSettingsScreen(
        name = agent.name,
        connectionId = connectionId,
        thumbhash = agent.thumbhash,
        status = status,
        onBack = onBack,
        onAppearance = onAppearance,
        onRemove = {
            scope.launch {
                // The next account opens: a Happy account first, else another agent; none, the first screen.
                val next = graph.accountStore.registry.value.ordered.firstOrNull()?.id
                    ?: graph.agentConnections.accounts.value.filter { it.id != connectionId }.minByOrNull { it.addedAt }?.id
                graph.agentConnections.remove(connectionId)
                if (next != null) {
                    graph.open(next)
                } else {
                    withContext(Dispatchers.IO) { graph.accountStore.select(null) }
                    graph.auth.reload()
                }
            }
        },
    )
}
