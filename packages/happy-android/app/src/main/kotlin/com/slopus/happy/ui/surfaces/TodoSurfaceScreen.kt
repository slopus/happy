package com.slopus.happy.ui.surfaces

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.R
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.todos.TodoListState
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.todos.TodoDeletedRoute
import com.slopus.happy.ui.todos.TodoListContent
import com.slopus.happy.ui.todos.rememberTodoActions

/** iOS TodoListViewController: kept editable cards, with deleted todos and history on the same navigation stack. */
@Composable
fun TodoSurfaceScreen(session: AgentSession, surfaceId: String, onBack: () -> Unit, open: (Any) -> Unit = {}) {
    val surface by remember(session, surfaceId) { session.surface(surfaceId) }.collectAsStateWithLifecycle(null)
    val state by remember(session, surfaceId) { session.todos.states(surfaceId) }.collectAsStateWithLifecycle(TodoListState())
    val actions = rememberTodoActions(session, surfaceId, open)
    PlaceScaffold(surfaceTitle(session, surface?.name.orEmpty()), onBack, tag = "todo.screen", actions = {
        SurfaceMenu(session, surfaceId, onBack, open = open) { close ->
            HappyMenuItem(stringResource(R.string.todo_deleted_todos), onClick = { close(); open(TodoDeletedRoute(session.connectionId, surfaceId)) })
        }
    }) { TodoListContent(state, actions, readOnly = !session.permissions.collectAsStateWithLifecycle().value.canWrite) }
}
