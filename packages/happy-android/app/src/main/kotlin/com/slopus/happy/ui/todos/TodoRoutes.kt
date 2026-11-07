package com.slopus.happy.ui.todos

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.todos.TodoItem
import com.slopus.happy.todos.TodoListState
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.cards.CardNote
import com.slopus.happy.ui.page
import com.slopus.happy.ui.surfaces.surfaceTitle
import com.slopus.happy.ui.surfaces.openSurface
import androidx.compose.ui.res.stringResource
import kotlinx.serialization.Serializable

@Serializable data class TodoListsRoute(val connectionId: String)
@Serializable data class TodoDeletedRoute(val connectionId: String, val surfaceId: String)
@Serializable data class TodoHistoryRoute(val connectionId: String, val surfaceId: String, val todoId: String, val text: String = "")

/** Child pages share the application's page motion and predictive back. */
fun NavGraphBuilder.todoRoutes(graph: AppGraph, nav: NavHostController) {
    page<TodoListsRoute> { entry ->
        val route = entry.toRoute<TodoListsRoute>()
        val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
        if (session == null) MissingTodoConnection { nav.popBackStack() }
        else TodoListsScreen(session, onBack = { nav.popBackStack() }, onOpen = { nav.openSurface(graph, route.connectionId, it) })
    }
    page<TodoDeletedRoute> { entry ->
        val route = entry.toRoute<TodoDeletedRoute>()
        val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
        if (session == null) MissingTodoConnection { nav.popBackStack() }
        else TodoDeletedScreen(session, route.surfaceId, onBack = { nav.popBackStack() }, open = { nav.navigate(it) })
    }
    page<TodoHistoryRoute> { entry ->
        val route = entry.toRoute<TodoHistoryRoute>()
        val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
        if (session == null) MissingTodoConnection { nav.popBackStack() }
        else TodoHistoryScreen(session, route.surfaceId, route.todoId, route.text, onBack = { nav.popBackStack() })
    }
}

@Composable
internal fun rememberTodoActions(session: AgentSession, surfaceId: String, open: (Any) -> Unit): TodoActions = remember(session, surfaceId, open) {
    val library = session.todos
    TodoActions(
        add = { library.add(surfaceId, it) },
        edit = { id, text -> library.setText(surfaceId, id, text) },
        done = { id, done -> library.setDone(surfaceId, id, done) },
        delete = { library.delete(surfaceId, it) },
        restore = { id, place, status -> library.restore(surfaceId, id, place, status) },
        move = { id, index -> library.move(surfaceId, id, index) },
        history = { todo: TodoItem -> open(TodoHistoryRoute(session.connectionId, surfaceId, todo.id, todo.heading ?: todo.text)) },
        refresh = { library.refresh(surfaceId) },
        dismissFailure = { library.dismissFailure(surfaceId) },
    )
}

@Composable
private fun TodoDeletedScreen(session: AgentSession, surfaceId: String, onBack: () -> Unit, open: (Any) -> Unit) {
    val states = remember(session, surfaceId) { session.todos.states(surfaceId) }
    val state by states.collectAsStateWithLifecycle(TodoListState())
    val actions = rememberTodoActions(session, surfaceId, open)
    LaunchedEffect(session, surfaceId) { session.todos.showDeleted(surfaceId) }
    PlaceScaffold(surfaceTitle(session, stringResource(R.string.todo_deleted_todos)), onBack, tag = "todo.deleted.screen") {
        TodoListContent(state, actions, deleted = true, readOnly = !session.permissions.collectAsStateWithLifecycle().value.canWrite)
    }
}

@Composable
private fun MissingTodoConnection(onBack: () -> Unit) {
    PlaceScaffold(stringResource(R.string.todo_lists), onBack, tag = "todo.missing.connection") {
        CardNote(stringResource(R.string.todo_missing))
    }
}