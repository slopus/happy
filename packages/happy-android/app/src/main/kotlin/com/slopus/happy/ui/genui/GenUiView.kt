package com.slopus.happy.ui.genui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.slopus.happy.genui.Action
import com.slopus.happy.genui.Align
import com.slopus.happy.genui.BoxRole
import com.slopus.happy.genui.ButtonVariant
import com.slopus.happy.genui.Direction
import com.slopus.happy.genui.Divide
import com.slopus.happy.genui.Element
import com.slopus.happy.genui.Gap
import com.slopus.happy.genui.IconName
import com.slopus.happy.genui.IconRole
import com.slopus.happy.genui.Justify
import com.slopus.happy.genui.Leading
import com.slopus.happy.genui.Overflow
import com.slopus.happy.genui.PressRole
import com.slopus.happy.genui.RenderDocument
import com.slopus.happy.genui.Span
import com.slopus.happy.genui.StepStatus
import com.slopus.happy.genui.TextAlign
import com.slopus.happy.genui.TextRole
import com.slopus.happy.genui.Tone
import com.slopus.happy.genui.ViewerRef
import com.slopus.happy.R
import com.slopus.happy.genui.GenUiColors
import com.slopus.happy.genui.GenUiMarkers
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.theme.AppMono
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

/**
 * Gen UI's numbers on a phone. The render document says what each thing is
 * (a role, a gap, a tone); every distance, size and colour is here. A card is
 * the chat's own surface with a hairline, 16 round and 16 in; inside it
 * hierarchy is spacing, hairlines and type.
 */
object GenUiSpec {
    val chatInset = 16.dp
    val cardRadius = 16.dp
    val cardPadding = 16.dp
    val noticeRadius = 12.dp
    val noticePadding = 12.dp
    val itemMinHeight = 44.dp

    /** Below this width of its own a `switch` draws its compact branch (RENDER.md M5). */
    val regularWidth = 560.dp

    val code = happyTextStyle(fontSize = 13, lineHeight = 19, family = AppMono)
    val pill = happyTextStyle(fontSize = 12, lineHeight = 16, weight = FontWeight.Medium)
    val button = happyTextStyle(fontSize = 14, lineHeight = 20, weight = FontWeight.Medium)
    val axis = happyTextStyle(fontSize = 11, lineHeight = 14).tabular()
    val legend = happyTextStyle(fontSize = 13, lineHeight = 18)
    val overlay = happyTextStyle(fontSize = 22, lineHeight = 28, weight = FontWeight.SemiBold)

    /** A gap between siblings; a row puts related things further apart than a column does. */
    fun gap(gap: Gap, direction: Direction, role: BoxRole): Dp = when (gap) {
        Gap.None -> 0.dp
        Gap.Inline -> if (role == BoxRole.Notice) 10.dp else 8.dp
        Gap.Tight -> 2.dp
        Gap.Related -> if (direction == Direction.Row || role == BoxRole.Record) 8.dp else 4.dp
        Gap.Labeled -> 8.dp
        Gap.Heading -> 10.dp
        Gap.Items -> 12.dp
        Gap.Blocks -> 16.dp
    }

    /** Width of an item row's shared leading column. */
    fun leading(leading: Leading): Dp = when (leading) {
        Leading.None -> 0.dp
        Leading.Icon -> 24.dp
        Leading.Thumb -> 40.dp
        Leading.Number -> 24.dp
    }

    /** Between the leading column and the item's texts. */
    val leadingGap = 12.dp

    fun icon(role: IconRole): Dp = when (role) {
        IconRole.Leading -> 20.dp
        IconRole.Inline -> 14.dp
    }

    /** Clamped text's line count. */
    const val clampLines = 2
}

/** Digits of one width, so numbers in a column line up. */
fun TextStyle.tabular(): TextStyle = copy(fontFeatureSettings = "tnum")

/** A text role's type, and the colour it has unless a tone overrides it. */
@Immutable
internal data class RoleStyle(val style: TextStyle, val secondary: Boolean)

/** Where text sits sets the body's size: the answer's 16/24 at the top, a step down in a card. */
internal enum class Surface { Root, Card }

internal fun roleStyle(role: TextRole, surface: Surface): RoleStyle = when (role) {
    TextRole.Title -> RoleStyle(happyTextStyle(16, 22, weight = FontWeight.SemiBold), false)
    TextRole.Subtitle -> RoleStyle(happyTextStyle(13, 18), true)
    TextRole.Heading -> RoleStyle(happyTextStyle(12, 16, weight = FontWeight.Medium), true)
    TextRole.Prompt -> RoleStyle(happyTextStyle(15, 20, weight = FontWeight.Medium), false)
    TextRole.Body -> RoleStyle(if (surface == Surface.Root) happyTextStyle(16, 24) else happyTextStyle(15, 22), false)
    TextRole.Note -> RoleStyle(happyTextStyle(13, 18), true)
    TextRole.Label -> RoleStyle(happyTextStyle(14, 20), true)
    TextRole.Value -> RoleStyle(happyTextStyle(24, 30, weight = FontWeight.SemiBold).tabular(), false)
    TextRole.Delta -> RoleStyle(happyTextStyle(12, 16, weight = FontWeight.Medium).tabular(), false)
    TextRole.Item -> RoleStyle(happyTextStyle(15, 20, weight = FontWeight.Medium), false)
    TextRole.Detail -> RoleStyle(happyTextStyle(13, 18), true)
    TextRole.Trailing -> RoleStyle(happyTextStyle(13, 18).tabular(), true)
    TextRole.Column -> RoleStyle(happyTextStyle(12, 16, weight = FontWeight.Medium), true)
    TextRole.Rowhead -> RoleStyle(happyTextStyle(14, 20, weight = FontWeight.Medium), false)
    TextRole.Cell -> RoleStyle(happyTextStyle(14, 20), false)
    TextRole.Number -> RoleStyle(happyTextStyle(14, 20).tabular(), false)
    TextRole.Ordinal -> RoleStyle(happyTextStyle(15, 20, weight = FontWeight.Medium).tabular(), true)
}

/** The shared Gen UI colours for the app's light or dark theme. */
internal val LocalGenUiColors = staticCompositionLocalOf { GenUiColors.Light }

/**
 * What the host gets from a Gen UI block. Nothing is executed here: an
 * activated element reports its key and action, a tapped image its viewer
 * group and index. A button whose action the host doesn't run ([supports])
 * is drawn disabled. An image's stored path becomes Coil's model at once
 * when the host has it ([cached]), otherwise once read ([load], null when
 * there is none); its box is sized from the document either way.
 */
@Immutable
class GenUiHost(
    val onAction: (key: String, action: Action) -> Unit = { _, _ -> },
    val onView: (key: String, viewer: ViewerRef) -> Unit = { _, _ -> },
    val supports: (Action) -> Boolean = { it !is Action.Unsupported },
    val cached: (path: String) -> Any? = { it },
    val load: suspend (path: String) -> Any? = { it },
    /** The memory cache's name for [path]'s picture, when the model alone doesn't name it (bytes). */
    val key: (path: String) -> String? = { null },
)

/**
 * What a person did to one drawn document: which element each single-choice
 * group settled on. A host that draws the document in a list keeps it with
 * the version, so a row scrolled away and back keeps its choices.
 */
@Stable
class GenUiState {
    internal val chosen: SnapshotStateMap<String, String> = mutableStateMapOf()

    /** Settles [group] on [key], as a tap would; the first choice stands. */
    fun choose(group: String, key: String) {
        if (group !in chosen) chosen[group] = key
    }
}

object GenUiTags {
    const val VIEW = "genui"
    const val SCROLL = "genui.scroll"
}

/** One document being drawn: its elements, the host, and what was done to it. */
internal class GenUiScope(val document: RenderDocument, val host: GenUiHost, val state: GenUiState) {
    val chosen: SnapshotStateMap<String, String> get() = state.chosen
}

internal val LocalGenUi = staticCompositionLocalOf<GenUiScope?> { null }

/** How far a child may reach past its column on each side: the chat's inset at the root, a card's padding in one. */
internal val LocalBleed = staticCompositionLocalOf { 0.dp }

internal val LocalSurface = staticCompositionLocalOf { Surface.Root }

/** Set by a press with an action on what it wraps. */
internal val LocalTappable = staticCompositionLocalOf { false }

/** Set by a grid on its cells: text aligns as its column does. */
internal val LocalCellEnd = staticCompositionLocalOf<Boolean?> { null }

/** How far a step marker's rail runs past its own row: the gap to the next step. */
internal val LocalRailReach = staticCompositionLocalOf { 0.dp }

/**
 * A render document as an answer block, at the full width it is given less
 * [inset] each side (the chat's, by default; a carousel scrolls out into
 * it). Its height depends only on the document, that width and the text
 * size (RENDER.md "Measuring"). A document with nothing drawable shows its
 * `fallback` as text.
 */
@Composable
fun GenUiView(
    document: RenderDocument,
    modifier: Modifier = Modifier,
    host: GenUiHost = GenUiHost(),
    state: GenUiState = remember(document) { GenUiState() },
    inset: Dp = GenUiSpec.chatInset,
) {
    val scope = remember(document, host, state) { GenUiScope(document, host, state) }
    val shared = if (HappyTheme.colors.dark) GenUiColors.Dark else GenUiColors.Light
    CompositionLocalProvider(LocalGenUi provides scope, LocalBleed provides inset, LocalGenUiColors provides shared) {
        Box(modifier.fillMaxWidth().padding(horizontal = inset).testTag(GenUiTags.VIEW)) {
            val root = document.root
            if (document.drawable && root != null) Draw(root, Modifier.fillMaxWidth())
            else document.fallback?.let { Text(it, style = roleStyle(TextRole.Body, Surface.Root).style, color = HappyTheme.colors.text) }
        }
    }
}

/** One element by key, through its primitive. A key with no element draws nothing. */
@Composable
internal fun Draw(key: String, modifier: Modifier = Modifier, first: Boolean = true) {
    val scope = LocalGenUi.current ?: return
    when (val e = scope.document.elements[key] ?: return) {
        is Element.Box -> BoxView(key, e, modifier, first)
        is Element.Grid -> GridView(e, modifier)
        is Element.Scroll -> ScrollView(e, modifier)
        is Element.Switch -> SwitchView(e, modifier)
        is Element.Text -> TextView(key, e, modifier)
        is Element.Icon -> IconView(e, modifier)
        is Element.Image -> ImageView(key, e, modifier)
        is Element.Pill -> PillView(e, modifier)
        is Element.Button -> ButtonView(key, e, modifier)
        is Element.Press -> PressView(key, e, modifier)
        is Element.Bar -> BarView(e, modifier)
        is Element.Marker -> MarkerView(e, modifier)
        is Element.Spark -> SparkView(e, modifier)
        is Element.Plot -> PlotView(e, modifier)
        is Element.Code -> CodeView(key, e, modifier)
    }
}

/** Elements that take their own width in a column rather than its full width. */
private fun Element.hugs(): Boolean = this is Element.Pill || this is Element.Button || this is Element.Icon

/** What sits in an item row's leading column: its icon, thumbnail or list position. */
private fun Element.leads(): Boolean =
    this is Element.Icon || this is Element.Image || (this is Element.Text && role == TextRole.Ordinal)

// Box

@Composable
private fun BoxView(key: String, box: Element.Box, modifier: Modifier, first: Boolean) {
    val colors = HappyTheme.colors
    val scope = LocalGenUi.current ?: return
    var m = modifier
    var surface = LocalSurface.current
    var bleed = LocalBleed.current
    when (box.role) {
        BoxRole.Card -> {
            val shape = RoundedCornerShape(GenUiSpec.cardRadius)
            m = m.fillMaxWidth().clip(shape).border(hairline(), colors.divider, shape).padding(GenUiSpec.cardPadding)
            surface = Surface.Card
            bleed = GenUiSpec.cardPadding
        }
        BoxRole.Notice -> {
            val tone = box.tone ?: Tone.Neutral
            m = m.fillMaxWidth().clip(RoundedCornerShape(GenUiSpec.noticeRadius)).background(LocalGenUiColors.current.fill(tone)).padding(GenUiSpec.noticePadding)
        }
        BoxRole.Item -> if (box.direction == Direction.Row && LocalTappable.current) {
            // A row that can be tapped is at least a touch target high, centred in it.
            Box(m.heightIn(min = GenUiSpec.itemMinHeight), contentAlignment = Alignment.CenterStart) {
                CompositionLocalProvider(LocalSurface provides surface, LocalBleed provides bleed) { BoxBody(box, Modifier.fillMaxWidth(), scope) }
            }
            return
        }
        BoxRole.Mosaic -> {
            Mosaic(box.children, m)
            return
        }
        else -> Unit
    }
    CompositionLocalProvider(LocalSurface provides surface, LocalBleed provides bleed) {
        if (box.role == BoxRole.Section && !first) {
            Column(m.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Hairline()
                BoxBody(box, Modifier.fillMaxWidth(), scope)
            }
        } else {
            BoxBody(box, m, scope)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BoxBody(box: Element.Box, modifier: Modifier, scope: GenUiScope) {
    val gap = GenUiSpec.gap(box.gap, box.direction, box.role)
    val children = box.children
    val elements = scope.document.elements
    if (box.direction == Direction.Column) {
        val horizontal = when (box.align) {
            Align.Center -> Alignment.CenterHorizontally
            Align.End -> Alignment.End
            else -> Alignment.Start
        }
        CompositionLocalProvider(LocalRailReach provides gap) {
            if (box.divide != Divide.None) {
                val inset = if (box.divide == Divide.Inset && box.leading != Leading.None) GenUiSpec.leading(box.leading) + GenUiSpec.leadingGap else 0.dp
                Column(modifier, horizontalAlignment = horizontal) {
                    children.forEachIndexed { i, child ->
                        if (i > 0) Hairline(Modifier.padding(start = inset, top = gap, bottom = gap))
                        Draw(child, childInColumn(elements[child], box.align), first = i == 0)
                    }
                }
            } else {
                Column(modifier, verticalArrangement = Arrangement.spacedBy(gap), horizontalAlignment = horizontal) {
                    children.forEachIndexed { i, child -> Draw(child, childInColumn(elements[child], box.align), first = i == 0) }
                }
            }
        }
        return
    }
    when {
        box.role == BoxRole.Actions || box.equal -> EqualRow(gap, whole = box.role == BoxRole.Actions, stack = box.wrap, modifier) {
            children.forEach { Draw(it, Modifier.fillMaxWidth()) }
        }
        box.wrap -> {
            FlowRow(
                modifier,
                horizontalArrangement = if (box.justify == Justify.Between) Arrangement.SpaceBetween else Arrangement.spacedBy(gap),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                children.forEach { child ->
                    val e = elements[child]
                    var m: Modifier = Modifier
                    if (box.justify == Justify.Between) m = m.padding(end = gap)
                    if (box.align == Align.Baseline) m = m.then(if (e is Element.Icon) Modifier.alignBy { it.measuredHeight } else Modifier.alignByBaseline())
                    else if (box.align == Align.Center) m = m.align(Alignment.CenterVertically)
                    if (e is Element.Box && e.grow) m = m.weight(1f)
                    Draw(child, m)
                }
            }
        }
        else -> {
            val leading = if (box.role == BoxRole.Item) box.leading else Leading.None
            val first = children.firstOrNull()?.let(elements::get)
            // The leading column holds the first child when that is an icon, picture or position; otherwise it stays empty.
            val own = leading != Leading.None && first != null && first.leads()
            if (leading == Leading.None) {
                LineRow(box, children, gap, elements, modifier)
            } else {
                // The column sits outside the line, so justify and baseline act on the rest only.
                Row(modifier, verticalAlignment = if (box.align == Align.Start) Alignment.Top else Alignment.CenterVertically) {
                    Box(Modifier.width(GenUiSpec.leading(leading)), contentAlignment = Alignment.Center) { if (own) Draw(children.first()) }
                    Spacer(Modifier.width(GenUiSpec.leadingGap))
                    LineRow(box, if (own) children.drop(1) else children, gap, elements, Modifier.weight(1f))
                }
            }
        }
    }
}

/** Children on one line, as [box] says to justify and align them. */
@Composable
private fun LineRow(box: Element.Box, children: List<String>, gap: Dp, elements: Map<String, Element>, modifier: Modifier) {
    val rail = children.any { elements[it] is Element.Marker }
    Row(
        modifier.then(if (rail) Modifier.height(IntrinsicSize.Min) else Modifier),
        horizontalArrangement = when (box.justify) {
            Justify.Between -> if (children.size > 1) Arrangement.SpaceBetween else Arrangement.spacedBy(gap)
            Justify.Start -> Arrangement.spacedBy(gap)
            Justify.End -> Arrangement.spacedBy(gap, Alignment.End)
        },
        verticalAlignment = when (box.align) {
            Align.Center -> Alignment.CenterVertically
            Align.End -> Alignment.Bottom
            else -> Alignment.Top
        },
    ) {
        children.forEachIndexed { i, child ->
            var m = rowChild(elements[child], box.align)
            // SpaceBetween takes the gap away; give it back between neighbours.
            if (box.justify == Justify.Between && i < children.lastIndex) m = m.padding(end = gap)
            Draw(child, m)
        }
    }
}

/** A child in a column: full width unless it is a pill, button or icon, which keep their own. */
private fun childInColumn(e: Element?, align: Align): Modifier =
    if (e == null || e.hugs() || align != Align.Stretch) Modifier else Modifier.fillMaxWidth()

/**
 * A child in a row, which stays on one line. A growing box takes what is
 * left; `fixed` text, icons, pills, buttons and markers keep their width;
 * other text and boxes give way (wrapping, clamping or truncating).
 */
private fun RowScope.rowChild(e: Element?, align: Align): Modifier {
    var m: Modifier = when {
        e is Element.Box && e.grow -> Modifier.weight(1f)
        e is Element.Box -> Modifier.weight(1f, fill = false)
        e is Element.Text && !e.fixed -> Modifier.weight(1f, fill = false)
        else -> Modifier
    }
    if (align == Align.Baseline) {
        m = m.then(if (e is Element.Icon) Modifier.alignBy { it.measuredHeight } else Modifier.alignByBaseline())
    }
    if (align == Align.Start && e is Element.Icon && e.role == IconRole.Leading) m = m.padding(top = 1.dp)
    return m
}

/**
 * Children side by side at equal widths. With [stack], they go one under
 * another, full width, when any doesn't fit its share: buttons ([whole]) must
 * fit on one line, other children may wrap as long as no word is cut.
 */
@Composable
internal fun EqualRow(gap: Dp, whole: Boolean, stack: Boolean, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Layout(content, modifier.fillMaxWidth()) { measurables, constraints ->
        val gapPx = gap.roundToPx()
        val n = measurables.size
        if (n == 0) return@Layout layout(constraints.minWidth, 0) {}
        val width = constraints.maxWidth
        val cell = (width - gapPx * (n - 1)) / n
        val fits = !stack || measurables.all { (if (whole) it.maxIntrinsicWidth(Constraints.Infinity) else it.minIntrinsicWidth(Constraints.Infinity)) <= cell }
        if (fits) {
            val placeables = measurables.map { it.measure(Constraints(minWidth = cell, maxWidth = cell)) }
            val height = placeables.maxOf { it.height }
            layout(width, height) { placeables.forEachIndexed { i, p -> p.place(i * (cell + gapPx), 0) } }
        } else {
            val placeables = measurables.map { it.measure(Constraints(minWidth = width, maxWidth = width)) }
            val height = placeables.sumOf { it.height } + gapPx * (n - 1)
            layout(width, height) {
                var y = 0
                placeables.forEach { it.place(0, y); y += it.height + gapPx }
            }
        }
    }
}

/** A full-width hairline in the theme's divider colour. */
@Composable
internal fun Hairline(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(hairline()).background(HappyTheme.colors.divider))
}

/** Lets a child reach [bleed] past its column on both sides (a carousel scrolls out to the edge). */
internal fun Modifier.bleed(bleed: Dp): Modifier = layout { measurable, constraints ->
    val extra = bleed.roundToPx()
    if (!constraints.hasBoundedWidth || extra == 0) {
        val placeable = measurable.measure(constraints)
        return@layout layout(placeable.width, placeable.height) { placeable.place(0, 0) }
    }
    val width = constraints.maxWidth + extra * 2
    val placeable = measurable.measure(constraints.copy(minWidth = width, maxWidth = width))
    layout(constraints.maxWidth, placeable.height) { placeable.place(-extra, 0) }
}

// Switch

/**
 * The branch its own width calls for (RENDER.md M5). Both are composed and
 * only that one is measured and placed: no subcomposition, so a switch can
 * sit where its parent asks for intrinsic sizes (a grid cell, an equal row).
 */
@Composable
private fun SwitchView(e: Element.Switch, modifier: Modifier) {
    val branch: @Composable (List<String>) -> Unit = { keys -> Column(Modifier.fillMaxWidth()) { keys.forEach { Draw(it, Modifier.fillMaxWidth()) } } }
    Layout(listOf({ branch(e.compact) }, { branch(e.regular) }), modifier.fillMaxWidth()) { (compact, regular), constraints ->
        val shown = if (constraints.maxWidth < GenUiSpec.regularWidth.roundToPx()) compact else regular
        val placeables = shown.map { it.measure(constraints) }
        layout(constraints.maxWidth, placeables.maxOfOrNull { it.height } ?: constraints.minHeight) { placeables.forEach { it.place(0, 0) } }
    }
}

// Text

@Composable
private fun TextView(key: String, e: Element.Text, modifier: Modifier) {
    val colors = HappyTheme.colors
    val scope = LocalGenUi.current
    val role = roleStyle(e.role, LocalSurface.current)
    val color = e.tone?.let { LocalGenUiColors.current.text(it) } ?: if (role.secondary) colors.textSecondary else colors.text
    val text = rememberSpans(e.spans) { url -> scope?.host?.onAction(key, Action.Open(url)) }
    val end = LocalCellEnd.current ?: (e.align == TextAlign.End)
    Text(
        text,
        modifier,
        style = role.style,
        color = color,
        textAlign = if (end) androidx.compose.ui.text.style.TextAlign.End else androidx.compose.ui.text.style.TextAlign.Start,
        maxLines = when (e.overflow) {
            Overflow.Wrap -> Int.MAX_VALUE
            Overflow.Clamp -> GenUiSpec.clampLines
            Overflow.Truncate -> 1
        },
        overflow = if (e.overflow == Overflow.Wrap) TextOverflow.Clip else TextOverflow.Ellipsis,
    )
}

/** Spans as one string: strong is semibold, emphasis italic, code mono on a quiet fill, a link the link colour underlined. */
@Composable
private fun rememberSpans(spans: List<Span>, onLink: (String) -> Unit): AnnotatedString {
    val colors = HappyTheme.colors
    return remember(spans, colors) {
        buildAnnotatedString {
            for (span in spans) {
                var style = SpanStyle()
                if (span.strong) style = style.merge(SpanStyle(fontWeight = FontWeight.SemiBold))
                if (span.emphasis) style = style.merge(SpanStyle(fontStyle = FontStyle.Italic))
                if (span.code) style = style.merge(SpanStyle(fontFamily = AppMono, fontSize = 0.9.em, background = colors.surfaceHighest))
                val link = span.link
                if (link != null) {
                    val linkStyle = TextLinkStyles(SpanStyle(color = colors.textLink, textDecoration = TextDecoration.Underline))
                    withLink(LinkAnnotation.Clickable(link, linkStyle) { onLink(link) }) { withStyle(style) { append(span.text) } }
                } else {
                    withStyle(style) { append(span.text) }
                }
            }
        }
    }
}

// Icon and pill

/** The shared Gen UI glyph of [this] (Lucide, from the spec's `icons/`), a black mask to tint. */
internal val IconName.drawable: Int
    get() = when (this) {
        IconName.Check -> R.drawable.genui_ic_check
        IconName.X -> R.drawable.genui_ic_x
        IconName.Alert -> R.drawable.genui_ic_alert
        IconName.Info -> R.drawable.genui_ic_info
        IconName.Clock -> R.drawable.genui_ic_clock
        IconName.Calendar -> R.drawable.genui_ic_calendar
        IconName.User -> R.drawable.genui_ic_user
        IconName.Users -> R.drawable.genui_ic_users
        IconName.File -> R.drawable.genui_ic_file
        IconName.Folder -> R.drawable.genui_ic_folder
        IconName.Code -> R.drawable.genui_ic_code
        IconName.Terminal -> R.drawable.genui_ic_terminal
        IconName.GitBranch -> R.drawable.genui_ic_git_branch
        IconName.GitCommit -> R.drawable.genui_ic_git_commit
        IconName.GitPullRequest -> R.drawable.genui_ic_git_pull_request
        IconName.Link -> R.drawable.genui_ic_link
        IconName.Search -> R.drawable.genui_ic_search
        IconName.Star -> R.drawable.genui_ic_star
        IconName.Heart -> R.drawable.genui_ic_heart
        IconName.Download -> R.drawable.genui_ic_download
        IconName.Upload -> R.drawable.genui_ic_upload
        IconName.Play -> R.drawable.genui_ic_play
        IconName.Pause -> R.drawable.genui_ic_pause
        IconName.Image -> R.drawable.genui_ic_image
        IconName.Chart -> R.drawable.genui_ic_chart
        IconName.Globe -> R.drawable.genui_ic_globe
        IconName.Bolt -> R.drawable.genui_ic_bolt
        IconName.Bug -> R.drawable.genui_ic_bug
        IconName.Lock -> R.drawable.genui_ic_lock
        IconName.Sparkles -> R.drawable.genui_ic_sparkles
        IconName.ArrowRight -> R.drawable.genui_ic_arrow_right
        IconName.ArrowUpRight -> R.drawable.genui_ic_arrow_up_right
        IconName.ArrowUp -> R.drawable.genui_ic_arrow_up
        IconName.ArrowDown -> R.drawable.genui_ic_arrow_down
        IconName.ArrowDownRight -> R.drawable.genui_ic_arrow_down_right
        IconName.ChevronRight -> R.drawable.genui_ic_chevron_right
        IconName.Dollar -> R.drawable.genui_ic_dollar
        IconName.MapPin -> R.drawable.genui_ic_map_pin
        IconName.Copy -> R.drawable.genui_ic_copy
    }

/** A shared glyph at [size], its alpha painted in [tint]. */
@Composable
internal fun GenUiIcon(name: IconName, size: Dp, tint: Color, modifier: Modifier = Modifier, contentDescription: String? = null) {
    Image(painterResource(name.drawable), contentDescription, modifier.size(size), colorFilter = ColorFilter.tint(tint))
}

@Composable
private fun IconView(e: Element.Icon, modifier: Modifier) {
    GenUiIcon(e.name, GenUiSpec.icon(e.role), LocalGenUiColors.current.ink(e.tone), modifier)
}

/** A 22 high capsule: the tone's soft fill, its word in the tone, an optional 12 glyph. */
@Composable
private fun PillView(e: Element.Pill, modifier: Modifier) {
    val colors = HappyTheme.colors
    val shared = LocalGenUiColors.current
    val ink = shared.ink(e.tone)
    val fg = shared.text(e.tone)
    Row(
        modifier.heightIn(min = 22.dp).clip(CircleShape).background(shared.fill(e.tone)).padding(horizontal = 8.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        e.icon?.let { GenUiIcon(it, 12.dp, ink) }
        Text(e.text, style = GenUiSpec.pill, color = fg, maxLines = 1, softWrap = false)
    }
}

// Button and press

/** Whether [key] may still be activated, and whether it is its group's choice. */
@Immutable
private data class ChoiceState(val enabled: Boolean, val chosen: Boolean)

@Composable
private fun choiceState(key: String, group: String?): ChoiceState {
    val scope = LocalGenUi.current ?: return ChoiceState(true, false)
    if (group == null) return ChoiceState(true, false)
    val pick = scope.chosen[group] ?: return ChoiceState(true, false)
    return ChoiceState(false, pick == key)
}

private fun GenUiScope.activate(key: String, group: String?, action: Action) {
    if (group != null) {
        if (group in chosen) return
        chosen[group] = key
    }
    host.onAction(key, action)
}

/**
 * Material buttons in Happy's colours: primary is the inverse fill (black on
 * light), secondary a hairline outline, plain the word alone, a chip an
 * outlined capsule. A tone colours the fill or the word. In a single-choice
 * group the chosen one takes a darker outline (and a check for its glyph,
 * if it has one) and the rest fade and stop responding.
 */
@Composable
private fun ButtonView(key: String, e: Element.Button, modifier: Modifier) {
    val colors = HappyTheme.colors
    val scope = LocalGenUi.current ?: return
    val runs = scope.host.supports(e.action)
    val state = choiceState(key, e.group).let { if (runs) it else it.copy(enabled = false) }
    // A neutral button is the app's own text colour; a toned one takes the tone's ink for its fill
    // and glyph, and the tone's text colour for its word.
    val shared = LocalGenUiColors.current
    val toneColor = if (e.tone == Tone.Neutral) colors.text else shared.ink(e.tone)
    val wordColor = if (e.tone == Tone.Neutral) colors.text else shared.text(e.tone)
    val onClick = { scope.activate(key, e.group, e.action) }
    val primary = e.variant == ButtonVariant.Primary
    val onFill = if (colors.dark) Color.Black else Color.White
    val fg = if (primary) onFill else toneColor
    val word = if (primary) onFill else wordColor
    // The check stands in for a glyph and is never added beside the word, so choosing doesn't change a button's width (M2).
    val icon = if (state.chosen && e.icon != null) IconName.Check else e.icon
    val content: @Composable RowScope.() -> Unit = {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            icon?.let { GenUiIcon(it, 16.dp, fg) }
            Text(e.label, style = GenUiSpec.button, color = word, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
    val faded = if (!state.enabled && !state.chosen) modifier.alpha(0.4f) else modifier
    val outline = BorderStroke(if (state.chosen) 1.5.dp else 1.dp, if (state.chosen) colors.text else colors.text.copy(alpha = if (colors.dark) 0.2f else 0.14f))
    val padding = PaddingValues(horizontal = 16.dp, vertical = 10.dp)
    val disabledColors = ButtonDefaults.outlinedButtonColors(disabledContentColor = toneColor)
    when (e.variant) {
        ButtonVariant.Primary -> Button(
            onClick, faded.heightIn(min = 40.dp), enabled = state.enabled, contentPadding = padding,
            colors = ButtonDefaults.buttonColors(containerColor = toneColor, disabledContainerColor = toneColor),
            content = content,
        )
        ButtonVariant.Secondary -> OutlinedButton(
            onClick, faded.heightIn(min = 40.dp), enabled = state.enabled, contentPadding = padding, border = outline, colors = disabledColors, content = content,
        )
        ButtonVariant.Plain -> TextButton(onClick, faded.heightIn(min = 40.dp), enabled = state.enabled, contentPadding = padding, content = content)
        ButtonVariant.Chip -> OutlinedButton(
            onClick, faded.heightIn(min = 36.dp), enabled = state.enabled, shape = CircleShape, border = outline, colors = disabledColors,
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp), content = content,
        )
    }
}

/**
 * Its children, tappable when it has an action. In a group the chosen one is
 * tinted and the rest fade; a list row's or carousel card's tint reaches a
 * little past its content, so it reads as the whole row or card.
 */
@Composable
private fun PressView(key: String, e: Element.Press, modifier: Modifier) {
    val colors = HappyTheme.colors
    val scope = LocalGenUi.current ?: return
    val state = choiceState(key, e.group)
    val action = e.action?.takeIf(scope.host.supports)
    val (reach, radius) = when (e.role) {
        PressRole.Plain -> 0.dp to 8.dp
        PressRole.Item -> 8.dp to 10.dp
        PressRole.Tile -> 6.dp to 16.dp
    }
    var m = modifier
    if (state.chosen) {
        val tint = LocalGenUiColors.current.fill(Tone.Accent)
        m = m.drawBehind {
            val r = reach.toPx()
            drawRoundRect(tint, Offset(-r, -r), Size(size.width + r * 2, size.height + r * 2), CornerRadius(radius.toPx()))
        }
    }
    if (action != null) {
        // No clip: it would cut into a card's last line at the corners.
        m = m.clickable(enabled = state.enabled, role = Role.Button) { scope.activate(key, e.group, action) }
    }
    if (!state.enabled && !state.chosen) m = m.alpha(0.4f)
    CompositionLocalProvider(LocalTappable provides (action != null)) {
        Column(m) { e.children.forEach { Draw(it, Modifier.fillMaxWidth()) } }
    }
}

// Bar, marker, code

/** A 6 high track, filled to [Element.Bar.value] in its tone's ink. */
@Composable
private fun BarView(e: Element.Bar, modifier: Modifier) {
    val colors = HappyTheme.colors
    val fill = LocalGenUiColors.current.ink(e.tone)
    Box(modifier.fillMaxWidth().height(6.dp).clip(CircleShape).background(colors.surfaceHighest)) {
        Box(Modifier.fillMaxWidth(e.value.toFloat()).height(6.dp).clip(CircleShape).background(fill))
    }
}

/**
 * A step's mark ([StepMark]), and its 2 rail in the hairline colour down
 * through the gap to the next step's mark.
 */
@Composable
private fun MarkerView(e: Element.Marker, modifier: Modifier) {
    val colors = HappyTheme.colors
    val reach = LocalRailReach.current
    val railColor = colors.divider
    Box(
        modifier.width(20.dp).fillMaxHeight().then(
            if (e.rail) Modifier.drawBehindRail(railColor, reach) else Modifier,
        ),
        contentAlignment = Alignment.TopCenter,
    ) {
        Box(Modifier.padding(top = 1.dp)) { StepMark(e.status) }
    }
}

private fun Modifier.drawBehindRail(color: Color, reach: Dp): Modifier = drawBehind {
    val top = 24.dp.toPx()
    val bottom = size.height + reach.toPx() - 2.dp.toPx()
    if (bottom > top) drawLine(color, Offset(size.width / 2, top), Offset(size.width / 2, bottom), 2.dp.toPx(), StrokeCap.Round)
}

/**
 * One 20 circle whatever the status, in the status's ink (theme `markers`):
 * done and failed a filled disc with a check or cross in the card's colour,
 * active a 2 ring around a dot half the diameter, pending the same ring empty.
 */
@Composable
private fun StepMark(status: StepStatus) {
    val colors = HappyTheme.colors
    val ink = LocalGenUiColors.current.ink(GenUiMarkers[status] ?: Tone.Muted)
    val diameter = 20.dp
    when (status) {
        StepStatus.Done, StepStatus.Failed -> Box(Modifier.size(diameter).clip(CircleShape).background(ink), contentAlignment = Alignment.Center) {
            GenUiIcon(if (status == StepStatus.Done) IconName.Check else IconName.X, 13.dp, colors.surface)
        }
        StepStatus.Active, StepStatus.Pending -> Canvas(Modifier.size(diameter)) {
            val stroke = 2.dp.toPx()
            drawCircle(ink, radius = (size.minDimension - stroke) / 2, style = Stroke(stroke))
            if (status == StepStatus.Active) drawCircle(ink, radius = size.minDimension / 4)
        }
    }
}

/**
 * The chat's code well: title or language, a copy control that reports `copy`
 * (a check for a moment after), and the text scrolling sideways.
 */
@Composable
private fun CodeView(key: String, e: Element.Code, modifier: Modifier) {
    val colors = HappyTheme.colors
    val scope = LocalGenUi.current ?: return
    var copied by remember(e.text) { mutableStateOf(false) }
    if (copied) LaunchedEffect(Unit) { delay(1500); copied = false }
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(colors.surfaceHigh)) {
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                e.title ?: e.language ?: "", Modifier.weight(1f),
                style = happyTextStyle(12, 16, weight = FontWeight.Medium, family = AppMono), color = colors.textSecondary,
            )
            Box(
                Modifier.size(36.dp).clip(CircleShape).clickable(role = Role.Button) {
                    copied = true
                    scope.host.onAction(key, Action.Copy(e.text))
                },
                contentAlignment = Alignment.Center,
            ) {
                val ink = LocalGenUiColors.current.ink(Tone.Muted)
                if (copied) GenUiIcon(IconName.Check, 14.dp, ink, contentDescription = "Copied")
                else GenUiIcon(IconName.Copy, 14.dp, ink, contentDescription = "Copy")
            }
        }
        Text(
            e.text, Modifier.horizontalScroll(rememberScrollState()).padding(start = 12.dp, end = 12.dp, bottom = 12.dp),
            style = GenUiSpec.code, color = colors.text, softWrap = false,
        )
    }
}
