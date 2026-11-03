package com.slopus.happy.ui.artifacts

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.LoadingIndicator
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.artifacts.ArtifactListing
import com.slopus.happy.artifacts.ArtifactRef
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.Problem
import com.slopus.happy.ui.conversation.problemText
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.StatePage
import com.slopus.happy.ui.connection.AgentHomeSpec
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

object ArtifactsTags {
    const val LIST = "artifacts.list"
    const val ROW = "artifacts.row"
    const val EMPTY = "artifacts.empty"
    const val FAILED = "artifacts.failed"
}

/**
 * The catalog as read so far: its rows, newest first, the cursor of the
 * next page (null at the end), whether a first read has finished, and
 * whether it failed with nothing to show.
 */
@Immutable
data class ArtifactListState(val items: List<ArtifactRef>, val next: String?, val failed: Boolean = false, val loaded: Boolean = false, val reason: Problem? = null)

/**
 * The artifact catalog, as iOS's `ArtifactsViewController` reads it: the
 * last first page kept offline shows at once, then the first page is read,
 * again on every `artifact.*` event; further pages are appended as the list
 * nears its end. One read at a time. A read that fails while rows show
 * keeps them; with none, it says so with Retry.
 */
class ArtifactCatalogReader(
    private val files: ArtifactClient,
    private val scope: CoroutineScope,
    private val cached: () -> JsonObject? = { null },
    private val keep: (JsonObject) -> Unit = {},
) {
    private val stateFlow = MutableStateFlow(ArtifactListState(emptyList(), null))
    val state: StateFlow<ArtifactListState> = stateFlow.asStateFlow()
    private var reading: Job? = null
    private var starting: Job? = null
    private var started = false
    private var observing = true

    fun resume() {
        observing = true
        if (started) read() else start()
    }

    fun pause() {
        observing = false
        if (starting?.isActive == true) started = false
        starting?.cancel()
        reading?.cancel()
        reading = null
    }

    /** The kept page, then a fresh read; once, however often the screen comes back. */
    fun start() {
        if (started) return
        started = true
        starting = scope.launch {
            val page = withContext(Dispatchers.IO) { cached() }?.let(ArtifactListing::parse)
            if (page != null && !stateFlow.value.loaded) stateFlow.value = ArtifactListState(page.items, page.next, loaded = page.items.isNotEmpty())
            read()
        }
    }

    fun read(append: Boolean = false) {
        if (!observing || reading?.isActive == true) return
        val cursor = if (append) stateFlow.value.next ?: return else null
        reading = scope.launch {
            try {
                val answer = files.catalog(cursor)
                if (!append) withContext(Dispatchers.IO) { keep(answer) }
                val page = ArtifactListing.parse(answer)
                stateFlow.update { current ->
                    val known = current.items.mapTo(HashSet()) { it.id }
                    val items = if (append) current.items + page.items.filter { it.id !in known } else page.items
                    ArtifactListState(items, page.next, loaded = true)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                stateFlow.update { if (it.items.isEmpty()) it.copy(failed = true, loaded = true, reason = Conversation.describe(e)) else it }
            }
        }
    }

    fun retry() {
        stateFlow.update { it.copy(failed = false, loaded = false) }
        read()
    }
}

/**
 * The artifact catalog, one titled row each with a disclosure chevron,
 * newest first; a tap opens the artifact. A loader while the first read
 * runs with nothing kept, "No artifacts yet." for an empty catalog.
 */
@Composable
fun ArtifactsScreen(
    read: ArtifactListState,
    onBack: () -> Unit,
    onOpen: (ArtifactRef) -> Unit,
    onMore: () -> Unit,
    onRetry: () -> Unit,
) {
    val colors = HappyTheme.colors
    PlaceScaffold(stringResource(R.string.artifacts_title), onBack, ArtifactsTags.LIST) {
        when {
            read.items.isEmpty() && read.failed -> StatePage(
                title = stringResource(R.string.agent_artifacts_failed),
                body = read.reason?.let { problemText(it) },
                icon = Ionicon.CloudOfflineOutline,
                action = stringResource(R.string.common_retry) to onRetry,
                tag = ArtifactsTags.FAILED,
            )
            read.items.isEmpty() && !read.loaded -> LoadingIndicator(Modifier.testTag(PlaceTags.LOADER))
            read.items.isEmpty() -> StatePage(title = null, body = stringResource(R.string.artifacts_empty), icon = Ionicon.LayersOutline, tag = ArtifactsTags.EMPTY)
            else -> {
                val untitled = stringResource(R.string.agent_artifacts_untitled)
                LazyColumn(Modifier.fillMaxSize().contentMaxWidth(LocalWindowLayout.current)) {
                    itemsIndexed(read.items, key = { _, it -> it.id }) { index, artifact ->
                        if (index == read.items.lastIndex && read.next != null) LaunchedEffect(read.next) { onMore() }
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(min = 52.dp)
                                .clickable(role = Role.Button) { onOpen(artifact) }
                                .padding(horizontal = 16.dp)
                                .testTag(ArtifactsTags.ROW),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                artifact.title.ifBlank { untitled },
                                style = AgentHomeSpec.title,
                                color = colors.text,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            Icon(Ionicon.ChevronForward, 16.dp, colors.grouped.chevron)
                        }
                        if (index < read.items.lastIndex) HorizontalDivider(Modifier.padding(start = 16.dp), thickness = 0.5.dp, color = colors.divider)
                    }
                    item { Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars)) }
                }
            }
        }
    }
}
