package com.slopus.happy.ui.files

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.agent.WorkspaceFiles
import com.slopus.happy.agent.string
import com.slopus.happy.text.Words
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/** The open agent connection's session, or null when it is gone (signed out, removed). */
@Composable
private fun rememberAgentSession(graph: AppGraph, connectionId: String): AgentSession? =
    remember(connectionId) { graph.agentSessions.session(connectionId) }

/** What the catalog calls [workspaceId]: its own name, or its project's. */
private fun AgentSession.workspaceName(workspaceId: String): String? {
    val catalog = catalog.value
    return (catalog.workspaces[workspaceId] ?: catalog.projects[workspaceId])?.string("name")?.takeIf { it.isNotBlank() }
}

/** The workspace [agentId] works in: home's catalog, else the agent itself (a hidden subagent isn't listed). */
private suspend fun AgentSession.workspaceOf(agentId: String): String {
    catalog.value.agent(agentId)?.workspaceId?.let { return it }
    val body = AgentClient.json.parseToJsonElement(client.send("GET", "/v0/agents/${AgentClient.escape(agentId)}").text) as? JsonObject
    return (body?.get("agent") as? JsonObject)?.string("workspaceId") ?: throw AgentApiException(404, "not_found", null)
}

/** One folder of the workspace: a folder pushes the next, a file opens the viewer. */
@Composable
internal fun WorkspaceFilesEntry(graph: AppGraph, route: WorkspaceFilesRoute, nav: NavHostController) {
    val session = rememberAgentSession(graph, route.connectionId)
    val scope = rememberCoroutineScope()
    val folder = remember(session, route.workspaceId, route.path) {
        val files = session?.let { WorkspaceFiles(it.client) }
        WorkspaceFolder(scope, { path, cursor -> files?.tree(route.workspaceId, path, cursor) ?: throw IllegalStateException() }, route.path)
    }
    LaunchedEffect(folder) { folder.open() }
    val state by folder.state.collectAsStateWithLifecycle()
    val title = route.path.substringAfterLast('/').ifEmpty { session?.workspaceName(route.workspaceId) ?: stringResource(R.string.common_files) }
    WorkspaceFilesScreen(
        title = title,
        state = if (session == null) WorkspaceFolder.State(loading = false, error = Words.ours(R.string.conversation_unavailable)) else state,
        onBack = { nav.popBackStack() },
        onOpen = { entry ->
            if (entry.directory) nav.navigate(WorkspaceFilesRoute(route.connectionId, route.workspaceId, entry.path))
            else nav.openWorkspaceFile(route.connectionId, entry.path, workspaceId = route.workspaceId)
        },
        onRetry = folder::open,
        onMore = folder::more,
    )
}

/**
 * One workspace file in the viewer (desktop's FilePreview): read through
 * the agent, then shown as text with its syntax, a picture, or a Markdown
 * document with its source a tab away; past the agent's size limit, said.
 */
@Composable
internal fun WorkspaceFileEntry(graph: AppGraph, route: WorkspaceFileRoute, onBack: () -> Unit) {
    val session = rememberAgentSession(graph, route.connectionId)
    val load by produceState<FileLoad>(FileLoad.Loading, session, route) {
        val live = session ?: run {
            value = FileLoad.Failed(Words.ours(R.string.conversation_unavailable))
            return@produceState
        }
        value = try {
            val workspaceId = route.workspaceId ?: live.workspaceOf(route.agentId!!)
            val file = WorkspaceFiles(live.client).read(workspaceId, route.path)
            withContext(Dispatchers.Default) { fileLoadOf(route.path, file.bytes) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            FileLoad.Failed(WorkspaceFolder.describe(e))
        }
    }
    FileScreen(load, route.path, onBack, route.line)
}
