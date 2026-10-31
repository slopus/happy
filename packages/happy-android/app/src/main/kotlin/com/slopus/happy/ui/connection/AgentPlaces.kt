package com.slopus.happy.ui.connection

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.conversation.ArtifactSummary
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.Todo
import com.slopus.happy.ui.chat.MarkdownView
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.StateArt
import com.slopus.happy.ui.components.StatePage
import com.slopus.happy.ui.conversation.ArtifactRoute
import com.slopus.happy.ui.conversation.ConversationScreenTags
import com.slopus.happy.ui.conversation.conversationRequest
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** The agent's artifacts, home's Artifacts row. */
@Serializable data class AgentArtifactsRoute(val connectionId: String)

/** One Surface the person joined; [name] titles the bar before anything is read. */
@Serializable data class AgentSurfaceRoute(val connectionId: String, val surfaceId: String, val type: String, val name: String)

object AgentPlacesTags {
    const val ARTIFACTS = "agentPlaces.artifacts"
    const val ARTIFACT = "agentPlaces.artifact"
    const val SURFACE = "agentPlaces.surface"
    const val TODO = "agentPlaces.todo"
    const val TODO_FIELD = "agentPlaces.todoField"
    const val DOCUMENT = "agentPlaces.document"
    const val NOTE = "agentPlaces.note"
}

/** What a place screen has read: nothing yet, its content, or why it couldn't, while it has nothing to show. */
sealed interface PlaceRead<out T> {
    data object Reading : PlaceRead<Nothing>
    data class Ready<T>(val value: T) : PlaceRead<T>
    data class Failed(val reason: String) : PlaceRead<Nothing>
}

/** The artifacts read so far and the cursor of the next page; null once there is no more. */
data class ArtifactPages(val items: List<ArtifactSummary>, val next: String?)

/**
 * The artifact catalog, as iOS's `ArtifactsViewController` reads it: the
 * first page, again on every `artifact.*` event; further pages appended as
 * the list nears its end. One read at a time; a read that fails once
 * something is shown keeps what is shown.
 */
internal class ArtifactCatalogReader(private val api: ConversationApi, private val scope: CoroutineScope) {
    private val stateFlow = MutableStateFlow<PlaceRead<ArtifactPages>>(PlaceRead.Reading)
    val state: StateFlow<PlaceRead<ArtifactPages>> = stateFlow.asStateFlow()
    private var reading: Job? = null

    fun read(append: Boolean = false) {
        if (reading?.isActive == true) return
        val shown = (stateFlow.value as? PlaceRead.Ready)?.value
        val cursor = if (append) shown?.next ?: return else null
        reading = scope.launch {
            try {
                val (page, next) = api.artifacts(cursor)
                stateFlow.update { current ->
                    val before = (current as? PlaceRead.Ready)?.value?.items.orEmpty()
                    val known = before.mapTo(HashSet()) { it.id }
                    PlaceRead.Ready(ArtifactPages(if (append) before + page.filter { it.id !in known } else page, next))
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (stateFlow.value !is PlaceRead.Ready) stateFlow.value = PlaceRead.Failed(Conversation.describe(e))
            }
        }
    }

    fun retry() {
        stateFlow.value = PlaceRead.Reading
        read()
    }
}

/** What one Surface shows on the phone: a todo list, a document's Markdown, or a note to open it on the computer. */
sealed interface SurfaceBody {
    data class Todos(val todos: List<Todo>) : SurfaceBody
    data class Document(val markdown: String) : SurfaceBody
    data object Elsewhere : SurfaceBody
}

/**
 * One Surface, as iOS's `SurfaceViewController` reads it: a todo list read
 * again on each event about it and after each todo added; a document read
 * once; any other kind isn't read at all.
 */
internal class SurfaceReader(
    private val api: ConversationApi,
    private val scope: CoroutineScope,
    private val surfaceId: String,
    private val type: String,
) {
    private val stateFlow = MutableStateFlow<PlaceRead<SurfaceBody>>(if (readable) PlaceRead.Reading else PlaceRead.Ready(SurfaceBody.Elsewhere))
    val state: StateFlow<PlaceRead<SurfaceBody>> = stateFlow.asStateFlow()

    private val readable get() = type == TODO || type == DOCUMENT

    /** Whether [event] is about this Surface (iOS keys a Surface's events by `surfaceId`). */
    fun hears(event: AgentEvent): Boolean = event.type == AgentEvent.HELLO ||
        (type == TODO && (event.data["surfaceId"].str ?: event.data["todo"].obj?.get("surfaceId").str) == surfaceId)

    fun read() {
        if (!readable) return
        scope.launch {
            try {
                val body = when (type) {
                    TODO -> SurfaceBody.Todos(api.todos(surfaceId))
                    else -> SurfaceBody.Document(api.document(surfaceId))
                }
                stateFlow.value = PlaceRead.Ready(body)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (stateFlow.value !is PlaceRead.Ready) stateFlow.value = PlaceRead.Failed(Conversation.describe(e))
            }
        }
    }

    fun retry() {
        stateFlow.value = PlaceRead.Reading
        read()
    }

    /** A new todo, then the list read again; blank text adds nothing. */
    fun add(text: String) {
        val words = text.trim()
        if (type != TODO || words.isEmpty()) return
        scope.launch {
            try {
                api.addTodo(surfaceId, ConversationApi.clientId(), words)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
            read()
        }
    }

    companion object {
        const val TODO = "todo"
        const val DOCUMENT = "document"
    }
}

@Composable
internal fun AgentArtifacts(graph: AppGraph, nav: NavHostController, route: AgentArtifactsRoute) {
    val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
    val scope = rememberCoroutineScope()
    val reader = remember(session) { session?.let { ArtifactCatalogReader(ConversationApi(it.conversationRequest()), scope) } }
    LaunchedEffect(reader) {
        if (session == null || reader == null) return@LaunchedEffect
        reader.read()
        session.events.filter { it.type.startsWith("artifact.") || it.type == AgentEvent.HELLO }.collect { reader.read() }
    }
    val read = reader?.state?.collectAsStateWithLifecycle()?.value ?: PlaceRead.Failed(stringResource(R.string.conversation_unavailable))
    ArtifactsScreen(
        read = read,
        onBack = { nav.popBackStack() },
        onOpen = { nav.navigate(ArtifactRoute(route.connectionId, it)) },
        onMore = { reader?.read(append = true) },
        onRetry = { reader?.retry() },
    )
}

@Composable
internal fun AgentSurface(graph: AppGraph, nav: NavHostController, route: AgentSurfaceRoute) {
    val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
    val scope = rememberCoroutineScope()
    val reader = remember(session) { session?.let { SurfaceReader(ConversationApi(it.conversationRequest()), scope, route.surfaceId, route.type) } }
    LaunchedEffect(reader) {
        if (session == null || reader == null) return@LaunchedEffect
        reader.read()
        if (route.type == SurfaceReader.TODO) session.events.filter(reader::hears).collect { reader.read() }
    }
    // The bar keeps up with a rename, as iOS's does.
    val feed = session?.feed?.collectAsStateWithLifecycle()?.value
    val name = feed?.rows?.firstNotNullOfOrNull { (it as? AgentFeedRow.Surface)?.takeIf { s -> s.id == route.surfaceId }?.name } ?: route.name
    val read = reader?.state?.collectAsStateWithLifecycle()?.value ?: PlaceRead.Failed(stringResource(R.string.conversation_unavailable))
    SurfaceScreen(
        name = name,
        read = read,
        onBack = { nav.popBackStack() },
        onAdd = { reader?.add(it) },
        onRetry = { reader?.retry() },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PlacePage(title: String, onBack: () -> Unit, tag: String, content: @Composable () -> Unit) {
    val colors = HappyTheme.colors
    Column(Modifier.fillMaxSize().background(colors.surface).testTag(tag)) {
        TopAppBar(
            title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            navigationIcon = {
                IconButton(onClick = onBack, modifier = Modifier.testTag(ConversationScreenTags.BACK)) {
                    androidx.compose.material3.Icon(MaterialSymbols.ArrowBack, stringResource(R.string.conversation_back))
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = colors.surface,
                scrolledContainerColor = colors.surface,
                titleContentColor = colors.text,
                navigationIconContentColor = colors.text,
            ),
        )
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) { content() }
    }
}

@Composable
private fun <T> PlaceState(read: PlaceRead<T>, failed: String, onRetry: () -> Unit, ready: @Composable (T) -> Unit) {
    when (read) {
        PlaceRead.Reading -> StatePage(title = null, body = null, art = StateArt.Waiting)
        is PlaceRead.Failed -> StatePage(
            title = failed,
            body = read.reason,
            icon = Ionicon.CloudOfflineOutline,
            action = stringResource(R.string.common_retry) to onRetry,
        )
        is PlaceRead.Ready -> ready(read.value)
    }
}

/** The artifact catalog, one titled row each, newest first; a tap opens the artifact. */
@Composable
fun ArtifactsScreen(
    read: PlaceRead<ArtifactPages>,
    onBack: () -> Unit,
    onOpen: (artifactId: String) -> Unit,
    onMore: () -> Unit,
    onRetry: () -> Unit,
) {
    val colors = HappyTheme.colors
    PlacePage(stringResource(R.string.agent_home_artifacts), onBack, AgentPlacesTags.ARTIFACTS) {
        PlaceState(read, stringResource(R.string.agent_artifacts_failed), onRetry) { pages ->
            if (pages.items.isEmpty()) {
                StatePage(title = null, body = stringResource(R.string.agent_artifacts_empty), icon = Ionicon.LayersOutline)
                return@PlaceState
            }
            val untitled = stringResource(R.string.agent_artifacts_untitled)
            LazyColumn(Modifier.fillMaxSize().contentMaxWidth(LocalWindowLayout.current)) {
                itemsIndexed(pages.items, key = { _, it -> it.id }) { index, artifact ->
                    if (index == pages.items.lastIndex && pages.next != null) LaunchedEffect(pages.next) { onMore() }
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 52.dp)
                            .clickable(role = Role.Button) { onOpen(artifact.id) }
                            .padding(horizontal = 16.dp)
                            .testTag(AgentPlacesTags.ARTIFACT),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            artifact.title ?: untitled,
                            style = AgentHomeSpec.title,
                            color = colors.text,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        Icon(Ionicon.ChevronForward, 16.dp, colors.grouped.chevron)
                    }
                    if (index < pages.items.lastIndex) HorizontalDivider(Modifier.padding(start = 16.dp), thickness = 0.5.dp, color = colors.divider)
                }
                item { Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars)) }
            }
        }
    }
}

/**
 * One Surface, kept minimal as on iOS: a todo list shows its todos and
 * takes a new one; a document shows its Markdown, read-only; any other
 * kind says to open it on the computer.
 */
@Composable
fun SurfaceScreen(
    name: String,
    read: PlaceRead<SurfaceBody>,
    onBack: () -> Unit,
    onAdd: (String) -> Unit,
    onRetry: () -> Unit,
) {
    PlacePage(name, onBack, AgentPlacesTags.SURFACE) {
        PlaceState(read, stringResource(R.string.agent_surface_failed), onRetry) { body ->
            when (body) {
                is SurfaceBody.Todos -> TodoList(body.todos, onAdd)
                is SurfaceBody.Document -> if (body.markdown.isBlank()) {
                    PlaceNote(stringResource(R.string.agent_surface_empty_document))
                } else {
                    Column(
                        Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState())
                            .contentMaxWidth(LocalWindowLayout.current)
                            .padding(16.dp)
                            .testTag(AgentPlacesTags.DOCUMENT),
                    ) {
                        MarkdownView(parseMarkdown(body.markdown))
                        Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
                    }
                }
                SurfaceBody.Elsewhere -> PlaceNote(stringResource(R.string.agent_surface_open_on_computer))
            }
        }
    }
}

@Composable
private fun PlaceNote(text: String) {
    Text(
        text,
        style = AgentHomeSpec.timestamp.copy(fontSize = AgentHomeSpec.title.fontSize),
        color = HappyTheme.colors.textSecondary,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 24.dp).testTag(AgentPlacesTags.NOTE),
    )
}

@Composable
private fun TodoList(todos: List<Todo>, onAdd: (String) -> Unit) {
    val colors = HappyTheme.colors
    val done = stringResource(R.string.agent_surface_todo_done)
    val nothing = stringResource(R.string.agent_surface_no_todos)
    LazyColumn(Modifier.fillMaxSize().imePadding().contentMaxWidth(LocalWindowLayout.current)) {
        item(key = "field") { TodoField(onAdd) }
        if (todos.isEmpty()) item(key = "empty") { PlaceNote(nothing) }
        itemsIndexed(todos, key = { _, it -> it.id }) { _, todo ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 44.dp)
                    .padding(horizontal = 16.dp, vertical = 10.dp)
                    .semantics(mergeDescendants = true) { if (todo.done) stateDescription = done }
                    .testTag(AgentPlacesTags.TODO),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(
                    if (todo.done) Ionicon.CheckmarkCircle else Ionicon.EllipseOutline,
                    20.dp,
                    colors.textSecondary,
                    Modifier.padding(top = 1.dp),
                )
                Text(
                    todo.text,
                    style = AgentHomeSpec.title.copy(fontWeight = null, textDecoration = if (todo.done) TextDecoration.LineThrough else null),
                    color = if (todo.done) colors.textSecondary else colors.text,
                    modifier = Modifier.weight(1f),
                )
            }
        }
        item { Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars)) }
    }
}

/** iOS's "Add a todo" field: Done adds what was typed and clears it. */
@Composable
private fun TodoField(onAdd: (String) -> Unit) {
    val colors = HappyTheme.colors
    var text by rememberSaveable { mutableStateOf("") }
    val style = AgentHomeSpec.title.copy(fontWeight = null, color = colors.input.text)
    val placeholder = stringResource(R.string.agent_surface_add_todo)
    BasicTextField(
        value = text,
        onValueChange = { text = it },
        singleLine = true,
        textStyle = style,
        cursorBrush = SolidColor(colors.text),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = {
            onAdd(text)
            text = ""
        }),
        modifier = Modifier
            .fillMaxWidth()
            .padding(16.dp)
            .semantics { contentDescription = placeholder }
            .testTag(AgentPlacesTags.TODO_FIELD),
        decorationBox = { inner ->
            Box(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .background(colors.input.background)
                    .heightIn(min = 44.dp)
                    .padding(horizontal = 12.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (text.isEmpty()) Text(placeholder, style = style.copy(color = colors.input.placeholder), maxLines = 1)
                inner()
            }
        },
    )
}
