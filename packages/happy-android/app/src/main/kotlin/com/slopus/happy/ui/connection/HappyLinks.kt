package com.slopus.happy.ui.connection

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.res.stringResource
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.HappyLink
import com.slopus.happy.agent.HappyReferenceKind
import com.slopus.happy.agent.HappyUrls
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.connection.AgentConnection
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.artifacts.ArtifactRoute
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.connect.DeepLink
import com.slopus.happy.ui.connect.DeepLinks
import com.slopus.happy.ui.conversation.openConversation
import com.slopus.happy.ui.files.openWorkspaceFile

/**
 * Opens Happy URLs (edge SSO contract §7) in one account's back stack.
 * An external link, `happy://<instanceId>/…`, opens only on the
 * connection whose installation that is, switching to it first, and never
 * on another: one no connection matches says so. An internal link means
 * the connection it was shown in.
 */
@Stable
class HappyLinks internal constructor(
    private val graph: AppGraph,
    private val nav: NavHostController,
    /** The agent connection whose stack this is, if one is open. */
    private val openConnection: String?,
    /** Opens a web page outside the app: a settings link's page in Happy Cloud's web app. */
    private val openWeb: (String) -> Unit = {},
) {
    /** "Not connected" is up. */
    var unknownServer by mutableStateOf(false)
        internal set

    /** A link [DeepLinks] handed over: an external one, or one waiting for its connection to open. */
    fun take(link: DeepLink) {
        when (link) {
            is DeepLink.Instance -> open(link.instanceId, link.link)
            is DeepLink.OnConnection -> go(link.connectionId, link.link)
            else -> Unit
        }
    }

    /**
     * [url] tapped in [connectionId]'s screens. True when it was a Happy
     * URL, opened or not (a malformed one opens nothing); false for any
     * other address, which is the caller's.
     */
    fun open(url: String, connectionId: String): Boolean {
        if (!HappyUrls.owns(url)) return false
        val parsed = HappyUrls.parse(url) ?: return true
        val instanceId = parsed.instanceId
        if (instanceId == null) go(connectionId, parsed.link) else open(instanceId, parsed.link)
        return true
    }

    /**
     * Whether [url], shown in [connectionId]'s screens, opens anything: false
     * for one that isn't a Happy URL or is malformed, and for a settings page
     * the phone has nowhere for on the connection it names.
     */
    fun opens(url: String, connectionId: String): Boolean {
        val parsed = HappyUrls.parse(url) ?: return false
        val settings = parsed.link as? HappyLink.Settings ?: return true
        val instanceId = parsed.instanceId
        val id = if (instanceId == null) connectionId else connectionFor(graph.agentConnections.accounts.value, instanceId, openConnection) ?: return true
        return SettingsLinks.place(graph, id, settings.page) != null
    }

    private fun open(instanceId: String, link: HappyLink) {
        val id = connectionFor(graph.agentConnections.accounts.value, instanceId, openConnection)
        when (id) {
            null -> unknownServer = true
            openConnection -> go(id, link)
            else -> {
                // Its own back stack takes it once the connection is open.
                DeepLinks.offer(DeepLink.OnConnection(id, link))
                graph.open(id)
            }
        }
    }

    private fun go(connectionId: String, link: HappyLink) {
        if (link is HappyLink.Settings) nav.openSettingsLink(graph, connectionId, link.page, openWeb, link.query) else nav.openHappyLink(connectionId, link)
    }

    companion object {
        /** The connection an external link for [instanceId] opens on: the open one if it is that installation, else the first that is; null if none. */
        fun connectionFor(connections: List<AgentConnection>, instanceId: String, open: String?): String? {
            val matches = connections.filter { it.instanceId == instanceId }
            return (matches.firstOrNull { it.id == open } ?: matches.firstOrNull())?.id
        }
    }
}

/** This stack's [HappyLinks]; null outside an account's stack. */
val LocalHappyLinks = staticCompositionLocalOf<HappyLinks?> { null }

/** [HappyLinks] for [nav], the stack of [openConnection], and its "not connected" alert while it is up. */
@Composable
fun rememberHappyLinks(graph: AppGraph, nav: NavHostController, openConnection: String?): HappyLinks {
    val context = androidx.compose.ui.platform.LocalContext.current
    val dark by androidx.compose.runtime.rememberUpdatedState(com.slopus.happy.ui.theme.HappyTheme.colors.dark)
    val links = remember(graph, nav, openConnection, context) {
        HappyLinks(graph, nav, openConnection) { url -> com.slopus.happy.ui.browser.openCustomTab(context, url, dark) }
    }
    if (links.unknownServer) {
        HappyAlert(
            Alert(
                title = stringResource(R.string.happy_link_unknown_title),
                message = stringResource(R.string.happy_link_unknown_server),
                buttons = listOf(AlertButton(stringResource(R.string.common_ok))),
            ),
        ) { links.unknownServer = false }
    }
    return links
}

/**
 * [link] on [connectionId]: an artifact, a conversation, a Surface,
 * a workspace's file at its line. What the phone has no screen for
 * (a workspace, project, service or person) opens the connection's home.
 */
fun NavHostController.openHappyLink(connectionId: String, link: HappyLink) {
    when (link) {
        is HappyLink.Reference -> when (link.kind) {
            HappyReferenceKind.Artifact -> navigate(
                ArtifactRoute(connectionId, link.id, version = link.version ?: 1, followsLatest = link.version == null, pinned = link.version != null),
            )
            HappyReferenceKind.Agent -> openConversation(connectionId, link.id)
            HappyReferenceKind.Surface -> navigate(com.slopus.happy.ui.surfaces.SurfaceRoute(connectionId, link.id))
            else -> popBackStack(HomeRoute, inclusive = false)
        }
        // Settings need the app's graph: HappyLinks opens them (openSettingsLink).
        is HappyLink.Settings -> Unit
        // The file itself, in the viewer at its first line (unit files' entry).
        is HappyLink.File -> when (val target = link.target) {
            is HappyLink.Target.Agent -> openWorkspaceFile(connectionId, link.path, agentId = target.agentId, line = link.lines?.first)
            is HappyLink.Target.Workspace -> openWorkspaceFile(connectionId, link.path, workspaceId = target.workspaceId, line = link.lines?.first)
        }
    }
}
