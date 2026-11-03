package com.slopus.happy.ui.conversation

import android.graphics.Picture
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.foundation.text.selection.rememberSelectionState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Canvas
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.CanvasDrawScope
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.MeasurePolicy
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.drawText
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.constrainWidth
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.markdown.MarkdownBlock
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.ui.browser.Link
import com.slopus.happy.ui.browser.linkAt
import com.slopus.happy.ui.browser.webLinkGestures
import com.slopus.happy.ui.chat.AgentSelectable
import com.slopus.happy.ui.chat.LocalTextReveal
import com.slopus.happy.ui.chat.LiftSelection
import com.slopus.happy.ui.chat.LocalTrailingSlot
import com.slopus.happy.ui.chat.TrailingLine
import com.slopus.happy.ui.chat.MarkdownBlockView
import com.slopus.happy.ui.chat.MarkdownView
import com.slopus.happy.ui.chat.MarkdownSpec
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.MessageSpec
import com.slopus.happy.ui.chat.MessageTags
import com.slopus.happy.ui.chat.TextReveal
import com.slopus.happy.ui.chat.drawRevealed
import com.slopus.happy.ui.chat.liftSource
import com.slopus.happy.ui.chat.rememberCopyText
import com.slopus.happy.ui.chat.rememberLiftSource
import com.slopus.happy.ui.chat.revealHeight
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.IdentityHashMap
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.roundToInt

object ProseTags {
    /** Each drawn segment of a row's text: a node that draws its paragraphs, lists and rules. */
    const val TEXT = "conversation.prose"
}

/** The geometry this composition lays text out for; recomposes when the typesetter has layouts for a new one. */
@Composable
internal fun rememberProseGeometry(typesetter: Typesetter): ProseGeometry {
    val density = LocalDensity.current
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    typesetter.version
    return typesetter.geometry.at(density, rtl)
}

/** [source]'s layout: made ahead on the lane, or (for a row nothing laid out) here. */
@Composable
internal fun rememberProse(source: ProseSource): Prose {
    val typesetter = Typesetter.of(LocalContext.current)
    return typesetter.prose(source, rememberProseGeometry(typesetter))
}

/**
 * Where a long press on drawn text asks for the selectable view: the word
 * under it, in the [occurrence]th piece reading [text].
 */
internal class SelectionStart(val text: AnnotatedString, val occurrence: Int, val range: TextRange, val code: Boolean = false) {
    /** What the lift's Select takes: this inline code span whole, or (null) everything. */
    fun lifted(): LiftSelection? = if (code) LiftSelection(text.text, occurrence, range) else null
}

/**
 * [prose] as MarkdownView's column: its drawn segments, each one node that
 * draws its texts at the places the typesetter gave them ([DrawnProse]),
 * and between them the blocks that stay composables, composed by
 * [composed]. [fill] takes the whole width (an answer); otherwise the column
 * is as wide as its widest text (a bubble).
 */
@Composable
internal fun ProseColumn(
    prose: Prose,
    fill: Boolean,
    modifier: Modifier = Modifier,
    reveal: ProseReveal? = null,
    onLongPress: ((SelectionStart) -> Unit)? = null,
    composed: @Composable (MarkdownBlock) -> Unit,
) {
    Column(modifier) {
        prose.segments.forEachIndexed { index, segment ->
            key(index) {
                when (segment) {
                    is DrawnSegment -> DrawnProse(prose, segment, index, fill, reveal, onLongPress)
                    is ComposedSegment -> composed(segment.block)
                }
            }
        }
    }
}

/**
 * One drawn segment: a node as tall as the typesetter measured it, drawing
 * its texts and rules in one pass, its links hit-tested on their layouts,
 * its words in semantics. At a width it wasn't laid out for (the window
 * just changed) it draws its old layout scaled to fit and tells the
 * typesetter, which lays it out again off the main thread.
 */
@Composable
private fun DrawnProse(prose: Prose, segment: DrawnSegment, index: Int, fill: Boolean, reveal: ProseReveal?, onLongPress: ((SelectionStart) -> Unit)?) {
    val colors = HappyTheme.colors
    val palette = remember(colors) { ProsePalette.of(colors) }
    val typesetter = Typesetter.of(LocalContext.current)
    typesetter.reportPalette(palette)
    val density = LocalDensity.current
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    // Set in measure, read in draw and in hit tests: the stale layout's scale.
    val scale = remember { FloatArray(1) { 1f } }
    val handler = LocalUriHandler.current
    val semantics = remember(segment, handler) {
        val links = segment.texts.flatMap { text -> text.getLinkAnnotations(0, text.length).map { text.substring(it.start, it.end) to it.item } }
        Modifier.semantics {
            this[SemanticsProperties.Text] = segment.texts
            if (links.isNotEmpty()) customActions = links.map { (words, link) -> CustomAccessibilityAction(words) { Link(link).activate(handler); true } }
        }
    }
    val unscaled = { width: Float -> width / scale[0] }
    val measure = remember(segment, prose.available, fill, rtl, density) {
        MeasurePolicy { _, constraints ->
            val width = if (constraints.hasBoundedWidth) constraints.maxWidth else prose.available
            if (width != prose.available) typesetter.reportColumn(width + 2 * prose.source.kind.inset(prose.geometry), density, rtl)
            val s = width.toFloat() / prose.available
            scale[0] = s
            val w = if (fill) width else ceil(segment.width * s).toInt()
            layout(constraints.constrainWidth(w), (segment.height * s).roundToInt()) {}
        }
    }
    Layout(
        modifier = semantics
            .testTag(ProseTags.TEXT)
            .then(
                if (segment.hasLinks) {
                    Modifier.webLinkGestures(segment) { position ->
                        val at = Offset(position.x / scale[0], position.y / scale[0])
                        segment.pieceAt(at, unscaledWidth(segment, fill, prose.available), rtl, exact = true)?.let { (piece, local) -> linkAt(piece.text, piece.layout, local) }
                    }
                } else {
                    Modifier
                },
            )
            .then(
                if (onLongPress != null) {
                    Modifier.pointerInput(segment) {
                        detectTapGestures(onLongPress = { position ->
                            val at = Offset(position.x / scale[0], position.y / scale[0])
                            val (piece, local) = segment.pieceAt(at, unscaled(size.width.toFloat()), rtl, exact = false) ?: return@detectTapGestures
                            val offset = piece.layout.getOffsetForPosition(local)
                            val under = offset.coerceAtMost((piece.text.length - 1).coerceAtLeast(0))
                            // Inline code is taken whole; other words one at a time.
                            val code = piece.text.getStringAnnotations(INLINE_CODE, under, under + 1).firstOrNull()
                            val range = code?.let { TextRange(it.start, it.end) } ?: piece.layout.getWordBoundary(under)
                            val occurrence = prose.pieces.takeWhile { it !== piece }.count { it.text.text == piece.text.text }
                            onLongPress(SelectionStart(piece.text, occurrence, range, code = code != null))
                        })
                    }
                } else {
                    Modifier
                },
            )
            .then(if (reveal != null) Modifier.onPlaced { reveal.placed(index, it) } else Modifier)
            .drawBehind {
                val s = scale[0]
                val width = size.width / s
                val recorded = segment.recording.value
                scale(s, s, pivot = Offset.Zero) {
                    if (reveal == null && recorded != null && recorded.palette == palette && abs(recorded.width - width) < 0.5f) {
                        drawIntoCanvas { it.nativeCanvas.drawPicture(recorded.picture) }
                        ProseThread.playbacks.incrementAndGet()
                    } else {
                        drawSegment(segment, width, rtl, palette.text, palette.secondary, palette.divider, reveal)
                    }
                }
            },
        measurePolicy = measure,
    )
}

/** How wide a segment's node is, unscaled: the width it was laid out at, or its own when it wraps. */
private fun unscaledWidth(segment: DrawnSegment, fill: Boolean, available: Int): Float = if (fill) available.toFloat() else segment.width.toFloat()

/** Whether every drawn segment is drawn ahead in [palette]. */
internal fun Prose.recorded(palette: ProsePalette): Boolean = segments.all { it !is DrawnSegment || it.recording.value?.palette == palette }

/**
 * Draws this prose's segments into pictures in [palette], each as wide as
 * its node will be (an answer fills its width): Telegram draws its cells'
 * layouts; this also shapes their glyphs here, off the main thread, so the
 * row only plays the picture back. Kept until the palette or layout changes.
 */
internal fun Prose.record(palette: ProsePalette) {
    val direction = if (geometry.rtl) LayoutDirection.Rtl else LayoutDirection.Ltr
    for (segment in segments) {
        if (segment !is DrawnSegment || segment.recording.value?.palette == palette) continue
        val width = unscaledWidth(segment, source.kind == ProseKind.Answer, available).toInt()
        val picture = Picture()
        val canvas = picture.beginRecording(width.coerceAtLeast(1), segment.height.coerceAtLeast(1))
        CanvasDrawScope().draw(geometry.density, direction, Canvas(canvas), Size(width.toFloat(), segment.height.toFloat())) {
            drawSegment(segment, width.toFloat(), geometry.rtl, palette.text, palette.secondary, palette.divider, null)
        }
        picture.endRecording()
        segment.recording.value = ProseRecording(palette, width, picture)
    }
}

/** Where [piece] starts in a node [width] wide, mirrored right to left. */
private fun ProsePiece.left(width: Float, rtl: Boolean): Float = if (rtl) width - x - layout.size.width else x.toFloat()

/**
 * The piece under [position] (unscaled), and the point in it; with [exact]
 * false, the nearest piece on the point's line, or above or below it.
 */
private fun DrawnSegment.pieceAt(position: Offset, width: Float, rtl: Boolean, exact: Boolean): Pair<ProsePiece, Offset>? {
    var best: Pair<ProsePiece, Offset>? = null
    var bestDistance = Float.MAX_VALUE
    parts.forEachIndexed { i, part ->
        for (piece in part.pieces) {
            val left = piece.left(width, rtl)
            val top = (tops[i] + piece.y).toFloat()
            val local = position - Offset(left, top)
            val size = piece.layout.size
            val inside = local.y >= 0 && local.y < size.height && local.x >= 0 && local.x < size.width
            if (inside) return piece to local
            if (exact) continue
            val dy = if (local.y < 0) -local.y else (local.y - size.height).coerceAtLeast(0f)
            val dx = if (local.x < 0) -local.x else (local.x - size.width).coerceAtLeast(0f)
            val distance = dy * 4 + dx
            if (distance < bestDistance) {
                bestDistance = distance
                best = piece to Offset(local.x.coerceIn(0f, size.width.toFloat()), local.y.coerceIn(0f, size.height - 1f))
            }
        }
    }
    return best
}

/**
 * [segment]'s rules and texts. A text's paint is its layout's own and
 * painting sets its colour, so a layout paints for one thread at a time: the
 * lane drawing it ahead, or a row drawing it itself.
 */
private fun DrawScope.drawSegment(segment: DrawnSegment, width: Float, rtl: Boolean, text: Color, secondary: Color, divider: Color, reveal: ProseReveal?) {
    segment.parts.forEachIndexed { i, part ->
        val top = segment.tops[i].toFloat()
        var r = 0
        while (r < part.rules.size) {
            drawRect(divider, Offset(0f, top + part.rules[r]), Size(width, part.rules[r + 1].toFloat()))
            r += 2
        }
        for (piece in part.pieces) {
            val color = if (piece.secondary) secondary else text
            val origin = Offset(piece.left(width, rtl), top + piece.y)
            val revealed = reveal?.piece(piece)
            synchronized(piece.layout) {
                if (revealed == null) {
                    drawText(piece.layout, color, origin)
                } else {
                    translate(origin.x, origin.y) { drawRevealed(revealed, piece.layout) { drawText(piece.layout, color) } }
                }
            }
        }
    }
}

/**
 * A streaming answer's drawn texts in its [TextReveal], in the order the
 * answer reads, as MarkdownView's Texts register theirs: one piece per text
 * that reveals (paragraphs, headers, list items, not their markers), kept
 * by its place so the growing paragraph stays the piece the caret is in.
 */
@Stable
internal class ProseReveal(private val reveal: TextReveal) {
    private val pieces = ArrayList<TextReveal.Piece>()
    private val layouts = ArrayList<androidx.compose.runtime.MutableState<TextLayoutResult?>>()
    private val segments = ArrayList<Int>()
    private val origins = ArrayList<Offset>()
    private var byPiece = IdentityHashMap<ProsePiece, TextReveal.Piece>()
    private val placed = HashMap<Int, LayoutCoordinates>()

    /** Takes [prose]'s texts; after each composition. */
    fun sync(prose: Prose) {
        val next = IdentityHashMap<ProsePiece, TextReveal.Piece>()
        var n = 0
        prose.segments.forEachIndexed { index, segment ->
            if (segment !is DrawnSegment) return@forEachIndexed
            val width = prose.available.toFloat()
            segment.parts.forEachIndexed { i, part ->
                for (piece in part.pieces) {
                    if (!piece.reveals) continue
                    val origin = Offset(piece.left(width, prose.geometry.rtl), (segment.tops[i] + piece.y).toFloat())
                    if (n < pieces.size) {
                        layouts[n].value = piece.layout
                        segments[n] = index
                        origins[n] = origin
                    } else {
                        val layout = mutableStateOf<TextLayoutResult?>(piece.layout)
                        val made = reveal.Piece(layout)
                        layouts += layout
                        pieces += made
                        segments += index
                        origins += origin
                        reveal.register(made)
                    }
                    pieces[n].origin = origin
                    pieces[n].coordinates = placed[index]
                    next[piece] = pieces[n]
                    n++
                }
            }
        }
        while (pieces.size > n) {
            reveal.unregister(pieces.removeAt(pieces.lastIndex))
            layouts.removeAt(layouts.lastIndex)
            segments.removeAt(segments.lastIndex)
            origins.removeAt(origins.lastIndex)
        }
        byPiece = next
    }

    /** Segment [index]'s node was placed. */
    fun placed(index: Int, coordinates: LayoutCoordinates) {
        placed[index] = coordinates
        for (i in pieces.indices) if (segments[i] == index) pieces[i].coordinates = coordinates
    }

    fun piece(piece: ProsePiece): TextReveal.Piece? = byPiece[piece]

    fun dispose() {
        pieces.forEach(reveal::unregister)
        pieces.clear()
    }
}

/**
 * An answer drawn from its laid-out [source]: AgentMessage's spec (16 in,
 * 10 above and below, the copy button under the text unless its turn's
 * end offers it, [copies]) with the text
 * drawn, not composed. A long press on the words puts this one answer
 * back in a SelectionContainer over MarkdownView, exactly as it lays out,
 * with the word under the finger selected; once nothing is selected it is
 * drawn again. [reveal] draws streaming words in as AgentMessage's does.
 */
@Composable
internal fun AnswerProse(source: ProseSource, callbacks: MessageCallbacks, modifier: Modifier, reveal: TextReveal?, copies: Boolean = true) {
    val prose = rememberProse(source)
    var selecting by remember(source.key) { mutableStateOf<SelectionStart?>(null) }
    val haptics = LocalHapticFeedback.current
    // Held, it lifts over the chat on a card (iOS 8c2a92172); without a lift, its words become selectable in place.
    val lift = rememberLiftSource(source.key)
    Box(modifier.revealHeight(reveal).liftSource(lift)) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = MessageSpec.agentMarginHorizontal, vertical = MessageSpec.agentMarginVertical)
                .testTag(MessageTags.AGENT),
        ) {
            val start = selecting
            if (start != null && reveal == null) {
                SelectableAnswer(source.blocks, start, callbacks.onOptionPress) { selecting = null }
            } else {
                val revealed = reveal?.let { remember(it) { ProseReveal(it) } }
                if (revealed != null) {
                    SideEffect { revealed.sync(prose) }
                    DisposableEffect(revealed) { onDispose { revealed.dispose() } }
                }
                CompositionLocalProvider(LocalTextReveal provides reveal) {
                    ProseColumn(
                        prose,
                        fill = true,
                        modifier = Modifier.fillMaxWidth(),
                        reveal = revealed,
                        onLongPress = if (reveal == null) {
                            { at ->
                                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                if (lift != null) {
                                    lift.lift(source.text, card = true, select = at.lifted()) { AgentSelectable(source.blocks, callbacks) }
                                } else {
                                    selecting = at
                                }
                            }
                        } else {
                            null
                        },
                    ) { block -> MarkdownBlockView(block, callbacks.onOptionPress) }
                }
            }
            if (copies) ProseCopyButton(source.text)
        }
    }
}

/** What a long press on a drawn answer selected; tests read it. */
internal object ProseSelection {
    @Volatile var selected: ((String) -> Unit)? = null
}

/** Today's selectable answer, with [start]'s word selected once it has laid out; [onDone] once nothing is selected. */
@Composable
private fun SelectableAnswer(blocks: List<MarkdownBlock>, start: SelectionStart, onOptionPress: (String) -> Unit, onDone: () -> Unit) {
    val state = rememberSelectionState()
    val done by rememberUpdatedState(onDone)
    SelectionContainer(state) {
        MarkdownView(blocks, modifier = Modifier.fillMaxWidth(), onOptionPress = onOptionPress)
    }
    LaunchedEffect(state) {
        // The texts lay out and register in the frame they compose.
        withFrameNanos {}
        withFrameNanos {}
        var seen = 0
        var base = 0
        for (text in state.getSelectableTexts()) {
            if (text.text == start.text.text) {
                if (seen == start.occurrence) {
                    state.select(TextRange(base + start.range.start, base + start.range.end))
                    break
                }
                seen++
            }
            base += text.length
        }
        withTimeoutOrNull(1_000) { snapshotFlow { state.selectedTexts.isNotEmpty() }.first { it } }
        ProseSelection.selected?.invoke(state.selectedTexts.joinToString("") { it.text })
        snapshotFlow { state.selectedTexts.isEmpty() }.first { it }
        done()
    }
}

/**
 * MessageCopyButton drawn: 20 high, its 16 glyph's width, copy-outline
 * swapping to a checkmark for 1.5 s after a copy. The glyph was laid out
 * on the lane with the rows.
 */
@Composable
internal fun ProseCopyButton(text: String) {
    val typesetter = Typesetter.of(LocalContext.current)
    val geometry = rememberProseGeometry(typesetter)
    val copy = rememberCopyText()
    var copied by remember { mutableStateOf(false) }
    if (copied) {
        LaunchedEffect(Unit) {
            delay(1500)
            copied = false
        }
    }
    val glyph = typesetter.glyph(if (copied) Ionicon.Checkmark else Ionicon.CopyOutline, MessageSpec.copyIcon, geometry)
    val color = HappyTheme.colors.text
    val description = stringResource(if (copied) R.string.common_copied else R.string.common_copy)
    Box(
        modifier = Modifier
            .testTag(MessageTags.AGENT_COPY)
            .height(MessageSpec.copyHeight)
            .width(MessageSpec.copyIcon)
            .clickable(role = Role.Button, onClickLabel = stringResource(R.string.common_copy)) {
                copy(text)
                copied = true
            }
            .semantics { contentDescription = description }
            .drawBehind { drawGlyph(glyph, MessageSpec.copyIcon.toPx().roundToInt(), color) },
    )
}

/** An [com.slopus.happy.ui.components.Icon]'s glyph: in its [box] square, centred in this node, the text centred in the box. */
private fun DrawScope.drawGlyph(glyph: TextLayoutResult, box: Int, color: Color, left: Float = -1f) {
    val boxAt = Alignment.Center.align(IntSize(box, box), IntSize(if (left >= 0f) box else size.width.roundToInt(), size.height.roundToInt()), layoutDirection)
    val textAt = Alignment.Center.align(glyph.size, IntSize(box, box), layoutDirection)
    val x = (if (left >= 0f) left else boxAt.x.toFloat()) + textAt.x
    drawText(glyph, color, Offset(x, (boxAt.y + textAt.y).toFloat()))
}

/**
 * The thinking row, drawn: its "Thinking" line and chevron (13/18 semibold
 * and a 16 glyph, 4 apart, secondary, centred on each other) as one
 * button, and opened, the thought (14/20 secondary, 4 under), laid out on
 * the lane first, so opening it measures nothing here.
 */
@Composable
internal fun ReasoningProse(row: ConversationRow.Reasoning, modifier: Modifier) {
    val colors = HappyTheme.colors
    val typesetter = Typesetter.of(LocalContext.current)
    val geometry = rememberProseGeometry(typesetter)
    var open by rememberSaveable(row.key) { mutableStateOf(false) }
    val label = stringResource(R.string.session_info_thinking)
    val line = typesetter.line(label, ConversationRowSpec.label, geometry)
    val chevron = typesetter.glyph(if (open) Ionicon.ChevronUp else Ionicon.ChevronDown, ConversationRowSpec.icon, geometry)
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val icon = with(density) { ConversationRowSpec.icon.roundToPx() }
    val gap = with(density) { ReasoningSpec.gap.roundToPx() }
    val width = line.size.width + gap + icon
    val height = maxOf(line.size.height, icon)
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = ConversationRowSpec.marginHorizontal, vertical = ConversationRowSpec.marginVertical)
            .testTag(ConversationRowTags.REASONING),
    ) {
        Box(
            Modifier
                .size(with(density) { width.toDp() }, with(density) { height.toDp() })
                .clickable(role = Role.Button) {
                    if (open) {
                        open = false
                    } else {
                        val source = ProseSource(row.key, ProseKind.Reasoning, row.current, emptyList())
                        if (typesetter.peek(source) != null) {
                            open = true
                        } else {
                            // Laid out on the lane, then shown: the frame it opens in only draws it.
                            scope.launch {
                                withContext(typesetter.lane) { typesetter.build(source, typesetter.geometry) }
                                open = true
                            }
                        }
                    }
                }
                .semantics { this[SemanticsProperties.Text] = listOf(AnnotatedString(label)) }
                .drawBehind {
                    val rtl = layoutDirection == LayoutDirection.Rtl
                    val lineY = ((size.height - line.size.height) / 2f).roundToInt().toFloat()
                    val lineX = if (rtl) size.width - line.size.width else 0f
                    drawText(line, colors.textSecondary, Offset(lineX, lineY))
                    val chevronX = if (rtl) 0f else (line.size.width + gap).toFloat()
                    drawGlyph(chevron, icon, colors.textSecondary, left = chevronX)
                },
        )
        if (open) {
            val words = row.live?.let { framed(it).text } ?: row.text
            ProseColumn(rememberProse(ProseSource(row.key, ProseKind.Reasoning, words, emptyList())), fill = false) {}
        }
    }
}

/** Another agent's message: "From another agent" over its Markdown, drawn as one prose, 16 in and 6 above and below. */
@Composable
internal fun CollaboratorProse(row: ConversationRow.Collaborator, callbacks: MessageCallbacks, modifier: Modifier) {
    val label = stringResource(R.string.conversation_from_agent)
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = ConversationRowSpec.marginHorizontal, vertical = ConversationRowSpec.marginVertical)
            .testTag(ConversationRowTags.COLLABORATOR),
    ) {
        ProseColumn(rememberProse(ProseSource(row.key, ProseKind.Collaborator, row.text, row.blocks, label)), fill = false) { block ->
            MarkdownBlockView(block, callbacks.onOptionPress)
        }
    }
}

/**
 * A person's long message is cut at its first lines until tapped open, as
 * desktop's Message and iOS's bubble are (MESSAGE_PREVIEW_HEIGHT; iOS
 * c52fd2842): past [PREVIEW_LINES] lines it shows those, to the foot of the
 * last, and Show full [gap] under them in [control], the time on that line;
 * opened, all of it and Show less. Cut, it keeps the whole text's width, so
 * opening only grows it down.
 */
object UserFold {
    const val PREVIEW_LINES = 10
    val gap = 8.dp
    val control = TurnRowSpec.traceMeta

    /** Where a cut whose last line is in code or a table falls, in [density]'s pixels: ten lines of text. */
    fun limit(density: Density): Int = with(density) { (MarkdownSpec.text.lineHeight * PREVIEW_LINES).toPx().roundToInt() }
}

/**
 * Where a person's words are cut ([UserFold]): [at] is the foot of the
 * last line shown in the prose's pixels, or null where that line is in a
 * composed block (code, a table) or under one, whose height is the row's.
 */
internal class ProseCut(val at: Int?)

/** Where [Prose] is cut to its first [lines] lines; null when it has no more. A composed block counts its own lines. */
internal fun Prose.cut(lines: Int): ProseCut? {
    var count = 0
    var top: Int? = 0
    var at: Int? = null
    for (segment in segments) {
        when (segment) {
            is DrawnSegment -> {
                // A list's markers sit beside its items' lines: they aren't lines of their own.
                val feet = ArrayList<Int>()
                segment.parts.forEachIndexed { index, part ->
                    for (piece in part.pieces) if (piece.reveals) for (line in 0 until piece.layout.lineCount) {
                        feet += segment.tops[index] + piece.y + piece.layout.getLineBottom(line).roundToInt()
                    }
                }
                feet.sort()
                for (foot in feet) {
                    if (++count == lines) at = top?.plus(foot)
                    if (count > lines) return ProseCut(at)
                }
                top = top?.plus(segment.height)
            }
            is ComposedSegment -> {
                count += segment.block.lineCount()
                if (count > lines) return ProseCut(at)
                // Below it, nothing here knows how far down a line is.
                top = null
            }
        }
    }
    return null
}

/** How many lines a composed block reads as: code's own, a table's rows and header. */
private fun MarkdownBlock.lineCount(): Int = when (this) {
    is MarkdownBlock.CodeBlock -> content.trimEnd('\n').lines().size
    is MarkdownBlock.Mermaid -> content.trimEnd('\n').lines().size
    is MarkdownBlock.Table -> rows.size + 1
    is MarkdownBlock.Options -> items.size
    else -> 1
}

/**
 * A person's words in their bubble, drawn ([UserMessage][com.slopus.happy.ui.chat.UserMessage]'s body); where a sent
 * message's flight lands ([SendFlight]). [cut] says where they fold ([UserFold]), unless the row is opened.
 */
@Composable
internal fun UserProse(row: ConversationRow.User, prose: Prose, cut: ProseCut?, callbacks: MessageCallbacks) {
    // A message just sent: its words fly here from the composer, and land where these are placed.
    val flight = LocalSendFlight.current
    // An own bubble's time rides up onto the last line when it can (MessageDelivery's BubbleFoot).
    val trailing = LocalTrailingSlot.current
    val placed = if (flight != null) Modifier.onPlaced { flight.place(row.key, it, prose) { trailing?.content } } else Modifier
    val limit = UserFold.limit(LocalDensity.current)
    val opened = row.opened
    // Cut, the words are measured whole, as wide as all of them, and shown to their tenth line; the clip keeps the rest from drawing.
    val words = (if (cut != null) Modifier.clipToBounds() else Modifier).layout { measurable, constraints ->
        val placeable = measurable.measure(constraints)
        // A layout made for another width is drawn scaled to this one (DrawnProse); so are its lines.
        val scale = if (constraints.hasBoundedWidth) constraints.maxWidth.toFloat() / prose.available else 1f
        val shown = when {
            cut == null || opened -> placeable.height
            cut.at != null -> (cut.at * scale).roundToInt()
            else -> limit
        }.coerceAtMost(placeable.height)
        if (cut == null) trailing?.line = prose.trailing()?.let { TrailingLine(it.right * scale, it.below * scale) }
        layout(placeable.width, shown) { placeable.place(0, 0) }
    }
    val column = @Composable {
        ProseColumn(prose, fill = false, modifier = placed.then(words)) { block ->
            MarkdownBlockView(block, callbacks.onOptionPress)
        }
    }
    if (cut == null) return column()
    Layout(
        contents = listOf(
            column,
            {
                // Said by the bubble's tap instead: a screen reader reads the words whole.
                Text(
                    stringResource(if (opened) R.string.machine_launcher_show_less else R.string.conversation_show_full),
                    style = UserFold.control,
                    color = HappyTheme.colors.textSecondary,
                    maxLines = 1,
                    modifier = Modifier.testTag(ConversationRowTags.USER_FOLD).semantics { hideFromAccessibility() },
                )
            },
        ),
    ) { (texts, controls), constraints ->
        val text = texts.first().measure(constraints.copy(minHeight = 0))
        val control = controls.first().measure(constraints.copy(minWidth = 0, minHeight = 0))
        val top = text.height + UserFold.gap.roundToPx()
        // The last line is the control's: the time rides on it.
        trailing?.line = TrailingLine(control.width.toFloat(), 0f)
        layout(maxOf(text.width, control.width), top + control.height) {
            text.place(0, 0)
            control.place(0, top)
        }
    }
}

/** Where the last line ends when the prose ends in a paragraph or a header; null after a list, code or a table. */
internal fun Prose.trailing(): TrailingLine? {
    val segment = segments.lastOrNull() as? DrawnSegment ?: return null
    val index = segment.parts.lastIndex
    val part = segment.parts.getOrNull(index) ?: return null
    if (part.block !is MarkdownBlock.Text && part.block !is MarkdownBlock.Header) return null
    val piece = part.pieces.lastOrNull() ?: return null
    val last = piece.layout.lineCount - 1
    if (last < 0) return null
    val right = piece.x + piece.layout.getLineRight(last) - minOf(piece.layout.getLineLeft(last), 0f)
    val foot = segment.tops[index] + piece.y + piece.layout.getLineBottom(last)
    return TrailingLine(right, segment.height - foot)
}
