package com.slopus.happy.ui.todos

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.R
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.agent.SurfaceType
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Prompt
import com.slopus.happy.ui.components.PromptModal
import com.slopus.happy.ui.connection.BarIconButton
import com.slopus.happy.ui.surfaces.surfaceTitle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** iOS TodoListsViewController: joined lists with kept counts, refresh and a required-name creation menu. */
@Composable
internal fun TodoListsScreen(session: AgentSession, onBack: () -> Unit, onOpen: (String) -> Unit) {
    val catalog by session.surfaces.collectAsStateWithLifecycle()
    val ids = remember(catalog) { catalog.surfaces.filter { it.type == SurfaceType.TODO && catalog.joined(it) }.map { it.id } }
    val counts by remember(session, ids) { session.todos.outstandingStates(ids) }.collectAsStateWithLifecycle(emptyMap())
    val entries by produceState(emptyList<TodoListEntry>(), catalog, counts) {
        value = withContext(Dispatchers.Default) { catalog.of(SurfaceType.TODO).filter(catalog::joined).map { TodoListEntry(it.id, it.name, counts[it.id]) } }
    }
    var unsupported by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    suspend fun refresh() {
        if (refreshing) return
        refreshing = true
        try { unsupported = !session.refreshSurfaces() }
        catch (error: CancellationException) { throw error }
        catch (_: Exception) { /* Keep the catalog while the link recovers. */ }
        finally { refreshing = false }
    }
    LaunchedEffect(session) { refresh() }
    var prompt by remember { mutableStateOf<Prompt?>(null) }
    var creating by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    val listTitle = stringResource(R.string.todo_new_list)
    val documentTitle = stringResource(R.string.todo_new_document)
    val create = stringResource(R.string.common_create)
    val fallback = stringResource(R.string.common_error)
    fun ask(type: String) {
        if (creating) return
        prompt = Prompt(if (type == SurfaceType.TODO) listTitle else documentTitle, confirmText = create, allowBlank = false) { value ->
            if (value != null) {
                creating = true
                scope.launch {
                    try { onOpen(session.createSurface(type, value.trim()).id) }
                    catch (error: CancellationException) { throw error }
                    catch (error: Exception) { failure = error.message?.takeIf { it.isNotBlank() } ?: fallback }
                    finally { creating = false }
                }
            }
        }
    }
    PlaceScaffold(surfaceTitle(session, stringResource(R.string.todo_lists)), onBack, tag = "todo.lists.screen", actions = {
        TodoNewMenu(creating, onList = { ask(SurfaceType.TODO) }, onDocument = { ask(SurfaceType.DOCUMENT) })
    }) { TodoListsContent(entries, catalog.loaded, unsupported, onOpen, { scope.launch { refresh() } }, refreshing) }
    prompt?.let { current -> PromptModal(current) { prompt = null } }
    failure?.let { reason -> HappyAlert(Alert(stringResource(R.string.todo_create_failed_title), stringResource(R.string.todo_create_failed, reason),
        listOf(AlertButton(stringResource(R.string.common_ok)))), { failure = null }) }
}

@Composable
private fun TodoNewMenu(busy: Boolean, onList: () -> Unit, onDocument: () -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        BarIconButton(Ionicon.Add, stringResource(R.string.todo_new), { if (!busy) expanded = true }, Modifier.testTag("todo.lists.new"))
        HappyDropdownMenu(expanded, { expanded = false }) {
            HappyMenuItem(stringResource(R.string.todo_new_list), { expanded = false; onList() }, Modifier.testTag("todo.lists.new.list"))
            HappyMenuItem(stringResource(R.string.todo_new_document), { expanded = false; onDocument() }, Modifier.testTag("todo.lists.new.document"))
        }
    }
}