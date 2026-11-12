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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.model.settings.PushPermissionStatus
import com.slopus.happy.push.CloudPushApi
import com.slopus.happy.push.CloudPushPreferences
import com.slopus.happy.push.rememberNotificationPermission
import com.slopus.happy.push.requestOrOpenSettings
import com.slopus.happy.ui.components.HappySwitch
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.revealRow
import com.slopus.happy.ui.page
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

@Serializable data class CloudPushSettingsRoute(val connectionId: String)

object CloudPushTags {
    /** Settings' one Notifications row: the same row as [AgentSharingTags.ROW], since Sharing is notifications. */
    const val ROW = AgentSharingTags.ROW
    const val SWITCH = "cloudPush.enabled"
    /** The server's switch row, as search reveals it. */
    const val SERVER = "cloudPush.server"
    const val DEVICE = "cloudPush.device"
    const val LIST = "cloudPush.list"
}

/** The push page's old route opens the one Notifications page ([AgentNotificationsPage]). */
internal fun NavGraphBuilder.cloudPushSettingsRoutes(graph: AppGraph, nav: NavHostController) {
    page<CloudPushSettingsRoute> { entry -> AgentNotificationsPage(graph, nav, entry.toRoute<CloudPushSettingsRoute>().connectionId) }
}

/**
 * A Happy Cloud server's push settings on its Notifications page: read
 * whenever the page shows, with the device's permission asked from here.
 */
@Composable
internal fun CloudPushPanel(graph: AppGraph, connectionId: String) {
    val client = remember(connectionId) { graph.agentSessions.session(connectionId)?.client?.takeIf { it.cloud } }
    val source = remember(client) { client?.let { CloudPushPreferences(CloudPushApi(it)) } }
    val state = source?.state?.collectAsStateWithLifecycle()?.value ?: CloudPushPreferences.State.Failed
    val permission = rememberNotificationPermission()
    var permissionInfo by remember { mutableStateOf(permission.info()) }
    var asking by remember { mutableStateOf(false) }
    var permissionFailed by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(source, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            permissionInfo = permission.info()
            source?.refresh()
        }
    }
    CloudPushGroups(state, permissionInfo.granted, asking, permissionFailed,
        onChange = { enabled -> scope.launch { source?.set(enabled) } },
        onRetry = { scope.launch { source?.refresh() } },
        onAllow = {
            if (!asking) {
                asking = true
                permissionFailed = false
                scope.launch {
                    try {
                        permissionInfo = permission.requestOrOpenSettings().permission
                        if (permissionInfo.granted) graph.cloudPush.refresh()
                    } catch (e: CancellationException) { throw e }
                    catch (_: Exception) { permissionFailed = true }
                    finally { asking = false }
                }
            }
        },
        permissionStatus = permissionInfo.status,
    )
}

/** The push settings alone on the Notifications page, as a Cloud server's page shows them over the join switches. */
@Composable
internal fun CloudPushSettingsScreen(
    state: CloudPushPreferences.State,
    granted: Boolean,
    asking: Boolean,
    permissionFailed: Boolean,
    onChange: (Boolean) -> Unit,
    onRetry: () -> Unit,
    onAllow: () -> Unit,
    onBack: () -> Unit,
    permissionStatus: PushPermissionStatus = if (granted) PushPermissionStatus.Granted else PushPermissionStatus.Denied,
) {
    AgentNotificationsScreen(sharing = null, onAutoJoin = { _, _ -> }, onBack = onBack, push = {
        CloudPushGroups(state, granted, asking, permissionFailed, onChange, onRetry, onAllow, permissionStatus)
    })
}

/** "Notifications from this server" with its footer, then the device's permission and enabling it here; at least 48 dp row targets. */
@Composable
internal fun CloudPushGroups(
    state: CloudPushPreferences.State,
    granted: Boolean,
    asking: Boolean,
    permissionFailed: Boolean,
    onChange: (Boolean) -> Unit,
    onRetry: () -> Unit,
    onAllow: () -> Unit,
    permissionStatus: PushPermissionStatus = if (granted) PushPermissionStatus.Granted else PushPermissionStatus.Denied,
) {
    when (state) {
        CloudPushPreferences.State.Loading -> ItemGroup { Item(stringResource(R.string.cloud_push_server), loading = true, showChevron = false) }
        CloudPushPreferences.State.Failed -> ItemGroup {
            Item(stringResource(R.string.push_load_failed), subtitle = stringResource(R.string.team_server_try_again), onClick = onRetry, showChevron = false)
        }
        is CloudPushPreferences.State.Loaded -> ItemGroup(footer = stringResource(R.string.cloud_push_footer)) {
            val title = stringResource(R.string.cloud_push_server)
            Item(title, titleLines = 0, modifier = Modifier.revealRow(CloudPushTags.SERVER), rightElement = {
                HappySwitch(state.value.enabled, onChange, enabled = !state.saving, label = title, modifier = Modifier.testTag(CloudPushTags.SWITCH))
            }, showChevron = false)
        }
    }
    ItemGroup {
        val label = when (permissionStatus) {
            PushPermissionStatus.Granted -> R.string.push_label_allowed
            PushPermissionStatus.Denied -> R.string.push_label_denied
            PushPermissionStatus.Undetermined -> R.string.push_label_not_requested
            PushPermissionStatus.Unsupported -> R.string.push_label_unavailable
        }
        Item(stringResource(R.string.cloud_push_permission), detail = stringResource(label), showChevron = false)
        if (!granted && permissionStatus != PushPermissionStatus.Unsupported) Item(stringResource(R.string.cloud_push_device), onClick = onAllow, enabled = !asking, loading = asking, showChevron = false, modifier = Modifier.testTag(CloudPushTags.DEVICE))
        if (permissionFailed) Item(stringResource(R.string.push_request_failed), showChevron = false)
    }
}
