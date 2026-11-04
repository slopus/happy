package com.slopus.happy.ui.todos

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.todos.TodoRevision
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.cards.CardNote
import com.slopus.happy.ui.cards.CardRow
import com.slopus.happy.ui.components.HomeCardPlace
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.util.Date

internal data class TodoHistoryRow(val revision: TodoRevision, val change: TodoRevision.Change, val time: String)

private sealed interface HistoryRead {
    data object Loading : HistoryRead
    data object Failed : HistoryRead
    data class Ready(val rows: List<TodoHistoryRow>, val names: Map<String, String>) : HistoryRead
}

@Composable
internal fun TodoHistoryScreen(session: AgentSession, surfaceId: String, todoId: String, text: String, onBack: () -> Unit) {
    val locale = LocalConfiguration.current.locales[0]
    val read by produceState<HistoryRead>(HistoryRead.Loading, session, surfaceId, todoId, locale) {
        value = try {
            withContext(Dispatchers.Default) {
                val (revisions, names) = session.todos.history(surfaceId, todoId)
                val changes = TodoRevision.changes(revisions)
                val format = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT, locale)
                HistoryRead.Ready(revisions.mapIndexed { index, revision ->
                    TodoHistoryRow(revision, changes[index], format.format(Date(revision.todo.updatedAt.toLong())))
                }.asReversed(), names)
            }
        } catch (e: CancellationException) { throw e } catch (_: Exception) { HistoryRead.Failed }
    }
    PlaceScaffold(todoTitle(session, stringResource(R.string.artifact_history)), onBack, tag = "todo.history", subtitle = text) {
        Box(Modifier.fillMaxSize().navigationBarsPadding()) {
            when (val value = read) {
                HistoryRead.Loading -> CardNote(stringResource(R.string.todo_history_loading))
                HistoryRead.Failed -> CardNote(stringResource(R.string.todo_history_unavailable))
                is HistoryRead.Ready -> TodoHistoryContent(value.rows, value.names)
            }
        }
    }
}

@Composable
internal fun TodoHistoryContent(rows: List<TodoHistoryRow>, names: Map<String, String>) {
    if (rows.isEmpty()) { CardNote(stringResource(R.string.todo_history_empty)); return }
    LazyColumn(Modifier.fillMaxSize().testTag("todo.history.rows"), contentPadding = PaddingValues(top = 8.dp, bottom = 16.dp)) {
        itemsIndexed(rows, key = { _, row -> row.revision.todo.version }) { index, row ->
            val person = row.revision.userId?.let(names::get)
            val agent = row.revision.agentId != null || row.revision.source == "tool"
            val actor = when {
                person != null && agent -> "$person · ${stringResource(R.string.todo_agent)}"
                person != null -> person
                agent -> stringResource(R.string.todo_agent)
                else -> stringResource(R.string.todo_someone)
            }
            CardRow(HomeCardPlace(index == 0, index == rows.lastIndex), actor,
                subtitle = "${todoChangeText(row.change)} · ${row.time}", titleLines = 3, tag = "todo.history.$index")
        }
    }
}

@Composable
internal fun todoChangeText(change: TodoRevision.Change): String = when (change) {
    TodoRevision.Change.Created -> stringResource(R.string.turn_added)
    is TodoRevision.Change.Edited -> stringResource(R.string.todo_history_edited, change.from)
    TodoRevision.Change.Completed -> stringResource(R.string.todo_history_done)
    TodoRevision.Change.Reopened -> stringResource(R.string.todo_history_not_done)
    TodoRevision.Change.Deleted -> stringResource(R.string.files_deleted)
    TodoRevision.Change.Restored -> stringResource(R.string.todo_history_restored)
    TodoRevision.Change.Moved -> stringResource(R.string.todo_history_moved)
    is TodoRevision.Change.EditedAnd -> stringResource(R.string.todo_history_changed_and, todoChangeText(change.change).lowercase(LocalConfiguration.current.locales[0]))
}