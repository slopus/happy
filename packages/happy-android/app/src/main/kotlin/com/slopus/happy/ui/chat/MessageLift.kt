package com.slopus.happy.ui.chat

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.text.selection.rememberSelectionState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.toSize
import androidx.compose.ui.util.lerp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.PageBackHandler
import com.slopus.happy.ui.components.glassBlurs
import com.slopus.happy.ui.theme.HappyTheme
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * A held message lifted over the blurred, dimmed chat (iOS 8c2a92172;
 * Telegram's `ContextControllerExtractedPresentationNode`): its numbers.
 */
object MessageLiftSpec {
    /** `contentActionsSpacing`: the menu this far under the message. */
    val spacing = 7.dp
    val topInset = 8.dp
    val bottomInset = 10.dp
    /** `actionsEdgeInset`: the menu this far in from the screen's sides. */
    val edgeInset = 12.dp
    /** The menu leans this far in from the message's leading or trailing edge. */
    val leadingInset = 2.dp
    val trailingInset = 7.dp
    /** The least a message cut to the room is given. */
    val minimumHeight = 200.dp

    /** `makeSpringBounceAnimation`: mass 5, stiffness 900, damping 104. */
    const val SPRING_MASS = 5f
    const val SPRING_STIFFNESS = 900f
    const val SPRING_DAMPING = 104f
    val dampingRatio = SPRING_DAMPING / (2 * sqrt(SPRING_STIFFNESS * SPRING_MASS))
    const val stiffness = SPRING_STIFFNESS / SPRING_MASS

    const val BACKDROP_MS = 200
    const val MENU_FADE_MS = 50
    const val DISMISS_MS = 200

    /**
     * The veil over the chat above the composer, which stays sharp: light a
     * white frost (iOS's `.light` blur reads grey under its `0x000a26` dim,
     * and the light chat should read white), dark black at 0.6 as iOS's.
     */
    val dimLight = Color.White.copy(alpha = 0.6f)
    val dimDark = Color.Black.copy(alpha = 0.6f)
    val blur = 12.dp

    /** A card's shadow on the white veil: just enough to part white from white. */
    val cardShadow = Color.Black.copy(alpha = 0.08f)
    val cardShadowRadius = 12.dp
    val cardShadowY = 2.dp
    /** The menu's, lower than a pressed copy menu's 8: its shade stays off the composer under it. */
    val menuElevation = 4.dp

    /** An answer lifts on a card, 8 in from the row's sides. */
    val cardInset = 8.dp
    val cardRadius = 18.dp
}

object MessageLiftTags {
    const val SCRIM = "messageLift.scrim"
    const val MESSAGE = "messageLift.message"
    const val MENU = "messageLift.menu"
    const val COPY = "messageLift.copy"
    const val SELECT = "messageLift.select"
}

/**
 * Where a lifted message and its menu go ([MessageLiftSpec]), in pixels: the
 * message stays where it was, its menu [MessageLiftSpec.spacing] under it.
 * When the two run past the foot both move up, never above the top. A
 * message taller than the room the menu leaves is cut to it, at least
 * [MessageLiftSpec.minimumHeight], centred on where it was; its viewport
 * starts [offset] into it. The menu hangs from the message's leading edge
 * for one on the leading half, from its trailing edge otherwise, and keeps
 * [MessageLiftSpec.edgeInset] from the sides.
 */
class MessageLiftLayout(val viewport: Rect, val offset: Float, val menu: Rect) {
    companion object {
        fun of(screen: Size, top: Float, bottom: Float, source: Rect, menu: Size, leading: Boolean, px: (androidx.compose.ui.unit.Dp) -> Float): MessageLiftLayout {
            val ceiling = top + px(MessageLiftSpec.topInset)
            val floorY = screen.height - bottom - px(MessageLiftSpec.bottomInset)
            val menuRoom = if (menu.height > 0) px(MessageLiftSpec.spacing) + menu.height else 0f
            val room = floorY - ceiling - menuRoom
            var y = source.top
            var height = source.height
            if (source.height > room) {
                height = max(room, min(source.height, px(MessageLiftSpec.minimumHeight)))
                y = floor(source.center.y - height / 2)
            }
            if (y < ceiling) y = ceiling
            if (y + height + menuRoom > floorY) y = floorY - height - menuRoom
            if (y < ceiling) y = ceiling
            val viewport = Rect(source.left, y, source.right, y + height)
            val offset = min(max(0f, y - source.top), max(0f, source.height - height))
            var x = if (leading) viewport.left + px(MessageLiftSpec.leadingInset) else viewport.right - px(MessageLiftSpec.trailingInset) - menu.width
            x = max(px(MessageLiftSpec.edgeInset), min(screen.width - px(MessageLiftSpec.edgeInset) - menu.width, x))
            return MessageLiftLayout(viewport, offset, Rect(Offset(x, viewport.bottom + px(MessageLiftSpec.spacing)), menu))
        }
    }
}

/**
 * The chat's held message, if any: a row lifts itself ([LiftSource.lift])
 * and [MessageLiftOverlay] draws it over the chat, from the drawing the row
 * keeps recording, so a streaming answer goes on streaming while lifted.
 */
@Stable
class MessageLift {
    class Lifted internal constructor(
        val key: String,
        internal val layer: GraphicsLayer,
        internal val source: Rect,
        val text: String,
        val actions: List<CopyMenuAction>,
        internal val card: Boolean,
        internal val selectable: @Composable () -> Unit,
        internal val select: LiftSelection? = null,
    )

    var lifted by mutableStateOf<Lifted?>(null)
        private set

    /** Select was chosen: the words are laid out again with handles on them. */
    var selecting by mutableStateOf(false)
        internal set

    internal var closing by mutableStateOf(false)
        private set

    /** How far the chat behind has blurred and dimmed, 0 to 1. */
    internal val backdrop = Animatable(0f)

    /** The composer's top in the window ([liftClear]): below it nothing is veiled. NaN without one. */
    internal var clear by mutableFloatStateOf(Float.NaN)

    /** Whether row [key] is lifted, and so drawn by the overlay, not in place. */
    fun hides(key: String): Boolean = lifted?.key == key

    internal fun open(lifted: Lifted) {
        this.lifted = lifted
        selecting = false
        closing = false
    }

    /** Puts the message back in its row. */
    fun close() {
        if (lifted != null) closing = true
    }

    internal fun done(lifted: Lifted) {
        if (this.lifted === lifted) {
            this.lifted = null
            selecting = false
            closing = false
        }
    }
}

val LocalMessageLift = staticCompositionLocalOf<MessageLift?> { null }

/** A row that can lift: where it is, and its drawing ([liftSource]). */
@Stable
class LiftSource internal constructor(private val key: String, private val lift: MessageLift, internal val layer: GraphicsLayer) {
    internal var coordinates: LayoutCoordinates? = null

    internal fun hides(): Boolean = lift.hides(key)

    /**
     * Lifts the row: [text] is what Copy takes; [selectable] lays its words
     * out to select, as wide as the row; Select takes [select], or all of it.
     */
    fun lift(text: String, actions: List<CopyMenuAction> = emptyList(), card: Boolean = false, select: LiftSelection? = null, selectable: @Composable () -> Unit) {
        val at = coordinates?.takeIf { it.isAttached } ?: return
        lift.open(MessageLift.Lifted(key, layer, Rect(at.positionInRoot(), at.size.toSize()), text, actions, card, selectable, select))
    }
}

/**
 * What Select takes when it isn't everything: [range] in the [occurrence]th
 * selectable text reading [text] (an inline code span held, desktop 3e08585d).
 */
class LiftSelection(val text: String, val occurrence: Int, val range: TextRange)

/** The lift for row [key], when the chat has one ([LocalMessageLift]). */
@Composable
fun rememberLiftSource(key: String): LiftSource? {
    val lift = LocalMessageLift.current ?: return null
    val layer = rememberGraphicsLayer()
    return remember(key, lift, layer) { LiftSource(key, lift, layer) }
}

/**
 * The row's drawing, recorded for [source] each time it is drawn. While
 * lifted it is still recorded, not drawn here: the lift draws it. (A layer
 * left unrecorded once nothing draws it loses its drawing.)
 */
fun Modifier.liftSource(source: LiftSource?): Modifier = if (source == null) this else this
    .onPlaced { source.coordinates = it }
    .drawWithContent {
        source.layer.record { this@drawWithContent.drawContent() }
        if (!source.hides()) drawLayer(source.layer)
    }

/** The composer, which a lift leaves sharp and unveiled: the veil stops at its top. */
fun Modifier.liftClear(lift: MessageLift): Modifier = onGloballyPositioned { lift.clear = it.positionInRoot().y }

/** The chat behind a lifted message, blurred as it dims ([MessageLift.backdrop]); not the composer. */
fun Modifier.liftBackdrop(lift: MessageLift, blur: Float): Modifier = graphicsLayer {
    val p = lift.backdrop.value
    renderEffect = if (p > 0f && glassBlurs()) BlurEffect(blur * p, blur * p, TileMode.Decal) else null
}

/**
 * The lifted message over this box, which fills the screen: the dim, the
 * message on Telegram's spring from where it was to where it fits, and its
 * menu (Copy, Select, then the row's own) growing out of its edge. A tap
 * outside or Back puts it back over 0.2 s. Select lays its words out again
 * in a SelectionContainer, all of them selected, with the system's handles
 * and toolbar.
 */
@Composable
fun BoxScope.MessageLiftOverlay(lift: MessageLift) {
    val lifted = lift.lifted ?: return
    val density = LocalDensity.current
    val colors = HappyTheme.colors
    val copy = rememberCopyText()
    val place = remember(lifted) { Animatable(0f) }
    val menuIn = remember(lifted) { Animatable(0f) }
    val closing = lift.closing
    LaunchedEffect(lifted, closing) {
        if (!closing) {
            coroutineScope {
                launch { lift.backdrop.animateTo(1f, tween(MessageLiftSpec.BACKDROP_MS)) }
                launch { menuIn.animateTo(1f, spring(MessageLiftSpec.dampingRatio, MessageLiftSpec.stiffness)) }
                launch { place.animateTo(1f, spring(MessageLiftSpec.dampingRatio, MessageLiftSpec.stiffness)) }
            }
        } else {
            coroutineScope {
                launch { menuIn.animateTo(0f, tween(MessageLiftSpec.MENU_FADE_MS)) }
                launch { lift.backdrop.animateTo(0f, tween(MessageLiftSpec.DISMISS_MS, easing = FastOutSlowInEasing)) }
                launch { place.animateTo(0f, tween(MessageLiftSpec.DISMISS_MS, easing = FastOutSlowInEasing)) }
            }
            lift.done(lifted)
        }
    }
    PageBackHandler { lift.close() }
    // What measuring worked out, for the frames that only draw.
    val placed = remember(lifted) { arrayOf(MessageLiftLayout(Rect.Zero, 0f, Rect.Zero)) }
    val menuSize = remember(lifted) { arrayOf(Size.Zero) }
    var scrolled by remember(lifted) { mutableFloatStateOf(0f) }
    val top = WindowInsets.statusBars.getTop(density).toFloat()
    val bottom = WindowInsets.navigationBars.getBottom(density).toFloat()
    val dim = if (colors.dark) MessageLiftSpec.dimDark else MessageLiftSpec.dimLight
    val shadow = if (colors.dark) Color.Transparent else MessageLiftSpec.cardShadow
    val selecting = lift.selecting && !closing
    // This box's top in the window, as placing found it, for the veil's foot.
    val origin = remember { floatArrayOf(0f) }
    Layout(
        contents = listOf(
            {
                Box(
                    Modifier
                        .testTag(MessageLiftTags.SCRIM)
                        .drawBehind {
                            val foot = lift.clear.takeIf { !it.isNaN() }?.let { (it - origin[0]).coerceIn(0f, size.height) } ?: size.height
                            drawRect(dim, size = Size(size.width, foot), alpha = lift.backdrop.value)
                        }
                        .pointerInput(lift) { detectTapGestures { lift.close() } },
                )
            },
            {
                Box(
                    Modifier
                        .testTag(MessageLiftTags.MESSAGE)
                        // A message cut to the room scrolls inside it.
                        .draggable(
                            rememberDraggableState { delta ->
                                val layout = placed[0]
                                val most = (lifted.source.height - layout.viewport.height - layout.offset).coerceAtLeast(0f)
                                scrolled = (scrolled - delta).coerceIn(-layout.offset, most)
                            },
                            Orientation.Vertical,
                            enabled = !selecting,
                        )
                        .drawBehind {
                            if (selecting) return@drawBehind
                            if (lifted.card) drawCard(colors.surface, shadow, lift.backdrop.value)
                            clipRect {
                                translate(0f, -placed[0].offset - scrolled) { drawLayer(lifted.layer) }
                            }
                        },
                ) {
                    if (selecting) SelectingWords(lifted, (placed[0].offset + scrolled).toInt()) { lift.close() }
                }
            },
            {
                if (!selecting) LiftMenu(
                    lifted,
                    onCopy = {
                        copy(lifted.text)
                        lift.close()
                    },
                    onSelect = { lift.selecting = true },
                    onAction = { action ->
                        lift.close()
                        action.onClick()
                    },
                    modifier = Modifier.graphicsLayer {
                        // Telegram's menu fades in over 0.05 s and grows out of the message's edge from 0.01.
                        alpha = menuIn.value.coerceIn(0f, 1f)
                        val s = lerp(0.01f, 1f, menuIn.value.coerceAtLeast(0f))
                        scaleX = s
                        scaleY = s
                        transformOrigin = TransformOrigin(if (placed[0].menu.left <= placed[0].viewport.left + 1f) 0f else 1f, 0f)
                    },
                )
            },
        ),
        modifier = Modifier.matchParentSize(),
    ) { (scrims, messages, menus), constraints ->
        val screen = Size(constraints.maxWidth.toFloat(), constraints.maxHeight.toFloat())
        val scrim = scrims.first().measure(Constraints.fixed(constraints.maxWidth, constraints.maxHeight))
        val menu = menus.firstOrNull()?.measure(Constraints(maxWidth = constraints.maxWidth))
        // Selecting drops the menu, not its room: the message stays put.
        if (menu != null) menuSize[0] = Size(menu.width.toFloat(), menu.height.toFloat())
        // The source is in the window's terms, this box maybe not (a tablet's chat pane).
        // The composer stays clear: the message and its menu keep above it.
        fun layoutFrom(here: Offset) = MessageLiftLayout.of(
            screen, top, lift.clear.takeIf { !it.isNaN() }?.let { max(bottom, screen.height - (it - here.y)) } ?: bottom,
            lifted.source.translate(-here), menuSize[0],
            leading = lifted.source.center.x - here.x <= screen.width / 2f,
        ) { with(density) { it.toPx() } }
        // How big the message is doesn't hang on where this box is; where it goes does, known once placing.
        val viewport = layoutFrom(Offset.Zero).viewport
        val message = messages.first().measure(Constraints.fixed(viewport.width.toInt().coerceAtLeast(0), viewport.height.toInt().coerceAtLeast(0)))
        layout(constraints.maxWidth, constraints.maxHeight) {
            val here = coordinates?.positionInRoot() ?: Offset.Zero
            origin[0] = here.y
            val layout = layoutFrom(here)
            placed[0] = layout
            scrim.place(0, 0)
            // From where it rested to where it fits, on the spring; the menu rides with it.
            val shift = lerp(lifted.source.top - here.y - layout.viewport.top, 0f, place.value)
            message.place(layout.viewport.left.toInt(), (layout.viewport.top + shift).toInt())
            menu?.place(layout.menu.left.toInt(), (layout.menu.top + shift).toInt())
        }
    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawCard(color: Color, shadow: Color, alpha: Float = 1f) {
    val inset = MessageLiftSpec.cardInset.toPx()
    val radius = MessageLiftSpec.cardRadius.toPx()
    if (shadow.alpha > 0f) {
        drawIntoCanvas { canvas ->
            val paint = Paint().asFrameworkPaint().apply {
                isAntiAlias = true
                this.color = color.copy(alpha = color.alpha * alpha).toArgb()
                setShadowLayer(MessageLiftSpec.cardShadowRadius.toPx(), 0f, MessageLiftSpec.cardShadowY.toPx(), shadow.copy(alpha = shadow.alpha * alpha).toArgb())
            }
            canvas.nativeCanvas.drawRoundRect(inset, 0f, size.width - inset, size.height, radius, radius, paint)
        }
        return
    }
    drawRoundRect(
        color,
        topLeft = Offset(inset, 0f),
        size = Size(size.width - 2 * inset, size.height),
        cornerRadius = CornerRadius(radius),
        alpha = alpha,
    )
}

/** The lifted words laid out again in a SelectionContainer, all selected once laid out; [onDone] once nothing is. */
@Composable
private fun SelectingWords(lifted: MessageLift.Lifted, scrolled: Int, onDone: () -> Unit) {
    val state = rememberSelectionState()
    val colors = HappyTheme.colors
    Box(
        Modifier
            .fillMaxSize()
            .then(if (lifted.card) Modifier.drawBehind { drawCard(colors.surface, if (colors.dark) Color.Transparent else MessageLiftSpec.cardShadow) } else Modifier)
            .verticalScroll(rememberScrollState(scrolled)),
    ) {
        SelectionContainer(state) { lifted.selectable() }
    }
    LaunchedEffect(state) {
        // The texts lay out and register in the frame they compose.
        withFrameNanos {}
        withFrameNanos {}
        val texts = state.getSelectableTexts()
        val total = texts.sumOf { it.length }
        val range = lifted.select?.let { within(texts, it) } ?: TextRange(0, total)
        if (total > 0) state.select(range)
        snapshotFlow { state.selectedTexts.isNotEmpty() }.first { it }
        LiftSelected.selected?.invoke(state.selectedTexts.joinToString("") { it.text })
        snapshotFlow { state.selectedTexts.isEmpty() }.first { it }
        onDone()
    }
}

/** What Select selected in a lift; tests read it. */
internal object LiftSelected {
    @Volatile var selected: ((String) -> Unit)? = null
}

/** Where [select] is among [texts] laid end to end; null if they don't read it. */
private fun within(texts: List<androidx.compose.ui.text.AnnotatedString>, select: LiftSelection): TextRange? {
    var seen = 0
    var base = 0
    for (text in texts) {
        if (text.text == select.text && seen++ == select.occurrence) return TextRange(base + select.range.start, base + select.range.end)
        base += text.length
    }
    return null
}

/** The lifted message's menu: Copy, Select, then the row's own (a refused send's Retry and Discard). */
@Composable
private fun LiftMenu(lifted: MessageLift.Lifted, onCopy: () -> Unit, onSelect: () -> Unit, onAction: (CopyMenuAction) -> Unit, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val hairline = with(LocalDensity.current) { 1f.toDp() }
    val shape = RoundedCornerShape(CopyMenuSpec.radius)
    Column(
        modifier = modifier
            .testTag(MessageLiftTags.MENU)
            .width(CopyMenuSpec.width)
            .shadow(MessageLiftSpec.menuElevation, shape)
            .clip(shape)
            .background(colors.surface)
            .border(hairline, colors.divider, shape),
    ) {
        CopyMenuRow(stringResource(R.string.common_copy), Ionicon.CopyOutline, MessageLiftTags.COPY, onCopy)
        CopyMenuRow(stringResource(R.string.message_select), Ionicon.TextOutline, MessageLiftTags.SELECT, onSelect)
        for (action in lifted.actions) CopyMenuRow(action.label, action.icon, action.tag) { onAction(action) }
    }
}
