package com.slopus.happy.ui.todos

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.cards.CardNote
import com.slopus.happy.ui.cards.CardRow
import com.slopus.happy.ui.cards.CardTile
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.connection.RowTile

@Immutable
internal data class TodoListEntry(val id: String, val name: String, val outstanding: Int?)

/** iOS TodoListsItems: one card of named lists, with counts only where kept. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TodoListsContent(
    entries: List<TodoListEntry>,
    loaded: Boolean,
    unsupported: Boolean,
    onOpen: (String) -> Unit,
    onRefresh: () -> Unit,
) {
    PullToRefreshBox(isRefreshing = false, onRefresh = onRefresh, modifier = Modifier.fillMaxSize().navigationBarsPadding().testTag("todo.lists")) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 8.dp, bottom = 16.dp)) {
            if (entries.isEmpty()) item("note") {
                CardNote(stringResource(when {
                    unsupported -> R.string.todo_unsupported
                    !loaded -> R.string.todo_loading_lists
                    else -> R.string.todo_no_lists
                }))
            }
            itemsIndexed(entries, key = { _, entry -> entry.id }) { index, entry ->
                CardRow(HomeCardPlace(index == 0, index == entries.lastIndex), entry.name.ifEmpty { stringResource(R.string.agent_search_todos) },
                    subtitle = entry.outstanding?.let { if (it == 0) stringResource(R.string.todo_nothing) else pluralStringResource(R.plurals.todo_outstanding, it, it) },
                    leading = { CardTile(Ionicon.CheckboxOutline, RowTile.Green) }, onClick = { onOpen(entry.id) }, tag = "todo.lists.${entry.id}")
            }
        }
    }
}