package com.slopus.happy.ui.genui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.spring
import androidx.compose.foundation.gestures.FlingBehavior
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.ScrollScope
import androidx.compose.foundation.gestures.rememberScrollableState
import androidx.compose.foundation.gestures.scrollable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.round
import com.slopus.happy.genui.Element
import com.slopus.happy.genui.IconName
import com.slopus.happy.genui.ImageRole
import com.slopus.happy.genui.Tone
import com.slopus.happy.genui.Shape
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.components.RemoteImageState
import com.slopus.happy.ui.components.rememberThumbHash
import com.slopus.happy.ui.theme.HappyTheme

/** Width over height of a shape: 4:3, square, 3:4. */
internal fun Shape.ratio(): Float = when (this) {
    Shape.Landscape -> 4f / 3f
    Shape.Square -> 1f
    Shape.Portrait -> 3f / 4f
}

/** A figure's stored width over height (RENDER.md M3), its shape's where the file gave none, kept to 1:4 through 4:1. */
internal fun Element.Image.pixelRatio(): Float =
    if (width > 0 && height > 0) (width.toFloat() / height).coerceIn(0.25f, 4f) else shape.ratio()

/** Set by a mosaic: its tiles take the cell they are given instead of their shape. */
private val LocalSized = staticCompositionLocalOf { false }

/** What the host read for a picture the version doesn't hold. */
private object NoPicture

/**
 * A stored image in a box of its shape, cropped and centred, its ThumbHash
 * drawn until the file has loaded, so the final size is held from the start.
 * A figure is 12 round and at most 360 high; a tile is square-cornered (the
 * mosaic rounds the whole); a thumb is 40, 8 round; a cover is the top of a
 * carousel card, 12 round. A tap opens the host's viewer when the image has one.
 */
@Composable
internal fun ImageView(key: String, e: Element.Image, modifier: Modifier) {
    val scope = LocalGenUi.current ?: return
    val colors = HappyTheme.colors
    val sized = LocalSized.current
    var m = when {
        sized -> modifier.fillMaxSize()
        e.role == ImageRole.Thumb -> modifier.size(40.dp).clip(RoundedCornerShape(8.dp))
        e.role == ImageRole.Figure -> modifier.fillMaxWidth().heightIn(max = 360.dp).aspectRatio(e.pixelRatio(), matchHeightConstraintsFirst = true).clip(RoundedCornerShape(12.dp))
        e.role == ImageRole.Tile -> modifier.fillMaxWidth().aspectRatio(e.shape.ratio())
        else -> modifier.fillMaxWidth().aspectRatio(e.shape.ratio()).clip(RoundedCornerShape(12.dp))
    }
    e.viewer?.let { viewer -> m = m.clickable(role = Role.Image) { scope.host.onView(key, viewer) } }
    var failed by remember(e.file) { mutableStateOf(false) }
    val model by produceState(scope.host.cached(e.file), e.file, scope.host) { if (value == null) value = scope.host.load(e.file) ?: NoPicture }
    Box(m, contentAlignment = Alignment.Center) {
        RemoteImage(
            model = model?.takeIf { it != NoPicture },
            cacheKey = scope.host.key(e.file),
            contentDescription = e.alt,
            modifier = Modifier.matchParentSize(),
            background = colors.surfaceHighest,
            placeholder = rememberThumbHash(e.thumbhash),
            // Until the host has read it there is nothing to fail.
            onState = { if (model != null) failed = it == RemoteImageState.Error },
        )
        if (failed) GenUiIcon(IconName.Image, 24.dp, LocalGenUiColors.current.ink(Tone.Muted))
        e.overlay?.let { overlay ->
            Box(Modifier.matchParentSize().background(Color.Black.copy(alpha = 0.45f)), contentAlignment = Alignment.Center) {
                Text(overlay, style = GenUiSpec.overlay, color = Color.White)
            }
        }
    }
}

/**
 * A mosaic, arranged by count in one 12-round clip, tiles 2 apart: 1 full
 * width at its shape; 2 side by side; 3 one large beside two stacked; 4 two
 * by two; 5 two over three. Only the first five are drawn.
 */
@Composable
internal fun Mosaic(children: List<String>, modifier: Modifier) {
    val scope = LocalGenUi.current ?: return
    val keys = children.take(5)
    if (keys.isEmpty()) return
    val gap = 2.dp
    val ratio = (scope.document.elements[keys.first()] as? Element.Image)?.shape?.ratio() ?: Shape.Landscape.ratio()
    @Composable
    fun Tile(index: Int, modifier: Modifier) {
        Box(modifier) { Draw(keys[index]) }
    }
    CompositionLocalProvider(LocalSized provides true) {
        Column(modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)), verticalArrangement = Arrangement.spacedBy(gap)) {
            when (keys.size) {
                1 -> Tile(0, Modifier.fillMaxWidth().aspectRatio(ratio))
                2 -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap)) {
                    Tile(0, Modifier.weight(1f).aspectRatio(ratio * 0.75f))
                    Tile(1, Modifier.weight(1f).aspectRatio(ratio * 0.75f))
                }
                3 -> Row(Modifier.fillMaxWidth().aspectRatio(ratio), horizontalArrangement = Arrangement.spacedBy(gap)) {
                    Tile(0, Modifier.weight(2f).fillMaxSize())
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(gap)) {
                        Tile(1, Modifier.weight(1f).fillMaxWidth())
                        Tile(2, Modifier.weight(1f).fillMaxWidth())
                    }
                }
                4 -> (0 until 2).forEach { r ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap)) {
                        Tile(r * 2, Modifier.weight(1f).aspectRatio(ratio))
                        Tile(r * 2 + 1, Modifier.weight(1f).aspectRatio(ratio))
                    }
                }
                else -> {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap)) {
                        Tile(0, Modifier.weight(1f).aspectRatio(ratio))
                        Tile(1, Modifier.weight(1f).aspectRatio(ratio))
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap)) {
                        (2 until 5).forEach { Tile(it, Modifier.weight(1f).aspectRatio(1f)) }
                    }
                }
            }
        }
    }
}

/**
 * Cards in a row that scrolls out to the chat's edges and snaps one card at a
 * time. A landscape card is 72% of the column (at most 280), a square one 60%,
 * a portrait one 48%, so the next one peeks in at the edge and a tall
 * picture doesn't fill the screen. Every card is measured, on screen or not,
 * and the row is as tall as the tallest (RENDER.md M6); scrolling only moves
 * the cards, so it never measures again.
 */
@Composable
internal fun ScrollView(e: Element.Scroll, modifier: Modifier) {
    val bleed = LocalBleed.current
    val track = remember { CardTrack() }
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    val scrollable = rememberScrollableState { delta -> track.consume(delta) }
    val fling = remember(track) { CardSnap(track) }
    Layout(
        content = { e.children.forEach { Draw(it) } },
        modifier = modifier
            .fillMaxWidth()
            .bleed(bleed)
            .clipToBounds()
            .scrollable(scrollable, Orientation.Horizontal, reverseDirection = !rtl, flingBehavior = fling)
            .testTag(GenUiTags.SCROLL),
    ) { measurables, constraints ->
        val width = constraints.maxWidth
        val inset = bleed.roundToPx()
        val share = when (e.shape) {
            Shape.Landscape -> 0.72f
            Shape.Square -> 0.6f
            Shape.Portrait -> 0.48f
        }
        val card = minOf(((width - inset * 2) * share).toInt(), 280.dp.roundToPx())
        val gap = 12.dp.roundToPx()
        val placeables = measurables.map { it.measure(Constraints.fixedWidth(card)) }
        track.stride = card + gap
        track.max = (inset * 2 + placeables.size * card + (placeables.size - 1).coerceAtLeast(0) * gap - width).coerceAtLeast(0).toFloat()
        layout(width, placeables.maxOfOrNull { it.height } ?: 0) {
            val offset = track.offset.toInt()
            placeables.forEachIndexed { i, p -> p.placeRelative(inset + i * (card + gap) - offset, 0) }
        }
    }
}

/** Where a card row is scrolled to; read only when placing, so a scroll moves the cards without measuring them. */
@Stable
private class CardTrack {
    var offset by mutableFloatStateOf(0f)
    var stride = 1
    var max = 0f

    fun consume(delta: Float): Float {
        val before = offset
        offset = (offset + delta).coerceIn(0f, max)
        return offset - before
    }
}

/** A fling settles with a card's start on the column's start: the next or previous card when fast enough, else the nearest. */
private class CardSnap(private val track: CardTrack) : FlingBehavior {
    override suspend fun ScrollScope.performFling(initialVelocity: Float): Float {
        val at = track.offset / track.stride
        val index = when {
            initialVelocity > FLING_VELOCITY -> ceil(at)
            initialVelocity < -FLING_VELOCITY -> floor(at)
            else -> round(at)
        }
        val target = (index * track.stride).coerceIn(0f, track.max)
        var last = track.offset
        animate(last, target, initialVelocity, spring(stiffness = Spring.StiffnessMediumLow)) { value, _ ->
            scrollBy(value - last)
            last = value
        }
        return 0f
    }

    private companion object {
        const val FLING_VELOCITY = 400f
    }
}
