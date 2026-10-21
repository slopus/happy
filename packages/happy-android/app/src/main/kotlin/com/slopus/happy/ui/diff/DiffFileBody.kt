package com.slopus.happy.ui.diff

import androidx.compose.foundation.ScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.staticCompositionLocalOf
import com.slopus.happy.diff.DiffFile
import com.slopus.happy.diff.DiffLayout
import com.slopus.happy.diff.DiffRow
import com.slopus.happy.diff.syntax.DiffSyntax
import com.slopus.happy.diff.syntax.SyntaxService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.ConcurrentHashMap

/**
 * The syntax queue diffs colour through; null draws them plain
 * (happy-app's `DiffSyntaxEnabled` context).
 */
val LocalDiffSyntax = staticCompositionLocalOf<SyntaxService?> { SyntaxService.Shared }

/**
 * One file's rows as DiffFileView shows them: the collapse
 * (`selectVisibleRows`), syntax colour laid over the shown rows
 * (usePreparedSyntax / useSyntaxRequests), "show more"
 * (useSyntaxExpansion) and the horizontal scroll every row of the file
 * shares. Held outside composition so a lazy list can draw the rows as
 * items.
 *
 * Syntax gate: until the shown rows' hunks are coloured, or
 * [DiffSyntax.REVEAL_MS] has passed, [pending] is true and the rows are laid
 * out but invisible, so the first paint is coloured or, at the cap, plain.
 * Once painted, nothing blanks or recolours them again: later changes use
 * whatever is cached, and late results only fill the cache.
 */
@Stable
class DiffFileBody(
    val file: DiffFile,
    private val showHunkHeaders: Boolean = true,
    private val collapseAfter: Int = 400,
    private val syntax: SyntaxService? = null,
) {
    var expanded by mutableStateOf(false)
        private set

    /** Waiting, up to [DiffSyntax.REVEAL_MS], for the rest of the file's colour before expanding. */
    var expanding by mutableStateOf(false)
        private set

    private val selection get() = DiffLayout.selectVisibleRows(file.rows, showHunkHeaders, expanded, collapseAfter)

    var hiddenCount by mutableIntStateOf(selection.hiddenCount)
        private set

    /** The rows to draw, coloured where the syntax arrived in time. */
    var rows by mutableStateOf(selection.rows)
        private set

    var pending by mutableStateOf(false)
        private set

    /** Shared by every row of the file, so the code slides as one under the pinned gutter. */
    val scroll = ScrollState(0)

    private var revealed = false
    private var pendingSince: Long? = null
    private var job: Job? = null
    private var scope: CoroutineScope? = null

    init {
        // Decided before the first frame, so a cached file paints coloured and
        // an uncached one never flashes plain.
        val displayed = rows
        val plan = plan(displayed)
        val cached = cached(plan)
        if (cached.isNotEmpty()) rows = DiffSyntax.apply(displayed, plan, cached)
        pending = cached.size < plan.size
        if (!pending) revealed = true
    }

    private fun plan(displayed: List<DiffRow>) = if (syntax == null) emptyList() else DiffSyntax.plan(file, displayed)

    private fun cached(plan: List<DiffSyntax.Hunk>): Map<DiffSyntax.Input, DiffSyntax.Result> {
        val service = syntax ?: return emptyMap()
        return plan.mapNotNull { hunk -> service.peek(hunk.input)?.let { hunk.input to it } }.toMap()
    }

    /** Starts the syntax requests in [scope] (the composition's); [stop] cancels them. */
    fun start(scope: CoroutineScope) {
        if (job != null) return
        this.scope = scope
        job = scope.launch {
            snapshotFlow { expanded }.collectLatest { prepare(selection) }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        scope = null
    }

    private suspend fun prepare(selected: DiffLayout.VisibleRows) {
        val displayed = selected.rows
        hiddenCount = selected.hiddenCount
        val service = syntax
        val plan = plan(displayed)
        val outcomes = ConcurrentHashMap(cached(plan))
        fun publish() {
            rows = if (outcomes.isEmpty()) displayed else DiffSyntax.apply(displayed, plan, HashMap(outcomes))
            pending = false
            revealed = true
            pendingSince = null
        }
        if (service == null || outcomes.size == plan.size) return publish()
        val missing = plan.filter { !outcomes.containsKey(it.input) }
        if (revealed) {
            // Painted already: what is cached now, and the rest only warms the cache.
            publish()
            kotlinx.coroutines.coroutineScope { for (hunk in missing) launch { service.highlight(hunk.input) } }
            return
        }
        rows = displayed
        pending = true
        val started = pendingSince ?: System.currentTimeMillis().also { pendingSince = it }
        kotlinx.coroutines.coroutineScope {
            val requests = missing.map { hunk -> launch { outcomes[hunk.input] = service.highlight(hunk.input) } }
            withTimeoutOrNull(maxOf(0L, DiffSyntax.REVEAL_MS - (System.currentTimeMillis() - started))) { requests.joinAll() }
            publish()
        }
    }

    /**
     * useSyntaxExpansion: show the collapsed rest. When some of the file's
     * hunks have no colour yet, keep the rows already painted and wait for
     * them (up to [DiffSyntax.REVEAL_MS], [expanding] meanwhile), so the new
     * rows arrive coloured.
     */
    fun expand() {
        if (expanding || expanded) return
        val service = syntax
        val scope = scope
        val missing = if (service == null) emptyList() else DiffSyntax.plan(file, file.rows).filter { service.peek(it.input) == null }
        if (service == null || scope == null || missing.isEmpty()) {
            expanded = true
            return
        }
        expanding = true
        scope.launch {
            try {
                val requests = missing.map { hunk -> launch { service.highlight(hunk.input) } }
                withTimeoutOrNull(DiffSyntax.REVEAL_MS) { requests.joinAll() }
            } finally {
                expanding = false
                expanded = true
            }
        }
    }
}

/** A [DiffFileBody] for [file], started with the composition and stopped when it leaves. */
@Composable
fun rememberDiffFileBody(file: DiffFile, showHunkHeaders: Boolean = true, collapseAfter: Int = 400): DiffFileBody {
    val syntax = LocalDiffSyntax.current
    val scope = rememberCoroutineScope()
    val body = remember(file, showHunkHeaders, collapseAfter, syntax) { DiffFileBody(file, showHunkHeaders, collapseAfter, syntax) }
    DisposableEffect(body) {
        body.start(scope)
        onDispose { body.stop() }
    }
    return body
}
