package com.slopus.happy.ui.connection

import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.EaseInOut
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
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
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChangeIgnoreConsumed
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.ConversationKind
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs

/** Whether home lets this chat be carried to another place in its list: a project's or worktree's own chat. */
internal fun AgentFeedRow.Conversation.movable(): Boolean =
    kind == ConversationKind.Project && parentId == null && workspaceId != null

/** [item]'s chat when it is one home lets be carried ([movable]). */
private fun movableChat(item: AgentHomeItem): AgentFeedRow.Conversation? =
    ((item as? AgentHomeItem.Row)?.row as? AgentFeedRow.Conversation)?.takeIf { it.movable() }

/** The chats of [owner]'s list in [items], in the order they stand. */
internal fun homePeers(items: List<AgentHomeItem>, owner: String): List<AgentFeedRow.Conversation> =
    items.mapNotNull { item -> movableChat(item)?.takeIf { it.workspaceId == owner } }

/**
 * Where a screen reader's Move up and Move down put a chat, a place at a
 * time among its list's chats: up, when it is not first, after [upAfter]
 * (null: first); down, when it is not last, after [downAfter].
 */
@Immutable
internal data class HomeRowMoves(val up: Boolean, val upAfter: String?, val down: Boolean, val downAfter: String?)

/** Each movable chat's [HomeRowMoves] in [items], by agent ID; none for a chat alone in its list. */
internal fun homeRowMoves(items: List<AgentHomeItem>): Map<String, HomeRowMoves> = buildMap {
    for (peers in items.mapNotNull(::movableChat).groupBy { it.workspaceId }.values) {
        if (peers.size < 2) continue
        peers.forEachIndexed { index, chat ->
            put(chat.agentId, HomeRowMoves(index > 0, peers.getOrNull(index - 2)?.agentId, index < peers.lastIndex, peers.getOrNull(index + 1)?.agentId))
        }
    }
}

/**
 * [items] with [owner]'s chats in [order] (agent IDs), each with the subtask
 * rows listed under it; those of [folded] left out while it is carried, as
 * iOS folds a carried row's subtasks away. The last row of the run keeps
 * the card's foot. [items] itself, unchanged, when there is nothing to arrange.
 */
internal fun arrangedHomeItems(items: List<AgentHomeItem>, owner: String?, order: List<String>?, folded: String?): List<AgentHomeItem> {
    if (owner == null || order == null) return items
    val start = items.indexOfFirst { movableChat(it)?.workspaceId == owner }
    if (start < 0) return items
    // Each chat of the list with the rows nested under it, up to the first row that is neither.
    val blocks = LinkedHashMap<String, MutableList<AgentHomeItem>>()
    var end = start
    while (end < items.size) {
        val item = items[end]
        val chat = movableChat(item)
        val nested = ((item as? AgentHomeItem.Row)?.row as? AgentFeedRow.Conversation)?.parentId != null
        when {
            chat?.workspaceId == owner -> blocks[chat.agentId] = mutableListOf(item)
            nested && blocks.isNotEmpty() -> blocks.values.last() += item
            else -> break
        }
        end++
    }
    val ordered = order.mapNotNull { blocks[it] } + blocks.filterKeys { it !in order }.values
    val run = ordered.flatMap { block -> if (folded != null && (movableChat(block.first())?.agentId == folded)) block.take(1) else block }
    if (run.map { it.key } == items.subList(start, end).map { it.key }) return items
    // The card's foot stays at the foot of the run.
    val foot = (items[end - 1] as? AgentHomeItem.Row)?.last == true
    val placed = run.mapIndexed { index, item ->
        val row = item as? AgentHomeItem.Row ?: return@mapIndexed item
        val last = foot && index == run.lastIndex
        if (row.last == last) row else row.copy(last = last)
    }
    return items.subList(0, start) + placed + items.subList(end, items.size)
}

/**
 * A project's chat carried to another place in its list on home, as the
 * desktop's tab strip carries its tabs and iOS's sidebar its bots and tasks
 * (8386b4dd5c). A hold opens the chat's preview as before, and the same
 * long press holds the row ([hold]); the finger
 * moving [LIFT] from there closes the preview ([onLift]) and lifts the row
 * (1.03, a shadow), which then follows the finger past its peers, the
 * chats of the same project or worktree, the list scrolling at its edges.
 * Its subtasks fold away while it is carried. Letting go asks for the move
 * ([onReorder]: after the chat now before it, or first), and the list keeps
 * the new order until the feed lists it so.
 *
 * Geometry, swaps and the set-down follow [com.slopus.happy.ui.todos.TodoDrag].
 */
@Stable
class HomeChatDrag internal constructor(
    private val list: LazyListState,
    private val scope: CoroutineScope,
    private val view: View,
    private val density: Float,
) {
    /** The chat in hand: its row's key, its list, where its slot was, how far the finger has carried it. */
    private data class Held(val key: String, val agentId: String, val owner: String, val top: Float, val height: Int, val offset: Float = 0f)

    /** A finger is on the list, so a row's long press can hold it ([hold]). */
    private var pressed = false

    /** Held, but not yet carried: the finger has not moved [LIFT] since the hold. */
    private var armed by mutableStateOf<Held?>(null)
    private var moved = Offset.Zero
    private var held by mutableStateOf<Held?>(null)

    /**
     * The chat carried, its subtasks folded away ([arrange]): it changes as a
     * row lifts and drops, where [held] changes with every move of the finger,
     * which home's list must not compose again for.
     */
    private var carried by mutableStateOf<String?>(null)
    private var dropping by mutableStateOf<String?>(null)
    private var elevated by mutableStateOf<String?>(null)
    private val drop = Animatable(0f)
    private val lift = Animatable(1f)
    private var dropJob: Job? = null
    private var settleJob: Job? = null
    private var before: List<String> = emptyList()

    /** The list being arranged, and the order its chats stand in while carried and until the feed lists them so. */
    var owner by mutableStateOf<String?>(null)
        private set
    var order by mutableStateOf<List<String>?>(null)
        private set
    var items: List<AgentHomeItem> = emptyList()
    var onReorder: ((AgentFeedRow.Conversation, String?) -> Unit)? = null
    var onLift: () -> Unit = {}
    var reduced = false
    var dragging by mutableStateOf(false)
        private set
    var scrolling by mutableStateOf(false)
        private set

    /**
     * A chat is held, carried or not yet: the list must not scroll under the
     * finger, whose first few dp would otherwise start a scroll before the
     * row lifts ([LIFT] is past the touch slop) and take the gesture.
     */
    val holding: Boolean get() = armed != null || dragging

    /** [items] as the list shows them now ([arrangedHomeItems]). */
    fun arrange(items: List<AgentHomeItem>): List<AgentHomeItem> = arrangedHomeItems(items, owner, order, carried)

    /** Whether [key]'s row is in hand or being set down, and so drawn apart from its place ([row]). */
    fun holds(key: String): Boolean = elevated == key

    private fun peers(owner: String): List<String> = homePeers(items, owner).map { it.agentId }

    /**
     * [agentId]'s row is held: its own long press, the one that opens its preview
     * ([AgentHomeList]'s onHold), readies it to be carried. One hold for both, so
     * a preview never opens on a row the finger then cannot carry. A long press
     * with no finger on the list (a screen reader's) holds nothing; a reader
     * moves a chat with its Move up and Move down. The chat is looked up in
     * [items]: a row draws a copy without its list ([AgentFeedRow.Conversation.drawn]).
     */
    fun hold(agentId: String) {
        if (!pressed || onReorder == null) return
        val chat = items.firstNotNullOfOrNull { item -> movableChat(item)?.takeIf { it.agentId == agentId } } ?: return
        val owner = chat.workspaceId ?: return
        if (peers(owner).size < 2) return
        val item = list.layoutInfo.visibleItemsInfo.firstOrNull { it.key == chat.key } ?: return
        armed = Held(chat.key, chat.agentId, owner, item.offset.toFloat(), item.size)
        moved = Offset.Zero
    }

    private fun drag(amount: Offset) {
        armed?.let { waiting ->
            moved += amount
            if (moved.getDistance() < LIFT.value * density) return
            armed = null
            carry(waiting.copy(offset = moved.y))
            return
        }
        held = held?.let { it.copy(offset = it.offset + amount.y) }
        scrolling = scrollSpeed() != 0f
        place()
    }

    private fun carry(start: Held) {
        onLift()
        dropJob?.cancel()
        settleJob?.cancel()
        before = peers(start.owner)
        owner = start.owner
        order = before
        held = start
        carried = start.agentId
        dragging = true
        elevated = start.key
        dropping = null
        view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
        scope.launch { lift.snapTo(1f); lift.animateTo(if (reduced) 1f else 1.03f, tween(if (reduced) 0 else 200, easing = EaseInOut)) }
        scrolling = scrollSpeed() != 0f
        place()
    }

    private fun place() {
        val held = held ?: return
        val current = order ?: return
        val center = held.top + held.offset + held.height / 2f
        val keys = current.associateBy { "agent-$it" }
        val slot = list.layoutInfo.visibleItemsInfo.filter { it.key in keys }.minByOrNull { abs(it.offset + it.size / 2f - center) }?.key ?: return
        val from = current.indexOf(held.agentId)
        val to = current.indexOf(keys[slot])
        if (from < 0 || to < 0 || from == to) return
        order = current.toMutableList().apply { add(to, removeAt(from)) }
        view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    }

    private fun scrollSpeed(): Float {
        val held = held ?: return 0f
        val order = order ?: return 0f
        val edge = 56 * density
        val center = held.top + held.offset + held.height / 2f
        val viewport = list.layoutInfo
        // Under the glass bar the list is still drawn, but nothing there is a place to put a row.
        val top = maxOf(viewport.viewportStartOffset, 0)
        val end = viewport.viewportEndOffset
        // Only toward a place in the chat's own list not yet shown whole: past its list the
        // list would scroll the chat's slot away, and the row in hand would go with it.
        fun shown(agentId: String?) = viewport.visibleItemsInfo.firstOrNull { it.key == "agent-$agentId" }
            ?.let { it.offset >= top && it.offset + it.size <= end } == true
        return when {
            center < top + edge && !shown(order.firstOrNull()) -> -((top + edge - center) / edge).coerceIn(0f, 1f)
            center > end - edge && !shown(order.lastOrNull()) -> ((center - end + edge) / edge).coerceIn(0f, 1f)
            else -> 0f
        }
    }

    suspend fun scroll() {
        val speed = scrollSpeed()
        // Once the chat's list is shown whole the scrolling stops, till the finger moves again.
        scrolling = speed != 0f
        if (speed != 0f) { list.scrollBy(speed * 12 * density); place() }
    }

    private fun stop(cancelled: Boolean) {
        armed = null
        val held = held ?: return
        val offset = held.top + held.offset - (list.layoutInfo.visibleItemsInfo.firstOrNull { it.key == held.key }?.offset ?: held.top.toInt())
        // A chat that left the list while this one was carried (archived on another
        // device) is no place to go after, and the feed will never list it again.
        val listed = peers(held.owner).toSet()
        val placed = order?.filter { it in listed }
        val final = placed.takeIf { !cancelled && it != before.filter { id -> id in listed } }
        val chat = items.firstNotNullOfOrNull { movableChat(it)?.takeIf { chat -> chat.agentId == held.agentId } }
        this.held = null
        carried = null
        dragging = false
        scrolling = false
        dropping = held.key
        if (final == null) {
            order = null
            owner = null
        } else {
            order = final
        }
        view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
        dropJob = scope.launch {
            drop.snapTo(offset)
            if (final != null && chat != null) onReorder?.invoke(chat, final.getOrNull(final.indexOf(held.agentId) - 1))
            launch { lift.animateTo(1f, tween(if (reduced) 0 else 250, easing = CubicBezierEasing(0f, 0f, .58f, 1f))) }
            drop.animateTo(0f, tween(if (reduced) 0 else 250, easing = CubicBezierEasing(0f, 0f, .58f, 1f)))
            dropping = null
            elevated = null
        }
        // The move stands until the feed lists it so ([acknowledge]); a refusal, or another
        // device moving the list meanwhile, never does, and then the feed's own order shows.
        if (final != null) settleJob = scope.launch {
            delay(SETTLE_MILLIS)
            if (!dragging) { order = null; owner = null }
        }
    }

    /** Lets go of the order once the feed lists the list's chats in it. */
    fun acknowledge() {
        val owner = owner ?: return
        if (!dragging && order == peers(owner)) {
            order = null
            this.owner = null
            settleJob?.cancel()
        }
    }

    /**
     * The finger on the list, read before its rows see it (the Initial pass).
     * Until a row is held ([hold]) nothing is taken, so the list scrolls and a
     * row swipes as before. From the hold on the finger is the drag's: the held
     * row takes every event once its long press fires, so a drag reading the
     * finger after the row would only ever find it taken.
     */
    fun input(): Modifier = Modifier.pointerInput(this) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            pressed = true
            try {
                while (true) {
                    val event = awaitPointerEvent(PointerEventPass.Initial)
                    val change = event.changes.firstOrNull { it.id == down.id }
                    val ours = armed != null || held != null
                    if (change == null || !change.pressed) {
                        // A gesture the window cancels comes as an up already taken.
                        val cancelled = change == null || change.isConsumed
                        if (ours) {
                            if (!cancelled) event.changes.forEach { it.consume() }
                            stop(cancelled)
                        }
                        break
                    }
                    if (ours) {
                        // Held, the list neither scrolls nor swipes a row under the finger.
                        val amount = change.positionChangeIgnoreConsumed()
                        event.changes.forEach { it.consume() }
                        if (amount != Offset.Zero) drag(amount)
                    }
                }
            } catch (c: CancellationException) {
                if (armed != null || held != null) stop(true)
                throw c
            } finally {
                pressed = false
            }
        }
    }

    /** The carried row drawn over the others, where the finger has it, lifted; set down after. */
    fun row(key: String): Modifier = Modifier.zIndex(if (elevated == key) 1f else 0f).graphicsLayer {
        val current = held
        val lifted = current?.key == key || dropping == key
        translationY = when {
            current?.key == key -> current.top + current.offset - (list.layoutInfo.visibleItemsInfo.firstOrNull { it.key == key }?.offset ?: current.top.toInt())
            dropping == key -> drop.value
            else -> 0f
        }
        scaleX = if (lifted) lift.value else 1f
        scaleY = scaleX
        shadowElevation = if (lifted && !reduced) 8.dp.toPx() else 0f
    }

    companion object {
        /** How far the finger moves from a hold before the row lifts and the preview closes (iOS's 10 pt). */
        val LIFT = 10.dp

        /** How long a dropped order stands without the feed listing it so. */
        const val SETTLE_MILLIS = 3_000L
    }
}

@Composable
internal fun rememberHomeChatDrag(
    list: LazyListState,
    items: List<AgentHomeItem>,
    reduced: Boolean,
    onReorder: ((AgentFeedRow.Conversation, String?) -> Unit)?,
    onLift: () -> Unit,
): HomeChatDrag {
    val scope = rememberCoroutineScope()
    val view = LocalView.current
    val density = LocalDensity.current.density
    val drag = remember(list, scope, view, density) { HomeChatDrag(list, scope, view, density) }
    drag.items = items
    drag.onReorder = onReorder
    drag.onLift = onLift
    drag.reduced = reduced
    LaunchedEffect(items) { drag.acknowledge() }
    LaunchedEffect(drag.scrolling) {
        while (drag.scrolling) { withFrameNanos { }; drag.scroll() }
    }
    return drag
}
