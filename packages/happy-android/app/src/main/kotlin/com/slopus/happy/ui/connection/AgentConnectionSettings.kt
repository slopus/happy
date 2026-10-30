package com.slopus.happy.ui.connection

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
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
import com.slopus.happy.ui.connect.LocalAddFlow
import com.slopus.happy.ui.conversation.openChiefOfStaff
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.home.rememberAccountMenu
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
        AgentConnectionSettings(graph, nav, entry.toRoute<AgentConnectionSettingsRoute>().connectionId, onAppearance = onAppearance)
    }
}

object AgentSettingsTags {
    const val BAR = "agentSettings.bar"
    const val STATUS = "agentSettings.status"
    const val EDIT_NAME = "agentSettings.editName"
    const val EDIT_AVATAR = "agentSettings.editAvatar"
    const val CONNECT = "agentSettings.connect"
    const val APPEARANCE = "agentSettings.appearance"
    const val REMOVE = "agentSettings.remove"
    fun account(id: String) = "agentSettings.account.$id"
}

/** Everything an agent connection's settings ask of the app. */
@Immutable
class AgentSettingsActions(
    val onBack: () -> Unit,
    val onAppearance: () -> Unit,
    /** Forgets this connection; asked for only after the person confirmed. */
    val onRemove: () -> Unit,
    /** Opens the Happy account or agent connection [id]. */
    val onSwitchAccount: (id: String) -> Unit,
    /** Scans a code and adds what it is for: Add's own routing, a pasted link where there's no camera. */
    val onConnectAgent: () -> Unit,
    /** Opens this connection's Chief of Staff with [prefix] typed, unsent. */
    val onAskChief: (prefix: String) -> Unit,
)

/**
 * An agent connection's settings. Who you are on this agent (its profile:
 * name and photo, changed by asking its Chief of Staff, nothing sent until
 * you send it) and how its link stands; every account on the phone, the
 * open one checked, a tap opening another, and Connect Agent; Appearance;
 * and Remove connection, after a confirm. A device token can't reach the
 * agent's device list (API.md, "Credentials on the connector's socket"),
 * so removing forgets the agent here only; the footer says so.
 */
@Composable
fun AgentConnectionSettingsScreen(
    name: String,
    connectionId: String,
    thumbhash: String?,
    status: AgentLinkStatus,
    accounts: AccountMenu,
    actions: AgentSettingsActions,
) {
    val colors = HappyTheme.colors
    var confirming by remember { mutableStateOf(false) }
    val namePrefix = stringResource(R.string.agent_settings_edit_name_prefix)
    val avatarPrefix = stringResource(R.string.agent_settings_edit_avatar_prefix)
    // The bar on the page's own grey (black in dark), the groups on it: one surface, as the chat's details.
    Screen(
        header = {
            AgentTopBar(
                tag = AgentSettingsTags.BAR,
                container = colors.grouped.background,
                navigationIcon = { BarIconButton(Ionicon.ArrowBack, stringResource(R.string.common_back), actions.onBack) },
                title = { Text(stringResource(R.string.settings_title), style = MaterialTheme.typography.titleLarge, maxLines = 1) },
            )
        },
    ) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            ItemGroup(footer = stringResource(R.string.agent_settings_profile_footer)) {
                Item(
                    title = name,
                    subtitle = statusText(status),
                    icon = { Avatar(connectionId, 48.dp, thumbhash = thumbhash) },
                    showChevron = false,
                    modifier = Modifier.testTag(AgentSettingsTags.STATUS),
                )
                Item(
                    title = stringResource(R.string.agent_settings_edit_name),
                    icon = { Icon(Ionicon.Pencil, 24.dp, colors.text) },
                    onClick = { actions.onAskChief(namePrefix) },
                    modifier = Modifier.testTag(AgentSettingsTags.EDIT_NAME),
                )
                Item(
                    title = stringResource(R.string.agent_settings_edit_avatar),
                    icon = { Icon(Ionicon.ImageOutline, 24.dp, colors.text) },
                    onClick = { actions.onAskChief(avatarPrefix) },
                    modifier = Modifier.testTag(AgentSettingsTags.EDIT_AVATAR),
                )
            }
            ItemGroup(title = stringResource(R.string.account_menu_title)) {
                for (entry in accounts.entries) AccountRow(entry, actions.onSwitchAccount)
                Item(
                    title = stringResource(R.string.agent_settings_connect),
                    icon = { Icon(Ionicon.QrCodeOutline, 24.dp, colors.text) },
                    showChevron = false,
                    onClick = actions.onConnectAgent,
                    modifier = Modifier.testTag(AgentSettingsTags.CONNECT),
                )
            }
            ItemGroup {
                Item(
                    title = stringResource(R.string.settings_appearance),
                    icon = { Icon(Ionicon.ColorPaletteOutline, 24.dp, colors.text) },
                    onClick = actions.onAppearance,
                    modifier = Modifier.testTag(AgentSettingsTags.APPEARANCE),
                )
            }
            ItemGroup(footer = stringResource(R.string.agent_settings_remove_footer)) {
                Item(
                    title = stringResource(R.string.agent_settings_remove),
                    icon = { Icon(Ionicon.TrashOutline, 24.dp, colors.textDestructive) },
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
                    AlertButton(stringResource(R.string.agent_settings_remove), destructive = true, onClick = actions.onRemove),
                ),
            ),
            onDismiss = { confirming = false },
        )
    }
}

@Composable
private fun statusText(status: AgentLinkStatus): String = stringResource(
    when (status) {
        AgentLinkStatus.Connected -> R.string.agent_settings_connected
        AgentLinkStatus.Connecting -> R.string.agent_settings_connecting
        AgentLinkStatus.Offline -> R.string.agent_settings_offline
        AgentLinkStatus.Revoked -> R.string.agent_settings_revoked
        AgentLinkStatus.UpdateRequired -> R.string.agent_settings_update
    },
)

/** One account on the phone: its picture and name, a check on the open one; a tap opens another. */
@Composable
private fun AccountRow(entry: AccountMenuEntry, onSwitch: (String) -> Unit) {
    val colors = HappyTheme.colors
    val name = entry.name ?: stringResource(if (entry.agent) R.string.account_menu_unnamed_agent else R.string.account_menu_unnamed_account)
    Item(
        title = name,
        subtitle = entry.detail ?: if (entry.agent) stringResource(R.string.account_menu_agent) else null,
        icon = { Avatar(entry.id, 32.dp, imageUri = entry.imageUrl, thumbhash = entry.thumbhash) },
        rightElement = when {
            entry.active -> { { Icon(Ionicon.Checkmark, 22.dp, colors.text) } }
            entry.attention -> { { Icon(Ionicon.AlertCircleOutline, 22.dp, colors.textDestructive) } }
            else -> null
        },
        showChevron = false,
        onClick = { if (!entry.active) onSwitch(entry.id) },
        modifier = Modifier.testTag(AgentSettingsTags.account(entry.id)).semantics { selected = entry.active },
    )
}

@Composable
private fun AgentConnectionSettings(graph: AppGraph, nav: NavHostController, connectionId: String, onAppearance: () -> Unit) {
    val agents by graph.agentConnections.accounts.collectAsStateWithLifecycle()
    val agent = agents.firstOrNull { it.id == connectionId } ?: return
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) }
    val status = session?.status?.collectAsStateWithLifecycle()?.value ?: AgentLinkStatus.Offline
    val scope = rememberCoroutineScope()
    val add = LocalAddFlow.current
    val actions = remember(graph, nav, connectionId, onAppearance, add) {
        AgentSettingsActions(
            onBack = { nav.popBackStack() },
            onAppearance = onAppearance,
            onSwitchAccount = { graph.open(it) },
            onConnectAgent = { add?.scan() },
            onAskChief = { prefix -> nav.openChiefOfStaff(connectionId, prefix) },
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
    AgentConnectionSettingsScreen(
        name = agent.name,
        connectionId = connectionId,
        thumbhash = agent.thumbhash,
        status = status,
        accounts = rememberAccountMenu(graph),
        actions = actions,
    )
}
