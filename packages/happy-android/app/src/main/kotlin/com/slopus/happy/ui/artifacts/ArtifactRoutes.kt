package com.slopus.happy.ui.artifacts

import com.slopus.happy.ui.page
import android.content.res.Resources
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.agent.HappyLink
import com.slopus.happy.agent.HappyReferenceKind
import com.slopus.happy.agent.HappyUrls
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.artifacts.ArtifactRef
import com.slopus.happy.browser.BrowserPolicy
import com.slopus.happy.browser.BrowserProxy
import com.slopus.happy.browser.browserWorkspace
import com.slopus.happy.ui.browser.BrowserPage
import com.slopus.happy.ui.browser.BrowserScreen
import com.slopus.happy.ui.browser.openOutside
import com.slopus.happy.ui.connection.LocalHappyLinks
import kotlinx.coroutines.flow.filter
import kotlinx.serialization.Serializable

/** The agent's artifacts, home's Artifacts row. */
@Serializable data class AgentArtifactsRoute(val connectionId: String)

/**
 * One artifact of an agent connection, as something named it
 * ([ArtifactRef]); or, with [path], one file of version [openedVersion]
 * that a link in another of its files opened.
 */
@Serializable data class ArtifactRoute(
    val connectionId: String,
    val artifactId: String,
    val version: Int = 1,
    val type: String = "",
    val title: String = "",
    val followsLatest: Boolean = true,
    val pinned: Boolean = false,
    val openedVersion: Int? = null,
    val path: String? = null,
) {
    val ref: ArtifactRef get() = ArtifactRef(artifactId, version, type, title, followsLatest, pinned)
}

/** A web page in the in-app browser, through the computer of [connectionId]; [agentId]'s workspace when given. */
@Serializable data class BrowserRoute(val connectionId: String, val url: String, val agentId: String? = null)

/** Opens [ref] over whatever screen is up. */
fun NavHostController.openArtifact(connectionId: String, ref: ArtifactRef) {
    navigate(ArtifactRoute(connectionId, ref.id, ref.version, ref.type, ref.title, ref.followsLatest, ref.pinned))
}

/** The artifact and browser screens. AgentConnectionRoutes registers them with the agent's other places. */
fun NavGraphBuilder.artifactRoutes(graph: AppGraph, nav: NavHostController) {
    page<AgentArtifactsRoute> { entry -> AgentArtifacts(graph, nav, entry.toRoute()) }
    page<ArtifactRoute> { entry -> ArtifactEntry(graph, nav, entry.toRoute()) }
    page<BrowserRoute> { entry -> BrowserEntry(graph, nav, entry.toRoute()) }
}

/** The connection's name as the browser shows it: "via Studio". */
@Composable
internal fun computerName(graph: AppGraph, connectionId: String): String {
    val agents by graph.agentConnections.accounts.collectAsStateWithLifecycle()
    return agents.firstOrNull { it.id == connectionId }?.name?.takeIf { it.isNotBlank() } ?: stringResource(R.string.browser_default_computer)
}

private class ArtifactsHolder(session: AgentSession?) : ViewModel() {
    val reader: ArtifactCatalogReader? = session?.let {
        ArtifactCatalogReader(ArtifactClient(it.client), viewModelScope, cached = { it.cachedResource("artifacts") }, keep = { value -> it.keepResource("artifacts", value) })
    }
}

@Composable
private fun AgentArtifacts(graph: AppGraph, nav: NavHostController, route: AgentArtifactsRoute) {
    val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
    val reader = viewModel { ArtifactsHolder(session) }.reader
    com.slopus.happy.ui.components.StartedEffect(reader) {
        if (session == null || reader == null) return@StartedEffect
        reader.resume()
        try {
            session.events.filter { it.type.startsWith("artifact.") || it.type == AgentEvent.HELLO }.collect { reader.read() }
        } finally { reader.pause() }
    }
    val read = reader?.state?.collectAsStateWithLifecycle()?.value ?: ArtifactListState(emptyList(), null, failed = true, loaded = true)
    ArtifactsScreen(
        read = read,
        onBack = { nav.popBackStack() },
        onOpen = { nav.openArtifact(route.connectionId, it) },
        onMore = { reader?.read(append = true) },
        onRetry = { reader?.retry() },
    )
}

private class ArtifactHolder(session: AgentSession?, route: ArtifactRoute, resources: Resources) : ViewModel() {
    val loader: ArtifactLoader? = session?.let {
        ArtifactLoader(
            files = ArtifactClient(it.client),
            agent = it.client,
            scope = viewModelScope,
            ref = route.ref,
            opened = route.path?.let { path -> (route.openedVersion ?: route.version) to path },
            labels = { isVideo, name ->
                resources.getString(R.string.artifact_media_label, resources.getString(if (isVideo) R.string.artifact_video else R.string.artifact_picture), name)
            },
            library = it.media,
        ).also(ArtifactLoader::load)
    }

    override fun onCleared() {
        loader?.close()
    }
}

@Composable
private fun ArtifactEntry(graph: AppGraph, nav: NavHostController, route: ArtifactRoute) {
    val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
    LaunchedEffect(session, route.artifactId) { session?.openTab("artifact", route.artifactId) }
    val resources = LocalResources.current
    val holder = viewModel { ArtifactHolder(session, route, resources) }
    val context = LocalContext.current
    val computer = computerName(graph, route.connectionId)
    val happyLinks = LocalHappyLinks.current
    val loader = holder.loader
    if (loader == null) {
        ArtifactScreen(route.title, ArtifactUi.Message(deleted = false), null, computer, ArtifactActions(onBack = { nav.popBackStack() }))
        return
    }
    val ui by loader.state.collectAsStateWithLifecycle()
    val title by loader.title.collectAsStateWithLifecycle()
    ArtifactScreen(
        title = title,
        ui = ui,
        media = loader.media,
        computer = computer,
        actions = remember(loader, nav) {
            ArtifactActions(
                onBack = { nav.popBackStack() },
                link = loader::link,
                onOpenFile = { version, path -> nav.navigate(route.copy(openedVersion = version, path = path)) },
                onOpenWeb = { url -> nav.navigate(BrowserRoute(route.connectionId, url)) },
                // A Happy URL stays in the app: an internal one means this connection, an external one its own.
                onOpenExternal = { url -> if (happyLinks?.open(url, route.connectionId) != true) openOutside(context, url) },
                artifactLink = { id ->
                    graph.agentConnections.accounts.value.firstOrNull { it.id == route.connectionId }?.instanceId
                        ?.let { HappyUrls.format(HappyLink.Reference(HappyReferenceKind.Artifact, id), it) }
                },
                fileReader = { file ->
                    val version = loader.version ?: throw IllegalStateException("not read")
                    ArtifactClient(session!!.client).bytes(route.artifactId, version.number, file.path)
                },
                artifactKey = "artifact-${route.artifactId}",
            )
        },
    )
}

@Composable
private fun BrowserEntry(graph: AppGraph, nav: NavHostController, route: BrowserRoute) {
    val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
    val computer = computerName(graph, route.connectionId)
    val host = remember(route.url) { runCatching { java.net.URI(route.url).host }.getOrNull().orEmpty() }
    var title by remember { mutableStateOf(host) }
    var url by remember { mutableStateOf(route.url) }
    BrowserScreen(
        title = title,
        url = url,
        onUrl = { url = it },
        computer = computer,
        prepare = {
            val client = session?.client ?: throw IllegalStateException("no connection")
            BrowserPage(route.url, BrowserProxy.Scope.Workspace(client) { client.browserWorkspace(agentId = route.agentId) })
        },
        onBack = { nav.popBackStack() },
        onTitle = { title = it },
        onOpenElsewhere = { url ->
            if (BrowserPolicy.route(url) == BrowserPolicy.Route.Web) nav.navigate(BrowserRoute(route.connectionId, url, route.agentId))
        },
    )
}
