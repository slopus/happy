package com.slopus.happy.ui.conversation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.agent.WorkspaceGit
import com.slopus.happy.agent.string
import com.slopus.happy.ui.files.AgentChanges
import com.slopus.happy.ui.files.ChangesActions
import com.slopus.happy.ui.files.ChangesContent
import com.slopus.happy.ui.files.ChangesScreen
import kotlinx.coroutines.flow.filter

/**
 * A workspace's changes against its comparison base, opened from its
 * agent's page: the session changes screen ([ChangesScreen]) over the
 * workspace's own Git ([WorkspaceGit]). Five files or fewer open whole;
 * more start folded, each opening its diff when tapped. Read again on
 * every return to the screen, and in place whenever the agent says the
 * workspace's Git changed (`git.updated`, as desktop's Changes panel).
 */
@Composable
internal fun WorkspaceChangesEntry(graph: AppGraph, nav: NavHostController, route: WorkspaceChangesRoute) {
    val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
    val scope = rememberCoroutineScope()
    val changes = remember(session, route.workspaceId) {
        session?.let { AgentChanges(scope, WorkspaceGit(it.conversationRequest(), route.workspaceId), route.workspaceId, supported = true) }
    }
    LifecycleResumeEffect(changes) {
        changes?.refresh()
        onPauseOrDispose { }
    }
    LaunchedEffect(session, changes) {
        val live = session ?: return@LaunchedEffect
        live.events.filter { it.type == "git.updated" && it.data.string("workspaceId") == route.workspaceId }.collect { changes?.update() }
    }
    val content = if (changes == null) {
        ChangesContent.Loading
    } else {
        ChangesContent.Agent(changes.state.collectAsStateWithLifecycle().value, supported = true, expandFew = true)
    }
    ChangesScreen(
        content,
        ChangesActions(
            onBack = { nav.popBackStack() },
            onExpandContext = { path -> changes?.expandContext(path) },
            onRequestContent = { path -> changes?.requestContent(path) },
            onRetry = { changes?.refresh() },
        ),
    )
}
