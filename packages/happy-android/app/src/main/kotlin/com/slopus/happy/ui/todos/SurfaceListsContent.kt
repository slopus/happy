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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.agent.SurfaceType
import com.slopus.happy.ui.cards.CardNote
import com.slopus.happy.ui.cards.CardRow
import com.slopus.happy.ui.cards.CardTile
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.connection.RowTile

/**
 * Home's Documents and TODOs pages (desktop's sections): every Surface of
 * [type] on the computer, joined or not, each with its kind's words.
 */
internal enum class SurfaceList(
    val type: String,
    val title: Int,
    val create: Int,
    val empty: Int,
    val loading: Int,
    val unsupported: Int,
) {
    Documents(SurfaceType.DOCUMENT, R.string.surface_lists_documents, R.string.todo_new_document, R.string.document_lists_empty, R.string.document_lists_loading, R.string.document_lists_unsupported),
    Todos(SurfaceType.TODO, R.string.surface_lists_todos, R.string.todo_new_list, R.string.todo_no_lists, R.string.todo_loading_lists, R.string.todo_unsupported);

    /** Its screen's tags: `document.lists` or `todo.lists`, then `.<surfaceId>` per row. */
    val tag get() = "$type.lists"
}

@Immutable
internal data class SurfaceListEntry(val id: String, val name: String, val outstanding: Int? = null)

/**
 * One card of [list]'s Surfaces by name, each on its kind's tile; a todo
 * list has its open todos as a trailing count, only when there are any
 * (desktop's section list).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SurfaceListsContent(
    list: SurfaceList,
    entries: List<SurfaceListEntry>,
    loaded: Boolean,
    unsupported: Boolean,
    onOpen: (String) -> Unit,
    onRefresh: () -> Unit,
    refreshing: Boolean = false,
) {
    val (glyph, tile) = RowTile.surface(list.type)
    PullToRefreshBox(isRefreshing = refreshing, onRefresh = onRefresh, modifier = Modifier.fillMaxSize().navigationBarsPadding().testTag(list.tag)) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 8.dp, bottom = 16.dp)) {
            if (entries.isEmpty()) item("note") {
                CardNote(stringResource(when {
                    unsupported -> list.unsupported
                    !loaded -> list.loading
                    else -> list.empty
                }))
            }
            itemsIndexed(entries, key = { _, entry -> entry.id }) { index, entry ->
                CardRow(HomeCardPlace(index == 0, index == entries.lastIndex), entry.name.ifEmpty { stringResource(list.title) },
                    trailing = entry.outstanding?.takeIf { it > 0 }?.toString(),
                    leading = { CardTile(glyph, tile) }, onClick = { onOpen(entry.id) }, tag = "${list.tag}.${entry.id}")
            }
        }
    }
}
