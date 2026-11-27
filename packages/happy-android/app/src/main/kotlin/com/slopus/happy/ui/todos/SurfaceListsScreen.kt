package com.slopus.happy.ui.todos

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
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
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Prompt
import com.slopus.happy.ui.components.PromptModal
import com.slopus.happy.ui.connection.BarIconButton
import com.slopus.happy.ui.surfaces.surfaceTitle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Home's Documents or TODOs page (desktop's section list): every Surface of
 * [list]'s kind by name, joined or not, refreshed on open and by pulling;
 * a todo list counts its open todos, kept or read now. + asks a name and
 * makes one of the kind, then opens it.
 */
@Composable
internal fun SurfaceListsScreen(session: AgentSession, list: SurfaceList, onBack: () -> Unit, onOpen: (String) -> Unit) {
    val catalog by session.surfaces.collectAsStateWithLifecycle()
    val ids = remember(catalog, list) { if (list.type == SurfaceType.TODO) catalog.of(SurfaceType.TODO).map { it.id } else emptyList() }
    val kept by remember(session, ids) { session.todos.outstandingStates(ids) }.collectAsStateWithLifecycle(emptyMap())
    // The lists the phone hasn't kept, read once while the page is open.
    val read = remember { mutableStateMapOf<String, Int>() }
    LaunchedEffect(session, ids, kept.keys) {
        for (id in ids) if (id !in kept && id !in read) launch { session.todos.readOutstanding(id)?.let { read[id] = it } }
    }
    val entries by produceState(emptyList<SurfaceListEntry>(), catalog, list, kept, read.toMap()) {
        value = withContext(Dispatchers.Default) { catalog.of(list.type).map { SurfaceListEntry(it.id, it.name, kept[it.id] ?: read[it.id]) } }
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
    val createTitle = stringResource(list.create)
    val create = stringResource(R.string.common_create)
    val fallback = stringResource(R.string.common_error)
    fun ask() {
        if (creating) return
        prompt = Prompt(createTitle, confirmText = create, allowBlank = false) { value ->
            if (value != null) {
                creating = true
                scope.launch {
                    try { onOpen(session.createSurface(list.type, value.trim()).id) }
                    catch (error: CancellationException) { throw error }
                    catch (error: Exception) { failure = error.message?.takeIf { it.isNotBlank() } ?: fallback }
                    finally { creating = false }
                }
            }
        }
    }
    PlaceScaffold(surfaceTitle(session, stringResource(list.title)), onBack, tag = "${list.tag}.screen", actions = {
        BarIconButton(Ionicon.Add, createTitle, ::ask, Modifier.testTag("${list.tag}.new"))
    }) { SurfaceListsContent(list, entries, catalog.loaded, unsupported, onOpen, { scope.launch { refresh() } }, refreshing) }
    prompt?.let { current -> PromptModal(current) { prompt = null } }
    failure?.let { reason -> HappyAlert(Alert(stringResource(R.string.todo_create_failed_title), stringResource(R.string.todo_create_failed, reason),
        listOf(AlertButton(stringResource(R.string.common_ok)))), { failure = null }) }
}
