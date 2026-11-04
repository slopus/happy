package com.slopus.happy.ui.connection

import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.ui.surfaces.SeedlingEmpty
import com.slopus.happy.R
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.Problem
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.Todo
import com.slopus.happy.ui.artifacts.PlaceTags
import com.slopus.happy.ui.components.LoadingIndicator
import com.slopus.happy.ui.artifacts.PlaceMessage
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.chat.MarkdownView
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.StatePage
import com.slopus.happy.ui.conversation.conversationRequest
import com.slopus.happy.ui.conversation.problemText
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

object AgentPlacesTags {
    const val SURFACE = "agentPlaces.surface"
    const val TODO = "agentPlaces.todo"
    const val TODO_FIELD = "agentPlaces.todoField"
    const val DOCUMENT = "agentPlaces.document"
}

/** What a place screen has read: nothing yet, its content, or why it couldn't, while it has nothing to show. */
sealed interface PlaceRead<out T> {
    data object Reading : PlaceRead<Nothing>
    data class Ready<T>(val value: T) : PlaceRead<T>
    data class Failed(val reason: Problem) : PlaceRead<Nothing>
}

/** What one Surface shows on the phone: a todo list, a document's Markdown, or a note to open it on the computer. */
sealed interface SurfaceBody {
    data class Todos(val todos: List<Todo>) : SurfaceBody
    data class Document(val markdown: String) : SurfaceBody
    data object Elsewhere : SurfaceBody

    /** As kept on the phone ([parse] reads it back). */
    fun json(): JsonObject = buildJsonObject {
        when (this@SurfaceBody) {
            is Todos -> putJsonArray("todos") {
                todos.forEach { todo -> add(buildJsonObject { put("id", todo.id); put("text", todo.text); put("done", todo.done) }) }
            }
            is Document -> put("markdown", markdown)
            Elsewhere -> Unit
        }
    }

    companion object {
        fun parse(value: JsonObject): SurfaceBody? = when {
            value["todos"] != null -> Todos(value["todos"].arr.orEmpty().mapNotNull { item ->
                val o = item.obj ?: return@mapNotNull null
                Todo(o["id"].str ?: return@mapNotNull null, o["text"].str.orEmpty(), o["done"].bool == true)
            })
            value["markdown"] != null -> Document(value["markdown"].str.orEmpty())
            else -> null
        }
    }
}

/**
 * One Surface, as iOS's `SurfaceViewController` reads it: a todo list read
 * again on each event about it and after each todo added; a document read
 * once and on each pull; any other kind isn't read at all.
 */
internal class SurfaceReader(
    private val api: ConversationApi,
    private val scope: CoroutineScope,
    private val surfaceId: String,
    private val type: String,
    /** What was last read, kept with the connection: shown first, offline included. */
    private val cached: () -> JsonObject? = { null },
    private val keep: (JsonObject) -> Unit = {},
) {
    private var reading: kotlinx.coroutines.Job? = null
    private val stateFlow = MutableStateFlow<PlaceRead<SurfaceBody>>(if (readable) PlaceRead.Reading else PlaceRead.Ready(SurfaceBody.Elsewhere))
    val state: StateFlow<PlaceRead<SurfaceBody>> = stateFlow.asStateFlow()

    private val readable get() = type == TODO || type == DOCUMENT

    /** Whether [event] is about this Surface (iOS keys a Surface's events by `surfaceId`). */
    fun hears(event: AgentEvent): Boolean = event.type == AgentEvent.HELLO ||
        (type == TODO && (event.data["surfaceId"].str ?: event.data["todo"].obj?.get("surfaceId").str) == surfaceId)

    fun read() {
        reading?.cancel()
        reading = scope.launch { restore(); refresh() }
    }

    fun pauseReads() { reading?.cancel() }

    /** One read, returning once it has landed or failed; what a pull waits on. */
    suspend fun refresh() {
        if (!readable) return
        try {
            val body = when (type) {
                TODO -> SurfaceBody.Todos(api.todos(surfaceId))
                else -> SurfaceBody.Document(api.document(surfaceId))
            }
            stateFlow.value = PlaceRead.Ready(body)
            withContext(Dispatchers.IO) { keep(body.json()) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (stateFlow.value !is PlaceRead.Ready) stateFlow.value = PlaceRead.Failed(Conversation.describe(e))
        }
    }

    /** What was kept, read off the main thread, while nothing newer is on screen. */
    private suspend fun restore() {
        if (!readable || stateFlow.value is PlaceRead.Ready) return
        val kept = withContext(Dispatchers.IO) { cached() }?.let(SurfaceBody::parse) ?: return
        if (stateFlow.value !is PlaceRead.Ready) stateFlow.value = PlaceRead.Ready(kept)
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
            refresh()
        }
    }

    companion object {
        const val TODO = "todo"
        const val DOCUMENT = "document"
    }
}

/**
 * A todo list or document read whole ([SurfaceReader]), shown by
 * [SurfaceScreen]; the bar keeps up with a rename, as iOS's does.
 */
@Composable
internal fun ReadSurface(session: AgentSession, surfaceId: String, type: String, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val reader = remember(session, surfaceId, type) {
        SurfaceReader(
            ConversationApi(session.conversationRequest()), scope, surfaceId, type,
            cached = { session.cachedResource("surface$surfaceId") },
            keep = { value -> session.keepResource("surface$surfaceId", value) },
        )
    }
    com.slopus.happy.ui.components.StartedEffect(reader) {
        reader.read()
        try {
            if (type == SurfaceReader.TODO) session.events.filter(reader::hears).collect { reader.read() }
            else kotlinx.coroutines.awaitCancellation()
        } finally { reader.pauseReads() }
    }
    val name = session.surface(surfaceId).collectAsStateWithLifecycle(null).value?.name.orEmpty()
    val read = reader.state.collectAsStateWithLifecycle().value
    SurfaceScreen(
        name = name,
        read = read,
        onBack = onBack,
        onAdd = { reader.add(it) },
        onRetry = { reader.retry() },
        onRefresh = { reader.refresh() },
        actions = { com.slopus.happy.ui.surfaces.SurfaceMenu(session, surfaceId, onBack) },
    )
}

/**
 * One Surface, kept minimal as on iOS: a todo list shows its todos live and
 * takes a new one; a document shows its Markdown, read-only, read again on
 * a pull; any other kind says to open it on the computer.
 */
@Composable
fun SurfaceScreen(
    name: String,
    read: PlaceRead<SurfaceBody>,
    onBack: () -> Unit,
    onAdd: (String) -> Unit,
    onRetry: () -> Unit,
    onRefresh: suspend () -> Unit = {},
    actions: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit = {},
) {
    PlaceScaffold(name, onBack, AgentPlacesTags.SURFACE, actions = actions) {
        when (read) {
            PlaceRead.Reading -> LoadingIndicator(Modifier.testTag(PlaceTags.LOADER))
            is PlaceRead.Failed -> StatePage(
                title = stringResource(R.string.agent_surface_failed),
                body = problemText(read.reason),
                icon = Ionicon.CloudOfflineOutline,
                action = stringResource(R.string.common_retry) to onRetry,
            )
            is PlaceRead.Ready -> when (val body = read.value) {
                is SurfaceBody.Todos -> TodoList(body.todos, onAdd)
                is SurfaceBody.Document -> SurfaceDocument(body.markdown, onRefresh)
                SurfaceBody.Elsewhere -> SeedlingEmpty(stringResource(R.string.agent_surface_open_on_computer))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SurfaceDocument(markdown: String, onRefresh: suspend () -> Unit) {
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
            refreshing = true
            scope.launch {
                try {
                    onRefresh()
                } finally {
                    refreshing = false
                }
            }
        },
        modifier = Modifier.fillMaxSize(),
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .contentMaxWidth(LocalWindowLayout.current)
                .testTag(AgentPlacesTags.DOCUMENT),
        ) {
            if (markdown.isBlank()) {
                PlaceMessage(stringResource(R.string.agent_surface_empty_document))
            } else {
                Box(Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 16.dp)) { MarkdownView(parseMarkdown(markdown)) }
            }
            Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
        }
    }
}

/** iOS's `TodoLayout`: the field 12 under the bar, then the rows 8 under it; with none, a note 24 under. */
@Composable
private fun TodoList(todos: List<Todo>, onAdd: (String) -> Unit) {
    val colors = HappyTheme.colors
    val done = stringResource(R.string.agent_surface_todo_done)
    val nothing = stringResource(R.string.agent_surface_no_todos)
    val style = happyTextStyle(fontSize = 16, lineHeight = 21)
    LazyColumn(Modifier.fillMaxSize().imePadding().contentMaxWidth(LocalWindowLayout.current)) {
        item(key = "field") { TodoField(onAdd) }
        if (todos.isEmpty()) item(key = "empty") { PlaceMessage(nothing, Modifier.padding(top = 16.dp)) }
        items(todos, key = { it.id }) { todo ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 44.dp)
                    .padding(horizontal = 16.dp, vertical = 10.dp)
                    .semantics(mergeDescendants = true) { if (todo.done) stateDescription = done }
                    .testTag(AgentPlacesTags.TODO),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(if (todo.done) Ionicon.CheckmarkCircle else Ionicon.EllipseOutline, 22.dp, colors.textSecondary)
                Text(
                    todo.text,
                    style = style.copy(textDecoration = if (todo.done) TextDecoration.LineThrough else null),
                    color = if (todo.done) colors.textSecondary else colors.text,
                    modifier = Modifier.weight(1f),
                )
            }
        }
        item { Spacer(Modifier.padding(bottom = 16.dp).windowInsetsBottomHeight(WindowInsets.navigationBars)) }
    }
}

/** iOS's "Add a todo" field: Done adds what was typed and clears it. */
@Composable
private fun TodoField(onAdd: (String) -> Unit) {
    val colors = HappyTheme.colors
    var text by rememberSaveable { mutableStateOf("") }
    val style = happyTextStyle(fontSize = 16, lineHeight = 21).copy(color = colors.input.text)
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
            .padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 8.dp)
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
