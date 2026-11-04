package com.slopus.happy.ui.todos

import android.view.HapticFeedbackConstants
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberSwipeToDismissBoxState
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.platform.ViewConfiguration
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.testTag as semanticTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.todos.TodoItem
import com.slopus.happy.todos.TodoLibrary
import com.slopus.happy.todos.TodoListState
import com.slopus.happy.ui.cards.CardListSpec
import com.slopus.happy.ui.cards.CardBlock
import com.slopus.happy.ui.cards.CardNote
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import com.slopus.happy.ui.connection.RowTile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class TodoActions(
    val add: suspend (String) -> Unit,
    val edit: suspend (String, String) -> Unit,
    val done: suspend (String, Boolean) -> Unit,
    val delete: suspend (String) -> Unit,
    val restore: suspend (String, TodoLibrary.Place, TodoItem.Status) -> Unit,
    val move: suspend (String, Int) -> Unit,
    val history: (TodoItem) -> Unit,
    val refresh: () -> Unit,
    val dismissFailure: () -> Unit,
)

private data class Undo(val todo: TodoItem, val after: String?)

/**
 * iOS TodoListViewController's scrolling body. The reducer and row plan run
 * off Main. UI commits keyed rows, focus and transforms only. A checked row
 * holds for 650 ms; delete offers a five-second undo, preserving its status
 * and place. Insets follow the keyboard and the shared readable column.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TodoListContent(state: TodoListState, actions: TodoActions, deleted: Boolean = false) {
    val colors = HappyTheme.colors
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val rootFocus = remember { FocusRequester() }
    val view = LocalView.current
    val reduced = rememberReduceMotion()
    val undoOffset = with(LocalDensity.current) { 16.dp.roundToPx() }
    val list = rememberLazyListState()
    val drag = rememberTodoDrag(list, state.active.map { it.id }, reduced, actions.move)
    val defaultConfiguration = LocalViewConfiguration.current
    val dragConfiguration = remember(defaultConfiguration) {
        object : ViewConfiguration by defaultConfiguration { override val longPressTimeoutMillis = 350L }
    }
    var completedShown by rememberSaveable { mutableStateOf(false) }
    var editing by rememberSaveable { mutableStateOf<String?>(null) }
    var text by rememberSaveable { mutableStateOf("") }
    var settling by remember { mutableStateOf<Map<String, TodoItem>>(emptyMap()) }
    val settlingJobs = remember { mutableMapOf<String, Job>() }
    var undo by remember { mutableStateOf<Undo?>(null) }
    var lastUndo by remember { mutableStateOf<Undo?>(null) }
    val rows by produceState(emptyList<TodoRow>(), state, deleted, completedShown, settling, drag.order) {
        value = withContext(Dispatchers.Default) { todoRows(state, deleted, completedShown, settling, drag.order) }
    }

    fun edit(todo: TodoItem?) { text = todo?.text.orEmpty(); editing = todo?.id ?: "add" }
    fun commit(stay: Boolean) {
        val id = editing ?: return
        val value = text
        if (!stay || id != "add") { editing = null; focus.clearFocus() } else text = ""
        scope.launch { if (id == "add") actions.add(value) else actions.edit(id, value) }
    }
    fun toggle(todo: TodoItem) {
        val done = todo.status != TodoItem.Status.Completed && todo.id !in settling
        settlingJobs.remove(todo.id)?.cancel()
        if (done && !reduced) {
            settling = settling + (todo.id to todo)
            settlingJobs[todo.id] = scope.launch { delay(650); settling = settling - todo.id; settlingJobs.remove(todo.id) }
        } else settling = settling - todo.id
        view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
        scope.launch { actions.done(todo.id, done) }
    }
    fun remove(todo: TodoItem) {
        val index = state.active.indexOfFirst { it.id == todo.id }
        val held = Undo(todo, state.active.getOrNull(index - 1)?.id)
        if (editing == todo.id) { editing = null; focus.clearFocus() }
        scope.launch { actions.delete(todo.id); lastUndo = held; undo = held }
    }
    fun restore(todo: TodoItem) { scope.launch { actions.restore(todo.id, TodoLibrary.Place.End, TodoItem.Status.Active) } }

    BackHandler(editing != null) { commit(false) }
    LaunchedEffect(editing) { if (editing == null) rootFocus.requestFocus() }
    LaunchedEffect(undo) { if (undo != null) { delay(5000); undo = null } }

    val restoreLabel = stringResource(R.string.onboarding_restore_button)
    val historyLabel = stringResource(R.string.artifact_history)
    val deleteLabel = stringResource(R.string.common_delete)
    val editLabel = stringResource(R.string.files_edit_file)
    val upLabel = stringResource(R.string.todo_move_up)
    val downLabel = stringResource(R.string.todo_move_down)
    Box(Modifier.fillMaxSize().imePadding().navigationBarsPadding().testTag(if (deleted) "todo.deleted" else "todo.list")
        .onPreviewKeyEvent { event ->
            val character = event.nativeKeyEvent.unicodeChar
            if (!deleted && editing == null && event.type == KeyEventType.KeyDown && character >= 32 && !event.nativeKeyEvent.isCtrlPressed && !event.nativeKeyEvent.isAltPressed) {
                text = String(Character.toChars(character)); editing = "add"; true
            } else false
        }.focusRequester(rootFocus).focusable()) {
        PullToRefreshBox(isRefreshing = false, onRefresh = actions.refresh) {
            CompositionLocalProvider(LocalViewConfiguration provides dragConfiguration) {
            LazyColumn(Modifier.fillMaxSize().then(drag.input(!deleted && editing == null)).testTag("todo.rows"), state = list, userScrollEnabled = !drag.dragging, contentPadding = PaddingValues(top = 8.dp, bottom = 86.dp)) {
                items(rows, key = { it.key }, contentType = { it::class }) { row ->
                    when (row) {
                        TodoRow.Add -> TodoLine("add", HomeCardPlace(true, true), onCheck = { edit(null) }, checkRole = Role.Button, checkLabel = stringResource(R.string.agent_surface_add_todo), mark = { TodoAddMark() }, text = {
                            if (editing == "add") TodoEditor(text, { text = it }, { commit(true) }, onBlur = { commit(false) })
                            else Text(stringResource(R.string.agent_surface_add_todo), style = happyTextStyle(fontSize = 16, lineHeight = 20), color = colors.textSecondary, modifier = Modifier.fillMaxWidth().clickable { edit(null) })
                        })
                        is TodoRow.Gap -> Spacer(Modifier.height(CardListSpec.headingGap))
                        is TodoRow.Note -> CardNote(noteText(row.kind))
                        is TodoRow.Notice -> TodoNotice(if (row.reason.isEmpty()) stringResource(R.string.todo_failure_generic) else stringResource(R.string.todo_failure, row.reason), actions.dismissFailure)
                        is TodoRow.Completed -> Row(Modifier.contentMaxWidth(LocalWindowLayout.current).clickable { completedShown = !completedShown }.padding(start = 32.dp, end = 32.dp, top = 24.dp, bottom = 6.dp).heightIn(min = 20.dp).testTag("todo.completed"), verticalAlignment = Alignment.CenterVertically) {
                            Icon(if (row.shown) Ionicon.ChevronDown else Ionicon.ChevronForward, 12.dp, colors.textSecondary)
                            Text(stringResource(if (row.shown) R.string.todo_hide_completed else R.string.todo_show_completed, row.count), style = happyTextStyle(fontSize = 15, lineHeight = 20, weight = FontWeight.Medium), color = colors.textSecondary, modifier = Modifier.padding(start = 6.dp))
                        }
                        is TodoRow.Heading -> {
                            val todo = row.todo
                            val deleteHeading = stringResource(R.string.todo_delete_heading, todo.heading.orEmpty())
                            val index = state.active.indexOfFirst { it.id == todo.id }
                            val accessibility = if (editing == todo.id) Modifier else Modifier.clearAndSetSemantics {
                                semanticTag = "todo.heading.${todo.id}"
                                heading()
                                contentDescription = todo.heading.orEmpty()
                                onClick(editLabel) { edit(todo); true }
                                customActions = buildList {
                                    add(CustomAccessibilityAction(editLabel) { edit(todo); true })
                                    add(CustomAccessibilityAction(deleteHeading) { remove(todo); true })
                                    add(CustomAccessibilityAction(historyLabel) { actions.history(todo); true })
                                    if (index > 0) add(CustomAccessibilityAction(upLabel) { scope.launch { actions.move(todo.id, index - 1) }; true })
                                    if (index < state.active.lastIndex) add(CustomAccessibilityAction(downLabel) { scope.launch { actions.move(todo.id, index + 1) }; true })
                                }
                            }
                            val modifier = drag.row(todo.id).contentMaxWidth(LocalWindowLayout.current).padding(start = 32.dp, end = 32.dp, top = 26.dp, bottom = 8.dp).then(accessibility).testTag("todo.heading.${todo.id}")
                            TodoSwipe(onDelete = { remove(todo) }, onHistory = { actions.history(todo) }, deleted = false, modifier = modifier) {
                                if (editing == todo.id) TodoEditor(text, { text = it }, { commit(false) }, heading = true)
                                else Text(todo.heading.orEmpty(), style = happyTextStyle(fontSize = 20, lineHeight = 24, weight = FontWeight.SemiBold), maxLines = 3, color = colors.text, modifier = Modifier.fillMaxWidth().clickable { edit(todo) })
                            }
                        }
                        is TodoRow.Item -> {
                            val todo = row.todo
                            val mark = stringResource(if (row.done) R.string.todo_mark_not_done else R.string.todo_mark_done, todo.text)
                            val author = todo.authorUserId?.let(state.names::get)
                            val statusWords = buildList {
                                add(stringResource(if (row.done) R.string.todo_done else R.string.todo_not_done))
                                if (author != null) add(stringResource(R.string.todo_added_by, author))
                                if (todo.id in state.waiting) add(stringResource(R.string.todo_not_sent))
                            }.joinToString(", ")
                            val index = state.active.indexOfFirst { it.id == todo.id }
                            val semantics = if (editing == todo.id) Modifier else Modifier.clearAndSetSemantics {
                                semanticTag = "todo.row.${todo.id}"
                                contentDescription = todo.text
                                stateDescription = if (deleted) restoreLabel else statusWords
                                onClick(if (deleted) restoreLabel else editLabel) { if (deleted) restore(todo) else edit(todo); true }
                                customActions = if (deleted) listOf(CustomAccessibilityAction(restoreLabel) { restore(todo); true }) else buildList {
                                    add(CustomAccessibilityAction(mark) { toggle(todo); true })
                                    add(CustomAccessibilityAction(editLabel) { edit(todo); true })
                                    add(CustomAccessibilityAction(deleteLabel) { remove(todo); true })
                                    add(CustomAccessibilityAction(historyLabel) { actions.history(todo); true })
                                    if (!row.done) {
                                        if (index > 0) add(CustomAccessibilityAction(upLabel) { scope.launch { actions.move(todo.id, index - 1) }; true })
                                        if (index < state.active.lastIndex) add(CustomAccessibilityAction(downLabel) { scope.launch { actions.move(todo.id, index + 1) }; true })
                                    }
                                }
                            }
                            val motion = if (reduced) Modifier else Modifier.animateItem(fadeInSpec = null, placementSpec = tween(250), fadeOutSpec = null)
                            TodoSwipe(onDelete = { if (deleted) restore(todo) else remove(todo) }, onHistory = { actions.history(todo) }, deleted = deleted, modifier = motion.then(drag.row(todo.id))) {
                                if (deleted) TodoDeletedLine(todo.id, todo.text, row.place, semantics) { restore(todo) }
                                else TodoLine(todo.id, row.place, semantics, author = author, authorSeed = todo.authorUserId, onCheck = { toggle(todo) }, checked = row.done, checkLabel = mark,
                                    mark = { TodoCheck(row.done) },
                                    text = {
                                        if (editing == todo.id) TodoEditor(text, { text = it }, { commit(false) })
                                        else TodoTextLabel(todo.text, row.done) { edit(todo) }
                                    })
                            }
                        }
                    }
                }
            }
            }
        }
        AnimatedVisibility(undo != null, Modifier.align(Alignment.BottomCenter).padding(horizontal = 16.dp, vertical = 12.dp),
            enter = if (reduced) fadeIn(tween(0)) else fadeIn(tween(300)) + slideInVertically(spring(dampingRatio = .85f)) { undoOffset },
            exit = fadeOut(tween(if (reduced) 0 else 200))) {
            Row(Modifier.widthIn(max = 480.dp).fillMaxWidth().heightIn(min = 50.dp).clip(RoundedCornerShape(25.dp)).background(colors.surfaceHighest).padding(horizontal = 18.dp)
                .testTag("todo.undo").semantics { liveRegion = LiveRegionMode.Polite }, horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.todo_deleted, lastUndo?.todo?.heading ?: lastUndo?.todo?.text.orEmpty()), style = happyTextStyle(fontSize = 15, lineHeight = 20), maxLines = 1, overflow = TextOverflow.Ellipsis, color = colors.text, modifier = Modifier.weight(1f))
                TextButton(onClick = {
                    val held = undo ?: return@TextButton
                    undo = null
                    scope.launch { actions.restore(held.todo.id, TodoLibrary.Place.After(held.after), held.todo.status) }
                }, modifier = Modifier.testTag("todo.undo.button")) { Text(stringResource(R.string.todo_undo), color = colors.textLink) }
            }
        }
    }
}

@Composable
private fun TodoNotice(text: String, onDismiss: () -> Unit) {
    val colors = HappyTheme.colors
    val dismiss = stringResource(R.string.agent_question_dismiss)
    CardBlock(HomeCardPlace(true, true), tag = "todo.notice") {
        Row(Modifier.fillMaxWidth().clickable(onClickLabel = dismiss, role = Role.Button, onClick = onDismiss).padding(horizontal = 16.dp, vertical = 10.dp).heightIn(min = 24.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Ionicon.AlertCircleOutline, 20.dp, RowTile.Red.ink(colors.dark))
            Text(text, style = CardListSpec.subtitle, color = colors.text, maxLines = 8)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TodoSwipe(onDelete: () -> Unit, onHistory: () -> Unit, deleted: Boolean, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val colors = HappyTheme.colors
    val state = rememberSwipeToDismissBoxState(confirmValueChange = { value ->
        when (value) {
            SwipeToDismissBoxValue.EndToStart -> onDelete()
            SwipeToDismissBoxValue.StartToEnd -> onHistory()
            else -> Unit
        }
        false
    })
    SwipeToDismissBox(state = state, modifier = modifier, enableDismissFromStartToEnd = !deleted, backgroundContent = {
        val history = state.dismissDirection == SwipeToDismissBoxValue.StartToEnd
        Box(Modifier.fillMaxSize().contentMaxWidth(LocalWindowLayout.current).padding(horizontal = 16.dp).clip(RoundedCornerShape(26.dp))
            .background(if (history) colors.textSecondary else if (deleted) colors.textLink else colors.textDestructive).padding(horizontal = 24.dp),
            contentAlignment = if (history) Alignment.CenterStart else Alignment.CenterEnd) {
            Text(stringResource(if (history) R.string.artifact_history else if (deleted) R.string.onboarding_restore_button else R.string.common_delete), color = androidx.compose.ui.graphics.Color.White, style = CardListSpec.title)
        }
    }) { content() }
}

@Composable
private fun noteText(kind: TodoRow.Note.Kind) = stringResource(when (kind) {
    TodoRow.Note.Kind.Loading -> R.string.todo_loading
    TodoRow.Note.Kind.Empty -> R.string.todo_empty
    TodoRow.Note.Kind.Missing -> R.string.todo_missing
    TodoRow.Note.Kind.DeletedLoading -> R.string.todo_deleted_loading
    TodoRow.Note.Kind.DeletedEmpty -> R.string.todo_deleted_empty
})