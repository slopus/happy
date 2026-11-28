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
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.connection.LocalAgentPictures
import com.slopus.happy.ui.page
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.genui.GenUiPluginReports
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** A connection's plugins, home's Plugins row. */
@Serializable data class PluginsRoute(val connectionId: String)

/**
 * One plugin of a connection, by its catalog key ([com.slopus.happy.plugins.Plugin.key]).
 * [report] is a Gen UI tap's setup report ([GenUiPluginReports]): while
 * this page is on the stack, an active installation it reads sends it.
 */
@Serializable data class PluginRoute(val connectionId: String, val pluginKey: String, val report: String? = null)

/** One installation of a plugin: its setup, sign-ins and removal. */
@Serializable data class PluginInstallationRoute(val connectionId: String, val installationId: String)

/**
 * Opens plugin [pluginId] of [connectionId] over whatever screen is up: a
 * Gen UI `plugin` action (with its setup [report], if any), a settings
 * link. On a Happy Cloud server the ID is the catalog key.
 */
fun NavHostController.openPlugin(connectionId: String, pluginId: String, report: String? = null) {
    navigate(PluginRoute(connectionId, pluginId, report))
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
        PluginPage(plugins(route.connectionId), nav, route.connectionId, route.pluginKey, route.report)
    }
    page<PluginInstallationRoute> { entry ->
        val route = entry.toRoute<PluginInstallationRoute>()
        InstallationPage(plugins(route.connectionId), nav, route.installationId)
    }
}

/**
 * A page's plugins and the pictures they wear; [source] null where the
 * connection is gone. [noteFeature] tells the connection a feature plugin
 * was installed or uninstalled here, so its feature shows or hides at once.
 */
class PagePlugins(val source: PluginsSource?, val pictures: AgentPictures?, val noteFeature: (id: String, available: Boolean) -> Unit = { _, _ -> })

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
    return PagePlugins(holder.source, session?.pictures) { id, available -> session?.features?.note(id, available) }
}

/**
 * A Gen UI tap's setup [report], for as long as the page it opened is on
 * the stack (an installation's page over it included): each read of the
 * plugins goes to [GenUiPluginReports.seen], which sends it once one of
 * the plugin's installations is active.
 */
internal class PluginReportWatch(state: StateFlow<PluginsState>, report: String) : ViewModel() {
    init {
        viewModelScope.launch {
            state.collect { (it as? PluginsState.Loaded)?.let { loaded -> GenUiPluginReports.seen(report, loaded.snapshot.installations) } }
        }
    }
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
private fun PluginPage(plugins: PagePlugins, nav: NavHostController, connectionId: String, pluginKey: String, report: String?) {
    val source = plugins.source ?: return PluginScreen(PluginsState.Unsupported, pluginKey, { nav.popBackStack() }, {})
    RefreshOnResume(source)
    if (report != null) viewModel { PluginReportWatch(source.state, report) }
    val state by source.state.collectAsStateWithLifecycle()
    val acts = remember { PluginActs() }
    val scope = rememberCoroutineScope()
    val manage = (state as? PluginsState.Loaded)?.snapshot?.canManage == true
    var uninstalling by remember { mutableStateOf<com.slopus.happy.plugins.Plugin?>(null) }
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
                    // A feature plugin's has nothing to set up, sign in to or name.
                    onClick = if (manage && !installation.feature) ({ nav.navigate(PluginInstallationRoute(connectionId, installation.id)) }) else null,
                    showChevron = manage && !installation.feature,
                    modifier = Modifier.testTag(PluginsTags.installation(installation.id)),
                )
            },
            actions = { plugin, snapshot ->
                PluginInstallActions(plugin, snapshot, acts, onUninstall = { uninstalling = plugin }) {
                    scope.launch {
                        var id: String? = null
                        val installed = acts.run(PluginActionTags.INSTALL) { id = source.write { install(plugin) } }
                        if (installed && plugin.feature) plugins.noteFeature(plugin.id, true)
                        // A plugin that does nothing until it signs in opens its installation, where that is done.
                        if (installed && plugin.authRequired) {
                            id?.let { nav.navigate(PluginInstallationRoute(connectionId, it)) }
                        }
                    }
                }
            },
        )
    }
    uninstalling?.let { plugin ->
        HappyAlert(
            uninstallAlert(plugin) {
                val installation = (state as? PluginsState.Loaded)?.snapshot?.installationsOf(plugin.key)?.firstOrNull()?.id ?: plugin.id
                scope.launch {
                    if (acts.run(PluginActionTags.UNINSTALL) { source.write { remove(installation) } }) plugins.noteFeature(plugin.id, false)
                }
            },
            onDismiss = { uninstalling = null },
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
