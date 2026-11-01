package com.slopus.happy.ui

import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import com.slopus.happy.diagnostics.traced
import kotlin.math.roundToInt

/**
 * Bench-only first changed incoming placement, relative to the NavHost pane.
 * An animation sample need not be placed or drawn. Compare the actual layout
 * with the slide's initial offset; FrameTimeline still determines whether
 * this frame submitted a buffer and when that buffer reached the display.
 * No state here invalidates composition, layout or drawing.
 */
internal class NavPlacementTrace(
    private val report: (String) -> Unit = { traced("Happy:navFirstPlacement:$it") {} },
) {
    private data class Incoming(val source: String, var initialX: Int, var reported: Boolean = false)
    private val incoming = mutableMapOf<String, Incoming>()
    private var container: LayoutCoordinates? = null

    fun expect(source: String, target: String, initialX: Int) {
        if (source == target) return
        val previous = incoming[target]
        if (previous?.source == source) previous.initialX = initialX
        else incoming[target] = Incoming(source, initialX)
    }

    fun placed(entry: String, x: Float) {
        val movement = incoming[entry] ?: return
        if (!movement.reported && x.roundToInt() != movement.initialX) {
            movement.reported = true
            report(entry)
        }
    }

    fun forget(entry: String) { incoming.remove(entry) }

    fun container(coordinates: LayoutCoordinates) { container = coordinates }

    fun page(entry: String, coordinates: LayoutCoordinates) {
        val parent = container ?: return
        if (parent.isAttached && coordinates.isAttached) placed(entry, parent.localPositionOf(coordinates).x)
    }
}

/** No modifier or callback is installed in production/debug builds. */
internal fun Modifier.traceNavPlacement(dims: PageDims): Modifier =
    dims.placement?.let { trace -> onGloballyPositioned(trace::container) } ?: this