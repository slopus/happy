package com.slopus.happy.ui.todos

import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.EaseInOut
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Geometry stays in the scrolling UI; only the final slot goes to the library.
 * Visible swap slots and offset correction follow Telegram's ItemTouchHelper
 * (3de37c8:813-897); iOS supplies the 350 ms hold, 1.03 lift and 250 ms setdown.
 * See research/telegram-todos.md.
 */
@Stable
internal class TodoDrag(
    private val list: LazyListState,
    private val scope: CoroutineScope,
    private val view: View,
    private val density: Float,
) {
    private data class Held(val id: String, val top: Float, val height: Int, val offset: Float = 0f)
    private var held by mutableStateOf<Held?>(null)
    private var dropping by mutableStateOf<String?>(null)
    private var elevatedId by mutableStateOf<String?>(null)
    private val drop = Animatable(0f)
    private val lift = Animatable(1f)
    private var dropJob: Job? = null
    var order by mutableStateOf<List<String>?>(null)
        private set
    var active: List<String> = emptyList()
    var move: suspend (String, Int) -> Unit = { _, _ -> }
    var reduced = false
    var dragging by mutableStateOf(false)
        private set
    var scrolling by mutableStateOf(false)
        private set

    fun start(point: Offset) {
        val item = list.layoutInfo.visibleItemsInfo.firstOrNull { point.y >= it.offset && point.y < it.offset + it.size && it.key in active } ?: return
        dropJob?.cancel()
        held = Held(item.key as String, item.offset.toFloat(), item.size)
        dragging = true
        elevatedId = item.key as String
        scrolling = scrollSpeed() != 0f
        dropping = null
        order = active
        view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        scope.launch { lift.snapTo(1f); lift.animateTo(if (reduced) 1f else 1.03f, tween(if (reduced) 0 else 200, easing = EaseInOut)) }
    }

    fun drag(delta: Float) {
        held = held?.let { it.copy(offset = it.offset + delta) }
        scrolling = scrollSpeed() != 0f
        place()
    }

    private fun place() {
        val held = held ?: return
        val center = held.top + held.offset + held.height / 2f
        val slot = list.layoutInfo.visibleItemsInfo.filter { it.key in active }.minByOrNull { kotlin.math.abs(it.offset + it.size / 2f - center) }?.key ?: return
        val current = order ?: return
        val from = current.indexOf(held.id)
        val to = current.indexOf(slot)
        if (from < 0 || to < 0 || from == to) return
        order = current.toMutableList().apply { add(to, removeAt(from)) }
        view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    }

    private fun scrollSpeed(): Float {
        val held = held ?: return 0f
        val edge = 56 * density
        val center = held.top + held.offset + held.height / 2f
        val viewport = list.layoutInfo
        return when {
            center < viewport.viewportStartOffset + edge -> -((viewport.viewportStartOffset + edge - center) / edge).coerceIn(0f, 1f)
            center > viewport.viewportEndOffset - edge -> ((center - viewport.viewportEndOffset + edge) / edge).coerceIn(0f, 1f)
            else -> 0f
        }
    }

    suspend fun scroll() {
        val speed = scrollSpeed()
        if (speed != 0f) { list.scrollBy(speed * 12 * density); place() }
    }

    fun stop(cancelled: Boolean) {
        val held = held ?: return
        val offset = held.top + held.offset - (list.layoutInfo.visibleItemsInfo.firstOrNull { it.key == held.id }?.offset ?: held.top.toInt())
        val target = order?.indexOf(held.id) ?: -1
        this.held = null
        dragging = false
        scrolling = false
        dropping = held.id
        if (cancelled) order = null
        view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
        dropJob = scope.launch {
            drop.snapTo(offset)
            if (!cancelled && target >= 0) move(held.id, target)
            launch { lift.animateTo(1f, tween(if (reduced) 0 else 250, easing = CubicBezierEasing(0f, 0f, .58f, 1f))) }
            drop.animateTo(0f, tween(if (reduced) 0 else 250, easing = CubicBezierEasing(0f, 0f, .58f, 1f)))
            dropping = null
            elevatedId = null
            order = null
        }
    }

    fun acknowledge() { if (!dragging && dropping == null && order == active) order = null }

    fun input(enabled: Boolean): Modifier = if (!enabled) Modifier else Modifier.pointerInput(this) {
        detectDragGesturesAfterLongPress(
            onDragStart = ::start,
            onDragEnd = { stop(false) },
            onDragCancel = { stop(true) },
            onDrag = { change, amount -> if (dragging) { change.consume(); drag(amount.y) } },
        )
    }

    fun row(id: String): Modifier = Modifier.zIndex(if (elevatedId == id) 1f else 0f).graphicsLayer {
        val current = held
        val lifted = current?.id == id || dropping == id
        translationY = when {
            current?.id == id -> current.top + current.offset - (list.layoutInfo.visibleItemsInfo.firstOrNull { it.key == id }?.offset ?: current.top.toInt())
            dropping == id -> drop.value
            else -> 0f
        }
        scaleX = if (lifted) lift.value else 1f
        scaleY = scaleX
        shadowElevation = if (lifted && !reduced) 8.dp.toPx() else 0f
    }
}

@Composable
internal fun rememberTodoDrag(list: LazyListState, active: List<String>, reduced: Boolean, move: suspend (String, Int) -> Unit): TodoDrag {
    val scope = rememberCoroutineScope()
    val view = LocalView.current
    val density = LocalDensity.current.density
    val drag = remember(list, scope, view, density) { TodoDrag(list, scope, view, density) }
    drag.active = active
    drag.move = move
    drag.reduced = reduced
    LaunchedEffect(active) { drag.acknowledge() }
    LaunchedEffect(drag.scrolling) {
        while (drag.scrolling) { withFrameNanos { }; drag.scroll() }
    }
    return drag
}