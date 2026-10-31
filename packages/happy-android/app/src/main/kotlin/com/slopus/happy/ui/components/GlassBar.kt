package com.slopus.happy.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.offset
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

object GlassBarTags {
    const val BAR = "glassBar.bar"
}

/** Inside a [GlassBarLayout]'s bar: the bar paints no ground of its own, the glass is its ground. */
val LocalBarOnGlass = staticCompositionLocalOf { false }

/**
 * The room a [GlassBarLayout]'s bar takes over the content, for a scrolling
 * list to start under it. A list that takes it [claim]s it, so the screen
 * stops holding its content below the bar; anything else stays below it.
 */
class BarInset internal constructor(val top: Dp) {
    internal var claims by mutableStateOf(0)
}

val LocalBarInset = staticCompositionLocalOf<BarInset?> { null }

/** Takes [inset] for this list while it is composed: see [BarInset]. */
@Composable
fun ClaimBarInset(inset: BarInset) {
    DisposableEffect(inset) {
        inset.claims++
        onDispose { inset.claims-- }
    }
}

/**
 * For a scrolling list on a [GlassBarScreen] (other than [ItemList], which
 * does this itself): claims the bar's room and returns its height, to lead
 * the list with, so it starts under the bar and scrolls on under it. 0 off
 * a glass screen.
 */
@Composable
fun barInsetTop(): Dp {
    val inset = LocalBarInset.current ?: return 0.dp
    ClaimBarInset(inset)
    return inset.top
}

/**
 * A screen whose top bar is glass, as iOS's bars are: the content runs the
 * full height and the [bar] lies over it, drawn on the content under it
 * blurred and saturated, with [ground] over that ([Modifier.glassBar]). At
 * rest only the ground shows under the bar, so the bar is the screen's own
 * colour; what scrolls under it goes soft behind it. Below API 31 the
 * ground is nearly opaque instead.
 *
 * [content] gets the bar's height (status bar included) to keep clear at
 * its top, a list as its top content padding. The content is recorded for
 * the glass here, unless the screen records its own [source] (where another
 * glass, a dock's, reads the same recording; it must not record itself).
 * A [backdrop] is drawn in the ground's place, with the ground's alphas
 * ([Modifier.glassBar]).
 */
@Composable
fun GlassBarLayout(
    bar: @Composable () -> Unit,
    ground: Color,
    modifier: Modifier = Modifier,
    source: GlassSource? = null,
    backdrop: (DrawScope.() -> Unit)? = null,
    content: @Composable (top: Dp) -> Unit,
) {
    val own = rememberGlassSource(ground)
    val glass = source ?: own
    val blurs = rememberGlassBlur()
    SubcomposeLayout(modifier) { constraints ->
        val loose = constraints.copy(minWidth = 0, minHeight = 0)
        val barPlaceables = subcompose("bar") {
            Box(Modifier.glassBar(glass, ground, blurs, backdrop).testTag(GlassBarTags.BAR)) {
                CompositionLocalProvider(LocalBarOnGlass provides true, content = bar)
            }
        }.map { it.measure(loose.copy(maxHeight = Constraints.Infinity)) }
        val barHeight = barPlaceables.maxOfOrNull { it.height } ?: 0
        val top = barHeight.toDp()
        val contentPlaceables = subcompose("content") {
            Box(if (source == null) Modifier.glassSource(own) else Modifier) { content(top) }
        }.map { it.measure(constraints) }
        val width = contentPlaceables.maxOfOrNull { it.width } ?: constraints.minWidth
        val height = contentPlaceables.maxOfOrNull { it.height } ?: constraints.minHeight
        layout(width, height) {
            contentPlaceables.forEach { it.place(0, 0) }
            barPlaceables.forEach { it.place(0, 0) }
        }
    }
}

/**
 * [GlassBarLayout] for content that doesn't scroll under the bar by itself:
 * it is held below the bar, unless a list in it claims the bar's room
 * ([LocalBarInset], as [ItemList] does) and starts under it instead.
 */
@Composable
fun GlassBarScreen(
    bar: @Composable () -> Unit,
    ground: Color,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    GlassBarLayout(bar, ground, modifier) { top ->
        val inset = remember(top) { BarInset(top) }
        Box(
            Modifier.layout { measurable, constraints ->
                val pad = if (inset.claims > 0) 0 else inset.top.roundToPx()
                val placeable = measurable.measure(constraints.offset(vertical = -pad))
                layout(placeable.width, placeable.height + pad) { placeable.place(0, pad) }
            },
        ) {
            CompositionLocalProvider(LocalBarInset provides inset, content = content)
        }
    }
}
