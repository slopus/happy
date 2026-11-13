package com.slopus.happy.ui.plugins

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.agent.AgentPictures
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.agent.Permission
import com.slopus.happy.plugins.ClusterPlugins
import com.slopus.happy.plugins.InstallationStatus
import com.slopus.happy.plugins.PluginConnection
import com.slopus.happy.plugins.PluginsSource
import com.slopus.happy.plugins.PluginsState
import com.slopus.happy.ui.browser.openCustomTab
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.connection.LocalAgentPictures
import com.slopus.happy.ui.page
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** A connection's plugins, home's Plugins row. */
@Serializable data class PluginsRoute(val connectionId: String)

/** One plugin of a connection, by its catalog key ([com.slopus.happy.plugins.Plugin.key]). */
@Serializable data class PluginRoute(val connectionId: String, val pluginKey: String)

/** One installation of a plugin: its setup, sign-ins and removal. */
@Serializable data class PluginInstallationRoute(val connectionId: String, val installationId: String)

/**
 * Opens plugin [pluginId] of [connectionId] over whatever screen is up: a
 * Gen UI `plugin` action, a settings link. On a Happy Cloud server the ID is
 * the catalog key.
 */
fun NavHostController.openPlugin(connectionId: String, pluginId: String) {
    navigate(PluginRoute(connectionId, pluginId))
}

fun NavGraphBuilder.pluginRoutes(graph: AppGraph, nav: NavHostController) = pluginRoutes(nav) { connectionId -> rememberPlugins(graph, connectionId) }

/** The plugin pages, each reading its connection's plugins through [plugins] (a debug fixture passes its own). */
fun NavGraphBuilder.pluginRoutes(nav: NavHostController, plugins: @Composable (connectionId: String) -> PagePlugins) {
    page<PluginsRoute> { entry ->
        val connectionId = entry.toRoute<PluginsRoute>().connectionId
        PluginsPage(plugins(connectionId), nav, connectionId)
    }
    page<PluginRoute> { entry ->
        val route = entry.toRoute<PluginRoute>()
        PluginPage(plugins(route.connectionId), nav, route.connectionId, route.pluginKey)
    }
    page<PluginInstallationRoute> { entry ->
        val route = entry.toRoute<PluginInstallationRoute>()
        InstallationPage(plugins(route.connectionId), nav, route.installationId)
    }
}

/** A page's plugins and the pictures they wear; [source] null where the connection is gone. */
class PagePlugins(val source: PluginsSource?, val pictures: AgentPictures?)

/** One page's view of the connection's plugins, for as long as the page is on the stack. */
internal class PluginsHolder(session: AgentSession?) : ViewModel() {
    val source: PluginsSource? = session?.let {
        PluginsSource(ClusterPlugins(it.client) { it.permissions.value.allows(Permission.MCP_MANAGE) }, it.events, viewModelScope)
    }
}

@Composable
private fun rememberPlugins(graph: AppGraph, connectionId: String): PagePlugins {
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) }
    val holder = viewModel { PluginsHolder(session) }
    return PagePlugins(holder.source, session?.pictures)
}

/** Back from a sign-in in the browser, the server has finished it. */
@Composable
private fun RefreshOnResume(source: PluginsSource) {
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { source.refresh() }
}

@Composable
private fun PluginsPage(plugins: PagePlugins, nav: NavHostController, connectionId: String) {
    val source = plugins.source ?: return PluginsScreen(PluginsState.Unsupported, {}, {}, { nav.popBackStack() })
    RefreshOnResume(source)
    val state by source.state.collectAsStateWithLifecycle()
    CompositionLocalProvider(LocalAgentPictures provides plugins.pictures) {
        PluginsScreen(state, onOpen = { nav.openPlugin(connectionId, it) }, onRetry = source::refresh, onBack = { nav.popBackStack() })
    }
}

@Composable
private fun PluginPage(plugins: PagePlugins, nav: NavHostController, connectionId: String, pluginKey: String) {
    val source = plugins.source ?: return PluginScreen(PluginsState.Unsupported, pluginKey, { nav.popBackStack() }, {})
    RefreshOnResume(source)
    val state by source.state.collectAsStateWithLifecycle()
    val acts = remember { PluginActs() }
    val scope = rememberCoroutineScope()
    val manage = (state as? PluginsState.Loaded)?.snapshot?.canManage == true
    CompositionLocalProvider(LocalAgentPictures provides plugins.pictures) {
        PluginScreen(
            state,
            pluginKey,
            onBack = { nav.popBackStack() },
            onRetry = source::refresh,
            installationRow = { installation ->
                Item(
                    title = installationTitle(installation),
                    subtitle = statusWords(installation),
                    subtitleColor = statusColor(installation),
                    onClick = if (manage) ({ nav.navigate(PluginInstallationRoute(connectionId, installation.id)) }) else null,
                    showChevron = manage,
                    modifier = Modifier.testTag(PluginsTags.installation(installation.id)),
                )
            },
            actions = { plugin, snapshot ->
                PluginInstallActions(plugin, snapshot, acts) {
                    scope.launch {
                        var id: String? = null
                        // A plugin that does nothing until it signs in opens its installation, where that is done.
                        if (acts.run(PluginActionTags.INSTALL) { id = source.write { install(plugin) } } && plugin.authRequired) {
                            id?.let { nav.navigate(PluginInstallationRoute(connectionId, it)) }
                        }
                    }
                }
            },
        )
    }
    RefusalAlert(acts)
}

@Composable
private fun InstallationPage(plugins: PagePlugins, nav: NavHostController, installationId: String) {
    val source = plugins.source ?: return
    RefreshOnResume(source)
    val state by source.state.collectAsStateWithLifecycle()
    val acts = remember { PluginActs() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val dark = HappyTheme.colors.dark
    var signingIn by rememberSaveable { mutableStateOf(false) }
    // The accounts it signed in to, read again as the installation changes.
    val installation = (state as? PluginsState.Loaded)?.snapshot?.installations?.firstOrNull { it.id == installationId }
    val connections by produceState(emptyList<PluginConnection>(), installation) {
        value = try {
            if (installation?.status == InstallationStatus.Active) source.connections(installationId) else emptyList()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            value
        }
    }
    LaunchedEffect(installation?.status) { if (installation?.status == InstallationStatus.Active) signingIn = false }
    CompositionLocalProvider(LocalAgentPictures provides plugins.pictures) {
        PluginInstallationScreen(
            state = state,
            installationId = installationId,
            connections = connections,
            acts = acts,
            signingIn = signingIn,
            onConnect = { _, method ->
                scope.launch {
                    var url: String? = null
                    if (acts.run(PluginActionTags.method(method.id)) { url = source.write { connect(installationId, method.id) } }) {
                        url?.let { openCustomTab(context, it, dark) }
                        signingIn = true
                    }
                }
            },
            onConfigure = { _, method, values ->
                scope.launch { acts.run(PluginActionTags.method(method.id)) { source.write { configure(installationId, method.id, values) } } }
            },
            onDisconnect = { _, connection ->
                scope.launch { acts.run(PluginActionTags.DISCONNECT) { source.write { disconnect(installationId, connection?.id) } } }
            },
            onRemove = { _ ->
                scope.launch { if (acts.run(PluginActionTags.REMOVE) { source.write { remove(installationId) } }) nav.popBackStack() }
            },
            onBack = { nav.popBackStack() },
        )
    }
}
