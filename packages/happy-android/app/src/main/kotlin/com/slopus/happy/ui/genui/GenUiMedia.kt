package com.slopus.happy.ui.genui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.snapping.SnapPosition
import androidx.compose.foundation.gestures.snapping.rememberSnapFlingBehavior
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
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

/** Set by a mosaic: its tiles take the cell they are given instead of their shape. */
private val LocalSized = staticCompositionLocalOf { false }

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
        e.role == ImageRole.Figure -> modifier.fillMaxWidth().heightIn(max = 360.dp).aspectRatio(e.shape.ratio(), matchHeightConstraintsFirst = true).clip(RoundedCornerShape(12.dp))
        e.role == ImageRole.Tile -> modifier.fillMaxWidth().aspectRatio(e.shape.ratio())
        else -> modifier.fillMaxWidth().aspectRatio(e.shape.ratio()).clip(RoundedCornerShape(12.dp))
    }
    e.viewer?.let { viewer -> m = m.clickable(role = Role.Image) { scope.host.onView(key, viewer) } }
    var failed by remember(e.file) { mutableStateOf(false) }
    Box(m, contentAlignment = Alignment.Center) {
        RemoteImage(
            model = scope.host.file(e.file),
            contentDescription = e.alt,
            modifier = Modifier.matchParentSize(),
            background = colors.surfaceHighest,
            placeholder = rememberThumbHash(e.thumbhash),
            onState = { failed = it == RemoteImageState.Error },
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
 * picture doesn't fill the screen.
 */
@Composable
internal fun ScrollView(e: Element.Scroll, modifier: Modifier) {
    val bleed = LocalBleed.current
    val state = rememberLazyListState()
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val share = when (e.shape) {
            Shape.Landscape -> 0.72f
            Shape.Square -> 0.6f
            Shape.Portrait -> 0.48f
        }
        val cardWidth: Dp = minOf(maxWidth * share, 280.dp)
        LazyRow(
            Modifier.bleed(bleed),
            state = state,
            contentPadding = PaddingValues(horizontal = bleed),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.Top,
            flingBehavior = rememberSnapFlingBehavior(state, SnapPosition.Start),
        ) {
            items(e.children) { child -> Draw(child, Modifier.width(cardWidth)) }
        }
    }
}
